// The only randomness source. Production code never takes a nonce parameter (§4.6.2);
// tests replace `rng.fill` through this internal object (not re-exported from index.ts).
export const rng = {
  fill(u: Uint8Array<ArrayBuffer>): void {
    for (let off = 0; off < u.length; off += 65536) {
      globalThis.crypto.getRandomValues(u.subarray(off, Math.min(u.length, off + 65536)));
    }
  },
};

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const u = new Uint8Array(n);
  rng.fill(u);
  return u;
}
