// Per-request timeouts in the engine (design §3.7.4, engine-spec §4.5): `requestUrl` has no timeout or
// cancel, so every remote call is raced against a timer from the injected Scheduler: 60 s for
// metadata, 30 s + size / 64 KiB/s for blobs. A timed-out request may still complete on the server;
// that is safe because every remote call is idempotent (commit per cid, blobs content-addressed). The
// late result is dropped, a late rejection is swallowed, and the timer is always cleared.
//
// Not timed: subscribe/ack (the feed has its own liveness), close, runMaintenance (long-running by
// design; it takes an AbortSignal), and the capability/kind getters.

import { RemoteError, type RemoteAdapter, type Scheduler } from "@shuttle/protocol";

export const METADATA_TIMEOUT_MS = 60_000;
export const BLOB_TIMEOUT_BASE_MS = 30_000;
/** Assumed worst-case transfer rate for the size-dependent part of a blob timeout. */
export const BLOB_TIMEOUT_BYTES_PER_S = 64 * 1024;

/** design §3.7.4: `30 s + size / 64 KiB/s`. */
export function blobTimeoutMs(bytes: number): number {
  return BLOB_TIMEOUT_BASE_MS + Math.ceil((Math.max(0, bytes) / BLOB_TIMEOUT_BYTES_PER_S) * 1000);
}

/** Race `p` against `ms` on the scheduler; reject with a retryable TIMEOUT RemoteError. */
export function withTimeout<T>(scheduler: Scheduler, ms: number, what: string, start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const h = scheduler.setTimer(ms, () => {
      if (settled) return;
      settled = true;
      reject(new RemoteError("TIMEOUT", `${what} timed out after ${ms} ms`, true));
    });
    let p: Promise<T>;
    try {
      p = start();
    } catch (e) {
      settled = true;
      scheduler.clearTimer(h);
      reject(e);
      return;
    }
    p.then((v) => {
      if (settled) return;
      settled = true;
      scheduler.clearTimer(h);
      resolve(v);
    }, (e: unknown) => {
      if (settled) return;
      settled = true;
      scheduler.clearTimer(h);
      reject(e);
    });
  });
}

const METADATA_METHODS = [
  "connect", "getVaultInfo", "createVaultInfo", "updateVaultInfo", "missingBlobs", "commit", "pull", "snapshot",
  "getVersion", "listVersions", "listDeleted", "usage", "listDevices", "revokeDevice", "createEnrollCode",
  "pairingPut", "pairingTake", "rebuild",
] as const;

/**
 * A RemoteAdapter view with the design's request timeouts. Optional methods exist on the view only
 * when the wrapped adapter has them; `kind` and `capabilities` are read live (capabilities are
 * provisional until connect()).
 */
export function withRequestTimeouts(inner: RemoteAdapter, scheduler: Scheduler): RemoteAdapter {
  const maxBlob = (): number => inner.capabilities.limits.maxBlobSize;
  const out: Record<string, unknown> = {};
  Object.defineProperty(out, "kind", { enumerable: true, get: () => inner.kind });
  Object.defineProperty(out, "capabilities", { enumerable: true, get: () => inner.capabilities });
  const target = inner as unknown as Record<string, unknown>;
  for (const m of METADATA_METHODS) {
    const f = target[m];
    if (typeof f !== "function") continue;
    out[m] = (...args: unknown[]) => withTimeout(scheduler, METADATA_TIMEOUT_MS, m, () => (f as (...a: unknown[]) => Promise<unknown>).apply(inner, args));
  }
  out.putBlob = (id: string, bytes: Uint8Array) => withTimeout(scheduler, blobTimeoutMs(bytes.length), "putBlob", () => inner.putBlob(id, bytes));
  // The chunk size is unknown at this layer: the largest blob the remote accepts bounds it.
  out.getBlob = (id: string) => withTimeout(scheduler, blobTimeoutMs(maxBlob()), "getBlob", () => inner.getBlob(id));
  if (inner.putBlobs) {
    const f = inner.putBlobs.bind(inner);
    out.putBlobs = (items: Array<{ id: string; bytes: Uint8Array }>) =>
      withTimeout(scheduler, blobTimeoutMs(items.reduce((n, x) => n + x.bytes.length, 0)), "putBlobs", () => f(items));
  }
  if (inner.getBlobs) {
    const f = inner.getBlobs.bind(inner);
    out.getBlobs = (ids: string[], maxBytes: number) => withTimeout(scheduler, blobTimeoutMs(maxBytes), "getBlobs", () => f(ids, maxBytes));
  }
  out.close = () => inner.close();
  out.subscribe = (since: number | null, sink: Parameters<RemoteAdapter["subscribe"]>[1]) => inner.subscribe(since, sink);
  out.ack = (upTo: number) => inner.ack(upTo);
  if (inner.runMaintenance) {
    const f = inner.runMaintenance.bind(inner);
    out.runMaintenance = (signal?: AbortSignal) => f(signal);
  }
  return out as unknown as RemoteAdapter;
}
