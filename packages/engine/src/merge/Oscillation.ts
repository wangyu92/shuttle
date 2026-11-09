// Conflict-loop fallback (design §3.10.1) and config oscillation detector (design §3.10.3, S19).
// Small stateful helpers with an injected monotonic clock; not persisted (session scope).

import type { Clock, FileId } from "@shuttle/protocol";

export const CONFLICT_LOOP_COUNT = 5;
export const CONFLICT_LOOP_WINDOW_MS = 60_000;
export const OSCILLATION_FLIPS = 4;
export const OSCILLATION_WINDOW_MS = 60 * 60 * 1000;

/** After 5 consecutive CONFLICTs on one fileId within 60 s, the next resolution is a conflict copy. */
export class ConflictLoopTracker {
  private hits = new Map<FileId, number[]>();
  constructor(private readonly clock: Pick<Clock, "monotonic">) {}

  recordConflict(fileId: FileId): void {
    const now = this.clock.monotonic();
    const list = (this.hits.get(fileId) ?? []).filter((t) => now - t <= CONFLICT_LOOP_WINDOW_MS);
    list.push(now);
    this.hits.set(fileId, list);
  }

  /** A successful commit breaks the streak. */
  recordSuccess(fileId: FileId): void {
    this.hits.delete(fileId);
  }

  tripped(fileId: FileId): boolean {
    const now = this.clock.monotonic();
    const list = (this.hits.get(fileId) ?? []).filter((t) => now - t <= CONFLICT_LOOP_WINDOW_MS);
    return list.length >= CONFLICT_LOOP_COUNT;
  }
}

/**
 * Stops syncing a config file on this device when its canonical value alternates between two values
 * more than 4 times per hour (design §3.10.3). Feed it the canonical JSON string of every value the
 * file takes (local writes and applied remote heads).
 */
export class OscillationDetector {
  private seen = new Map<string, Array<{ t: number; v: string }>>();
  constructor(private readonly clock: Pick<Clock, "monotonic">) {}

  /** Returns true when the file is oscillating and should be set `excluded` for the session. */
  observe(key: string, canonicalValue: string): boolean {
    const now = this.clock.monotonic();
    const list = (this.seen.get(key) ?? []).filter((x) => now - x.t <= OSCILLATION_WINDOW_MS);
    const last = list[list.length - 1];
    if (!last || last.v !== canonicalValue) list.push({ t: now, v: canonicalValue });
    this.seen.set(key, list);
    const distinct = new Set(list.map((x) => x.v));
    if (distinct.size !== 2) return false;
    return list.length - 1 > OSCILLATION_FLIPS;
  }

  forget(key: string): void {
    this.seen.delete(key);
  }
}
