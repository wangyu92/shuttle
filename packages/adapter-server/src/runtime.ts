// Default Clock and Scheduler over the host's timers, plus small helpers. Browser-safe: only
// globalThis.setTimeout, Date and performance, which exist in Obsidian (desktop and mobile) and Node.

import type { Clock, Scheduler, TimerHandle } from "@shuttle/protocol";
import { remoteError } from "@shuttle/protocol";

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

/** Scheduler over globalThis timers. Handles are numbers so the type matches the protocol. */
export function realScheduler(): Scheduler {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  return {
    setTimer(ms, fn) {
      const id = next++;
      timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, Math.max(0, ms)));
      return id;
    },
    clearTimer(h: TimerHandle) {
      const t = timers.get(h);
      if (t !== undefined) { clearTimeout(t); timers.delete(h); }
    },
    yieldToUi: () => new Promise<void>((r) => setTimeout(r, 0)),
    idle: (timeoutMs = 0) => new Promise<void>((r) => setTimeout(r, Math.min(timeoutMs, 50))),
  };
}

/**
 * Race `p` against a timer. The HttpClient contract already takes `timeoutMs`, but the plugin's
 * requestUrl has no timeout of its own (design §2.8.5), so the adapter enforces it as well.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, sched: Scheduler, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const h = sched.setTimer(ms, () => {
      if (done) return;
      done = true;
      reject(remoteError("TIMEOUT", `${what}: no answer within ${ms} ms`));
    });
    p.then(
      (v) => { if (!done) { done = true; sched.clearTimer(h); resolve(v); } },
      (e: unknown) => { if (!done) { done = true; sched.clearTimer(h); reject(e); } },
    );
  });
}

/** Lowercase hex SHA-256 via WebCrypto (available in Obsidian and Node 22). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw remoteError("UNSUPPORTED", "WebCrypto is not available");
  const digest = new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(bytes)));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

/** An ArrayBuffer holding exactly `bytes` (a view may cover only part of its buffer). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const encoder = new TextEncoder();
export function utf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
