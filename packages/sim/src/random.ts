// Deterministic randomness for one simulation run (design §7.4: a failing seed replays bit for bit).
// The engine draws fileIds and cids from globalThis.crypto.getRandomValues (engine util/uuid.ts), so
// the sim swaps that method for a seeded stream while a run is active and restores it afterwards.
// Only the sim process does this; production code is untouched.

import { Prng } from "@shuttle/testkit";

type GetRandomValues = <T extends ArrayBufferView | null>(array: T) => T;

let installed: { prev: GetRandomValues; prng: Prng } | null = null;

/** Route crypto.getRandomValues through `prng` until the returned function is called. */
export function installDeterministicRandom(prng: Prng): () => void {
  const c = globalThis.crypto as unknown as { getRandomValues: GetRandomValues };
  if (installed) throw new Error("installDeterministicRandom: a run is already active (runs are sequential)");
  const prev = c.getRandomValues;
  installed = { prev, prng };
  const fake: GetRandomValues = (array) => {
    if (array === null) return array;
    const view = array as unknown as ArrayBufferView;
    const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    u8.set(prng.bytes(u8.length));
    return array;
  };
  c.getRandomValues = fake;
  return () => {
    c.getRandomValues = prev;
    installed = null;
  };
}

/**
 * Deterministic asynchrony for one run (design §7.4). WebCrypto completes on a thread pool, so the
 * order of its completions against the fakes' macrotask hops (feed delivery, drains) depends on
 * wall time: the same seed could take a different path. While installed, every crypto.subtle call
 * and every testkit macrotask hop goes through one FIFO queue. Entries run one per macrotask in the
 * order they were queued; a crypto entry first waits for its real result. Call order is
 * deterministic, so the order of everything the engine observes is too.
 * Returns the uninstall function, which waits until the queue is empty.
 */
export function installDeterministicAsync(setHook: (h: ((fn: () => void) => void) | null) => unknown): () => Promise<void> {
  const realSetImmediate = globalThis.setImmediate.bind(globalThis);
  const q: Array<{ wait: Promise<unknown> | null; run: () => void }> = [];
  let pumping = false;
  let idle: Array<() => void> = [];
  const pump = async (): Promise<void> => {
    const e = q.shift();
    if (!e) {
      pumping = false;
      const w = idle;
      idle = [];
      for (const f of w) f();
      return;
    }
    if (e.wait) await e.wait.then(() => undefined, () => undefined);
    e.run();
    // The next entry runs after the microtasks this one started (setImmediate is a macrotask).
    realSetImmediate(() => { void pump(); });
  };
  const enqueue = (wait: Promise<unknown> | null, run: () => void): void => {
    q.push({ wait, run });
    if (!pumping) {
      pumping = true;
      realSetImmediate(() => { void pump(); });
    }
  };
  setHook((fn) => enqueue(null, fn));
  const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
  const names = ["encrypt", "decrypt", "sign", "verify", "digest", "generateKey", "deriveKey", "deriveBits", "importKey", "exportKey", "wrapKey", "unwrapKey"];
  const patched: string[] = [];
  for (const n of names) {
    const orig = subtle[n];
    if (typeof orig !== "function") continue;
    const f = orig as (...a: unknown[]) => Promise<unknown>;
    subtle[n] = (...args: unknown[]): Promise<unknown> => {
      let real: Promise<unknown>;
      try {
        real = f.apply(globalThis.crypto.subtle, args);
      } catch (e) {
        real = Promise.reject(e);
      }
      return new Promise((resolve, reject) => { enqueue(real, () => { real.then(resolve, reject); }); });
    };
    patched.push(n);
  }
  return async () => {
    // Let everything already queued finish (background work of the stopped engines).
    for (let i = 0; i < 1000 && (pumping || q.length > 0); i++) await new Promise<void>((r) => { idle.push(r); if (!pumping && q.length === 0) r(); });
    setHook(null);
    for (const n of patched) delete subtle[n];
  };
}
