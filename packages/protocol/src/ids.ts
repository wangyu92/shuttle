// Identifier and primitive format checks (design §2.3, §2.4).
// Pure functions; no platform APIs.

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64U = /^[A-Za-z0-9_-]*$/;
const B64U22 = /^[A-Za-z0-9_-]{21}[AQgw]$/; // 16 bytes: last char carries 2 data bits + 4 zero bits
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** fileId: 16 random bytes, lowercase hex (32 chars). */
export function isFileId(v: unknown): v is string {
  return typeof v === "string" && HEX32.test(v);
}

/** blobId: HMAC-SHA256 output, lowercase hex (64 chars). Lowercase only so lookups never miss on case. */
export function isBlobId(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

/** Lowercase hex SHA-256 (meta.hash, X-Shuttle-Sha256). */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

/** Unpadded base64url of exactly 16 bytes (22 chars, canonical trailing char). vaultId, pathKey, pairId. */
export function isB64u16(v: unknown): v is string {
  return typeof v === "string" && B64U22.test(v);
}

export const isVaultId = isB64u16;
export const isPathKey = isB64u16;
export const isPairId = isB64u16;

/** Unpadded base64url, any length > 0 (charset and length-mod-4 check only). */
export function isB64u(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length % 4 !== 1 && B64U.test(v);
}

/** deviceId: b64u, 1..64 chars (server assigns 16 bytes; S3 clients generate their own). */
export function isDeviceId(v: unknown): v is string {
  return isB64u(v) && (v as string).length <= 64;
}

/** cid: UUID (v4 by construction, any UUID form accepted on the wire). */
export function isCid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Non-negative safe integer. */
export function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Positive safe integer. */
export function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Seq: vault-wide monotonic safe integer >= 0 (0 = nothing yet; a record's own seq is >= 1). */
/**
 * Largest seq any party accepts (2^52). Seqs stay exact JavaScript numbers with headroom: SQLite stores
 * larger integers, but node:sqlite then throws on every read of the row (design §2.4 ID-10).
 */
export const MAX_SEQ = 2 ** 52;

export function isSeq(v: unknown): v is number {
  return isNonNegInt(v) && v <= MAX_SEQ;
}

/** Decoded byte length of an unpadded base64url string, without allocating. */
export function b64uDecodedLength(s: string): number {
  return Math.floor((s.length * 6) / 8);
}

const HEX_CHARS = "0123456789abcdef";

/** Lowercase hex to bytes. Throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes to lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += (HEX_CHARS[b >> 4] ?? "") + (HEX_CHARS[b & 15] ?? "");
  return s;
}
