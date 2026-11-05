// Byte helpers. No Node APIs (no Buffer): this package runs in Obsidian mobile WebViews.
export type Bytes = Uint8Array<ArrayBuffer>;

const te = new TextEncoder();
const tdFatal = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Bytes {
  return te.encode(s);
}

/** Strict UTF-8 decode (throws on malformed input). */
export function fromUtf8(b: Uint8Array): string {
  return tdFatal.decode(b);
}

/** Returns a view backed by a plain ArrayBuffer (copies only when needed), as WebCrypto typings require. */
export function ab(u: Uint8Array): Bytes {
  if (u.buffer instanceof ArrayBuffer) return u as Bytes;
  const o = new Uint8Array(u.length);
  o.set(u);
  return o;
}

export function concat(...parts: Uint8Array[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const o = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    o.set(p, off);
    off += p.length;
  }
  return o;
}

const HEX = "0123456789abcdef";

export function toHex(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) {
    const b = u[i] as number;
    s += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return s;
}

/** Lowercase hex only (identifiers are lowercase on the wire). */
export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error("invalid hex");
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return o;
}

/** Constant-time comparison for equal-length secrets; length itself is not secret. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}
