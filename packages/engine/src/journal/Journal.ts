// Journal: durable op records, coalescing and cancellation (design §3.7.1, §3.7.2; engine-spec §4).
//
// Rules:
//  - At most one non-terminal put/delete op per fileId (I4). A new change while that op is `queued`,
//    `blobs`, `ready` or `failed` (and not in a batch) replaces its fields in place and restarts it
//    from `queued`. Once a Batch holding the op is persisted as `sent`, the op is frozen: the new change
//    is remembered as "waiting" and re-planned after the ack (X3: base = the acked seq).
//  - Archive ops (LWW loser, design §3.10.4) are history records that never move the head; they are
//    kept separately from the put/delete slot so a later edit can never replace (and lose) an archive.
//  - An op with `source: 'staging'` carries its plaintext in `staging[opSeq]` from the moment it is
//    enqueued (archive bytes, X1 re-upload of the base): the file on disk may change right after.
//  - A staged put op (D1 merge write, X1) is never replaced in place or dropped before its ack: its
//    bytes can be the only copy of a local edit (torn merge write). A newer change, a CONFLICT or a
//    failed blob repair turns it into an archive op instead (I6).
//
// Every write here is one StateStore transaction; enqueueIn() runs inside a caller's transaction
// (PUSH_CREATE creates the FileEntry and its op together, design §3.7.1).

import type { FileId, Op, OpKind, Seq, StateStore, StateTx } from "@shuttle/protocol";
import type { PendingOpMirror } from "../state/epoch";

export interface EnqueueReq {
  kind: OpKind;
  fileId: FileId;
  path: string;
  base: Seq | null;
  groupId?: string;
  /** Plaintext captured now (archive, base re-upload); the op then never reads the disk. */
  staged?: Uint8Array;
  /** Previous synced path, for the pendingOps mirror (design §3.3.5). */
  fromPath?: string;
  /** Content hash the Planner saw (lets a repeated identical request keep the op's progress). */
  hash?: string;
  /** Times of the staged content (archive: the local file's mtime/ctime). */
  mtime?: number;
  ctime?: number;
}

function stagedTimes(req: EnqueueReq): Partial<Pick<Op, "mtime" | "ctime">> {
  if (req.staged === undefined) return {};
  return { ...(req.mtime !== undefined ? { mtime: req.mtime } : {}), ...(req.ctime !== undefined ? { ctime: req.ctime } : {}) };
}

export type EnqueueResult =
  | { t: 'queued'; opSeq: number }
  | { t: 'replaced'; opSeq: number }
  /** A frozen op of this fileId is in flight; re-plan after its ack. */
  | { t: 'waiting' };

export interface JournalDeps {
  state: StateStore;
  now(): number;
  /** localStorage pendingOps mirror (design §3.3.5, S26). */
  mirror?: { upsert(m: PendingOpMirror): void; remove(fileId: FileId): void; list?(): readonly PendingOpMirror[] };
}

const SLOT_STATES = new Set<Op["state"]>(["queued", "blobs", "ready", "sent", "failed"]);

/** The same request again (re-plan without a change): keep the op and its upload progress. */
function keepsOp(cur: Op, req: EnqueueReq): boolean {
  if (cur.state === "failed" || req.staged !== undefined || cur.source === "staging") return false;
  if (cur.kind !== req.kind || cur.path !== req.path || cur.base !== req.base || cur.fileId !== req.fileId) return false;
  if (req.kind === "delete") return true;
  return cur.state === "queued" || (req.hash !== undefined && req.hash === cur.contentHash);
}

/** A put op whose plaintext lives in staging (merge write D1, X1 base re-upload). */
export function isStagedPut(op: Op): boolean {
  return op.kind === "put" && op.source === "staging";
}

export function isFrozenOp(op: Op): boolean {
  return op.state === "sent";
}

export class Journal {
  private readonly waiting = new Set<FileId>();

  constructor(private readonly d: JournalDeps) {}

  /** The non-terminal put/delete op of `fileId`, if any. */
  static async slotOp(tx: StateTx, fileId: FileId): Promise<Op | undefined> {
    const ops = await tx.journal.getAll({ index: "fileId", only: fileId });
    return ops.find((o) => o.kind !== "archive" && SLOT_STATES.has(o.state));
  }

  enqueue(req: EnqueueReq): Promise<EnqueueResult> {
    return this.d.state.tx(["journal", "staging"], (tx) => this.enqueueIn(tx, req)).then((r) => this.after(req, r));
  }

  /**
   * Enqueue inside a caller's transaction (it must name `journal` and `staging`). Call afterCommit()
   * with the result once that transaction committed.
   */
  async enqueueIn(tx: StateTx, req: EnqueueReq): Promise<EnqueueResult> {
    const now = this.d.now();
    if (req.kind !== "archive") {
      const cur = await Journal.slotOp(tx, req.fileId);
      if (cur && isFrozenOp(cur)) return { t: "waiting" };
      if (cur && keepsOp(cur, req)) return { t: "replaced", opSeq: cur.opSeq };
      if (cur && isStagedPut(cur) && cur.base !== null) {
        // A staged put (D1 merge, X1 base re-upload) holds bytes that may exist nowhere else: a torn or
        // interrupted merge write leaves only a prefix on disk. It is never replaced in place: it becomes
        // an archive record (history, never moves the head) and the new change gets a fresh op (I6).
        await Journal.archiveStagedIn(tx, cur);
      } else if (cur) {
        const next: Op = {
          opSeq: cur.opSeq, kind: req.kind, fileId: req.fileId, path: req.path, base: req.base,
          state: "queued", attempts: 0, nextAttemptAt: 0, createdAt: cur.createdAt,
          ...(req.groupId !== undefined ? { groupId: req.groupId } : {}),
          ...(req.staged !== undefined ? { source: "staging" as const } : {}),
          ...stagedTimes(req),
        };
        await tx.journal.put(next);
        if (req.staged !== undefined) await tx.staging.put({ opSeq: cur.opSeq, bytes: req.staged });
        else await tx.staging.delete(cur.opSeq);
        return { t: "replaced", opSeq: cur.opSeq };
      }
    }
    const op = {
      kind: req.kind, fileId: req.fileId, path: req.path, base: req.base, state: "queued" as const,
      attempts: 0, nextAttemptAt: 0, createdAt: now,
      ...(req.groupId !== undefined ? { groupId: req.groupId } : {}),
      ...(req.staged !== undefined ? { source: "staging" as const } : {}),
      ...stagedTimes(req),
    };
    const opSeq = (await tx.journal.put(op)) as number;
    if (req.staged !== undefined) await tx.staging.put({ opSeq, bytes: req.staged });
    return { t: "queued", opSeq };
  }

  /** Bookkeeping after a transaction that called enqueueIn() committed. */
  afterCommit(req: EnqueueReq, r: EnqueueResult): EnqueueResult {
    return this.after(req, r);
  }

  private after(req: EnqueueReq, r: EnqueueResult): EnqueueResult {
    if (r.t === "waiting") this.waiting.add(req.fileId);
    else if (req.kind !== "archive") {
      this.d.mirror?.upsert({ fileId: req.fileId, kind: req.kind, ...(req.fromPath !== undefined ? { fromPath: req.fromPath } : {}), toPath: req.path });
    }
    return r;
  }

  /** Cancel the non-frozen put/delete op of `fileId` (FORGET, replaces, superseding actions). */
  cancel(fileId: FileId): Promise<boolean> {
    return this.d.state.tx(["journal", "staging"], (tx) => Journal.cancelIn(tx, fileId)).then((ok) => {
      if (ok) this.d.mirror?.remove(fileId);
      return ok;
    });
  }

  /**
   * Turn a non-frozen staged put op into an archive op in place (same opSeq, staging row kept), so its
   * bytes reach the remote history instead of being dropped (I6). The caller checked `base !== null`.
   */
  static async archiveStagedIn(tx: StateTx, cur: Op): Promise<void> {
    const { batchId: _b, lastError: _e, ...rest } = cur;
    await tx.journal.put({ ...rest, kind: "archive", state: "queued", attempts: 0, nextAttemptAt: 0 });
  }

  static async cancelIn(tx: StateTx, fileId: FileId): Promise<boolean> {
    const cur = await Journal.slotOp(tx, fileId);
    if (!cur || isFrozenOp(cur)) return false;
    if (isStagedPut(cur) && cur.base !== null) {
      // Never drop staged bytes (a torn merge write may have left no other copy): archive them (I6).
      await Journal.archiveStagedIn(tx, cur);
      return true;
    }
    await tx.journal.delete(cur.opSeq);
    await tx.staging.delete(cur.opSeq);
    return true;
  }

  /** The put/delete op of `fileId` left the journal for good (ack, conflict, drop, cancel in a txn). */
  unmirror(fileId: FileId): void {
    this.d.mirror?.remove(fileId);
  }

  /**
   * After a restart: drop mirror entries whose op is gone (a crash between an ack transaction and the
   * localStorage update), so rebuild-from-scan never replays a change that was already committed.
   */
  async pruneMirror(): Promise<number> {
    const m = this.d.mirror;
    if (!m?.list) return 0;
    const live = new Set((await this.ops()).filter((o) => o.kind !== "archive").map((o) => o.fileId));
    let n = 0;
    for (const x of [...m.list()]) {
      if (live.has(x.fileId)) continue;
      m.remove(x.fileId);
      n++;
    }
    return n;
  }

  /** True while a put/delete op of `fileId` is frozen in a sent batch. */
  isFrozen(fileId: FileId): Promise<boolean> {
    return this.d.state.tx(["journal"], async (tx) => {
      const cur = await Journal.slotOp(tx, fileId);
      return cur !== undefined && isFrozenOp(cur);
    }, "readonly");
  }

  /** Remember that a change of `fileId` arrived while its op was frozen. */
  markWaiting(fileId: FileId): void {
    this.waiting.add(fileId);
  }

  /** Consume the waiting flag (the op runner re-dirties these after an ack). */
  takeWaiting(fileId: FileId): boolean {
    return this.waiting.delete(fileId);
  }

  ops(): Promise<Op[]> {
    return this.d.state.tx(["journal"], (tx) => tx.journal.getAll(), "readonly");
  }

  /** Reset `failed` ops (user retry, or the cause cleared). */
  retryFailed(fileId?: FileId): Promise<number> {
    return this.d.state.tx(["journal"], async (tx) => {
      let n = 0;
      for (const op of await tx.journal.getAll({ index: "state", only: "failed" })) {
        if (fileId !== undefined && op.fileId !== fileId) continue;
        const { lastError: _e, batchId: _b, ...rest } = op;
        await tx.journal.put({ ...rest, state: "queued", attempts: 0, nextAttemptAt: 0 });
        n++;
      }
      return n;
    });
  }
}
