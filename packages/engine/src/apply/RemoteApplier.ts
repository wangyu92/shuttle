// RemoteApplier: the apply queue → local disk (design §3.8.2-§3.8.5, §3.9; engine-spec §5).
//
// applyOne(fileId) with write intents (S9, S11, S20, S21):
//  - scope / illegal name / integrity hold gates (never a download for a filtered path, I13);
//  - hand the file to the Planner whenever a local file exists that is not provably the base
//    (unless the Planner itself asked for this apply: `planned`);
//  - never write over a path held by another entry or by a foreign local file;
//  - download (verified), persist the intent, write, rename, then ONE apply transaction marks the file
//    synced (the only place a pull does, I1). The cursor was advanced by ingest only after the head and
//    the apply-queue row were durable (I2, invariant 9).
// Crash points: before the write → retried; after the write → contentOk, only the transaction runs;
// after the rename → locate() finds the file at the target path.
//
// Locks: the same keys as the Reconciler (`id:<fileId>`, `fk:<foldKey>`). drain() takes them;
// applyLocked() is for callers that already hold them (the Planner's PULL, torn-write reapply).

import type {
  EngineHooks, FileEntry, FileId, FileKind, LocalFs, LocalStat, RemoteHead, RemoveMode, RetentionClass, Scope, StateStore,
  WriteIntent,
} from "@shuttle/protocol";
import type { BlobPipeline } from "../content/BlobPipeline";
import { readAndHash, sha256Hex } from "../content/hash";
import { IntegrityError } from "../errors";
import type { EchoSuppressor } from "../events/EchoSuppressor";
import type { FileIndex } from "../index/FileIndex";
import { Journal, isStagedPut } from "../journal/Journal";
import { ILLEGAL_NAME_LOG } from "../path/illegal";
import { dirname, foldKey } from "../path/normalize";
import { hasFsCode } from "../platform/LocalFs";
import { fastPathMatch } from "../reconcile/fastPath";
import type { ScopeFn } from "../reconcile/scope";
import { crashPoint } from "../testing/crashPoint";
import type { DirtyKey, DirtyReason } from "../types";
import { toHex, utf8DecodeStrict } from "../util/bytes";
import type { KeyedMutex } from "../util/KeyedMutex";
import { cryptoRandomBytes, type RandomBytes } from "../util/uuid";
import { replaceFile } from "./replaceFile";
import { orderApplies, swapPath, type OrderItem } from "./BatchOrderer";
import { isStrictPrefix, type WriteIntents } from "./WriteIntents";

/** design §3.8.3: more pending local deletes than max(25, 10 % of active files) pause and ask. */
export const MASS_DELETE_MIN = 25;
export const MASS_DELETE_FRACTION = 0.1;
/** Attempts after which a blocked apply is logged as stuck (it stays queued). */
export const APPLY_STUCK_ATTEMPTS = 5;
/** S20: processText retries before falling back to an atomic write. */
export const PROCESS_TEXT_RETRIES = 3;
/** D5: re-applies of one torn write before the file is held with an integrity error (never loops). */
export const TORN_REAPPLY_MAX = 3;

export interface ApplierLog { key: string; cat: 'general' | 'error' | 'skipped' | 'merge' | 'network'; params?: Record<string, string | number | boolean | null>; path?: string; fileId?: FileId }

export interface RemoteApplierDeps {
  fs: LocalFs;
  state: StateStore;
  index: FileIndex;
  journal: Journal;
  blobs: BlobPipeline;
  intents: WriteIntents;
  locks: KeyedMutex;
  echo: EchoSuppressor;
  now(): number;
  hooks?: EngineHooks;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  scopeOf: ScopeFn;
  kindOf(path: string): FileKind;
  rcOf(path: string): RetentionClass;
  /** Legal on this platform's filesystem (path/illegal.ts with the platform's NameRules). */
  isLegal(path: string): boolean;
  needsBase(path: string, size: number): boolean;
  maxFileBytes(): number;
  deleteMode(): RemoveMode;
  /** Roots never removed when emptied: configDir, excluded folders (design §3.9). */
  keepFolder?(path: string): boolean;
  /** processText applies (notes open in an editor, design §3.8.4). */
  isText?(path: string): boolean;
  editorHasOpen?(path: string): boolean;
  /** design §3.8.3 guard. Absent: deletes above the threshold are held (never applied silently). */
  confirmMassDelete?(count: number, active: number): boolean | Promise<boolean>;
  /** The sender's user already approved this tombstone through its own mass-delete guard (§3.13). */
  deleteApproved?(fileId: FileId, seq: number): boolean;
  noteApplied?(path: string): void;
  /**
   * D5: an older remote version of `fileId` whose content hash is `hash` (the target of an interrupted
   * pull after the head moved on), or null when it is not retained. Absent: such writes count as edits.
   */
  targetHead?(fileId: FileId, hash: string): Promise<RemoteHead | null>;
  log?(e: ApplierLog): void;
  randomBytes?: RandomBytes;
  /** Applies of distinct files in flight at once (budget `applyConcurrency`, design §3.15). Default 1. */
  applyConcurrency?(): number;
}

export type ApplyOutcome =
  | 'applied' | 'deleted' | 'noop' | 'gone'
  | 'handoff'     // sent to the Planner (local change, occupant, remote behind)
  | 'blocked'     // target path held; stays queued
  | 'busy'        // frozen op in flight; stays queued until the ack
  | 'scope' | 'illegal' | 'hold' | 'oversize' | 'integrity'
  | 'retry';      // network error; stays queued

export interface ApplyOpts {
  /** The Planner chose this apply (PULL rows): skip the hand-to-Planner check, overwrite local content. */
  planned?: boolean;
  /** Apply into this path instead of R.path (row C8: pull content into the local new path). */
  targetPath?: string;
  /** A never-synced local entry to drop in the apply transaction (PULL.forget, ADOPT-like replaces). */
  replaces?: FileId;
  /** The engine itself moved the file (swap cycle): only content counts as a local change. */
  movedByUs?: boolean;
  /** Torn engine write at this path (design §3.8.4): rewrite R over it. */
  torn?: string;
}

export interface DrainStats { applied: number; deleted: number; handoff: number; blocked: number; held: number; other: number }

interface Observed { L: { path: string; hash: string; size: number; mtime: number; ino?: number; ctimeMs?: number }; st: LocalStat; bytes?: Uint8Array }

export class RemoteApplier {
  /** D5: torn re-applies per fileId in this session. */
  private readonly tornAttempts = new Map<FileId, number>();
  /**
   * Torn writes whose target bytes were found only in an archive record (a staged merge archived after a
   * CONFLICT, Journal I6): reapplyTorn restores those bytes, not the remote head (keyed by path).
   */
  private readonly tornArchived = new Map<string, Uint8Array>();

  constructor(private readonly d: RemoteApplierDeps) {}

  private crash(name: string): Promise<void> {
    return crashPoint(this.d.hooks, name);
  }

  /** Drain the apply queue once (design §3.8.2 ordering, §3.8.3 guard). */
  async drain(): Promise<DrainStats> {
    const s: DrainStats = { applied: 0, deleted: 0, handoff: 0, blocked: 0, held: 0, other: 0 };
    const rows = await this.d.state.tx(["applyQueue"], (tx) => tx.applyQueue.getAll(), "readonly");
    if (rows.length === 0) return s;
    const items: OrderItem[] = [];
    for (const r of rows) {
      const R = this.d.index.remote.byFileId(r.fileId);
      if (!R) {
        await this.removeQueue(r.fileId, Infinity);
        continue;
      }
      const e = this.d.index.byFileId(r.fileId);
      items.push({ fileId: r.fileId, R, localPath: e?.path ?? null });
    }
    // design §3.8.3 mass-delete guard on pull.
    // Deletes the sending device's user approved through its own guard do not ask again (one answer
    // per burst, design §3.13); any other burst above the threshold still pauses here.
    const deletes = items.filter((i) => i.R.deleted && i.localPath !== null && this.d.index.byFileId(i.fileId)?.obs &&
      !this.d.deleteApproved?.(i.fileId, i.R.seq));
    const threshold = Math.max(MASS_DELETE_MIN, Math.floor(this.d.index.activeCount() * MASS_DELETE_FRACTION));
    let holdDeletes = false;
    if (deletes.length > threshold) {
      const ok = this.d.confirmMassDelete ? await this.d.confirmMassDelete(deletes.length, this.d.index.activeCount()) : false;
      if (!ok) {
        holdDeletes = true;
        this.d.log?.({ key: "log.massDeleteRemotePaused", cat: "general", params: { count: deletes.length } });
      }
    }
    const ready = holdDeletes ? items.filter((i) => !(i.R.deleted && i.localPath !== null && !this.d.deleteApproved?.(i.fileId, i.R.seq))) : items;
    if (holdDeletes) s.held += items.length - ready.length;
    const { order, cycles } = orderApplies(ready, this.d.fs.configDir);
    for (const c of cycles) for (const out of await this.applyCycle(c)) count(s, out);
    const width = Math.max(1, Math.floor(this.d.applyConcurrency?.() ?? 1));
    if (width === 1) for (const id of order) count(s, await this.applyOne(id));
    else await this.applyWindow(order, width, (out) => count(s, out));
    return s;
  }

  /**
   * Bounded concurrent applies (budget `applyConcurrency`, part 5; 클로드 제안(미승인)). Ingest already
   * persisted the cursor together with the heads and queue rows (design §3.8.1, invariant 9), so the
   * order of applies never moves the cursor; what must hold is the BatchOrderer's order (§3.8.2:
   * path-freeing effects before path-needing ones). Items are started in that order and never
   * overtake: an item waits while it shares a lock key (fileId, foldKey of a path) with one in flight,
   * and deletes and moves (they free paths and remove emptied parent folders, which would race a
   * concurrent mkdir + write in that folder) run alone after everything before them finished.
   */
  private async applyWindow(order: readonly FileId[], width: number, done: (o: ApplyOutcome) => void): Promise<void> {
    const flying = new Map<Promise<void>, ReadonlySet<string>>();
    let failure: { err: unknown } | null = null;
    const settleOne = () => Promise.race(flying.keys());
    const drainAll = async () => { while (flying.size > 0) await settleOne(); };
    for (const id of order) {
      if (failure) break;
      const R = this.d.index.remote.byFileId(id);
      const e = this.d.index.byFileId(id);
      const alone = !R || R.deleted || (e !== null && e.path !== R.path);
      const keys = new Set(this.lockKeys(id, R, e));
      if (alone) {
        await drainAll();
        if (failure) break;
        done(await this.applyOne(id));
        continue;
      }
      const clashes = () => [...flying.values()].some((ks) => [...keys].some((k) => ks.has(k)));
      while (flying.size >= width || (flying.size > 0 && clashes())) await settleOne();
      if (failure) break;
      const p: Promise<void> = this.applyOne(id).then(done, (err: unknown) => { failure ??= { err }; })
        .finally(() => { flying.delete(p); });
      flying.set(p, keys);
    }
    await drainAll();
    if (failure) throw (failure as { err: unknown }).err;
  }

  /** applyOne with locks (design §3.8.4). */
  async applyOne(fileId: FileId, opts: ApplyOpts = {}): Promise<ApplyOutcome> {
    const R = this.d.index.remote.byFileId(fileId);
    const e = this.d.index.byFileId(fileId);
    const unlock = await this.d.locks.acquire(...this.lockKeys(fileId, R, e, opts.targetPath));
    try {
      return await this.applyLocked(fileId, opts);
    } finally {
      unlock();
    }
  }

  lockKeys(fileId: FileId, R: RemoteHead | null, e: FileEntry | null, target?: string): string[] {
    const keys = [`id:${fileId}`];
    for (const p of [R?.path, e?.path, target]) if (p !== undefined) keys.push(`fk:${foldKey(p)}`);
    return keys;
  }

  /**
   * Foreign content at `path` under a pull intent (design §3.8.4 `applier.reapply`, lead decision D5).
   * Caller holds the locks. A merge write is restored from staging (D1). Otherwise the content is torn
   * only when it is a strict prefix of the target bytes: then R is rewritten over it (I30), at most
   * TORN_REAPPLY_MAX times per file before an integrity error holds the file. Any other content is the
   * user's edit against the base preHash: the intent is dropped and the Planner treats it as a local
   * change (merge or conflict copy), never overwritten with the remote head (I6).
   */
  async reapply(path: string): Promise<ApplyOutcome> {
    // D1: an interrupted merge write is re-applied from its staged bytes, never from the remote head.
    const m = await this.recoverMerge(path);
    if (m !== null) return m;
    const ic = await this.d.intents.check(path);
    const i = ic.intent;
    if (!i) return "noop";
    if (ic.c !== "foreign") {
      // Not foreign (any more): the normal apply decides; a stale intent never blocks it.
      return this.applyLocked(i.fileId);
    }
    const cls = await this.classifyForeign(path, i);
    if (cls === "retry") {
      this.d.markDirty({ path }, "retry");
      return "retry";
    }
    if (cls === "edit") {
      await this.userEditOverIntent(path, i.fileId);
      return "handoff";
    }
    return this.reapplyTorn(path, i.fileId);
  }

  /** reapply() with the locks taken here (startup list of foreign files, design §3.8.4). */
  async reapplyAt(path: string, fileId: FileId): Promise<ApplyOutcome> {
    const R = this.d.index.remote.byFileId(fileId);
    const e = this.d.index.byFileId(fileId);
    const unlock = await this.d.locks.acquire(...this.lockKeys(fileId, R, e, path));
    try {
      return await this.reapply(path);
    } finally {
      unlock();
    }
  }

  /**
   * D5 classification of foreign content at `path`: 'torn' when it is a strict prefix of the bytes the
   * intent was writing, 'edit' otherwise (also when those bytes cannot be found any more: keeping the
   * content can only cost a conflict copy, overwriting it could lose a user edit), 'retry' when the
   * target bytes could not be fetched right now.
   */
  async classifyForeign(path: string, i: WriteIntent): Promise<'torn' | 'edit' | 'retry'> {
    const d = this.d;
    if (i.targetHash === null) return "edit";
    let cur: Uint8Array;
    try {
      cur = await d.fs.read(path);
    } catch (err) {
      if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) return "edit";
      throw err;
    }
    const R = d.index.remote.byFileId(i.fileId);
    let T: RemoteHead | null = R && !R.deleted && R.contentHash === i.targetHash ? R : null;
    try {
      if (!T && d.targetHead) T = await d.targetHead(i.fileId, i.targetHash);
      if (!T) return "edit";
      // Size known: anything as long as the target cannot be a strict prefix of it.
      if (cur.length >= T.size) return "edit";
      const target = await d.blobs.download(T, d.rcOf(T.path));
      if (!isStrictPrefix(cur, target)) return "edit";
      if (T.archive === true) this.tornArchived.set(path, target);
      return "torn";
    } catch (err) {
      if (err instanceof IntegrityError) return "edit";
      if (isRetryable(err)) return "retry";
      throw err;
    }
  }

  /** D5: the user edited the file after our write was interrupted: keep it, plan it as a local change. */
  private async userEditOverIntent(path: string, fileId: FileId): Promise<void> {
    const d = this.d;
    await d.intents.delete(path);
    this.tornAttempts.delete(fileId);
    d.log?.({ key: "log.tornWriteKeptEdit", cat: "merge", path, fileId });
    const e = d.index.byPath(path) ?? d.index.byFileId(fileId);
    d.markDirty(e ? { fileId: e.fileId, path } : { path }, "retry");
    const own = d.index.byFileId(fileId);
    if (own && e?.fileId !== fileId) d.markDirty({ fileId, path: own.path }, "remote");
  }

  /** D5: rewrite R over a torn write, bounded (never loops). */
  private async reapplyTorn(path: string, fileId: FileId): Promise<ApplyOutcome> {
    const d = this.d;
    const archived = this.tornArchived.get(path);
    this.tornArchived.delete(path);
    if (archived) {
      // D1 + I6: the torn write was a merge whose staged op was archived (CONFLICT): restore the merged
      // bytes, then the Planner merges them with the current head like any local change.
      d.echo.expect(path, { hash: await sha256Hex(archived), size: archived.length });
      await replaceFile(d.fs, path, archived, { mtime: d.now() });
      await d.intents.delete(path);
      this.tornAttempts.delete(fileId);
      d.log?.({ key: "log.tornMergeRestored", cat: "merge", path, fileId });
      const e = d.index.byPath(path);
      d.markDirty(e ? { fileId: e.fileId, path } : { path }, "retry");
      return "handoff";
    }
    const n = (this.tornAttempts.get(fileId) ?? 0) + 1;
    this.tornAttempts.set(fileId, n);
    const R = d.index.remote.byFileId(fileId);
    if (!R) {
      await d.intents.delete(path);
      this.tornAttempts.delete(fileId);
      return "gone";
    }
    if (n > TORN_REAPPLY_MAX) {
      // The re-apply keeps failing: hold the file (its torn bytes are never pushed) and move on.
      await d.intents.delete(path);
      this.tornAttempts.delete(fileId);
      await this.quarantine(fileId, R, new IntegrityError(`torn write at ${path} could not be repaired`, "tornWrite"));
      return "integrity";
    }
    const e = d.index.byFileId(fileId);
    if ((!e || e.path !== path) && R.path !== path) {
      // A stray torn write: the file has moved on (remote move, or the entry lives elsewhere), so no
      // copy of it belongs at this path. The prefix of our own write is removed (to the trash in trash
      // mode), never pushed, and the file is applied where it lives now.
      d.log?.({ key: "log.tornWriteReplaced", cat: "error", path, fileId });
      d.echo.expect(path, "deleted");
      try {
        await d.fs.remove(path, d.deleteMode());
      } catch (err) {
        if (!hasFsCode(err, "ENOENT")) throw err;
      }
      await d.intents.delete(path);
      await this.removeEmptyParents(path);
      this.tornAttempts.delete(fileId);
      return this.applyLocked(fileId);
    }
    if (R.deleted || (await this.intentTarget(path)) !== R.contentHash) {
      // The head moved on (or was deleted) since the torn write: the torn bytes are never pushed; the
      // current remote head is written instead and the change logged.
      d.log?.({ key: "log.tornWriteReplaced", cat: "error", path, fileId });
    }
    const out = await this.applyLocked(fileId, { planned: true, torn: path });
    if (out === "applied" || out === "noop" || out === "deleted" || out === "gone") this.tornAttempts.delete(fileId);
    return out;
  }

  private async intentTarget(path: string): Promise<string | null> {
    return (await this.d.intents.get(path))?.targetHash ?? null;
  }

  /** D1 merge-write recovery at `path` (null: the intent there is not a merge write). Caller holds the locks. */
  private async recoverMerge(path: string): Promise<ApplyOutcome | null> {
    const d = this.d;
    const r = await d.intents.recoverMerge(path, (bytes, hash) => d.echo.expect(path, { hash, size: bytes.length }));
    if (r === "none") return null;
    await this.crash("apply:mergeRecovered");
    if (r === "restored") d.log?.({ key: "log.tornMergeRestored", cat: "merge", path });
    // The staged merge stays queued; a later change of the file archives it (Journal, I6).
    if (r === "userEdit") d.log?.({ key: "log.tornWriteKeptEdit", cat: "merge", path });
    const e = d.index.byPath(path);
    d.markDirty(e ? { fileId: e.fileId, path } : { path }, "retry");
    return r === "restored" ? "applied" : "noop";
  }

  /** applyOne body; the caller holds the locks. */
  async applyLocked(fileId: FileId, opts: ApplyOpts = {}): Promise<ApplyOutcome> {
    const d = this.d;
    const R = d.index.remote.byFileId(fileId);
    if (!R) {
      await this.removeQueue(fileId, Infinity);
      return "gone";
    }
    if (await d.journal.isFrozen(fileId)) return "busy";
    const e = d.index.byFileId(fileId);
    const targetPath = opts.targetPath ?? R.path;

    // ---- gates ----
    // A tombstone acts on the local copy: when this device holds the file in scope, the delete applies
    // there even if the file was moved out of this device's scope before it was deleted (D6).
    const gatePath = R.deleted && e && e.scope === "active" ? e.path : targetPath;
    const sc = d.scopeOf(gatePath, R.deleted ? undefined : R.size);
    if (sc !== "active") {
      if (!R.deleted && (sc === "excluded" || sc === "ignored") && e && e.scope === "active" && e.path !== targetPath && !opts.targetPath) {
        return this.movedOutOfScope(fileId, R, e, sc);
      }
      await this.defer(fileId, R, sc === "illegal" ? "illegal" : sc === "oversize" ? "oversize" : "scope", e);
      return "scope";
    }
    if (!R.deleted && !d.isLegal(targetPath)) {
      d.log?.({ key: "log.illegalName", cat: "skipped", params: { message: ILLEGAL_NAME_LOG }, path: targetPath, fileId });
      await this.defer(fileId, R, "illegal", e);
      return "illegal";
    }
    if (e?.integrityHold) {
      await this.removeQueue(fileId, R.seq);
      return "hold";
    }

    // ---- a remote move out of a folder this device excludes ----
    if (e && e.scope !== "active" && e.path !== targetPath && !R.deleted && !opts.targetPath) {
      const detached = await this.movedIntoScope(fileId, R, e, targetPath);
      if (detached) return this.applyLocked(fileId, opts);
    }

    // ---- locate and observe ----
    const localPath = await this.locate(e, R, targetPath);
    const obs = await this.observe(localPath, e);
    const torn = opts.torn !== undefined && opts.torn === localPath;
    if (!torn && obs && !opts.planned) {
      const ic = await d.intents.check(localPath);
      if (ic.c === "foreign" && ic.intent) {
        const m = await this.recoverMerge(localPath);
        if (m !== null) {
          // The restored merge is a local change against R: the Planner decides (it pushes it).
          await this.removeQueue(fileId, R.seq);
          d.markDirty(e ? { fileId, path: e.path } : { path: localPath }, "remote");
          return "handoff";
        }
        const cls = await this.classifyForeign(localPath, ic.intent);
        if (cls === "retry") {
          await this.bump(fileId, "torn check needs the network");
          return "retry";
        }
        if (cls === "torn") {
          if (ic.intent.fileId === fileId) return this.reapplyTorn(localPath, fileId);
          // Our torn write for another entry sits here: that entry's re-apply repairs it first.
          d.markDirty({ path: localPath }, "retry");
          await this.bump(fileId, "torn write of another entry at the path");
          return "blocked";
        }
        // D5: a user edit over an interrupted pull. Fall through: the hand-to-Planner check below
        // sees a local change against the base and hands the file over (never overwritten).
        await this.userEditOverIntent(localPath, ic.intent.fileId);
      }
    }
    const planned = opts.planned === true || torn;

    if (!planned) {
      const L = obs?.L ?? null;
      const changed = L !== null && (!e?.synced || this.localChanged(e, L, opts.movedByUs === true));
      let occupant: Observed | null = null;
      if (!e && obs) occupant = obs;
      else if (e && e.path !== targetPath) occupant = await this.observe(targetPath, null);
      const holderAtTarget = d.index.byPath(targetPath);
      if ((L && changed && L.hash !== R.contentHash) ||
          (occupant && occupant.L.hash !== R.contentHash && holderAtTarget?.fileId !== fileId) ||
          (e?.synced && R.seq < e.synced.version)) {
        await this.removeQueue(fileId, R.seq);
        d.markDirty(e ? { fileId, path: e.path } : { path: targetPath }, "remote");
        return "handoff";
      }
    } else if (localPath !== targetPath) {
      // Planned apply into another path: never clobber a foreign file there.
      const occ = await this.observe(targetPath, null);
      if (occ && occ.L.hash !== R.contentHash && !this.isOurs(e, occ.L.hash, R)) {
        d.markDirty({ path: targetPath }, "remote");
        await this.bump(fileId, "target occupied");
        return "blocked";
      }
    }
    if (!R.deleted && this.heldByOther(targetPath, fileId, opts.replaces)) {
      const h = this.holderOf(targetPath, fileId, opts.replaces);
      // A holder with a pending op (e.g. its delete waiting for a commit retry) resolves when that op
      // is acked; re-planning it every iteration only spins the loop and keeps fake time from moving.
      if (h && !(await this.hasPendingOp(h.fileId))) d.markDirty({ fileId: h.fileId, path: h.path }, "remote");
      await this.bump(fileId, "path held by another entry");
      return "blocked";
    }

    // ---- remote delete ----
    if (R.deleted) {
      if (obs) {
        d.echo.expect(localPath, "deleted");
        try {
          await d.fs.remove(localPath, d.deleteMode());
        } catch (err) {
          if (!hasFsCode(err, "ENOENT")) throw err;
        }
        await this.crash("apply:removed");
        await this.removeEmptyParents(localPath);
      }
      await d.index.write(["applyQueue", "intents"], async (w) => {
        if (w.entry(fileId)) await w.deleteEntry(fileId);
        const q = await w.tx.applyQueue.get(fileId);
        if (q && q.seq <= R.seq) await w.tx.applyQueue.delete(fileId);
        await w.tx.intents.delete(localPath);
      });
      await this.crash("apply:committed");
      return "deleted";
    }

    // ---- content ----
    const contentOk = obs !== null && !torn && obs.L.hash === R.contentHash;
    let bytes: Uint8Array | null = null;
    let written: LocalStat | null = null;
    if (!contentOk) {
      if (R.size > d.maxFileBytes()) {
        await this.defer(fileId, R, "oversize", e);
        return "oversize";
      }
      try {
        bytes = await d.blobs.download(R, d.rcOf(R.path));
      } catch (err) {
        if (err instanceof IntegrityError) {
          await this.quarantine(fileId, R, err);
          return "integrity";
        }
        if (isRetryable(err)) {
          await this.bump(fileId, String((err as Error).message));
          return "retry";
        }
        throw err;
      }
      await this.crash("apply:downloaded");
      await d.intents.put({ path: localPath, fileId, preHash: obs?.L.hash ?? null, targetHash: R.contentHash });
      await this.crash("apply:intent");
      d.echo.expect(localPath, { hash: R.contentHash as string, size: R.size });
      let viaEditor = false;
      if (obs && !torn && d.fs.processText && d.isText?.(targetPath) && d.editorHasOpen?.(localPath)) {
        const expect = obs.bytes ?? (await d.fs.read(localPath));
        const expectText = utf8DecodeStrict(expect);
        const nextText = utf8DecodeStrict(bytes);
        if (expectText !== null && nextText !== null) {
          const ok = await d.fs.processText(localPath, (cur) => (cur === expectText ? nextText : null));
          if (ok) viaEditor = true;
          else {
            const n = await this.bump(fileId, "editor changed the file");
            if (n < PROCESS_TEXT_RETRIES) {
              await d.intents.delete(localPath);
              d.markDirty(e ? { fileId, path: e.path } : { path: localPath }, "apply");
              return "retry";
            }
          }
        }
      }
      if (!viaEditor) {
        await d.fs.mkdirp(dirname(localPath)).catch(() => undefined);
        const w: { mtime: number; ctime?: number } = { mtime: R.mtime };
        if (R.ctime !== undefined) w.ctime = R.ctime;
        try {
          written = await replaceFile(d.fs, localPath, bytes, w);
        } catch (err) {
          // A write torn in this session (the file holds a strict prefix of the bytes, D5) is
          // rewritten once right away: left torn, a user delete or edit of the prefix before the
          // next repair would be taken for a reason to re-apply or keep it (I30, no ghost).
          if (!(err instanceof Error) || err.name === "Crash" || err.name === "StateStoreError") throw err;
          // Unreadable right now: rewrite only a file that did not exist before (nothing to lose).
          const cur = await d.fs.read(localPath).catch(() => null);
          if (cur ? !isStrictPrefix(cur, bytes) : obs !== null) throw err;
          written = await replaceFile(d.fs, localPath, bytes, w);
        }
      }
      await this.crash("apply:written");
    }
    if (localPath !== targetPath) {
      d.echo.expect(targetPath, { renamedFrom: localPath });
      await d.fs.rename(localPath, targetPath);
      await this.crash("apply:renamed");
      await this.removeEmptyParents(localPath);
      written = null;
    }
    const st2 = written ?? (await d.fs.stat(targetPath));
    if (!st2) {
      // The file vanished between write and stat: try again later.
      await this.bump(fileId, "vanished after write");
      return "retry";
    }
    let baseBytes: Uint8Array | null = null;
    const hasBase = d.needsBase(targetPath, R.size);
    if (hasBase) {
      baseBytes = bytes ?? obs?.bytes ?? (await d.fs.read(targetPath));
      if (!bytes && (await sha256Hex(baseBytes)) !== R.contentHash) {
        // Edited between observation and now: the Planner decides.
        await this.removeQueue(fileId, R.seq);
        d.markDirty(e ? { fileId, path: e.path } : { path: targetPath }, "remote");
        return "handoff";
      }
    }
    // APPLY TXN: the only place a pull marks a file synced.
    await d.index.write(["applyQueue", "intents", "deferred", "journal", "staging"], async (w) => {
      if (opts.replaces && opts.replaces !== fileId && w.entry(opts.replaces)) {
        await cancelOpIn(w.tx, opts.replaces);
        await w.deleteEntry(opts.replaces);
      }
      const cur = w.entry(fileId);
      const kind = d.kindOf(targetPath);
      const next: FileEntry = {
        ...(cur ?? { fileId, path: targetPath, foldKey: foldKey(targetPath), scope: "active", kind, obs: null, synced: null, updatedAt: 0 }),
        path: targetPath, foldKey: foldKey(targetPath), scope: "active", kind,
        obs: { mtime: st2.mtime, size: st2.size, hash: R.contentHash, ...(st2.ino !== undefined ? { ino: st2.ino } : {}), ...(st2.ctimeMs !== undefined ? { ctimeMs: st2.ctimeMs } : {}) },
        synced: { version: R.seq, path: R.path, hash: R.contentHash as string, size: R.size, mtime: st2.mtime, hasBase: baseBytes !== null },
        updatedAt: d.now(),
      };
      delete next.integrityHold;
      await w.putEntry(next);
      if (baseBytes !== null) await w.tx.bases.put({ fileId, version: R.seq, hash: R.contentHash as string, bytes: baseBytes });
      else await w.tx.bases.delete(fileId);
      const q = await w.tx.applyQueue.get(fileId);
      if (q && q.seq <= R.seq) await w.tx.applyQueue.delete(fileId);
      await w.tx.deferred.delete(fileId);
      await w.tx.intents.delete(localPath);
      await w.tx.intents.delete(targetPath);
    });
    await this.crash("apply:committed");
    if (opts.replaces && opts.replaces !== fileId) d.journal.unmirror(opts.replaces);
    d.noteApplied?.(targetPath);
    return contentOk && localPath === targetPath ? "noop" : "applied";
  }

  /**
   * Lead decision D6 (클로드 제안(미승인)): a remote move of an active file into a folder this device
   * excludes. The file is gone from this device's scope: the entry follows the move (out of scope at the
   * new path, `synced` kept, S11) and the local copy at the old path is removed only when it still holds
   * synced content. A file the user changed here stays at the old path as a new local file (new fileId,
   * pushed as a create), so nothing is lost (I6). Re-including the folder pulls the file back (rescope).
   */
  private async movedOutOfScope(fileId: FileId, R: RemoteHead, e: FileEntry, sc: Scope): Promise<ApplyOutcome> {
    const d = this.d;
    const oldPath = e.path;
    const obs = await this.observe(oldPath, e);
    const ours = obs !== null && this.isOurs(e, obs.L.hash, R) && !(await this.hasPendingOp(fileId));
    if (obs && ours) {
      d.echo.expect(oldPath, "deleted");
      try {
        await d.fs.remove(oldPath, d.deleteMode());
      } catch (err) {
        if (!hasFsCode(err, "ENOENT")) throw err;
      }
      await this.crash("apply:movedOutRemoved");
      await this.removeEmptyParents(oldPath);
    }
    await d.index.write(["applyQueue", "deferred", "journal", "staging", "intents"], async (w) => {
      const cur = w.entry(fileId);
      if (cur) {
        // Local content that is not ours belongs to a new file now: its pending op must not move with it.
        if (obs && !ours) await cancelOpIn(w.tx, fileId);
        // Another entry may already hold the target path (the scan tracks untracked files in the
        // excluded folder by their scope flag). A placeholder without a base carries nothing: it gives
        // way. A real tracked entry there keeps the path: ours is dropped instead (the head stays
        // deferred and comes back on re-inclusion); moving onto it would violate the unique path and
        // kill every restart (sim seed 192).
        const holder = w.entryByPath(R.path);
        if (holder && holder.fileId !== fileId && holder.synced) await w.deleteEntry(fileId);
        else {
          if (holder && holder.fileId !== fileId) await w.deleteEntry(holder.fileId);
          await w.putEntry({ ...cur, path: R.path, foldKey: foldKey(R.path), scope: sc, obs: null, updatedAt: d.now() });
        }
      }
      await w.tx.deferred.put({ fileId, seq: R.seq, reason: "scope", path: R.path, deferredAt: d.now() });
      const q = await w.tx.applyQueue.get(fileId);
      if (q && q.seq <= R.seq) await w.tx.applyQueue.delete(fileId);
      await w.tx.intents.delete(oldPath);
    });
    await this.crash("apply:movedOutCommitted");
    if (obs && !ours) {
      d.log?.({ key: "log.movedOutKeptLocal", cat: "general", path: oldPath, fileId });
      d.markDirty({ path: oldPath }, "new");
    }
    return "scope";
  }

  /**
   * The remote head of a file this device holds out of scope (excluded folder) is at an active path:
   * a remote move out of the folder (the counterpart of D6), or a local rename into the folder that was
   * excluded before it was pushed. An unchanged local copy follows a remote move (the normal apply
   * renames it).
   * A copy the user changed or removed while it was out of scope is never touched (filters never
   * delete, I12): the entry is detached from it and moves to the target path with no local copy, so the
   * remote head is pulled there; the old file stays as an untracked out-of-scope file. Returns true
   * when the entry was detached (the caller re-runs the apply).
   */
  private async movedIntoScope(fileId: FileId, R: RemoteHead, e: FileEntry, targetPath: string): Promise<boolean> {
    const d = this.d;
    const oldPath = e.path;
    const obs = await this.observe(oldPath, e);
    // Follow only a move the remote made (R.path differs from the synced path): a file the user moved
    // into the excluded folder here stays where the user put it.
    const remoteMoved = e.synced !== null && R.path !== e.synced.path;
    // A local rename into the folder that was never pushed (e.path is not the synced path) is the
    // user's placement: the normal apply would see it as a local change and hand it to the Planner,
    // which never acts on an out-of-scope entry. Detach instead (both copies survive, I6/I12).
    const movedHere = e.synced !== null && e.path !== e.synced.path;
    if (obs && remoteMoved && !movedHere && this.isOurs(e, obs.L.hash, R) && !(await this.hasPendingOp(fileId))) return false;
    await d.index.write(["journal", "staging", "intents"], async (w) => {
      const cur = w.entry(fileId);
      if (!cur) return;
      await cancelOpIn(w.tx, fileId);
      // No local copy and no base at the target: a later reconcile can only pull it, never push a delete.
      await w.putEntry({ ...cur, path: targetPath, foldKey: foldKey(targetPath), scope: "active", obs: null, synced: null, updatedAt: d.now() });
      await w.tx.bases.delete(fileId);
      await w.tx.intents.delete(oldPath);
    });
    if (obs) d.markDirty({ path: oldPath }, "new");
    return true;
  }

  private async hasPendingOp(fileId: FileId): Promise<boolean> {
    return this.d.state.tx(["journal"], async (tx) => {
      for (const op of await tx.journal.getAll({ index: "fileId", only: fileId })) if (op.kind !== "archive") return true;
      return false;
    }, "readonly");
  }

  // ---------- swaps ----------

  private async applyCycle(ids: readonly FileId[]): Promise<ApplyOutcome[]> {
    const d = this.d;
    const keys: string[] = [];
    for (const id of ids) keys.push(...this.lockKeys(id, d.index.remote.byFileId(id), d.index.byFileId(id)));
    const unlock = await d.locks.acquire(...keys);
    const out: ApplyOutcome[] = [];
    try {
      const first = ids[0] as FileId;
      const e = d.index.byFileId(first);
      if (e && (await this.statFile(e.path))) {
        const rand = toHex((d.randomBytes ?? cryptoRandomBytes)(4));
        const tmp = swapPath(e.path, rand);
        d.echo.expect(tmp, { renamedFrom: e.path });
        await d.fs.rename(e.path, tmp);
        await this.crash("apply:swapParked");
        await d.index.setPath(first, tmp);
      }
      for (const id of [...ids.slice(1), first]) out.push(await this.applyLocked(id, { movedByUs: true }));
    } finally {
      unlock();
    }
    return out;
  }

  // ---------- helpers ----------

  private localChanged(e: FileEntry, L: { hash: string; path: string }, contentOnly: boolean): boolean {
    if (!e.synced) return true;
    if (L.hash !== e.synced.hash) return true;
    return !contentOnly && L.path !== e.synced.path;
  }

  /** The file at a path is ours (base content, remote content, or our own interrupted write). */
  private isOurs(e: FileEntry | null, hash: string, R: RemoteHead): boolean {
    return hash === R.contentHash || (e?.synced !== null && e?.synced !== undefined && hash === e.synced.hash);
  }

  /** design §3.8.4 locate(e, R): e.path, else the target path after a crash between rename and txn. */
  private async locate(e: FileEntry | null, R: RemoteHead, targetPath: string): Promise<string> {
    if (!e) return targetPath;
    if (await this.statFile(e.path)) return e.path;
    if (e.path !== targetPath && (await this.statFile(targetPath))) {
      const holder = this.d.index.byPath(targetPath);
      if (!holder || holder.fileId === e.fileId) {
        const h = await this.hashAt(targetPath);
        const intent = await this.d.intents.get(targetPath);
        if (h !== null && (this.isOurs(e, h, R) || (intent?.fileId === e.fileId && intent.targetHash === h))) return targetPath;
      }
    }
    return e.path;
  }

  private async statFile(path: string): Promise<LocalStat | null> {
    try {
      const st = await this.d.fs.stat(path);
      return st && st.kind === "file" ? st : null;
    } catch (err) {
      if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) return null;
      throw err;
    }
  }

  private async hashAt(path: string): Promise<string | null> {
    try {
      return (await readAndHash(this.d.fs, path)).hash;
    } catch (err) {
      if (hasFsCode(err, "ENOENT")) return null;
      throw err;
    }
  }

  /** Observation of `path` (fast path against the entry's obs when the entry is at that path). */
  private async observe(path: string, e: FileEntry | null): Promise<Observed | null> {
    const st = await this.statFile(path);
    if (!st) return null;
    const extra = { ...(st.ino !== undefined ? { ino: st.ino } : {}), ...(st.ctimeMs !== undefined ? { ctimeMs: st.ctimeMs } : {}) };
    if (e && e.path === path && e.obs?.hash && fastPathMatch(e.obs, st, this.d.fs.platform)) {
      return { L: { path, hash: e.obs.hash, size: e.obs.size, mtime: e.obs.mtime, ...extra }, st };
    }
    try {
      const h = await readAndHash(this.d.fs, path);
      return { L: { path, hash: h.hash, size: h.size, mtime: st.mtime, ...extra }, st, bytes: h.bytes };
    } catch (err) {
      if (hasFsCode(err, "ENOENT")) return null;
      throw err;
    }
  }

  private holderOf(path: string, fileId: FileId, replaces?: FileId): FileEntry | null {
    const exact = this.d.index.byPath(path);
    if (exact && exact.fileId !== fileId && exact.fileId !== replaces) return exact;
    if (this.d.fs.caseInsensitive) {
      for (const o of this.d.index.byFoldKey(foldKey(path))) if (o.fileId !== fileId && o.fileId !== replaces) return o;
    }
    return null;
  }

  private heldByOther(path: string, fileId: FileId, replaces?: FileId): boolean {
    return this.holderOf(path, fileId, replaces) !== null;
  }

  private async removeQueue(fileId: FileId, seqAtMost: number): Promise<void> {
    await this.d.state.tx(["applyQueue"], async (tx) => {
      const q = await tx.applyQueue.get(fileId);
      if (q && q.seq <= seqAtMost) await tx.applyQueue.delete(fileId);
    });
  }

  private async bump(fileId: FileId, error: string): Promise<number> {
    const R = this.d.index.remote.byFileId(fileId);
    const n = await this.d.state.tx(["applyQueue"], async (tx) => {
      const q = await tx.applyQueue.get(fileId);
      if (!q) {
        // A planned apply (Planner PULL) has no queue row: without one the failed apply would never
        // run again (nothing marks the entry dirty), and the device would report synced (§3.7 liveness).
        if (!R) return 0;
        await tx.applyQueue.put({ fileId, seq: R.seq, enqueuedAt: this.d.now(), attempts: 1, lastError: error });
        return 1;
      }
      const attempts = q.attempts + 1;
      await tx.applyQueue.put({ ...q, attempts, lastError: error });
      return attempts;
    });
    if (n === APPLY_STUCK_ATTEMPTS) this.d.log?.({ key: "log.applyStuck", cat: "error", params: { error }, fileId });
    return n;
  }

  /** Out of scope, illegal or oversize: never touches synced or bases (S11); remembered in `deferred`. */
  private async defer(fileId: FileId, R: RemoteHead, reason: 'scope' | 'illegal' | 'oversize', e: FileEntry | null): Promise<void> {
    const scope: Scope = reason === "scope" ? "excluded" : reason;
    await this.d.index.write(["applyQueue", "deferred"], async (w) => {
      await w.tx.deferred.put({ fileId, seq: R.seq, reason, path: R.path, deferredAt: this.d.now() });
      const cur = w.entry(fileId);
      if (cur && cur.scope === "active" && reason !== "scope" && cur.path === R.path) await w.putEntry({ ...cur, scope });
      const q = await w.tx.applyQueue.get(fileId);
      if (q && q.seq <= R.seq) await w.tx.applyQueue.delete(fileId);
    });
    void e;
  }

  /** design §4.14: quarantine + integrity hold; the local copy is never touched because of this record. */
  private async quarantine(fileId: FileId, R: RemoteHead, err: IntegrityError): Promise<void> {
    await this.d.index.write(["applyQueue", "integrity"], async (w) => {
      await w.tx.integrity.put({ seq: R.seq, fileId, reason: err.message.slice(0, 300), stage: err.stage });
      const cur = w.entry(fileId);
      if (cur) await w.putEntry({ ...cur, integrityHold: true });
      await w.tx.applyQueue.delete(fileId);
    });
    this.d.log?.({ key: "log.integrityError", cat: "error", params: { stage: err.stage }, path: R.path, fileId });
  }

  /** After remote deletes or moves: remove now-empty parents up to the root, except kept roots (§3.9). */
  private async removeEmptyParents(path: string): Promise<void> {
    let dir = dirname(path);
    while (dir !== "") {
      if (dir === this.d.fs.configDir || this.d.keepFolder?.(dir)) return;
      let removed: boolean;
      try {
        removed = await this.d.fs.rmdirIfEmpty(dir);
      } catch {
        return;
      }
      if (!removed) return;
      dir = dirname(dir);
    }
  }
}

async function cancelOpIn(tx: import("@shuttle/protocol").StateTx, fileId: FileId): Promise<void> {
  for (const op of await tx.journal.getAll({ index: "fileId", only: fileId })) {
    if (op.kind === "archive" || op.state === "sent") continue;
    if (isStagedPut(op) && op.base !== null) {
      // Staged bytes may be the only copy of a local edit (torn merge write): archive, never drop (I6).
      await Journal.archiveStagedIn(tx, op);
      continue;
    }
    await tx.journal.delete(op.opSeq);
    await tx.staging.delete(op.opSeq);
  }
}

function isRetryable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === true;
}

function count(s: DrainStats, o: ApplyOutcome): void {
  if (o === "applied" || o === "noop") s.applied++;
  else if (o === "deleted") s.deleted++;
  else if (o === "handoff") s.handoff++;
  else if (o === "blocked" || o === "busy") s.blocked++;
  else s.other++;
}
