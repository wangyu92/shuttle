// Byte helpers shared by engine modules (design §3.1 util/bytes.ts). Pure; no node:* imports.

const enc = new TextEncoder();
const strictDec = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s);
}

/** Decode UTF-8, or null when the bytes are not valid UTF-8 (design §3.10.2: such files merge as `other`). */
export function utf8DecodeStrict(b: Uint8Array): string | null {
  try {
    return strictDec.decode(b);
  } catch {
    return null;
  }
}

const HEX = "0123456789abcdef";

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const v = b[i] as number;
    s += HEX[v >> 4]! + HEX[v & 15]!;
  }
  return s;
}

/** A copy backed by a plain ArrayBuffer (SubtleCrypto rejects SharedArrayBuffer-backed views). */
export function ownBuffer(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
