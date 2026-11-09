// Local event timing constants (design §3.5 is the source of truth for these values; §3.6.2 for echo TTL).
// Sync's own values are UNVERIFIED; all are configurable through LocalEventQueue options.

/** Per-path settle time after the last modify/create event. */
export const DEBOUNCE_SETTLE_MS = 1500;
/** A path that keeps changing is flushed at the latest this long after its first event. */
export const DEBOUNCE_MAX_WAIT_MS = 10_000;
/** A file delete waits this long for a matching create (unlink+add = move). */
export const DELETE_HOLD_MS = 500;
/** `raw` events under configDir. */
export const RAW_DEBOUNCE_MS = 2000;
/** Expected engine writes (echo suppression). */
export const ECHO_TTL_MS = 30_000;

export interface EventTimings {
  settleMs: number;
  maxWaitMs: number;
  deleteHoldMs: number;
  rawDebounceMs: number;
}

export const DEFAULT_EVENT_TIMINGS: Readonly<EventTimings> = Object.freeze({
  settleMs: DEBOUNCE_SETTLE_MS,
  maxWaitMs: DEBOUNCE_MAX_WAIT_MS,
  deleteHoldMs: DELETE_HOLD_MS,
  rawDebounceMs: RAW_DEBOUNCE_MS,
});
