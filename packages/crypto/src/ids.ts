// Identifier derivations (§2.3, §4.7).
import { b64u } from "./b64u.js";
import { toHex, utf8 } from "./bytes.js";
import { randomBytes } from "./rng.js";
import { hmacSign, sha256 } from "./suite-sx1.js";

/** The path form hashed into pathKey: NFC, then toLowerCase. */
export function pathKeyInput(path: string): string {
  return "p\0" + path.normalize("NFC").toLowerCase();
}

export async function derivePathKey(kPathkey: CryptoKey, path: string): Promise<string> {
  return b64u((await hmacSign(kPathkey, utf8(pathKeyInput(path)))).subarray(0, 16));
}

/** blobId = hex(HMAC(K_blobid, SHA-256(chunk))) over the raw chunk. */
export async function deriveBlobId(kBlobid: CryptoKey, chunk: Uint8Array): Promise<{ blobId: string; sha256: Uint8Array }> {
  const h = await sha256(chunk);
  return { blobId: toHex(await hmacSign(kBlobid, h)), sha256: h };
}

/**
 * RESERVED (§4.3): HMAC fileId = hex(HMAC(K_fileid, "f\0" + NFC(path))[0..16]). Unused in v1,
 * where fileIds are random (ID-1); kept so the vectors prove NFD -> NFC normalization.
 */
export async function deriveReservedFileId(kFileid: CryptoKey, path: string): Promise<string> {
  return toHex((await hmacSign(kFileid, utf8("f\0" + path.normalize("NFC")))).subarray(0, 16));
}

/** v1 fileId: 16 random bytes, hex (§2.3). */
export function newFileId(): string {
  return toHex(randomBytes(16));
}

export function newVaultId(): string {
  return b64u(randomBytes(16));
}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}
