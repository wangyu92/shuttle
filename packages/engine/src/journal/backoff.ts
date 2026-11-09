// Per-batch retry backoff (design §3.7.4): 1 s → 5 min, ×2, ±20 % jitter.

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
export const BACKOFF_JITTER = 0.2;

/** Delay before attempt number `attempts` (1-based). `random` returns [0, 1). */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempts));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(n - 1, 30));
  const j = 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random();
  return Math.round(base * j);
}
