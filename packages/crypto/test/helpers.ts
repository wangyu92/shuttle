import V from "../vectors/vectors-v1.json" with { type: "json" };
import { fromHex } from "../src/bytes.js";
import { SxKeyring } from "../src/keyring.js";
import { rng } from "../src/rng.js";
import { vectorPassphrase } from "../src/selftest.js";
import type { Secret } from "./h3.js";

export { V };

/** Runs `fn` with rng.fill returning the given byte strings in order (test-only nonce seam). */
export async function withNonces<T>(hexes: string[], fn: () => Promise<T>): Promise<T> {
  const orig = rng.fill;
  const queue = hexes.map(fromHex);
  rng.fill = (u) => {
    const next = queue.shift();
    if (!next || next.length !== u.length) throw new Error("test rng: unexpected request");
    u.set(next);
  };
  try {
    const r = await fn();
    if (queue.length) throw new Error("test rng: unused nonces");
    return r;
  } finally {
    rng.fill = orig;
  }
}

export async function vectorRing(withKv2 = false): Promise<SxKeyring> {
  const m = new Map<number, Uint8Array>([[1, fromHex(V.inputs.vmk1Hex)]]);
  if (withKv2) m.set(2, fromHex(V.inputs.vmk2Hex));
  return SxKeyring.fromVmks(V.inputs.vaultId, m, withKv2 ? 2 : 1);
}

/** design §7.2 H3: the vector passphrase and VMKs, scanned for in every crypto suite's console output. */
export function vectorSecrets(): Secret[] {
  return [
    { name: "vector passphrase", value: vectorPassphrase().normalize("NFC") },
    { name: "vector VMK 1", value: fromHex(V.inputs.vmk1Hex) },
    { name: "vector VMK 2", value: fromHex(V.inputs.vmk2Hex) },
  ];
}
