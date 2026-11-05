// Password KDF (§4.4). Bounds are checked BEFORE running anything (anti-DoS, anti-downgrade).
import { fromB64u } from "./b64u.js";
import { CryptoError } from "./errors.js";
import { pbkdf2AesKey } from "./suite-sx1.js";

export type Kdf =
  | { alg: "PBKDF2-SHA256"; iter: number; salt: string }
  | { alg: "argon2id"; m: number; t: number; p: 1; salt: string }
  | { alg: "scrypt"; N: number; r: 8; p: number; salt: string };

export const PBKDF2_DEFAULT_ITER = 600000;
export const PBKDF2_MIN_ITER = 310000;
export const PBKDF2_MAX_ITER = 5000000;
export const SALT_LEN = 32;

const intIn = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;

/**
 * Throws UnsupportedKdf when the params are out of bounds or the algorithm is unknown.
 * `minIterOverride` exists only for known-answer tests (iter 1000 vectors); vault-info never sets it.
 */
export function validateKdf(kdf: unknown, minIterOverride?: number): asserts kdf is Kdf {
  const k = kdf as Record<string, unknown> | null;
  if (typeof k !== "object" || k === null) throw new CryptoError("UnsupportedKdf", "missing kdf");
  let salt: Uint8Array;
  try {
    salt = fromB64u(String(k.salt));
  } catch {
    throw new CryptoError("UnsupportedKdf", "salt is not base64url");
  }
  if (typeof k.salt !== "string" || salt.length < 16 || salt.length > 64) throw new CryptoError("UnsupportedKdf", "salt must be 16-64 bytes");
  switch (k.alg) {
    case "PBKDF2-SHA256":
      if (!intIn(k.iter, minIterOverride ?? PBKDF2_MIN_ITER, PBKDF2_MAX_ITER)) throw new CryptoError("UnsupportedKdf", `iter ${String(k.iter)} out of bounds`);
      return;
    case "argon2id":
      if (!intIn(k.m, 19456, 262144) || !intIn(k.t, 1, 10) || k.p !== 1) throw new CryptoError("UnsupportedKdf", "argon2id params out of bounds");
      return;
    case "scrypt": {
      const N = k.N;
      const ok = intIn(N, 2 ** 15, 2 ** 20) && ((N as number) & ((N as number) - 1)) === 0 && k.r === 8 && intIn(k.p, 1, 4) && 128 * (N as number) * 8 <= 256 * 2 ** 20;
      if (!ok) throw new CryptoError("UnsupportedKdf", "scrypt params out of bounds");
      return;
    }
    default:
      throw new CryptoError("UnsupportedKdf", `unknown alg ${String(k.alg)}`);
  }
}

/** NFC, no trim (§4.4.2). */
export function normalizePassphrase(pass: string): string {
  return pass.normalize("NFC");
}

/** Hard minimum for new passphrases (§4.4.2): 10 characters (code points, after NFC). */
export function assertNewPassphrase(pass: string): void {
  if ([...normalizePassphrase(pass)].length < 10) throw new RangeError("passphrase must be at least 10 characters");
}

/** Derives the KEK as a non-extractable AES-256-GCM key. Call validateKdf first. */
export async function deriveKek(kdf: Kdf, pass: string): Promise<CryptoKey> {
  if (kdf.alg !== "PBKDF2-SHA256") {
    // Argon2id/scrypt need the lazily bundled hash-wasm build (§4.4.4), which v1 does not ship yet.
    throw new CryptoError("UpdateRequired", `kdf ${kdf.alg} not supported by this build`);
  }
  return pbkdf2AesKey(normalizePassphrase(pass), fromB64u(kdf.salt), kdf.iter);
}
