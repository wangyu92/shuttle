// Small helpers shared by the server modules. AGPL-3.0-only.
import { createHash, randomBytes } from "node:crypto";
import type { WireErrorCode } from "@shuttle/protocol";
import { WIRE_ERRORS } from "@shuttle/protocol";

/** An error that maps to a REST error body and HTTP status (design §2.9.3). */
export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: WireErrorCode,
    message?: string,
    readonly extra: { retryAfterMs?: number; details?: Record<string, unknown>; status?: number } = {},
  ) {
    super(message ?? code);
    this.status = extra.status ?? WIRE_ERRORS[code].http;
  }
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/**
 * Strict b64u decode: returns null unless re-encoding gives back the same text, so a non-canonical
 * trailing character cannot silently change the bytes a client gets back (meta, inline are AEAD data).
 */
export function b64uDecodeStrict(s: string): Buffer | null {
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/** 16 random bytes as b64u (22 chars): deviceId, userId, vaultId-shaped ids. */
export function randomId16(): string {
  return randomBytes(16).toString("base64url");
}

export function randomHex(n: number): string {
  return randomBytes(n).toString("hex");
}

/** Normalized error text for logs; never includes request bodies or headers. */
export function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
