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
} from "@shuttle/protocol";
import type { BlobPipeline } from "../content/BlobPipeline";
import { readAndHash, sha256Hex } from "../content/hash";
import { IntegrityError } from "../errors";
import type { EchoSuppressor } from "../events/EchoSuppressor";
import type { FileIndex } from "../index/FileIndex";
import type { Journal } from "../journal/Journal";
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
import { orderApplies, swapPath, type OrderItem } from "./BatchOrderer";
import type { WriteIntents } from "./WriteIntents";

/** design §3.8.3: more pending local deletes than max(25, 10 % of active files) pause and ask. */
export const MASS_DELETE_MIN = 25;
export const MASS_DELETE_FRACTION = 0.1;
/** Attempts after which a blocked apply is logged as stuck (it stays queued). */
export const APPLY_STUCK_ATTEMPTS = 5;
/** S20: processText retries before falling back to an atomic write. */
export const PROCESS_TEXT_RETRIES = 3;

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
  noteApplied?(path: string): void;
  log?(e: ApplierLog): void;
  randomBytes?: RandomBytes;
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
    const deletes = items.filter((i) => i.R.deleted && i.localPath !== null && this.d.index.byFileId(i.fileId)?.obs);
    const threshold = Math.max(MASS_DELETE_MIN, Math.floor(this.d.index.activeCount() * MASS_DELETE_FRACTION));
    let holdDeletes = false;
    if (deletes.length > threshold) {
      const ok = this.d.confirmMassDelete ? await this.d.confirmMassDelete(deletes.length, this.d.index.activeCount()) : false;
      if (!ok) {
        holdDeletes = true;
        this.d.log?.({ key: "log.massDeleteRemotePaused", cat: "general", params: { count: deletes.length } });
      }
    }
    const ready = holdDeletes ? items.filter((i) => !(i.R.deleted && i.localPath !== null)) : items;
    if (holdDeletes) s.held += items.length - ready.length;
    const { order, cycles } = orderApplies(ready, this.d.fs.configDir);
    for (const c of cycles) for (const out of await this.applyCycle(c)) count(s, out);
    for (const id of order) count(s, await this.applyOne(id));
    return s;
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

  /** Torn engine write at `path` (design §3.8.4 `applier.reapply`): rewrite R. Caller holds the locks. */
  async reapply(path: string): Promise<ApplyOutcome> {
    // D1: an interrupted merge write is re-applied from its staged bytes, never from the remote head.
    const m = await this.recoverMerge(path);
    if (m !== null) return m;
    const i = await this.d.intents.get(path);
    if (!i) return "noop";
    const R = this.d.index.remote.byFileId(i.fileId);
    if (!R || R.deleted || (i.targetHash !== null && i.targetHash !== R.contentHash)) {
      // Not a pull of the current head (merge write, or the head moved on): the torn bytes are never
      // pushed; the current remote head is written instead and the change logged.
      this.d.log?.({ key: "log.tornWriteReplaced", cat: "error", path, fileId: i.fileId });
    }
    if (!R) {
      await this.d.intents.delete(path);
      return "gone";
    }
    return this.applyLocked(i.fileId, { planned: true, torn: path });
  }

  /** D1 merge-write recovery at `path` (null: the intent there is not a merge write). Caller holds the locks. */
  private async recoverMerge(path: string): Promise<ApplyOutcome | null> {
    const d = this.d;
    const r = await d.intents.recoverMerge(path, (bytes, hash) => d.echo.expect(path, { hash, size: bytes.length }));
    if (r === "none") return null;
    await this.crash("apply:mergeRecovered");
    if (r === "restored") d.log?.({ key: "log.tornMergeRestored", cat: "merge", path });
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
    const sc = d.scopeOf(targetPath, R.deleted ? undefined : R.size);
    if (sc !== "active") {
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

    // ---- locate and observe ----
    const localPath = await this.locate(e, R, targetPath);
    const obs = await this.observe(localPath, e);
    const torn = opts.torn !== undefined && opts.torn === localPath;
    if (!torn && obs && !opts.planned) {
      const ic = await d.intents.check(localPath);
      if (ic.c === "torn") {
        const m = await this.recoverMerge(localPath);
        if (m !== null) {
          // The restored merge is a local change against R: the Planner decides (it pushes it).
          await this.removeQueue(fileId, R.seq);
          d.markDirty(e ? { fileId, path: e.path } : { path: localPath }, "remote");
          return "handoff";
        }
        return this.applyLocked(fileId, { ...opts, planned: true, torn: localPath });
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
      if (h) d.markDirty({ fileId: h.fileId, path: h.path }, "remote");
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
        written = await d.fs.write(localPath, bytes, w);
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
    const n = await this.d.state.tx(["applyQueue"], async (tx) => {
      const q = await tx.applyQueue.get(fileId);
      if (!q) return 0;
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
