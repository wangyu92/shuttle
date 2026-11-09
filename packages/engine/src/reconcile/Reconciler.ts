// reconcile(key) (design §3.4.4; engine-spec §3.4): re-stat under lock, observe (fast path or hash),
// look up R, Planner.decide, apply the sync-mode post-pass, execute.
//
// Extension points:
//  - ActionExecutor (part 2): executes Actions (journal enqueue, applier.applyOne, merge + push, keep
//    both, archive, integrity error → snapshotResync). ADOPT/FORGET can use reconcile/indexActions.ts.
//  - ReconcileHooks: write-intent torn-write check (§3.8.4, part 2), hash budget (§3.15, part 3),
//    tombstone base hash for row N6 (rebuild, part 2), conflict-loop state (merge/Oscillation.ts).
//  - ScopeFn (part 3 PathFilter) and settings/ctx getters (part 3 config and SyncLoop).

import type { ConflictMode, FileEntry, FileKind, LocalFs, LocalStat, RemoteHead, SyncMode } from "@shuttle/protocol";
import { hasFsCode } from "../platform/LocalFs";
import type { EchoSuppressor } from "../events/EchoSuppressor";
import type { FileIndex } from "../index/FileIndex";
import { foldKey } from "../path/normalize";
import type { DirtyKey, DirtyReason, LocalState } from "../types";
import type { KeyedMutex } from "../util/KeyedMutex";
import { newFileId } from "../util/uuid";
import { fastPathMatch, observationOf } from "./fastPath";
import { applySyncMode, decide, type Action, type PlanCtx } from "./Planner";
import type { ScopeFn } from "./scope";

export interface ExecContext {
  /** Entry before the action (null for an untracked path). */
  entry: FileEntry | null;
  L: LocalState | null;
  R: RemoteHead | null;
  stat: LocalStat | null;
  kind: FileKind;
  ctx: PlanCtx;
}

/** Part 2 implements this (journal, op runner, applier, merge execution). */
export interface ActionExecutor {
  execute(action: Action, c: ExecContext): Promise<void>;
}

export interface ReconcileSettings { conflictMode: ConflictMode; mode: SyncMode }

export interface ReconcileHooks {
  /** §3.8.4: true when `path` is a torn engine write; reconcile then calls reapply() instead of planning. */
  isTorn?(path: string, st: LocalStat): Promise<boolean>;
  reapply?(path: string): Promise<void>;
  /**
   * design §3.8.4: true when `hash` at `path` is the target of this entry's own pull write whose apply
   * transaction never ran (crash after the write). That content is the engine's, not a user edit.
   */
  ownPullTarget?(path: string, fileId: string, hash: string): Promise<boolean>;
  /** §3.15 hash budget (bytes). */
  acquireHash?(bytes: number): Promise<void>;
  releaseHash?(bytes: number): void;
  /** Row N6: hash of the version a tombstone deleted (getVersion), only asked in rebuild mode. */
  tombstoneBaseHash?(tombstone: RemoteHead): Promise<string | null>;
  /** Conflict-loop fallback state per fileId. */
  conflictLoop?(fileId: string): boolean;
  /** Pending renames (LocalRenames): defer the mover, hide the moved bytes from a stale holder (§3.6.1). */
  renames?: { isPendingSource(fileId: string): boolean; pendingMoverFor(path: string): string | null };
}

export interface ReconcilerDeps {
  fs: LocalFs;
  index: FileIndex;
  locks: KeyedMutex;
  echo: EchoSuppressor;
  scopeOf: ScopeFn;
  kindOf(path: string): FileKind;
  isConfigJson(path: string): boolean;
  /** SHA-256 hex of the file's current bytes (content/hash.ts readAndHash). */
  hashFile(path: string): Promise<{ hash: string; size: number }>;
  settings(): ReconcileSettings;
  ctx(): PlanCtx;
  executor: ActionExecutor;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  /** Locked (design §3.13): no hashing; dirty keys accumulate. */
  isLocked(): boolean;
  /**
   * Where a key that needs hashing goes while Locked. Default: back into the dirty set. The engine
   * parks it until unlock instead, so a Locked loop never re-plans the same keys (no spin).
   */
  onLocked?(key: DirtyKey): void;
  hooks?: ReconcileHooks;
  newFileId?: () => string;
}

export type ReconcileOutcome =
  | { t: 'planned'; action: Action }
  | { t: 'scope' } | { t: 'hold' } | { t: 'echo' } | { t: 'locked' } | { t: 'torn' } | { t: 'vanished' }
  /** Waiting for a pending rename; LocalRenames.retry() marks it dirty again when the move applies. */
  | { t: 'deferred' };

export class Reconciler {
  constructor(private readonly d: ReconcilerDeps) {}

  async reconcile(key: DirtyKey): Promise<ReconcileOutcome> {
    const d = this.d;
    const first = d.index.lookup(key);
    const lockPath = first?.path ?? key.path;
    const unlock = await d.locks.acquire(`id:${key.fileId ?? first?.fileId ?? "p:" + key.path}`, `fk:${foldKey(lockPath)}`);
    try {
      const e = d.index.lookup(key);
      const path = e?.path ?? key.path;
      const rn = d.hooks?.renames;
      if (e && rn?.isPendingSource(e.fileId)) return { t: "deferred" };
      const mover = rn?.pendingMoverFor(path) ?? null;
      const st = mover !== null && mover !== e?.fileId ? null : await this.stat(path);
      const sc = d.scopeOf(path, st?.size);
      if (e && e.scope !== sc) await d.index.setScope(e.fileId, sc);
      if (sc !== "active") {
        if (!e && st && st.kind === "file" && sc !== "ignored") {
          await d.index.trackOutOfScope({ fileId: (d.newFileId ?? newFileId)(), st, scope: sc, kind: d.kindOf(path) });
        }
        return { t: "scope" };
      }
      if (e?.integrityHold) return { t: "hold" };

      let L: LocalState | null = null;
      if (st && st.kind === "file") {
        if (e?.obs && e.obs.hash && fastPathMatch(e.obs, st, d.fs.platform)) {
          L = { path, hash: e.obs.hash, size: e.obs.size, mtime: e.obs.mtime, ...extra(st) };
        } else {
          if (d.isLocked()) {
            if (d.onLocked) d.onLocked(key);
            else d.markDirty(key, "retry");
            return { t: "locked" };
          }
          if (d.hooks?.isTorn && (await d.hooks.isTorn(path, st))) {
            await d.hooks.reapply?.(path);
            return { t: "torn" };
          }
          const h = await this.hash(path, st.size);
          if (h === null) {
            // Vanished between stat and read: re-check later as missing; never an exception.
            d.markDirty(e ? { fileId: e.fileId, path } : { path }, "missing");
            return { t: "vanished" };
          }
          L = { path, hash: h.hash, size: h.size, mtime: st.mtime, ...extra(st) };
          if (d.echo.consume(path, { hash: h.hash, size: h.size })) {
            if (e) await d.index.updateObs(e.fileId, observationOf(st, h.hash));
            // design §3.6.2: correctness never depends on echo matching. Content that differs from the
            // synced base (a user edit that happens to equal bytes the engine wrote earlier, a merge
            // write not yet acked) is still planned; the Planner sees S1 for a true echo anyway.
            if (!e?.synced || e.synced.hash === h.hash) return { t: "echo" };
          }
        }
      }

      const kind = d.kindOf(path);
      const R = e?.synced ? d.index.remote.byFileId(e.fileId) : d.index.remote.headForFoldKey(foldKey(path));
      const ctx: PlanCtx = { ...d.ctx() };
      if (e && d.hooks?.conflictLoop?.(e.fileId)) ctx.conflictLoop = true;
      let tombstoneBaseHash: string | null = null;
      if (!e?.synced && L && R?.deleted && ctx.mode === "rebuild" && d.hooks?.tombstoneBaseHash) {
        tombstoneBaseHash = await d.hooks.tombstoneBaseHash(R);
      }
      const s = d.settings();
      // A completed pull write whose apply transaction was lost to a crash is no local change: plan it
      // as unchanged, so a newer head or tombstone applies instead of being pushed over (sim 736).
      let Lplan = L;
      if (L && e?.synced && L.hash !== e.synced.hash && d.hooks?.ownPullTarget && (await d.hooks.ownPullTarget(path, e.fileId, L.hash))) {
        Lplan = { ...L, hash: e.synced.hash };
      }
      const planned = decide({
        L: Lplan, R, P: key.pathTaken ?? null, path, scope: sc, kind, configJson: d.isConfigJson(path), conflictMode: s.conflictMode, ctx,
        entry: e ? { fileId: e.fileId, path: e.path, synced: e.synced, ...(e.integrityHold ? { integrityHold: true } : {}) } : null,
        tombstoneBaseHash,
        ...(R && !R.deleted && R.path !== path ? { rScope: d.scopeOf(R.path, R.size) } : {}),
      });
      const action = applySyncMode(planned, s.mode, R);
      // Observation recorded before the action: an executor that wrote the file (pull, merge, copy)
      // sets the entry's obs itself, and that newer observation must not be replaced by this one.
      const preObs = L ? (d.index.byPath(L.path)?.obs ?? null) : null;
      await d.executor.execute(action, { entry: e, L, R, stat: st, kind, ctx });
      if (L && st) {
        const after = d.index.byPath(L.path);
        if (after && sameObs(after.obs, preObs) && (!after.obs || after.obs.hash !== L.hash || after.obs.mtime !== L.mtime || after.obs.size !== L.size)) {
          await d.index.updateObs(after.fileId, observationOf(st, L.hash));
        }
      }
      return { t: "planned", action };
    } finally {
      unlock();
    }
  }

  private async stat(path: string): Promise<LocalStat | null> {
    try {
      return await this.d.fs.stat(path);
    } catch (err) {
      if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) return null;
      throw err;
    }
  }

  private async hash(path: string, size: number): Promise<{ hash: string; size: number } | null> {
    const h = this.d.hooks;
    await h?.acquireHash?.(size);
    try {
      return await this.d.hashFile(path);
    } catch (err) {
      if (hasFsCode(err, "ENOENT")) return null;
      throw err;
    } finally {
      h?.releaseHash?.(size);
    }
  }
}

function sameObs(a: FileEntry["obs"], b: FileEntry["obs"]): boolean {
  if (a === null || b === null) return a === b;
  return a.hash === b.hash && a.mtime === b.mtime && a.size === b.size && a.ino === b.ino && a.ctimeMs === b.ctimeMs;
}

function extra(st: LocalStat): Partial<Pick<LocalState, "ino" | "ctimeMs">> {
  const o: Partial<Pick<LocalState, "ino" | "ctimeMs">> = {};
  if (st.ino !== undefined) o.ino = st.ino;
  if (st.ctimeMs !== undefined) o.ctimeMs = st.ctimeMs;
  return o;
}
