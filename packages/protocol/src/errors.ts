// Error codes (design §2.9.3) and the adapter-level RemoteError (§2.12).
// Three code sets are kept apart on purpose:
//  - OpErrorCode: per-op results inside commitResult.
//  - WireErrorCode: what the server puts in WS `error` frames and REST error bodies.
//  - RemoteErrorCode: what adapters throw to the engine (includes client-side NETWORK/TIMEOUT).

import type { RemoteErrorCode } from "./types";

export const OP_ERROR_CODES = [
  "CONFLICT", "PATH_TAKEN", "MISSING_BLOB", "INVALID", "TOO_LARGE", "QUOTA", "KEY_VERSION", "ABORTED",
] as const;
export type OpErrorCode = (typeof OP_ERROR_CODES)[number];

/** §2.9.3 table plus REST-only codes named in §2.8.4/§2.8.5. */
export const WIRE_ERROR_CODES = [
  ...OP_ERROR_CODES,
  "UNAUTHENTICATED", "REVOKED", "FORBIDDEN", "VAULT_NOT_FOUND", "PRECONDITION_FAILED", "SNAPSHOT_REQUIRED",
  "RATE_LIMITED", "PROTOCOL", "HASH_MISMATCH", "SERVER", "UNAVAILABLE",
  // REST-only
  "BAD_CREDENTIALS", "CODE_EXPIRED", "NAME_TAKEN", "VAULT_EXISTS", "BAD_ID", "BAD_BLOB", "NOT_FOUND", "EXISTS",
] as const;
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

export const REMOTE_ERROR_CODES: readonly RemoteErrorCode[] = [
  "NETWORK", "TIMEOUT", "UNAUTHENTICATED", "REVOKED", "FORBIDDEN", "VAULT_NOT_FOUND", "NOT_FOUND",
  "PRECONDITION_FAILED", "ALREADY_EXISTS", "RATE_LIMITED", "TOO_LARGE", "QUOTA", "SNAPSHOT_REQUIRED",
  "HASH_MISMATCH", "PROTOCOL", "UNSUPPORTED", "SERVER", "UNAVAILABLE",
];

export interface WireErrorSpec { http: number; retry: boolean }

/** HTTP status and retry flag per wire code (§2.9.3; REST-only codes from §2.8.4/§2.8.5). */
export const WIRE_ERRORS: Readonly<Record<WireErrorCode, WireErrorSpec>> = Object.freeze({
  CONFLICT: { http: 409, retry: false },
  PATH_TAKEN: { http: 409, retry: false },
  MISSING_BLOB: { http: 409, retry: true },
  INVALID: { http: 400, retry: false },
  TOO_LARGE: { http: 413, retry: false },
  QUOTA: { http: 507, retry: true },        // "later"
  KEY_VERSION: { http: 409, retry: false },
  ABORTED: { http: 409, retry: true },
  UNAUTHENTICATED: { http: 401, retry: false },
  REVOKED: { http: 401, retry: false },
  FORBIDDEN: { http: 403, retry: false },
  VAULT_NOT_FOUND: { http: 404, retry: false },
  PRECONDITION_FAILED: { http: 412, retry: false },
  SNAPSHOT_REQUIRED: { http: 409, retry: false },
  RATE_LIMITED: { http: 429, retry: true },
  PROTOCOL: { http: 400, retry: false },
  HASH_MISMATCH: { http: 422, retry: true },
  SERVER: { http: 500, retry: true },
  UNAVAILABLE: { http: 503, retry: true },
  BAD_CREDENTIALS: { http: 401, retry: false },
  CODE_EXPIRED: { http: 410, retry: false },
  NAME_TAKEN: { http: 409, retry: false },
  VAULT_EXISTS: { http: 409, retry: false },
  BAD_ID: { http: 400, retry: false },
  BAD_BLOB: { http: 422, retry: false },
  NOT_FOUND: { http: 404, retry: false },
  EXISTS: { http: 409, retry: false },
});

export function isWireErrorCode(v: unknown): v is WireErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(WIRE_ERRORS, v);
}

export function isOpErrorCode(v: unknown): v is OpErrorCode {
  return typeof v === "string" && (OP_ERROR_CODES as readonly string[]).includes(v);
}

export class RemoteError extends Error {
  readonly code: RemoteErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;
  constructor(code: RemoteErrorCode, message: string, retryable: boolean, retryAfterMs?: number, details?: unknown) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

/**
 * Map a wire code from a WS `error` frame or REST error body to a RemoteErrorCode.
 * Op-level codes that are not adapter errors (CONFLICT etc.) map to PROTOCOL: they belong in OpResult.
 */
export function remoteCodeFromWire(code: string): RemoteErrorCode {
  switch (code) {
    case "UNAUTHENTICATED": case "BAD_CREDENTIALS": return "UNAUTHENTICATED";
    case "REVOKED": return "REVOKED";
    case "FORBIDDEN": return "FORBIDDEN";
    case "VAULT_NOT_FOUND": return "VAULT_NOT_FOUND";
    case "NOT_FOUND": case "CODE_EXPIRED": return "NOT_FOUND";
    case "PRECONDITION_FAILED": return "PRECONDITION_FAILED";
    case "EXISTS": case "VAULT_EXISTS": case "NAME_TAKEN": return "ALREADY_EXISTS";
    case "RATE_LIMITED": return "RATE_LIMITED";
    case "TOO_LARGE": return "TOO_LARGE";
    case "QUOTA": return "QUOTA";
    case "SNAPSHOT_REQUIRED": return "SNAPSHOT_REQUIRED";
    case "HASH_MISMATCH": return "HASH_MISMATCH";
    case "UNAVAILABLE": return "UNAVAILABLE";
    case "SERVER": return "SERVER";
    default: return "PROTOCOL";
  }
}

/** Build a RemoteError from a wire error (WS `error` frame or REST `{error:{…}}`). */
export function remoteErrorFromWire(e: { code: string; message?: string; retryAfterMs?: number | null; details?: unknown }): RemoteError {
  const code = remoteCodeFromWire(e.code);
  const spec = isWireErrorCode(e.code) ? WIRE_ERRORS[e.code] : undefined;
  return new RemoteError(code, e.message ?? e.code, spec?.retry ?? false, e.retryAfterMs ?? undefined, e.details);
}

/**
 * Default retry flag per adapter error code (design §2.9.3 "Retry?" column; NETWORK and TIMEOUT are
 * client-side and always retryable). Adapters use this when the remote does not say otherwise.
 */
export const REMOTE_ERRORS: Readonly<Record<RemoteErrorCode, { retry: boolean }>> = Object.freeze({
  NETWORK: { retry: true },
  TIMEOUT: { retry: true },
  UNAUTHENTICATED: { retry: false },
  REVOKED: { retry: false },
  FORBIDDEN: { retry: false },
  VAULT_NOT_FOUND: { retry: false },
  NOT_FOUND: { retry: false },
  PRECONDITION_FAILED: { retry: false },
  ALREADY_EXISTS: { retry: false },
  RATE_LIMITED: { retry: true },
  TOO_LARGE: { retry: false },
  QUOTA: { retry: true },
  SNAPSHOT_REQUIRED: { retry: false },
  HASH_MISMATCH: { retry: true },
  PROTOCOL: { retry: false },
  UNSUPPORTED: { retry: false },
  SERVER: { retry: true },
  UNAVAILABLE: { retry: true },
});

export function isRemoteErrorCode(v: unknown): v is RemoteErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(REMOTE_ERRORS, v);
}

/** RemoteError with the default retry flag of its code. */
export function remoteError(code: RemoteErrorCode, message: string, o: { retryAfterMs?: number; details?: unknown } = {}): RemoteError {
  return new RemoteError(code, message, REMOTE_ERRORS[code].retry, o.retryAfterMs, o.details);
}

export function isRemoteError(e: unknown, code?: RemoteErrorCode): e is RemoteError {
  return e instanceof RemoteError && (code === undefined || e.code === code);
}
