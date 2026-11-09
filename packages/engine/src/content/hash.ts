// Content hash (design §2.3.1, ID-3): `meta.hash` = lowercase hex SHA-256 of the whole plaintext file.
// SubtleCrypto only (globalThis.crypto.subtle exists in Obsidian desktop, iOS WebKit and Node 22).

import type { LocalFs } from "@shuttle/protocol";
import { ownBuffer, toHex } from "../util/bytes";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", ownBuffer(bytes));
  return toHex(new Uint8Array(d));
}

/** Hash of the empty file, handy for tests and the "empty local note" refinement (design §3.10.6). */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface HashedFile { bytes: Uint8Array; hash: string; size: number }

/** Read the whole file once and hash it (mobile has no range reads, design §3.2). */
export async function readAndHash(fs: LocalFs, path: string): Promise<HashedFile> {
  const bytes = await fs.read(path);
  return { bytes, hash: await sha256Hex(bytes), size: bytes.length };
}
