// Random identifiers (design §2.3: fileId = 16 random bytes hex32; cid = UUIDv4).
// Uses globalThis.crypto.getRandomValues, available in Obsidian (browser, iOS WebKit) and Node 22.

import type { FileId } from "@shuttle/protocol";
import { toHex } from "./bytes";

export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (n) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

/** A fresh fileId: 16 random bytes, lowercase hex (32 chars). */
export function newFileId(rand: RandomBytes = cryptoRandomBytes): FileId {
  return toHex(rand(16));
}

/** UUIDv4 string (RFC 4122 variant bits). */
export function uuidV4(rand: RandomBytes = cryptoRandomBytes): string {
  const b = rand(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
