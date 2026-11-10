// Startup / periodic local scan with the fast path (design §3.4.1; engine-spec §3.1).
// No IO for unchanged files (I23): only listAll() stats are compared with the stored observation;
// hashing is deferred to reconcile().

import type { FileKind, LocalFs, Scheduler } from "@shuttle/protocol";
import { isReplaceTemp, replaceInFlight } from "../apply/replaceFile";
import type { FileIndex } from "../index/FileIndex";
import { normalizePath } from "../path/normalize";
import type { DirtyKey, DirtyReason } from "../types";
import { newFileId } from "../util/uuid";
import { fastPathMatch } from "./fastPath";
import type { ScopeFn } from "./scope";

export interface ScanDeps {
  fs: LocalFs;
  index: FileIndex;
  scheduler: Pick<Scheduler, "yieldToUi">;
  scopeOf: ScopeFn;
  kindOf(path: string): FileKind;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  includeConfigDir: boolean;
  /** EmptyVaultGuard hook (design §3.13, part 3). Called once per scan after the listing. */
  emptyVaultCheck?(o: { seen: number; indexedActive: number }): void;
  /** Items between yields in the missing-file pass (design §3.15 scan batch; default 500). */
  yieldEvery?: number;
  newFileId?: () => string;
}

export interface ScanResult { seen: number; dirty: number; fastPath: number; tracked: number; missing: number }

export async function scanLocal(d: ScanDeps, mode: 'fast' | 'full'): Promise<ScanResult> {
  const seen = new Set<string>();
  const r: ScanResult = { seen: 0, dirty: 0, fastPath: 0, tracked: 0, missing: 0 };
  const mark = (k: DirtyKey, why: DirtyReason): void => {
    r.dirty++;
    d.markDirty(k, why);
  };
  for await (const batch of d.fs.listAll({ includeConfigDir: d.includeConfigDir })) {
    for (const raw of batch) {
      if (raw.kind !== "file") continue;
      const p = normalizePath(raw.path);
      const st = p === raw.path ? raw : { ...raw, path: p };
      seen.add(p);
      const sc = d.scopeOf(p, st.size);
      const e = d.index.byPath(p);
      if (!e) {
        if (sc === "ignored") {
          // D8: a replace temp left by a crash or a torn write before its rename. The target is whole;
          // the temp holds nothing that is not in the state store (intent/staging) or on the remote.
          if (isReplaceTemp(p) && !replaceInFlight(d.fs, p)) await d.fs.remove(p, "delete").catch(() => undefined);
          continue;
        }
        if (sc !== "active") {
          await d.index.trackOutOfScope({ fileId: (d.newFileId ?? newFileId)(), st, scope: sc, kind: d.kindOf(p) });
          r.tracked++;
          continue;
        }
        mark({ path: p, stat: st }, "new");
        continue;
      }
      if (e.scope !== sc) await d.index.setScope(e.fileId, sc);
      if (mode === "fast" && e.obs && fastPathMatch(e.obs, st, d.fs.platform)) {
        r.fastPath++;
        continue;
      }
      mark({ fileId: e.fileId, path: p, stat: st }, "stat-changed");
    }
    await d.scheduler.yieldToUi();
  }
  r.seen = seen.size;
  // design §3.15: yield every scanBatch items here too (I23: no long synchronous slice at 10k files).
  const every = d.yieldEvery ?? 500;
  let n = 0;
  for (const e of d.index.allActive()) {
    if (!seen.has(e.path) && e.obs !== null) {
      r.missing++;
      mark({ fileId: e.fileId, path: e.path }, "missing");
    }
    if (++n % every === 0) await d.scheduler.yieldToUi();
  }
  d.emptyVaultCheck?.({ seen: seen.size, indexedActive: d.index.activeCount() });
  return r;
}

export interface ScanMark { key: DirtyKey; reason: DirtyReason }

export interface PairDeps {
  index: FileIndex;
  /** Content hash of the file at `path` now, null when unreadable. */
  hashNow(path: string): Promise<string | null>;
  /** A delete event for `path` is held by the event queue (design §3.5 delete hold). */
  isDeleteHeld(path: string): boolean;
  /** Apply the rename rule (design §3.6.1) for a pair this scan found; drops any hold on `from`. */
  rename(from: string, to: string): Promise<void>;
}

/**
 * design §3.5 rename pairing for a scan (move = delete + create with the same content). A scan that
 * lands between a move's delete and its create (a watcher that reports in two pieces, or the periodic
 * fast scan, §3.14) sees the old path missing and the new one untracked. Pushed as they are, the move
 * would become a delete plus a create. For a missing entry whose delete event the queue is holding, the
 * scan pairs it the way the event queue would: same size, then the same hash as the entry's last
 * observation. A held entry that found no partner is left to the hold (its expiry marks it missing).
 * Returns the marks that remain.
 */
export async function pairScanRenames(marks: readonly ScanMark[], d: PairDeps): Promise<ScanMark[]> {
  // Only moves whose delete the event queue is holding right now: pairing any missing entry with any
  // same-content new file would also re-key unrelated files (a copy, a rebuild-from-scan).
  const missing = marks.filter((m) => m.reason === "missing" && m.key.fileId !== undefined && d.isDeleteHeld(m.key.path));
  const fresh = marks.filter((m) => m.reason === "new" && m.key.fileId === undefined && m.key.stat !== undefined);
  if (missing.length === 0) return [...marks];
  const drop = new Set<ScanMark>();
  if (fresh.length > 0) {
    const bySize = new Map<number, ScanMark[]>();
    for (const m of fresh) {
      const size = m.key.stat!.size;
      bySize.set(size, [...(bySize.get(size) ?? []), m]);
    }
    const hashes = new Map<string, string | null>();
    for (const m of missing) {
      const e = m.key.fileId ? d.index.byFileId(m.key.fileId) : null;
      if (!e?.obs?.hash || e.path !== m.key.path) continue;
      const cands = (bySize.get(e.obs.size) ?? []).filter((c) => !drop.has(c));
      for (const c of cands) {
        if (!hashes.has(c.key.path)) hashes.set(c.key.path, await d.hashNow(c.key.path));
        if (hashes.get(c.key.path) !== e.obs.hash) continue;
        drop.add(m);
        drop.add(c);
        await d.rename(e.path, c.key.path);
        break;
      }
    }
  }
  for (const m of missing) drop.add(m);
  return marks.filter((m) => !drop.has(m));
}

/** design §3.3.2 localChanged(e). */
export function pendingLocalChange(e: { path: string; obs: { hash: string | null } | null; synced: { path: string; hash: string } | null }): boolean {
  if (!e.synced) return e.obs !== null;
  return e.obs === null || e.path !== e.synced.path || e.obs.hash !== e.synced.hash;
}

/**
 * Startup (part 2 contract for part 3's loop): the dirty set lives in memory, so after a restart every
 * active entry with a recorded but unpushed local change (moved, edited, deleted, never synced) is
 * marked again. The fast-path scan cannot see these: their stat matches the stored observation.
 */
export function markPendingLocalChanges(index: FileIndex, markDirty: (k: DirtyKey, r: DirtyReason) => void): number {
  let n = 0;
  for (const e of index.allActive()) {
    if (!pendingLocalChange(e)) continue;
    markDirty({ fileId: e.fileId, path: e.path }, "redirty");
    n++;
  }
  return n;
}
