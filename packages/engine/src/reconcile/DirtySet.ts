// Dirty set (design §3.4.2): events, scans and ingests mark keys; the sync loop drains them through
// reconcile(). Key = fileId when known, else path. Nothing is dropped: a key that is locked or
// deferred (Locked state, budget) is simply marked again.

import type { DirtyKey, DirtyReason } from "../types";

export interface DirtyItem { key: DirtyKey; reason: DirtyReason }

const keyOf = (k: DirtyKey): string => (k.fileId ? `f:${k.fileId}` : `p:${k.path}`);

export class DirtySet {
  private m = new Map<string, DirtyItem>();
  private listeners = new Set<() => void>();

  mark(key: DirtyKey, reason: DirtyReason): void {
    const k = keyOf(key);
    const prev = this.m.get(k);
    // Keep the extra Planner input (pathTaken) and the newest path.
    const merged: DirtyKey = { ...(prev?.key ?? {}), ...key };
    if (key.fileId) this.m.delete(`p:${key.path}`);
    this.m.set(k, { key: merged, reason });
    for (const l of this.listeners) l();
  }

  has(key: DirtyKey): boolean {
    return this.m.has(keyOf(key));
  }

  get size(): number {
    return this.m.size;
  }

  /** Remove and return up to `n` items in insertion order. */
  take(n = Infinity): DirtyItem[] {
    const out: DirtyItem[] = [];
    for (const [k, v] of this.m) {
      if (out.length >= n) break;
      out.push(v);
      this.m.delete(k);
    }
    return out;
  }

  peek(): DirtyItem[] {
    return [...this.m.values()];
  }

  clear(): void {
    this.m.clear();
  }

  /** Called after every mark (the sync loop's kick, part 3). */
  onMark(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
