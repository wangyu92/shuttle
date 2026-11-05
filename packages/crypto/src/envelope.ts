// Envelopes (§4.6): blob (binary), record meta and inline body (b64u nonce||ct||tag), key wrap.
import { deflateSync, inflateSync } from "fflate";
import { blobAad, isBlobId, LABEL_INLINE, LABEL_META, type RecordHeader, recordAad, wrapAad } from "./aad.js";
import { b64u, fromB64u } from "./b64u.js";
import { type Bytes, concat, fromUtf8, utf8 } from "./bytes.js";
import { CryptoError } from "./errors.js";
import { metaPadLen, padIso, padmeTarget, unpadIso } from "./pad.js";
import { randomBytes } from "./rng.js";
import { gcmDecrypt, gcmEncrypt, NONCE_LEN, TAG_LEN } from "./suite-sx1.js";

export const BLOB_MAGIC = Uint8Array.of(0x53, 0x58, 0x42, 0x31); // "SXB1"
export const BLOB_HEADER_LEN = 4 + 1 + 1 + NONCE_LEN; // 18
export const BLOB_OVERHEAD = BLOB_HEADER_LEN + TAG_LEN; // 34
export const FLAG_DEFLATE = 1;
export const FLAG_PADME = 2;
export const MAX_BLOB_SIZE = 4 * 1024 * 1024 + 1024; // §2.3.1
export const MAX_SEALED_META = 1024 * 1024; // §4.6.3
export const MAX_META_DEPTH = 8;

/**
 * deflate-raw is used only when it saves at least 10 %: compressed * 10 <= plain * 9.
 * The same rule is mirrored in vectors/gen.mjs and vectors/xcheck.py.
 */
export function compressIfWorth(plain: Uint8Array): Uint8Array | null {
  if (plain.length === 0) return null;
  const z = deflateSync(plain);
  return z.length * 10 <= plain.length * 9 ? z : null;
}

/** Inflate with a hard output cap (anti-bomb): output must be exactly `expected` bytes. */
export function inflateExact(z: Uint8Array, expected: number): Uint8Array {
  const out = inflateSync(z, { out: new Uint8Array(expected + 1) });
  if (out.length !== expected) throw new Error("inflated size mismatch");
  return out;
}

// ---------- blob ----------

export interface SealBlobOptions {
  compress: boolean;
  pad: boolean;
  chunkMax: number;
}

export async function sealBlobRaw(kContent: CryptoKey, kv: number, vaultId: string, chunk: Uint8Array, blobId: string, o: SealBlobOptions): Promise<Bytes> {
  if (!isBlobId(blobId)) throw new Error("invalid blobId");
  if (chunk.length > o.chunkMax) throw new RangeError("chunk larger than chunkMax");
  let body: Uint8Array = chunk;
  let flags = 0;
  if (o.compress) {
    const z = compressIfWorth(chunk);
    if (z) {
      body = z;
      flags |= FLAG_DEFLATE;
    }
  }
  if (o.pad) {
    body = padIso(body, padmeTarget(body.length, o.chunkMax + 1));
    flags |= FLAG_PADME;
  }
  const nonce = randomBytes(NONCE_LEN);
  const ct = await gcmEncrypt(kContent, nonce, body, blobAad(vaultId, blobId));
  return concat(BLOB_MAGIC, Uint8Array.of(kv, flags), nonce, ct);
}

/** Parses the fixed header. Order per §4.6.1: length, magic, (kv checked by caller), reserved flags. */
export function parseBlobHeader(sealed: Uint8Array): { kv: number; flags: number; nonce: Uint8Array; ct: Uint8Array } {
  if (sealed.length < BLOB_OVERHEAD) throw new CryptoError("BlobIntegrity", "too short");
  if (sealed.length > MAX_BLOB_SIZE) throw new CryptoError("BlobIntegrity", "too long");
  for (let i = 0; i < 4; i++) if (sealed[i] !== BLOB_MAGIC[i]) throw new CryptoError("BlobIntegrity", "bad magic");
  return { kv: sealed[4] as number, flags: sealed[5] as number, nonce: sealed.subarray(6, 18), ct: sealed.subarray(18) };
}

/** Decrypt and decode a blob body; the caller recomputes blobId afterwards. */
export async function openBlobBody(kContent: CryptoKey, vaultId: string, blobId: string, flags: number, nonce: Uint8Array, ct: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if ((flags & ~3) !== 0) throw new CryptoError("BlobIntegrity", "reserved flag bits set");
  let body: Uint8Array;
  try {
    body = await gcmDecrypt(kContent, nonce, ct, blobAad(vaultId, blobId));
  } catch {
    throw new CryptoError("BlobIntegrity", "authentication failed");
  }
  try {
    if (flags & FLAG_PADME) body = unpadIso(body);
  } catch {
    throw new CryptoError("BlobIntegrity", "bad padding");
  }
  if (flags & FLAG_DEFLATE) {
    try {
      body = inflateExact(body, expectedSize);
    } catch {
      throw new CryptoError("BlobIntegrity", "inflate failed or size mismatch");
    }
  }
  if (body.length !== expectedSize) throw new CryptoError("BlobIntegrity", "size mismatch");
  return body;
}

// ---------- record meta and inline ----------

function splitB64Envelope(b64: unknown, max: number): { nonce: Uint8Array; ct: Uint8Array } {
  if (typeof b64 !== "string" || b64.length > Math.ceil((max * 4) / 3) + 4) throw new CryptoError("RecordIntegrity", "envelope too large or not a string");
  let raw: Uint8Array;
  try {
    raw = fromB64u(b64);
  } catch {
    throw new CryptoError("RecordIntegrity", "envelope is not base64url");
  }
  if (raw.length < NONCE_LEN + TAG_LEN) throw new CryptoError("RecordIntegrity", "envelope too short");
  return { nonce: raw.subarray(0, NONCE_LEN), ct: raw.subarray(NONCE_LEN) };
}

export async function sealMetaRaw(kMeta: CryptoKey, vaultId: string, h: RecordHeader, meta: Record<string, unknown>, bucket: number): Promise<string> {
  const json = utf8(JSON.stringify(meta));
  const padded = padIso(json, metaPadLen(json.length, bucket));
  const nonce = randomBytes(NONCE_LEN);
  const ct = await gcmEncrypt(kMeta, nonce, padded, await recordAad(LABEL_META, vaultId, h));
  return b64u(concat(nonce, ct));
}

function jsonDepth(v: unknown, d = 0): number {
  if (typeof v !== "object" || v === null) return d;
  let m = d + 1;
  for (const x of Object.values(v)) m = Math.max(m, jsonDepth(x, d + 1));
  return m;
}

/** Decrypts, unpads and parses meta; structural checks (v, type, tombstone fields) included. */
export async function openMetaRaw(kMeta: CryptoKey, vaultId: string, h: RecordHeader, b64: string): Promise<Record<string, unknown>> {
  const { nonce, ct } = splitB64Envelope(b64, MAX_SEALED_META);
  let pt: Uint8Array;
  try {
    pt = await gcmDecrypt(kMeta, nonce, ct, await recordAad(LABEL_META, vaultId, h));
  } catch (e) {
    throw new CryptoError("RecordIntegrity", e instanceof Error && e.message.startsWith("invalid record header") ? e.message : "meta authentication failed");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(fromUtf8(unpadIso(pt)));
  } catch {
    throw new CryptoError("RecordIntegrity", "meta padding or JSON invalid");
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new CryptoError("RecordIntegrity", "meta is not an object");
  if (jsonDepth(meta) > MAX_META_DEPTH) throw new CryptoError("RecordIntegrity", "meta nesting too deep");
  const m = meta as Record<string, unknown>;
  if (m.v !== 1) throw new CryptoError("RecordIntegrity", "meta.v != 1");
  if (m.type !== "file") throw new CryptoError("RecordIntegrity", "meta.type != file");
  if (typeof m.path !== "string") throw new CryptoError("RecordIntegrity", "meta.path missing");
  if (h.kind === "del" && ("size" in m || "hash" in m || "chunks" in m)) throw new CryptoError("RecordIntegrity", "tombstone carries size, hash or chunks");
  return m;
}

export async function sealInlineRaw(kContent: CryptoKey, vaultId: string, h: RecordHeader, body: Uint8Array, o: { compress: boolean; pad: boolean }): Promise<{ ct: string; z: boolean; p: boolean }> {
  let b: Uint8Array = body;
  let z = false;
  if (o.compress) {
    const c = compressIfWorth(body);
    if (c) {
      b = c;
      z = true;
    }
  }
  if (o.pad) b = padIso(b, padmeTarget(b.length));
  const nonce = randomBytes(NONCE_LEN);
  const ct = await gcmEncrypt(kContent, nonce, b, await recordAad(LABEL_INLINE, vaultId, h));
  return { ct: b64u(concat(nonce, ct)), z, p: o.pad };
}

export async function openInlineRaw(kContent: CryptoKey, vaultId: string, h: RecordHeader, b64: string, z: boolean, p: boolean, expectedSize: number): Promise<Uint8Array> {
  const { nonce, ct } = splitB64Envelope(b64, MAX_BLOB_SIZE);
  let body: Uint8Array;
  try {
    body = await gcmDecrypt(kContent, nonce, ct, await recordAad(LABEL_INLINE, vaultId, h));
  } catch {
    throw new CryptoError("RecordIntegrity", "inline authentication failed");
  }
  try {
    if (p) body = unpadIso(body);
    if (z) body = inflateExact(body, expectedSize);
  } catch {
    throw new CryptoError("RecordIntegrity", "inline padding or inflate failed");
  }
  if (body.length !== expectedSize) throw new CryptoError("RecordIntegrity", "inline size mismatch");
  return body;
}

// ---------- key wrap (§4.6.6) ----------

export async function wrapVmk(kek: CryptoKey, vaultId: string, kv: number, vmk: Uint8Array): Promise<{ nonce: string; wrapped: string }> {
  const nonce = randomBytes(NONCE_LEN);
  return { nonce: b64u(nonce), wrapped: b64u(await gcmEncrypt(kek, nonce, vmk, wrapAad(vaultId, kv))) };
}

/** Throws the raw WebCrypto error on failure; the caller maps it to WrongPassphrase/CorruptVaultInfo. */
export async function unwrapVmk(kek: CryptoKey, vaultId: string, kv: number, nonceB64: string, wrappedB64: string): Promise<Bytes> {
  const vmk = await gcmDecrypt(kek, fromB64u(nonceB64), fromB64u(wrappedB64), wrapAad(vaultId, kv));
  if (vmk.length !== 32) throw new Error("VMK must be 32 bytes");
  return vmk;
}
