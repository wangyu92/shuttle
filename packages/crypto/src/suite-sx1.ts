// Suite sx1 primitives over globalThis.crypto.subtle only (§4.2).
import { ab, type Bytes, utf8 } from "./bytes.js";

export const SUITE = "sx1";
export const NONCE_LEN = 12;
export const TAG_LEN = 16;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is unavailable");
  return s;
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", ab(data)));
}

/** VMK as a non-extractable HKDF base key. */
export function importHkdfBase(ikm: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", ab(ikm), "HKDF", false, ["deriveKey", "deriveBits"]);
}

function hkdfParams(salt: Uint8Array, info: string): HkdfParams {
  return { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: utf8(info) };
}

export function hkdfAesKey(base: CryptoKey, salt: Uint8Array, info: string): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function hkdfHmacKey(base: CryptoKey, salt: Uint8Array, info: string): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
}

export async function hkdfBits(base: CryptoKey, salt: Uint8Array, info: string, bytes: number): Promise<Bytes> {
  return new Uint8Array(await subtle().deriveBits(hkdfParams(salt, info), base, bytes * 8));
}

export function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", ab(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", ab(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function pbkdf2AesKey(pass: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", utf8(pass), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: ab(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** ciphertext || tag */
export async function gcmEncrypt(key: CryptoKey, nonce: Uint8Array, pt: Uint8Array, aad: string): Promise<Bytes> {
  if (nonce.length !== NONCE_LEN) throw new Error("nonce must be 12 bytes");
  return new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: utf8(aad), tagLength: 128 }, key, ab(pt)));
}

/** Throws (OperationError) on any authentication failure. */
export async function gcmDecrypt(key: CryptoKey, nonce: Uint8Array, ct: Uint8Array, aad: string): Promise<Bytes> {
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: utf8(aad), tagLength: 128 }, key, ab(ct)));
}

export async function hmacSign(key: CryptoKey, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().sign("HMAC", key, ab(data)));
}

/** Constant-time full-length verify (§4.5.2). */
export function hmacVerify(key: CryptoKey, mac: Uint8Array, data: Uint8Array): Promise<boolean> {
  return subtle().verify("HMAC", key, ab(mac), ab(data));
}
