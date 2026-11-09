// Notice rate limiting (design §5.9): `notice.error` at most once per error kind per 10 minutes, and
// only on a transition into `error`; network trouble alone never shows a notice. Pure.

import type { EngineStatus } from "@shuttle/protocol";

export const ERROR_NOTICE_EVERY_MS = 10 * 60 * 1000;

export class ErrorNoticeGate {
  private last = new Map<string, number>();
  private prev: EngineStatus["status"] | null = null;

  /** The reason to show now, or null. Feed every status update. */
  next(s: EngineStatus | null, now: number): string | null {
    const prev = this.prev;
    this.prev = s?.status ?? null;
    if (!s || s.status !== "error" || prev === "error") return null;
    const kind = s.reason ?? "error";
    const at = this.last.get(kind);
    if (at !== undefined && now - at < ERROR_NOTICE_EVERY_MS) return null;
    this.last.set(kind, now);
    return kind;
  }
}

/** True once per profile when the first full sync completes (design §5.5.8 `notice.firstSyncDone`). */
export function firstSyncDone(s: EngineStatus | null, alreadyNoted: boolean): boolean {
  return !alreadyNoted && !!s && s.status === "synced" && s.pendingUp === 0 && s.pendingDown === 0 && !s.locked;
}
