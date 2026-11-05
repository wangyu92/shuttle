// Padding (§4.6.3, §4.6.4): ISO/IEC 7816-4 marker (0x80 then zeros), Padmé targets, meta buckets.
import type { Bytes } from "./bytes.js";

/** Padmé (Nikitin et al., PETS 2019); identity for L < 2. Integer arithmetic only. */
export function padme(L: number): number {
  if (!Number.isSafeInteger(L) || L < 0 || L >= 2 ** 32) throw new RangeError("padme: length out of range");
  if (L < 2) return L;
  const E = 31 - Math.clz32(L);
  const S = 31 - Math.clz32(E) + 1;
  const z = E - S;
  const unit = 2 ** z;
  return Math.ceil(L / unit) * unit;
}

/** Padded length for a Padmé-padded body of `len` bytes (marker included), capped at `cap`. */
export function padmeTarget(len: number, cap = Number.MAX_SAFE_INTEGER): number {
  return Math.max(len + 1, Math.min(padme(len + 1), cap));
}

/** Meta plaintext length after bucket padding: the next multiple of `bucket` that fits len + marker. */
export function metaPadLen(len: number, bucket = 256): number {
  return Math.ceil((len + 1) / bucket) * bucket;
}

export function padIso(pt: Uint8Array, target: number): Bytes {
  if (target < pt.length + 1) throw new RangeError("pad target too small");
  const o = new Uint8Array(target);
  o.set(pt);
  o[pt.length] = 0x80;
  return o;
}

/** Strips trailing zeros, then requires the 0x80 marker. Throws on malformed padding. */
export function unpadIso(p: Uint8Array): Uint8Array {
  let i = p.length - 1;
  while (i >= 0 && p[i] === 0) i--;
  if (i < 0 || p[i] !== 0x80) throw new Error("bad padding");
  return p.subarray(0, i);
}
