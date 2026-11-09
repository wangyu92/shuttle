// Startup / periodic local scan with the fast path (design §3.4.1; engine-spec §3.1).
// No IO for unchanged files (I23): only listAll() stats are compared with the stored observation;
// hashing is deferred to reconcile().

import type { FileKind, LocalFs, Scheduler } from "@shuttle/protocol";
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
        if (sc === "ignored") continue;
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
