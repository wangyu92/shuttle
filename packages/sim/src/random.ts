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
