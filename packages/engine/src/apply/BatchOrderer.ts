// BatchOrderer (design §3.8.2; engine-spec §5.2). Pure.
//  1. Path-freeing entries (deletes, moves away) before the entries that need those paths.
//  2. Otherwise notes (.md, .canvas, .base) and config first, then attachments by size ascending
//     (UX-D7), ties by seq.
//  3. Swaps and rename cycles are returned separately; the applier breaks each one with a temporary
//     `.shuttle-swap-<rand>-<basename>` rename (a dotfile, so `ignored` by the path filter).

import type { FileId, RemoteHead } from "@shuttle/protocol";
import { basename, dirname, extname, foldKey, join } from "../path/normalize";

export interface OrderItem {
  fileId: FileId;
  R: RemoteHead;
  /** Where the file is locally now (entry path), or null if untracked. */
  localPath: string | null;
}

export interface ApplyOrder {
  /** Applied one by one in this order. */
  order: FileId[];
  /** Each cycle is applied together (one member parked on a swap path first). */
  cycles: FileId[][];
}

const NOTE_EXT = new Set(["md", "canvas", "base"]);

function rank(i: OrderItem, configDir: string): number {
  if (i.R.deleted) return 0;
  const p = i.R.path;
  if (p === configDir || p.startsWith(configDir + "/")) return 1;
  if (NOTE_EXT.has(extname(p).toLowerCase())) return 1;
  return 2;
}

export function orderApplies(items: readonly OrderItem[], configDir: string): ApplyOrder {
  const byId = new Map(items.map((i) => [i.fileId, i] as const));
  // holder: foldKey of a current local path → the item whose file is there and leaves it.
  const leaving = new Map<string, FileId>();
  for (const i of items) {
    if (i.localPath === null) continue;
    const away = i.R.deleted || foldKey(i.localPath) !== foldKey(i.R.path);
    if (away) leaving.set(foldKey(i.localPath), i.fileId);
  }
  // Edge B → A: B frees the path A needs.
  const deps = new Map<FileId, FileId[]>();
  for (const i of items) {
    if (i.R.deleted) continue;
    const need = foldKey(i.R.path);
    if (i.localPath !== null && foldKey(i.localPath) === need) continue;
    const b = leaving.get(need);
    if (b && b !== i.fileId) deps.set(i.fileId, [...(deps.get(i.fileId) ?? []), b]);
  }
  const sorted = [...items].sort((a, b) => {
    const r = rank(a, configDir) - rank(b, configDir);
    if (r !== 0) return r;
    if (rank(a, configDir) === 2 && a.R.size !== b.R.size) return a.R.size - b.R.size;
    return a.R.seq - b.R.seq;
  });
  // Tarjan SCC over deps for cycles, then DFS post-order for the rest.
  let idx = 0;
  const index = new Map<FileId, number>();
  const low = new Map<FileId, number>();
  const onStack = new Set<FileId>();
  const stack: FileId[] = [];
  const comp = new Map<FileId, FileId[]>();
  const strong = (v: FileId): void => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!byId.has(w)) continue;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const c: FileId[] = [];
      for (;;) {
        const w = stack.pop() as FileId;
        onStack.delete(w);
        c.push(w);
        if (w === v) break;
      }
      for (const w of c) comp.set(w, c);
    }
  };
  for (const i of sorted) if (!index.has(i.fileId)) strong(i.fileId);

  const order: FileId[] = [];
  const cycles: FileId[][] = [];
  const done = new Set<FileId>();
  const visit = (v: FileId): void => {
    if (done.has(v)) return;
    const c = comp.get(v) ?? [v];
    for (const m of c) done.add(m);
    for (const m of c) for (const w of deps.get(m) ?? []) if (byId.has(w) && !c.includes(w)) visit(w);
    if (c.length > 1) {
      const rankOf = new Map(sorted.map((s, k) => [s.fileId, k] as const));
      cycles.push([...c].sort((a, b) => (rankOf.get(a) as number) - (rankOf.get(b) as number)));
    } else order.push(v);
  };
  for (const i of sorted) visit(i.fileId);
  return { order, cycles };
}

/** Temporary path for breaking a swap (design §3.8.2 step 3). */
export function swapPath(path: string, rand: string): string {
  return join(dirname(path), `.shuttle-swap-${rand}-${basename(path)}`);
}
