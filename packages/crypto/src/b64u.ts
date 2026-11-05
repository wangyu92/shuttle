// RFC 4648 §5 base64url without padding. Decoding is strict: rejects padding, foreign
// characters and non-canonical trailing bits, so every value has exactly one encoding.
import type { Bytes } from "./bytes.js";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) REV[ALPHA.charCodeAt(i)] = i;

export function b64u(u: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < u.length; i += 3) {
    const n = ((u[i] as number) << 16) | ((u[i + 1] as number) << 8) | (u[i + 2] as number);
    s += ALPHA[(n >> 18) & 63]! + ALPHA[(n >> 12) & 63]! + ALPHA[(n >> 6) & 63]! + ALPHA[n & 63]!;
  }
  const rest = u.length - i;
  if (rest === 1) {
    const n = (u[i] as number) << 16;
    s += ALPHA[(n >> 18) & 63]! + ALPHA[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((u[i] as number) << 16) | ((u[i + 1] as number) << 8);
    s += ALPHA[(n >> 18) & 63]! + ALPHA[(n >> 12) & 63]! + ALPHA[(n >> 6) & 63]!;
  }
  return s;
}

export function fromB64u(s: string): Bytes {
  if (s.length % 4 === 1) throw new Error("invalid base64url length");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? (REV[c] as number) : -1;
    if (v < 0) throw new Error("invalid base64url character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new Error("non-canonical base64url");
  return out;
}

/** Decodes and requires an exact byte length. */
export function fromB64uLen(s: unknown, n: number): Bytes {
  if (typeof s !== "string") throw new Error("expected base64url string");
  const b = fromB64u(s);
  if (b.length !== n) throw new Error(`expected ${n} bytes, got ${b.length}`);
  return b;
}
