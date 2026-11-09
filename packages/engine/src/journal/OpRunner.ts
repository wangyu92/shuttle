// OpRunner: executes journal ops (design §3.7.2-§3.7.4; engine-spec §4).
//
//   queued ──read+hash+chunk (+staging)──▶ blobs ──missingBlobs+putBlob──▶ ready
//          ──[freeze txn: Batch(sent) + ops sent]──▶ sent ──commit──▶ [result txn: Batch(resolved)]
//          ──▶ one ack txn per op (the only place a push marks a file synced) ──▶ (deleted)
//
// Crash safety:
//  - The freeze transaction commits before the first byte of the commit is sent. A frozen batch is
//    never changed: a resend rebuilds byte-identical op headers (same cid, same order; pathKey from
//    op.path, rc from the path, kv from Batch.kv, blobs from the op) and re-seals meta and inline from
//    the op and staging with fresh nonces; the ops digest excludes ciphertext (design §2.8.3, ID-6).
//  - The result is persisted (Batch state `resolved`) before any ack; resume re-runs the acks, which
//    are idempotent (an op that is gone or left the batch is skipped).
//  - Ops in queued/blobs/ready restart from queued after a restart (contents are re-read).
//  - No transaction awaits anything but its own store operations: crypto and network run between
//    transactions, and crash points sit only between transactions (design §3.1 testing/crashPoint.ts).

import { b64u } from "@shuttle/crypto";
import {
  isRemoteError, opsDigestPreimage,
  type Batch, type CommitOp, type CommitRequest, type CommitResponse, type ConfigCategory, type EngineHooks, type FileId,
  type FileKind, type Keyring, type LocalFs, type Op, type OpResult, type RemoteAdapter, type RemoteHead, type RetentionClass,
  type Seq, type StateStore, type StateTx, type VersionRecord,
} from "@shuttle/protocol";
import type { BlobPipeline, PreparedContent } from "../content/BlobPipeline";
import { AuthError, LockedError } from "../errors";
import type { FileIndex, IndexWriter } from "../index/FileIndex";
import { foldKey } from "../path/normalize";
import { hasFsCode } from "../platform/LocalFs";
import { decodeRecord, putMeta, tombstoneMeta } from "../remote/records";
import { crashPoint } from "../testing/crashPoint";
import type { DirtyKey, DirtyReason } from "../types";
import { utf8Encode } from "../util/bytes";
import type { KeyedMutex } from "../util/KeyedMutex";
import { uuidV4 } from "../util/uuid";
import { Journal } from "./Journal";
import { backoffDelay } from "./backoff";

/** Encoded-size reserve below maxCommitBytes (design §3.7.2, XS-24). */
export const COMMIT_BYTES_RESERVE = 16 * 1024;
/** Resends of one batch to repair MISSING_BLOB before giving up on those ops. */
export const MISSING_BLOB_ROUNDS = 3;

export interface OpLog { key: string; cat: 'general' | 'error' | 'skipped' | 'merge' | 'network'; params?: Record<string, string | number | boolean | null>; path?: string; fileId?: FileId }

export interface OpRunnerDeps {
  state: StateStore;
  index: FileIndex;
  journal: Journal;
  remote: RemoteAdapter;
  /** null while Locked (design §3.13): nothing is read, sealed or sent. */
  keyring(): Keyring | null;
  fs: LocalFs;
  blobs: BlobPipeline;
  locks: KeyedMutex;
  now(): number;
  deviceId(): string;
  hooks?: EngineHooks;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  rcOf(path: string): RetentionClass;
  kindOf(path: string): FileKind;
  /** Text base kept for this file (design §3.3.4: notes ≤ baseMaxBytes). */
  needsBase(path: string, size: number): boolean;
  categoryOf?(path: string): ConfigCategory | null;
  /** Platform commit batch size (design §3.15). */
  batchMaxOps: number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  log?(e: OpLog): void;
  /** After a successful ack (LocalRenames.retry after deletes, conflict-loop reset, ...). */
  onAcked?(op: Op, seq: Seq): void;
  /** CONFLICT result (conflict-loop tracker, design §3.10.1). */
  onConflict?(fileId: FileId): void;
  /** KEY_VERSION: refetch and validate vault-info (design §3.7.4, part 3). Ops are already re-queued. */
  onKeyVersion?(): void;
  /** SNAPSHOT_REQUIRED from commit (epoch changed): part 3 runs the resync. */
  onSnapshotRequired?(): void;
  /** X5: an archive op failed for good; its staged bytes must survive as a conflict copy. */
  onArchiveFailed?(op: Op, bytes: Uint8Array): Promise<void>;
}

export interface RunStats { prepared: number; uploaded: number; sent: number; acked: number; conflicts: number; failed: number; requeued: number }

interface Sealed { req: CommitRequest; pathKeys: string[] }

function emptyStats(): RunStats {
  return { prepared: 0, uploaded: 0, sent: 0, acked: 0, conflicts: 0, failed: 0, requeued: 0 };
}

const lockKeys = (fileId: FileId, ...paths: Array<string | undefined>): string[] =>
  [`id:${fileId}`, ...paths.filter((p): p is string => p !== undefined).map((p) => `fk:${foldKey(p)}`)];

export class OpRunner {
  /** Commit ops cap after a whole-commit TOO_LARGE (halved each time). */
  private opsCap = Infinity;
  /** kv that the remote refused (KEY_VERSION): nothing is frozen under it until the keyring changes. */
  private refusedKv: number | null = null;

  constructor(private readonly d: OpRunnerDeps) {}

  private ring(): Keyring {
    const r = this.d.keyring();
    if (!r) throw new LockedError();
    return r;
  }

  private crash(name: string): Promise<void> {
    return crashPoint(this.d.hooks, name);
  }

  /**
   * design §3.7.4 resumeJournal(): resolved batches → re-run acks; ops not in a batch restart from
   * queued. Sent batches without a result are resent by the next run().
   */
  async resume(): Promise<RunStats> {
    const s = emptyStats();
    if (!this.d.keyring()) return s;
    await this.d.state.tx(["journal"], async (tx) => {
      for (const op of await tx.journal.getAll()) {
        if ((op.state === "blobs" || op.state === "ready") && op.batchId === undefined) await tx.journal.put({ ...op, state: "queued" });
      }
    });
    const batches = await this.d.state.tx(["batches"], (tx) => tx.batches.getAll(), "readonly");
    for (const b of batches) if (b.state === "resolved" && b.result) await this.processResults(b, b.result, s);
    await this.d.journal.pruneMirror();
    return s;
  }

  /** The vault-info was refetched after KEY_VERSION (design §3.7.4): freeze again (re-seal, new cid). */
  keyVersionResolved(): void {
    this.refusedKv = null;
  }

  /** One pass: prepare and upload due ops, resend due sent batches, freeze and send ready ops. */
  async run(): Promise<RunStats> {
    const s = emptyStats();
    if (!this.d.keyring()) return s;
    const now = this.d.now();
    const ops = await this.d.journal.ops();
    for (const op of ops) {
      if (op.state === "queued" && op.nextAttemptAt <= now) await this.prepareOp(op, s);
    }
    const batches = await this.d.state.tx(["batches", "journal"], async (tx) => {
      const out: Array<{ b: Batch; due: boolean }> = [];
      for (const b of await tx.batches.getAll()) {
        const mine = await tx.journal.getAll({ index: "batchId", only: b.batchId });
        out.push({ b, due: mine.every((o) => o.nextAttemptAt <= now) });
      }
      return out;
    }, "readonly");
    for (const { b, due } of batches) {
      if (b.state === "resolved" && b.result) await this.processResults(b, b.result, s);
      else if (b.state === "sent" && due) await this.send(b, null, s);
    }
    for (;;) {
      const next = await this.freezeNext();
      if (!next) break;
      await this.send(next.batch, next.sealed, s);
    }
    return s;
  }

  // ---------- queued → blobs → ready ----------

  private async prepareOp(op: Op, s: RunStats): Promise<void> {
    if (op.kind === "delete") {
      await this.d.state.tx(["journal"], async (tx) => {
        const cur = await tx.journal.get(op.opSeq);
        if (cur && sameIntent(cur, op) && cur.state === "queued") await tx.journal.put({ ...cur, state: "ready" });
      });
      s.prepared++;
      return;
    }
    const e = this.d.index.byFileId(op.fileId);
    const unlock = await this.d.locks.acquire(...lockKeys(op.fileId, op.path, e?.path));
    let prep: PreparedContent;
    try {
      let bytes: Uint8Array;
      let mtime = op.mtime ?? this.d.now();
      let ctime = op.ctime ?? mtime;
      if (op.source === "staging") {
        const row = await this.d.state.tx(["staging"], (tx) => tx.staging.get(op.opSeq), "readonly");
        if (!row) {
          // Staged content lost: nothing to upload; re-plan the file.
          await this.dropOp(op, "missing");
          return;
        }
        bytes = row.bytes;
      } else {
        try {
          const st = await this.d.fs.stat(op.path);
          if (!st || st.kind !== "file") throw Object.assign(new Error("gone"), { code: "ENOENT" });
          mtime = st.mtime;
          ctime = st.ctime;
          bytes = await this.d.fs.read(op.path);
        } catch (err) {
          if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) {
            // design §3.7.4: vanished file → re-run the Planner for that fileId.
            await this.dropOp(op, "missing");
            return;
          }
          throw err;
        }
      }
      prep = await this.d.blobs.prepare(bytes);
      const stage = prep.inline || this.d.needsBase(op.path, prep.size);
      const ok = await this.d.state.tx(["journal", "staging"], async (tx) => {
        const cur = await tx.journal.get(op.opSeq);
        if (!cur || cur.state !== "queued" || !sameIntent(cur, op)) return false;
        await tx.journal.put({
          ...cur, state: "blobs", contentHash: prep.hash, size: prep.size, mtime, ctime,
          chunkSizes: prep.chunkSizes, blobs: prep.blobs, inline: prep.inline,
        });
        if (stage && op.source !== "staging") await tx.staging.put({ opSeq: op.opSeq, bytes });
        else if (!stage && op.source !== "staging") await tx.staging.delete(op.opSeq);
        return true;
      });
      if (!ok) return;
    } finally {
      unlock();
    }
    s.prepared++;
    await this.crash("op:blobs");
    try {
      s.uploaded += await this.d.blobs.upload(prep);
    } catch (err) {
      if (!isRemoteError(err) || !err.retryable) throw err;
      await this.backoffOps([op.opSeq], String(err.message), "queued");
      return;
    }
    await this.crash("op:uploaded");
    await this.d.state.tx(["journal"], async (tx) => {
      const cur = await tx.journal.get(op.opSeq);
      if (cur && cur.state === "blobs" && cur.contentHash === prep.hash) await tx.journal.put({ ...cur, state: "ready" });
    });
  }

  /** Remove a non-frozen op and send its file back to the Planner. */
  private async dropOp(op: Op, why: DirtyReason): Promise<void> {
    await this.d.state.tx(["journal", "staging"], async (tx) => {
      const cur = await tx.journal.get(op.opSeq);
      if (!cur || cur.state === "sent") return;
      await tx.journal.delete(op.opSeq);
      await tx.staging.delete(op.opSeq);
    });
    if (op.kind !== "archive") this.d.journal.unmirror(op.fileId);
    const e = this.d.index.byFileId(op.fileId);
    this.d.markDirty({ fileId: op.fileId, path: e?.path ?? op.path }, why);
  }

  private async backoffOps(opSeqs: readonly number[], err: string, resetTo?: Op["state"]): Promise<void> {
    const now = this.d.now();
    await this.d.state.tx(["journal"], async (tx) => {
      for (const n of opSeqs) {
        const cur = await tx.journal.get(n);
        if (!cur) continue;
        const attempts = cur.attempts + 1;
        await tx.journal.put({
          ...cur, attempts, lastError: err, nextAttemptAt: now + backoffDelay(attempts, this.d.random),
          ...(resetTo !== undefined ? { state: resetTo } : {}),
        });
      }
    });
  }

  // ---------- freeze ----------

  /** Pack ready ops into the next batch and persist it as sent (design §3.7.2, XS-24). */
  private async freezeNext(): Promise<{ batch: Batch; sealed: Sealed } | null> {
    const ring = this.ring();
    if (this.refusedKv !== null) {
      if (this.refusedKv === ring.activeKv) return null;
      this.refusedKv = null;
    }
    const now = this.d.now();
    const { ready, staged } = await this.d.state.tx(["journal", "staging"], async (tx) => {
      const r = (await tx.journal.getAll({ index: "state", only: "ready" }))
        .filter((o) => o.batchId === undefined && o.nextAttemptAt <= now)
        .sort((a, b) => a.opSeq - b.opSeq);
      const st = new Map<number, Uint8Array>();
      for (const o of r) {
        if (o.inline) {
          const row = await tx.staging.get(o.opSeq);
          if (row) st.set(o.opSeq, row.bytes);
        }
      }
      return { ready: r, staged: st };
    }, "readonly");
    if (ready.length === 0) return null;
    const lim = this.d.remote.capabilities.limits;
    const maxOps = Math.max(1, Math.min(lim.maxCommitOps, this.d.batchMaxOps, this.opsCap));
    const maxBytes = Math.max(1024, lim.maxCommitBytes - COMMIT_BYTES_RESERVE);
    const groups = this.atomicGroups(ready);
    // First group decides the batch shape: an atomic group (swap / chain) goes alone.
    const first = groups[0] as Op[];
    let pick: Op[];
    let atomic = false;
    if (first.length > 1 && this.d.remote.capabilities.atomicCommit) {
      pick = first.slice(0, maxOps);
      atomic = pick.length > 1;
    } else {
      pick = [];
      let bytes = 0;
      for (const g of groups) {
        if (g.length > 1 && this.d.remote.capabilities.atomicCommit) continue;
        for (const o of g) {
          const est = estimateOpBytes(o);
          if (pick.length > 0 && (pick.length >= maxOps || bytes + est > maxBytes)) break;
          pick.push(o);
          bytes += est;
        }
        if (pick.length >= maxOps || bytes >= maxBytes) break;
      }
      if (pick.length === 0) pick = [first[0] as Op];
    }
    for (const o of pick) {
      if (o.inline && !staged.has(o.opSeq)) {
        // Inline body lost (should not happen): rebuild the content from scratch.
        await this.d.state.tx(["journal"], async (tx) => {
          const cur = await tx.journal.get(o.opSeq);
          if (cur && cur.state === "ready") await tx.journal.put({ ...cur, state: "queued" });
        });
        return this.freezeNext();
      }
    }
    const batch: Batch = {
      batchId: uuidV4(), opSeqs: pick.map((o) => o.opSeq), atomic, opsDigest: "", kv: ring.activeKv, state: "sent", createdAt: now,
    };
    const sealed = await this.seal(batch, pick, staged);
    batch.opsDigest = await opsDigest(sealed.req.ops);
    const ok = await this.d.state.tx(["journal", "batches"], async (tx) => {
      const cur: Op[] = [];
      for (const o of pick) {
        const c = await tx.journal.get(o.opSeq);
        if (!c || c.state !== "ready" || c.batchId !== undefined || !sameContent(c, o)) return false;
        cur.push(c);
      }
      await tx.batches.put(batch);
      for (const c of cur) await tx.journal.put({ ...c, state: "sent", batchId: batch.batchId });
      return true;
    });
    if (!ok) return this.freezeNext();
    await this.crash("op:frozen");
    return { batch, sealed };
  }

  /**
   * Swaps and rename chains (design §3.7.2, §3.9): ops whose target path is the current remote path
   * of another ready op's file go into one atomic batch, so pathKey uniqueness is checked on the
   * final state.
   */
  private atomicGroups(ready: readonly Op[]): Op[][] {
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) as number;
      parent.set(x, r);
      return r;
    };
    for (const o of ready) parent.set(o.opSeq, o.opSeq);
    const byRemoteFold = new Map<string, Op>();
    for (const o of ready) {
      const h = this.d.index.remote.byFileId(o.fileId);
      if (h && !h.deleted && foldKey(h.path) !== foldKey(o.path)) byRemoteFold.set(foldKey(h.path), o);
    }
    for (const o of ready) {
      if (o.kind === "archive") continue;
      const other = byRemoteFold.get(foldKey(o.path));
      if (other && other.opSeq !== o.opSeq && other.kind !== "archive") parent.set(find(o.opSeq), find(other.opSeq));
    }
    const groups = new Map<number, Op[]>();
    for (const o of ready) {
      const r = find(o.opSeq);
      const g = groups.get(r) ?? [];
      g.push(o);
      groups.set(r, g);
    }
    return [...groups.values()].sort((a, b) => (a[0] as Op).opSeq - (b[0] as Op).opSeq);
  }

  /** Build the commit request for a batch from its ops (identical headers on every call). */
  private async seal(batch: Batch, ops: readonly Op[], staged: ReadonlyMap<number, Uint8Array>): Promise<Sealed> {
    const ring = this.ring();
    const out: CommitOp[] = [];
    const pathKeys: string[] = [];
    for (const op of ops) {
      const pathKey = await ring.pathKey(op.path);
      pathKeys.push(pathKey);
      const rc = this.d.rcOf(op.path);
      const cat = this.d.categoryOf?.(op.path) ?? null;
      if (op.kind === "delete") {
        if (op.base === null) throw new Error(`delete op ${op.opSeq} without base`);
        const h = { fileId: op.fileId, kv: batch.kv, kind: "del" as const, base: op.base, rc, blobs: [], pathKey };
        out.push({ op: "del", fileId: op.fileId, base: op.base, pathKey, rc, kv: batch.kv, meta: await ring.sealMeta({ ...tombstoneMeta(op.path, cat) }, h) });
        continue;
      }
      const kind = op.kind === "archive" ? "archive" as const : "put" as const;
      const blobs = op.inline ? [] : [...(op.blobs ?? [])];
      const h = { fileId: op.fileId, kv: batch.kv, kind, base: op.base, rc, blobs, pathKey };
      let inline: string | null = null;
      let z = false;
      let p = false;
      if (op.inline) {
        const body = staged.get(op.opSeq);
        if (!body) throw new Error(`inline op ${op.opSeq} has no staged body`);
        const r = await ring.sealInline(body, h, this.inlineOpts());
        inline = r.ct;
        z = r.z;
        p = r.p;
      }
      const meta = await ring.sealMeta({
        ...putMeta({
          path: op.path, size: op.size ?? 0, mtime: op.mtime ?? 0, ctime: op.ctime ?? op.mtime ?? 0, hash: op.contentHash ?? "",
          chunkSizes: op.chunkSizes ?? [], inline: op.inline === true, z, p, cat,
        }),
      }, h);
      if (kind === "archive") {
        if (op.base === null) throw new Error(`archive op ${op.opSeq} without base`);
        out.push({ op: "archive", fileId: op.fileId, base: op.base, pathKey, rc, kv: batch.kv, meta, blobs, ...(inline !== null ? { inline } : {}) });
      } else {
        out.push({ op: "put", fileId: op.fileId, base: op.base, pathKey, rc, kv: batch.kv, meta, blobs, ...(inline !== null ? { inline } : {}) });
      }
    }
    const req: CommitRequest = { cid: batch.batchId, ops: out };
    if (batch.atomic) req.atomic = true;
    return { req, pathKeys };
  }

  private inlineOpts(): { compress: boolean; pad: boolean } {
    const p = this.d.blobs.params();
    return { compress: p.compression !== "none", pad: p.padding === "padme" };
  }

  /** Rebuild the request of a sent batch (resend after restart or network error). */
  private async rebuild(batch: Batch): Promise<{ sealed: Sealed; ops: Op[] } | null> {
    const loaded = await this.d.state.tx(["journal", "staging"], async (tx) => {
      const ops: Op[] = [];
      const st = new Map<number, Uint8Array>();
      for (const n of batch.opSeqs) {
        const o = await tx.journal.get(n);
        if (!o || o.batchId !== batch.batchId) return null;
        ops.push(o);
        if (o.inline) {
          const row = await tx.staging.get(n);
          if (!row) return null;
          st.set(n, row.bytes);
        }
      }
      return { ops, st };
    }, "readonly");
    if (!loaded) return null;
    const sealed = await this.seal(batch, loaded.ops, loaded.st);
    if ((await opsDigest(sealed.req.ops)) !== batch.opsDigest) throw new Error(`batch ${batch.batchId}: op headers changed after freeze`);
    return { sealed, ops: loaded.ops };
  }

  // ---------- send ----------

  private async send(batch: Batch, sealed: Sealed | null, s: RunStats): Promise<void> {
    let sl = sealed;
    if (!sl) {
      const r = await this.rebuild(batch);
      if (!r) {
        await this.abandonBatch(batch);
        return;
      }
      sl = r.sealed;
    }
    for (let round = 0; ; round++) {
      let resp: CommitResponse;
      try {
        s.sent++;
        resp = await this.d.remote.commit(sl.req);
      } catch (err) {
        await this.commitFailed(batch, err);
        return;
      }
      await this.crash("op:response");
      const missing = resp.results.filter((r): r is Extract<OpResult, { code: 'MISSING_BLOB' }> => !r.ok && r.code === "MISSING_BLOB");
      if (missing.length > 0 && round < MISSING_BLOB_ROUNDS) {
        const fixed = await this.repairMissing(batch, missing);
        if (fixed) continue;      // resend the SAME batch (same cid): the server re-evaluates those ops
      }
      await this.d.state.tx(["batches"], async (tx) => {
        const cur = await tx.batches.get(batch.batchId);
        if (cur && cur.state === "sent") await tx.batches.put({ ...cur, state: "resolved", result: resp });
      });
      await this.crash("op:resolved");
      await this.processResults({ ...batch, state: "resolved", result: resp }, resp, s);
      return;
    }
  }

  /** Upload missing blobs again from the op's source; false if the content no longer matches. */
  private async repairMissing(batch: Batch, missing: ReadonlyArray<Extract<OpResult, { code: 'MISSING_BLOB' }>>): Promise<boolean> {
    for (const r of missing) {
      const opSeq = batch.opSeqs[r.i];
      if (opSeq === undefined) return false;
      const op = await this.d.state.tx(["journal"], (tx) => tx.journal.get(opSeq), "readonly");
      if (!op) return false;
      let bytes: Uint8Array | null = null;
      if (op.source === "staging") bytes = (await this.d.state.tx(["staging"], (tx) => tx.staging.get(opSeq), "readonly"))?.bytes ?? null;
      else {
        try { bytes = await this.d.fs.read(op.path); } catch { bytes = null; }
      }
      if (!bytes) return false;
      const prep = await this.d.blobs.prepare(bytes);
      if (prep.hash !== op.contentHash || prep.blobs.join(",") !== (op.blobs ?? []).join(",")) return false;
      try {
        await this.d.blobs.upload(prep, new Set(r.missing));
      } catch (err) {
        if (isRemoteError(err) && err.retryable) return false;
        throw err;
      }
    }
    return true;
  }

  private async commitFailed(batch: Batch, err: unknown): Promise<void> {
    if (!isRemoteError(err)) throw err;
    switch (err.code) {
      case "UNAUTHENTICATED": case "REVOKED": case "FORBIDDEN":
        this.d.log?.({ key: "log.authFailed", cat: "error", params: { reason: err.code } });
        throw new AuthError(err.message);
      case "SNAPSHOT_REQUIRED":
        this.d.onSnapshotRequired?.();
        await this.backoffOps(batch.opSeqs, err.message);
        return;
      case "TOO_LARGE":
        // Rejected before anything was written: unfreeze and re-pack smaller (new cid).
        if (batch.opSeqs.length > 1) {
          this.opsCap = Math.max(1, Math.floor(batch.opSeqs.length / 2));
          await this.abandonBatch(batch, "ready");
        } else {
          await this.abandonBatch(batch, "failed", err.message);
        }
        return;
      default:
        if (err.retryable) {
          this.d.log?.({ key: "log.networkRetry", cat: "network", params: { code: err.code } });
          await this.backoffOps(batch.opSeqs, err.message);
          return;
        }
        throw err;
    }
  }

  /** Drop a batch that was never accepted; its ops go back to `to` (new cid on the next freeze). */
  private async abandonBatch(batch: Batch, to: Op["state"] = "queued", error?: string): Promise<void> {
    await this.d.state.tx(["journal", "batches"], async (tx) => {
      for (const o of await tx.journal.getAll({ index: "batchId", only: batch.batchId })) {
        const { batchId: _b, ...rest } = o;
        await tx.journal.put({ ...rest, state: to, ...(error !== undefined ? { lastError: error } : {}) });
      }
      await tx.batches.delete(batch.batchId);
    });
  }

  // ---------- results ----------

  private async processResults(batch: Batch, resp: CommitResponse, s: RunStats): Promise<void> {
    let keyVersion = false;
    for (let i = 0; i < batch.opSeqs.length; i++) {
      const opSeq = batch.opSeqs[i] as number;
      const r = resp.results.find((x) => x.i === i);
      const op = await this.d.state.tx(["journal"], (tx) => tx.journal.get(opSeq), "readonly");
      if (!op || op.batchId !== batch.batchId) continue;     // already handled (resume)
      if (!r) {
        await this.requeue(batch, op, "queued");
        s.requeued++;
        continue;
      }
      if (r.ok) {
        await this.ackOp(batch, op, r.seqs[r.seqs.length - 1] as Seq);
        s.acked++;
      } else if (r.code === "CONFLICT" || r.code === "PATH_TAKEN") {
        await this.conflictOp(batch, op, r.code, r.current);
        s.conflicts++;
      } else if (r.code === "KEY_VERSION" || r.code === "ABORTED") {
        // design §3.7.4: re-seal into a NEW batch (new cid); the old cached result is final.
        if (r.code === "KEY_VERSION") keyVersion = true;
        await this.requeue(batch, op, "ready");
        s.requeued++;
      } else if (r.code === "MISSING_BLOB") {
        // Repair failed (content changed or still missing): this op is abandoned; re-plan the file.
        if (await this.finishOp(batch, op, null)) this.d.journal.unmirror(op.fileId);
        this.redirty(op, "retry");
        s.requeued++;
      } else {
        await this.failOp(batch, op, `${r.code}${"message" in r && r.message ? ": " + r.message : ""}`);
        s.failed++;
      }
      await this.crash("op:handled");
    }
    if (keyVersion) {
      this.refusedKv = batch.kv;
      this.d.onKeyVersion?.();
    }
  }

  private redirty(op: Op, why: DirtyReason): void {
    if (op.kind !== "archive") this.d.journal.unmirror(op.fileId);
    const e = this.d.index.byFileId(op.fileId);
    this.d.markDirty({ fileId: op.fileId, path: e?.path ?? op.path }, why);
  }

  /** Remove `op` from its batch in one transaction (optionally with more writes); drop the batch when empty. */
  private async finishOp(batch: Batch, op: Op, more: ((w: IndexWriter, tx: StateTx) => Promise<void>) | null): Promise<boolean> {
    const e = this.d.index.byFileId(op.fileId);
    const unlock = await this.d.locks.acquire(...lockKeys(op.fileId, op.path, e?.path));
    try {
      return await this.d.index.write(["journal", "staging", "batches", "applyQueue"], async (w) => {
        const tx = w.tx;
        const cur = await tx.journal.get(op.opSeq);
        if (!cur || cur.batchId !== batch.batchId) return false;
        if (more) await more(w, tx);
        await tx.journal.delete(op.opSeq);
        await tx.staging.delete(op.opSeq);
        await dropBatchIfEmpty(tx, batch.batchId);
        return true;
      });
    } finally {
      unlock();
    }
  }

  private async requeue(batch: Batch, op: Op, to: Op["state"]): Promise<void> {
    await this.d.state.tx(["journal", "batches"], async (tx) => {
      const cur = await tx.journal.get(op.opSeq);
      if (!cur || cur.batchId !== batch.batchId) return;
      const { batchId: _b, ...rest } = cur;
      await tx.journal.put({ ...rest, state: to });
      await dropBatchIfEmpty(tx, batch.batchId);
    });
  }

  private async failOp(batch: Batch, op: Op, error: string): Promise<void> {
    if (op.kind === "archive") {
      // X5: archiving failed → the local bytes must survive as a conflict copy.
      const row = await this.d.state.tx(["staging"], (tx) => tx.staging.get(op.opSeq), "readonly");
      if (row && this.d.onArchiveFailed) await this.d.onArchiveFailed(op, row.bytes);
      if (row && !this.d.onArchiveFailed) {
        // Without a fallback handler the staged bytes stay in the journal as a failed op (never lost).
        await this.markFailed(batch, op, error);
        return;
      }
      await this.finishOp(batch, op, null);
      return;
    }
    this.d.log?.({ key: "log.pushFailed", cat: "error", params: { error }, path: op.path, fileId: op.fileId });
    await this.markFailed(batch, op, error);
  }

  private async markFailed(batch: Batch, op: Op, error: string): Promise<void> {
    await this.d.state.tx(["journal", "batches"], async (tx) => {
      const cur = await tx.journal.get(op.opSeq);
      if (!cur || cur.batchId !== batch.batchId) return;
      const { batchId: _b, ...rest } = cur;
      await tx.journal.put({ ...rest, state: "failed", lastError: error });
      await dropBatchIfEmpty(tx, batch.batchId);
    });
  }

  /**
   * design §3.7.3 ack transaction: synced (subject to §3.6.3), base from staging, remote head from the
   * op + seq (max seq kept), op and staging deleted, batch deleted with its last op.
   */
  private async ackOp(batch: Batch, op: Op, seq: Seq): Promise<void> {
    const ring = this.ring();
    const pathKey = await ring.pathKey(op.path);
    let newerRemote = false;
    let freedPath: string | null = null;
    const done = await this.finishOp(batch, op, async (w, tx) => {
      const head = this.headFromOp(op, batch, seq, pathKey);
      if (op.kind === "archive") return;
      const e = w.entry(op.fileId);
      if (op.kind === "delete") {
        if (e) {
          await w.deleteEntry(op.fileId);
          freedPath = e.path;
        }
        await w.upsertRemote(head);
        return;
      }
      const stored = await w.upsertRemote(head);
      const cur = w.remote(op.fileId);
      newerRemote = !stored && cur !== null && cur.seq > seq;
      if (e) {
        const hasBase = this.d.needsBase(op.path, op.size ?? 0);
        await w.putEntry({
          ...e,
          synced: { version: seq, path: op.path, hash: op.contentHash ?? "", size: op.size ?? 0, mtime: op.mtime ?? 0, hasBase },
          updatedAt: this.d.now(),
        });
        const row = hasBase ? await tx.staging.get(op.opSeq) : undefined;
        if (row) await tx.bases.put({ fileId: op.fileId, version: seq, hash: op.contentHash ?? "", bytes: row.bytes });
        else await tx.bases.delete(op.fileId);
      }
    });
    if (!done) return;
    if (op.kind !== "archive") this.d.journal.unmirror(op.fileId);
    await this.crash("op:acked");
    if (op.kind !== "archive") {
      // A change that arrived while the op was frozen, or a newer remote head (§3.6.3): re-plan.
      // Unchanged files resolve to S1 on the fast path, so this is cheap.
      this.d.journal.takeWaiting(op.fileId);
      if (freedPath !== null) this.d.markDirty({ path: freedPath }, "redirty");
      else this.redirty(op, newerRemote ? "remote" : "redirty");
    }
    this.d.onAcked?.(op, seq);
  }

  private headFromOp(op: Op, batch: Batch, seq: Seq, pathKey: string): RemoteHead {
    const del = op.kind === "delete";
    const h: RemoteHead = {
      fileId: op.fileId, seq, base: op.base, pathKey, path: op.path, deleted: del,
      size: del ? 0 : op.size ?? 0, mtime: del ? 0 : op.mtime ?? 0, contentHash: del ? null : op.contentHash ?? null,
      chunkSizes: del || op.inline ? [] : [...(op.chunkSizes ?? [])], blobs: del || op.inline ? [] : [...(op.blobs ?? [])],
      kv: batch.kv, deviceId: this.d.deviceId(), cid: batch.batchId, ts: this.d.now(), rc: this.d.rcOf(op.path),
    };
    if (!del && op.ctime !== undefined) h.ctime = op.ctime;
    return h;
  }

  /** CONFLICT / PATH_TAKEN: op removed, the current head mirrored, the file re-planned (design §3.7.2). */
  private async conflictOp(batch: Batch, op: Op, code: 'CONFLICT' | 'PATH_TAKEN', current: VersionRecord | null): Promise<void> {
    let head: RemoteHead | null = null;
    const ring = this.d.keyring();
    if (current && ring) {
      try {
        head = (await decodeRecord(ring, current)).head;
      } catch {
        head = null;   // a bad record arrives through ingest and is quarantined there
      }
    }
    // A delete whose head is already a tombstone is done (design §2.5 "the engine treats it as done").
    const deleteDone = op.kind === "delete" && code === "CONFLICT" && current?.kind === "del" && head !== null;
    let freedPath: string | null = null;
    const done = await this.finishOp(batch, op, async (w, tx) => {
      // A head learned from the result is mirrored AND queued for apply, exactly like ingest: when the
      // feed later delivers the same record it is "already known" and would not be queued again.
      if (head && (head.fileId === op.fileId || code === "PATH_TAKEN") && (await w.upsertRemote(head))) {
        await tx.applyQueue.put({ fileId: head.fileId, seq: head.seq, enqueuedAt: this.d.now(), attempts: 0 });
      }
      if (deleteDone) {
        const e = w.entry(op.fileId);
        if (e) {
          freedPath = e.path;
          await w.deleteEntry(op.fileId);
        }
      }
    });
    if (!done) return;
    this.d.journal.unmirror(op.fileId);
    await this.crash("op:conflict");
    this.d.journal.takeWaiting(op.fileId);
    if (deleteDone) {
      if (freedPath !== null) this.d.markDirty({ path: freedPath }, "redirty");
      this.d.onAcked?.(op, current?.seq ?? 0);
      return;
    }
    if (code === "CONFLICT") this.d.onConflict?.(op.fileId);
    const e = this.d.index.byFileId(op.fileId);
    const key: DirtyKey = { fileId: op.fileId, path: e?.path ?? op.path };
    if (code === "PATH_TAKEN" && head) key.pathTaken = head;
    this.d.markDirty(key, code === "PATH_TAKEN" ? "pathTaken" : "conflict");
    this.d.log?.({ key: code === "PATH_TAKEN" ? "log.pathTaken" : "log.commitConflict", cat: "merge", path: op.path, fileId: op.fileId });
  }
}

function sameIntent(a: Op, b: Op): boolean {
  return a.kind === b.kind && a.path === b.path && a.base === b.base && a.source === b.source && a.fileId === b.fileId;
}

function sameContent(a: Op, b: Op): boolean {
  return sameIntent(a, b) && a.contentHash === b.contentHash && a.size === b.size && a.inline === b.inline;
}

async function dropBatchIfEmpty(tx: StateTx, batchId: string): Promise<void> {
  const left = await tx.journal.count({ index: "batchId", only: batchId });
  if (left === 0) await tx.batches.delete(batchId);
}

/** b64u SHA-256 of the canonical op headers (design §2.8.3). */
export async function opsDigest(ops: readonly CommitOp[]): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", utf8Encode(opsDigestPreimage(ops)));
  return b64u(new Uint8Array(d));
}

/** Encoded size estimate of one op (meta bucket + inline body + header), design §3.7.2. */
export function estimateOpBytes(op: Op): number {
  const meta = Math.ceil((512 + 34) * 4 / 3);
  const inline = op.inline ? Math.ceil(((op.size ?? 0) + 64) * 4 / 3) : 0;
  const blobs = (op.blobs?.length ?? 0) * 68;
  return 256 + meta + inline + blobs;
}

