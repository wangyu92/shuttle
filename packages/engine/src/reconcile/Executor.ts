// ActionExecutor: carries out Planner actions (design §3.4.4 `execute`, §3.10; engine-spec §3.4).
//
//   PUSH_*            → journal enqueue (PUSH_CREATE creates the FileEntry in the same transaction)
//   PULL              → applier.applyLocked(planned), then the C8 follow-up push
//   LOCAL_DELETE      → remove (trash) + forget
//   LOCAL_RENAME      → rename + index path + markDirty (content next pass, row C7)
//   ADOPT / FORGET    → one index transaction (reconcile/indexActions.ts)
//   MERGE             → dmp3 / JSON / LWW (+archive) / conflict copy (design §3.10.2-§3.10.5)
//   KEEP_BOTH         → rename local to a conflict-copy name, re-plan it there, then pull (N5, P1)
//   INTEGRITY_ERROR   → log, keep the local file, schedule a snapshot resync
//
// The Reconciler holds the file's locks (`id:<fileId>`, `fk:<foldKey>`) while execute() runs, so the
// applier is entered through applyLocked(). While a put/delete op of the file is frozen in a sent
// batch, nothing is executed: the journal remembers the change and the ack re-dirties the file.

import type { FileEntry, FileId, Keyring, LocalFs, RemoteAdapter, RemoteHead, RetentionClass, StateStore } from "@shuttle/protocol";
import { isStateStoreError } from "@shuttle/protocol";
import type { RemoteApplier } from "../apply/RemoteApplier";
import type { WriteIntents } from "../apply/WriteIntents";
import type { BlobPipeline } from "../content/BlobPipeline";
import { sha256Hex } from "../content/hash";
import { IntegrityError } from "../errors";
import type { EchoSuppressor } from "../events/EchoSuppressor";
import type { FileIndex } from "../index/FileIndex";
import { Journal, type EnqueueReq } from "../journal/Journal";
import { conflictCopyPath, conflictStamp, hostTzOffset } from "../merge/conflictName";
import { DEFAULT_MERGE_OPTIONS, merge3, type MergeOptions } from "../merge/dmp3";
import { canonOfBytes, mergeJson } from "../merge/jsonMerge";
import { isTemplatePrefix, lwwDecide } from "../merge/MergePolicy";
import { dirname, foldKey } from "../path/normalize";
import { hasFsCode } from "../platform/LocalFs";
import { decodeRecord } from "../remote/records";
import { crashPoint } from "../testing/crashPoint";
import type { DirtyKey, DirtyReason, LocalState } from "../types";
import { utf8DecodeStrict } from "../util/bytes";
import { newFileId } from "../util/uuid";
import { observationOf } from "./fastPath";
import { adoptInIndex } from "./indexActions";
import type { Action, LogHint } from "./Planner";
import type { ActionExecutor, ExecContext } from "./Reconciler";
import type { EngineHooks } from "@shuttle/protocol";

/** LWW remote-wins archives stage the local bytes up to this size; larger files get a conflict copy. */
export const ARCHIVE_STAGE_MAX = 16 * 1024 * 1024;

export interface ExecLog extends LogHint { path?: string; fileId?: FileId }

export interface ExecutorDeps {
  fs: LocalFs;
  state: StateStore;
  index: FileIndex;
  journal: Journal;
  applier: RemoteApplier;
  blobs: BlobPipeline;
  intents: WriteIntents;
  remote: RemoteAdapter;
  keyring(): Keyring | null;
  echo: EchoSuppressor;
  now(): number;
  hooks?: EngineHooks;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  rcOf(path: string): RetentionClass;
  needsBase(path: string, size: number): boolean;
  deviceName(): string;
  tzOffset?(epochMs: number): number;
  mergeOptions?: MergeOptions;
  log?(e: ExecLog): void;
  /** INTEGRITY_ERROR (design §3.4.3): part 3 schedules snapshotResync. */
  scheduleResync?(reason: string): void;
  /** After FORGET, LOCAL_DELETE and renames: LocalRenames.retry(). */
  afterIndexChange?(): void;
  /** Outgoing delete guard (design §3.13, part 3). false = hold the delete (the file stays tracked). */
  allowPushDelete?(fileId: FileId, path: string): boolean;
  newFileId?: () => FileId;
}

export class Executor implements ActionExecutor {
  constructor(private readonly d: ExecutorDeps) {}

  private crash(name: string): Promise<void> {
    return crashPoint(this.d.hooks, name);
  }

  async execute(a: Action, c: ExecContext): Promise<void> {
    const d = this.d;
    if (a.type === "NOOP") {
      if (a.log) d.log?.({ ...a.log, path: c.entry?.path ?? c.L?.path ?? "" });
      return;
    }
    if (a.type !== "INTEGRITY_ERROR") {
      for (const id of involved(a, c)) {
        if (await d.journal.isFrozen(id)) {
          d.journal.markWaiting(id);
          return;
        }
      }
    }
    if (a.log && a.type !== "MERGE") d.log?.({ ...a.log, path: pathOf(a), ...(c.entry ? { fileId: c.entry.fileId } : {}) });
    let L = c.L;
    if (a.preRename) {
      const ok = await this.localRename(c.entry?.fileId ?? null, a.preRename.from, a.preRename.to);
      if (!ok) return;
      if (L) L = { ...L, path: a.preRename.to };
    }
    switch (a.type) {
      case "PUSH_PUT": return this.pushPut(a, c);
      case "PUSH_CREATE": return this.pushCreate(a, c, L);
      case "PUSH_DELETE": {
        if (d.allowPushDelete && !d.allowPushDelete(a.fileId, a.path)) return;
        await this.enqueue({ kind: "delete", fileId: a.fileId, path: a.path, base: a.base });
        return;
      }
      case "PULL": return this.pull(a, c);
      case "LOCAL_DELETE": return this.localDelete(a.fileId, a.path);
      case "LOCAL_RENAME": {
        if (await this.localRename(a.fileId, a.from, a.to)) d.markDirty({ fileId: a.fileId, path: a.to }, "rename");
        return;
      }
      case "ADOPT": return this.adopt(a, c, L);
      case "FORGET": {
        await d.journal.cancel(a.fileId);
        await d.index.forget(a.fileId);
        d.afterIndexChange?.();
        return;
      }
      case "MERGE": return this.merge(a, c, L);
      case "KEEP_BOTH": return this.keepBoth(a, c, L);
      case "INTEGRITY_ERROR":
        d.log?.({ key: "log.integrityMissingHead", cat: "error", params: { reason: a.reason }, path: a.path, ...(a.fileId ? { fileId: a.fileId } : {}) });
        d.scheduleResync?.(a.reason);
        return;
    }
  }

  // ---------- pushes ----------

  private async enqueue(req: EnqueueReq): Promise<void> {
    const e = this.d.index.byFileId(req.fileId);
    const fromPath = e?.synced?.path;
    await this.d.journal.enqueue({ ...req, ...(fromPath !== undefined && req.fromPath === undefined ? { fromPath } : {}) });
  }

  private async pushPut(a: Extract<Action, { type: 'PUSH_PUT' }>, c: ExecContext): Promise<void> {
    if (a.source === "base") {
      const base = await this.d.state.tx(["bases"], (tx) => tx.bases.get(a.fileId), "readonly");
      if (!base) {
        this.d.log?.({ key: "log.lostInServerRestore", cat: "error", path: a.path, fileId: a.fileId });
        return;
      }
      await this.enqueue({ kind: "put", fileId: a.fileId, path: a.path, base: a.base, staged: base.bytes, mtime: c.entry?.synced?.mtime ?? this.d.now() });
      return;
    }
    await this.enqueue({ kind: "put", fileId: a.fileId, path: a.path, base: a.base, ...(c.L ? { hash: c.L.hash } : {}) });
  }

  private async pushCreate(a: Extract<Action, { type: 'PUSH_CREATE' }>, c: ExecContext, L: LocalState | null): Promise<void> {
    const d = this.d;
    let staged: Uint8Array | undefined;
    if (a.source === "base") {
      const own = a.fileId ?? c.entry?.fileId ?? null;
      const row = own ? await d.state.tx(["bases"], (tx) => tx.bases.get(own), "readonly") : undefined;
      if (!row) {
        d.log?.({ key: "log.lostInServerRestore", cat: "error", path: a.path });
        if (own && !L) await d.index.forget(own);
        return;
      }
      staged = row.bytes;
    }
    const existing = a.fileId ? d.index.byFileId(a.fileId) : null;
    const fileId = existing ? existing.fileId : a.fileId ?? (d.newFileId ?? newFileId)();
    const req: EnqueueReq = {
      kind: "put", fileId, path: a.path, base: null,
      ...(staged ? { staged, mtime: c.entry?.synced?.mtime ?? d.now() } : L ? { hash: L.hash } : {}),
    };
    const replaced = a.replaces && a.replaces !== fileId ? d.index.byFileId(a.replaces) : null;
    try {
      const r = await d.index.write(["journal", "staging"], async (w) => {
        if (replaced) {
          await Journal.cancelIn(w.tx, replaced.fileId);
          await w.deleteEntry(replaced.fileId);
        }
        if (!w.entry(fileId)) {
          const base: FileEntry = replaced ?? c.entry ?? {
            fileId, path: a.path, foldKey: foldKey(a.path), scope: "active", kind: c.kind, obs: null, synced: null, updatedAt: d.now(),
          };
          await w.putEntry({
            ...base, fileId, path: a.path, foldKey: foldKey(a.path), scope: "active", kind: c.kind, synced: null,
            obs: L && c.stat ? observationOf({ ...c.stat, path: a.path }, L.hash) : base.obs, updatedAt: d.now(),
          });
        }
        return d.journal.enqueueIn(w.tx, req);
      });
      d.journal.afterCommit(req, r);
      if (replaced) d.journal.unmirror(replaced.fileId);
    } catch (err) {
      if (!isStateStoreError(err, "CONSTRAINT")) throw err;
      // The path is held by a stale entry: re-plan both.
      const h = d.index.byPath(a.path);
      if (h) d.markDirty({ fileId: h.fileId, path: h.path }, "missing");
      d.markDirty({ path: a.path }, "retry");
      return;
    }
    await this.crash("exec:created");
  }

  // ---------- local effects ----------

  private async pull(a: Extract<Action, { type: 'PULL' }>, c: ExecContext): Promise<void> {
    const d = this.d;
    await d.journal.cancel(a.fileId);
    const R = d.index.remote.byFileId(a.fileId);
    const target = R && a.path !== R.path ? a.path : undefined;
    const replaces = a.forget ?? (c.entry && c.entry.fileId !== a.fileId && !c.entry.synced ? c.entry.fileId : undefined);
    const out = await d.applier.applyLocked(a.fileId, {
      planned: true, ...(target !== undefined ? { targetPath: target } : {}), ...(replaces !== undefined ? { replaces } : {}),
    });
    if (a.thenPush && (out === "applied" || out === "noop")) {
      await this.enqueue({ kind: "put", fileId: a.fileId, path: a.thenPush.path, base: a.thenPush.base });
    }
  }

  private async localDelete(fileId: FileId | null, path: string): Promise<void> {
    const d = this.d;
    if (fileId) await d.journal.cancel(fileId);
    d.echo.expect(path, "deleted");
    try {
      await d.fs.remove(path, "trash");
    } catch (err) {
      if (!hasFsCode(err, "ENOENT")) throw err;
    }
    await this.crash("exec:removed");
    if (fileId) await d.index.forget(fileId);
    d.afterIndexChange?.();
  }

  /** Rename on disk and in the index. False (nothing changed) when `to` is occupied. */
  private async localRename(fileId: FileId | null, from: string, to: string): Promise<boolean> {
    const d = this.d;
    if (from === to) return true;
    const occupied = await this.exists(to);
    const caseOnly = foldKey(from) === foldKey(to) && d.fs.caseInsensitive;
    if (occupied && !caseOnly) {
      d.markDirty({ path: to }, "retry");
      if (fileId) d.markDirty({ fileId, path: from }, "retry");
      return false;
    }
    if (fileId) {
      const holder = d.index.byPath(to);
      if (holder && holder.fileId !== fileId) {
        d.markDirty({ fileId: holder.fileId, path: holder.path }, "missing");
        d.markDirty({ fileId, path: from }, "retry");
        return false;
      }
    }
    d.echo.expect(to, { renamedFrom: from });
    await d.fs.rename(from, to);
    await this.crash("exec:renamed");
    if (fileId) {
      try {
        await d.index.setPath(fileId, to);
      } catch (err) {
        if (!isStateStoreError(err, "CONSTRAINT")) throw err;
        d.markDirty({ fileId, path: from }, "retry");
      }
    }
    d.afterIndexChange?.();
    return true;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return (await this.d.fs.stat(path)) !== null;
    } catch (err) {
      if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) return false;
      throw err;
    }
  }

  private async adopt(a: Extract<Action, { type: 'ADOPT' }>, c: ExecContext, L: LocalState | null): Promise<void> {
    const d = this.d;
    const R = d.index.remote.byFileId(a.fileId);
    if (!R || !L) return;
    const replaces = a.replaces ?? (c.entry && c.entry.fileId !== a.fileId ? c.entry.fileId : undefined);
    if (replaces) await d.journal.cancel(replaces);
    await d.journal.cancel(a.fileId);
    let baseBytes: Uint8Array | undefined;
    if (d.needsBase(a.path, L.size)) {
      const bytes = await this.readExpect(L.path, L.hash);
      if (!bytes) return;
      baseBytes = bytes;
    }
    try {
      await adoptInIndex(d.index, { R, L: { ...L, path: a.path }, ...(replaces ? { replaces } : {}), kind: c.kind, ...(baseBytes ? { baseBytes } : {}), now: d.now() });
    } catch (err) {
      if (!isStateStoreError(err, "CONSTRAINT")) throw err;
      d.markDirty({ path: a.path }, "retry");
      return;
    }
    d.afterIndexChange?.();
  }

  // ---------- merge (design §3.10) ----------

  private async merge(a: Extract<Action, { type: 'MERGE' }>, c: ExecContext, L0: LocalState | null): Promise<void> {
    const d = this.d;
    const R = d.index.remote.byFileId(a.remote.fileId);
    const L = L0;
    if (!R || R.deleted || !L) return;
    const local = await this.readExpect(L.path, L.hash);
    if (!local) return;
    let remote: Uint8Array;
    try {
      remote = await d.blobs.download(R, d.rcOf(R.path));
    } catch (err) {
      if (err instanceof IntegrityError) {
        d.log?.({ key: "log.integrityError", cat: "error", params: { stage: err.stage }, path: R.path, fileId: R.fileId });
        return;
      }
      throw err;
    }
    let strategy = a.strategy;
    if (strategy === "dmp3") {
      const ok = await this.mergeDmp3(a, c, L, local, remote, R);
      if (ok) return;
      strategy = utf8DecodeStrict(local) === null || utf8DecodeStrict(remote) === null ? "lww" : "conflictCopy";
    }
    if (strategy === "json") {
      const m = mergeJson(local, remote);
      if (m) {
        if (m.equalsRemote || canonOfBytes(m.bytes) === canonOfBytes(remote)) {
          await d.applier.applyLocked(R.fileId, { planned: true, ...(a.replaces ? { replaces: a.replaces } : {}) });
          return;
        }
        if (!m.equalsLocal) await this.writeLocal(L.path, a.fileId, m.bytes, L.hash);
        await this.pushMerged(a, c, L.path);
        d.log?.({ key: "log.mergeConflict", cat: "merge", path: a.path, fileId: a.fileId });
        return;
      }
      strategy = "lww";
    }
    if (strategy === "lww") {
      const w = lwwDecide({ localMtime: L.mtime, remoteMtime: R.mtime, remoteTs: R.ts });
      if (w.clockWarning) d.log?.({ key: "log.clockWarning", cat: "general", path: a.path });
      if (w.winner === "local") {
        d.log?.({ key: "log.rejectedServerChange", cat: "merge", path: a.path, fileId: a.fileId });
        await this.pushMerged(a, c, L.path);
        return;
      }
      if (local.length <= ARCHIVE_STAGE_MAX) {
        // Remote wins: archive the local bytes first (staged, durable), then pull (design §3.10.4, I31).
        await this.enqueue({ kind: "archive", fileId: R.fileId, path: L.path, base: R.seq, staged: local, mtime: L.mtime });
        await this.crash("exec:archived");
        await d.applier.applyLocked(R.fileId, { planned: true, ...(a.replaces ? { replaces: a.replaces } : {}) });
        return;
      }
      strategy = "conflictCopy";
    }
    await this.conflictCopy(a.path, local, L, R, a.replaces);
  }

  /** dmp3 against the stored base; true when handled (clean merge). */
  private async mergeDmp3(a: Extract<Action, { type: 'MERGE' }>, c: ExecContext, L: LocalState, local: Uint8Array, remote: Uint8Array, R: RemoteHead): Promise<boolean> {
    const d = this.d;
    const lt = utf8DecodeStrict(local);
    const rt = utf8DecodeStrict(remote);
    if (lt === null || rt === null) return false;
    const baseBytes = await this.baseOf(c.entry);
    if (!baseBytes) return false;
    const bt = utf8DecodeStrict(baseBytes);
    if (bt === null) return false;
    const m = merge3(bt, lt, rt, d.mergeOptions ?? DEFAULT_MERGE_OPTIONS);
    if (!m.clean) return false;
    d.log?.({ key: "log.mergingConflictedFile", cat: "merge", path: a.path, fileId: a.fileId });
    if (m.text === rt) {
      await d.applier.applyLocked(R.fileId, { planned: true });
      return true;
    }
    if (m.text !== lt) await this.writeLocal(L.path, a.fileId, new TextEncoder().encode(m.text), L.hash);
    await this.pushMerged(a, c, L.path);
    return true;
  }

  /** design §3.10.2: bases[fileId] if it is the synced version, else getVersion(fileId, synced.version). */
  private async baseOf(e: FileEntry | null): Promise<Uint8Array | null> {
    const d = this.d;
    if (!e?.synced) return null;
    const synced = e.synced;
    const row = await d.state.tx(["bases"], (tx) => tx.bases.get(e.fileId), "readonly");
    if (row && row.version === synced.version) return row.bytes;
    const ring = d.keyring();
    if (!ring) return null;
    try {
      const rec = await d.remote.getVersion(e.fileId, synced.version);
      if (!rec) return null;
      const h = (await decodeRecord(ring, rec)).head;
      if (!h || h.deleted) return null;
      return await d.blobs.download(h, d.rcOf(h.path));
    } catch {
      return null;
    }
  }

  /** Push the merged local file under R's identity with base = R.seq at the resolved path. */
  private async pushMerged(a: Extract<Action, { type: 'MERGE' }>, c: ExecContext, localPath: string): Promise<void> {
    const d = this.d;
    if (a.replaces && a.replaces !== a.fileId) {
      // Row N4: the never-synced local entry is replaced by R's fileId at the same path.
      const old = d.index.byFileId(a.replaces);
      const st = await d.fs.stat(localPath);
      const hash = st ? await sha256Hex(await d.fs.read(localPath)) : null;
      const req: EnqueueReq = { kind: "put", fileId: a.fileId, path: a.path, base: a.base };
      const r = await d.index.write(["journal", "staging"], async (w) => {
        if (old) {
          await Journal.cancelIn(w.tx, old.fileId);
          await w.deleteEntry(old.fileId);
        }
        const cur = w.entry(a.fileId);
        await w.putEntry({
          fileId: a.fileId, path: a.path, foldKey: foldKey(a.path), scope: "active", kind: c.kind, synced: cur?.synced ?? null,
          obs: st && hash ? observationOf(st, hash) : null, updatedAt: d.now(),
        });
        return d.journal.enqueueIn(w.tx, req);
      });
      d.journal.afterCommit(req, r);
      if (old) d.journal.unmirror(old.fileId);
      return;
    }
    await this.enqueue({ kind: "put", fileId: a.fileId, path: a.path, base: a.base });
  }

  /**
   * design §3.10.5: the copy (new fileId, detecting device's content) is written first and becomes a
   * tracked create; then the original path gets the remote version (I10).
   */
  private async conflictCopy(path: string, local: Uint8Array, L: LocalState, R: RemoteHead, replaces?: FileId): Promise<void> {
    const d = this.d;
    const copy = await this.freeConflictPath(path);
    await d.fs.mkdirp(dirname(copy)).catch(() => undefined);
    const st = await d.fs.write(copy, local, { mtime: L.mtime });
    await this.crash("exec:copyWritten");
    const fileId = (d.newFileId ?? newFileId)();
    const req: EnqueueReq = { kind: "put", fileId, path: copy, base: null };
    try {
      const r = await d.index.write(["journal", "staging"], async (w) => {
        await w.putEntry({
          fileId, path: copy, foldKey: foldKey(copy), scope: "active", kind: d.index.byPath(path)?.kind ?? "other",
          obs: observationOf(st, L.hash), synced: null, updatedAt: d.now(),
        });
        return d.journal.enqueueIn(w.tx, req);
      });
      d.journal.afterCommit(req, r);
    } catch (err) {
      if (!isStateStoreError(err, "CONSTRAINT")) throw err;
      d.markDirty({ path: copy }, "new");
    }
    d.log?.({ key: "log.mergeConflict", cat: "merge", params: { copy }, path, fileId: R.fileId });
    await this.crash("exec:copyTracked");
    await d.applier.applyLocked(R.fileId, { planned: true, ...(replaces ? { replaces } : {}) });
  }

  private async keepBoth(a: Extract<Action, { type: 'KEEP_BOTH' }>, c: ExecContext, L: LocalState | null): Promise<void> {
    const d = this.d;
    if (!L) return;
    if (a.allowTemplateAdopt && a.pull) {
      const R = d.index.remote.byFileId(a.pull.fileId);
      const local = await this.readExpect(L.path, L.hash);
      if (!local) return;
      if (R && !R.deleted) {
        try {
          const remote = await d.blobs.download(R, d.rcOf(R.path));
          const lt = utf8DecodeStrict(local);
          const rt = utf8DecodeStrict(remote);
          if (lt !== null && rt !== null && isTemplatePrefix(lt, rt)) {
            // design §3.10.6 refinement: empty or template-created local note → remote silently.
            await d.applier.applyLocked(R.fileId, { planned: true, ...(a.fileId && a.fileId !== R.fileId ? { replaces: a.fileId } : {}) });
            return;
          }
        } catch (err) {
          if (!(err instanceof IntegrityError)) throw err;
        }
      }
    }
    const copy = await this.freeConflictPath(a.path);
    if (!(await this.localRename(a.fileId, L.path, copy))) return;
    d.markDirty(a.fileId ? { fileId: a.fileId, path: copy } : { path: copy }, "conflict");
    if (!a.log) d.log?.({ key: "log.mergeConflict", cat: "merge", params: { copy }, path: a.path });
    if (a.pull) {
      const R = d.index.remote.byFileId(a.pull.fileId);
      const target = R && a.pull.path !== R.path ? a.pull.path : undefined;
      await d.applier.applyLocked(a.pull.fileId, { planned: true, ...(target !== undefined ? { targetPath: target } : {}) });
    }
  }

  private async freeConflictPath(path: string): Promise<string> {
    const d = this.d;
    const now = d.now();
    const stamp = conflictStamp(now, (d.tzOffset ?? hostTzOffset)(now));
    const taken = new Set<string>();
    for (const e of d.index.all()) taken.add(foldKey(e.path));
    for (let i = 0; i < 100; i++) {
      const p = conflictCopyPath(path, d.deviceName(), stamp, (x) => taken.has(foldKey(x)));
      if (!(await this.exists(p))) return p;
      taken.add(foldKey(p));
    }
    throw new Error(`no free conflict-copy name for ${path}`);
  }

  /** Read `path` and require its hash to still be `hash`; else re-plan (it changed under us). */
  private async readExpect(path: string, hash: string): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.d.fs.read(path);
    } catch (err) {
      if (hasFsCode(err, "ENOENT")) {
        this.d.markDirty({ path }, "missing");
        return null;
      }
      throw err;
    }
    if ((await sha256Hex(bytes)) !== hash) {
      this.d.markDirty({ path }, "retry");
      return null;
    }
    return bytes;
  }

  /** Engine write of merged content, guarded by a write intent and an echo expectation. */
  private async writeLocal(path: string, fileId: FileId, bytes: Uint8Array, preHash: string): Promise<void> {
    const d = this.d;
    const h = await sha256Hex(bytes);
    await d.intents.put({ path, fileId, preHash, targetHash: h });
    d.echo.expect(path, { hash: h, size: bytes.length });
    const st = await d.fs.write(path, bytes, { mtime: d.now() });
    await this.crash("exec:mergedWritten");
    await d.intents.delete(path);
    const e = d.index.byPath(path);
    if (e) await d.index.updateObs(e.fileId, observationOf(st, h));
  }
}

function involved(a: Action, c: ExecContext): FileId[] {
  const out = new Set<FileId>();
  if (c.entry) out.add(c.entry.fileId);
  if ("fileId" in a && a.fileId) out.add(a.fileId);
  if ("replaces" in a && a.replaces) out.add(a.replaces);
  if (a.type === "PULL" && a.forget) out.add(a.forget);
  if (a.type === "MERGE") out.add(a.remote.fileId);
  if (a.type === "KEEP_BOTH" && a.pull) out.add(a.pull.fileId);
  // A push only coalesces: the journal itself reports `waiting` for a frozen op.
  if (a.type === "PUSH_PUT" || a.type === "PUSH_DELETE") return [];
  return [...out];
}

function pathOf(a: Action): string {
  if (a.type === "LOCAL_RENAME") return a.to;
  return "path" in a ? a.path : "";
}
