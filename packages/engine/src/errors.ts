// Typed engine errors (design §3.1 errors.ts). Remote failures are RemoteError values from
// @shuttle/protocol (errors.ts, REMOTE_ERRORS retry table); these classes cover engine-side states.

export type EngineErrorCode =
  | 'AUTH' | 'QUOTA' | 'CURSOR_EXPIRED' | 'CONFLICT' | 'PATH_TAKEN' | 'NET' | 'OOM' | 'LOCKED'
  | 'INTEGRITY' | 'NEWER_SCHEMA' | 'INVALID_PATH';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineError";
    this.code = code;
  }
}

export class AuthError extends EngineError { constructor(m = "authentication failed") { super("AUTH", m); this.name = "AuthError"; } }
export class QuotaError extends EngineError { constructor(m = "quota exceeded") { super("QUOTA", m); this.name = "QuotaError"; } }
export class CursorExpired extends EngineError { constructor(m = "cursor expired") { super("CURSOR_EXPIRED", m); this.name = "CursorExpired"; } }
export class ConflictError extends EngineError { constructor(m = "conflict") { super("CONFLICT", m); this.name = "ConflictError"; } }
export class PathTakenError extends EngineError { constructor(m = "path taken") { super("PATH_TAKEN", m); this.name = "PathTakenError"; } }
export class NetError extends EngineError { constructor(m = "network error", cause?: unknown) { super("NET", m, { cause }); this.name = "NetError"; } }
export class OOMError extends EngineError { constructor(m = "out of memory budget") { super("OOM", m); this.name = "OOMError"; } }
/** Keys not in the cache: no seal/open/hash/commit (design §3.13 Locked state). */
export class LockedError extends EngineError { constructor(m = "vault is locked") { super("LOCKED", m); this.name = "LockedError"; } }
/** Integrity failure on a record or blob (design §4.14). `stage` names where it was detected. */
export class IntegrityError extends EngineError {
  readonly stage: string;
  constructor(m: string, stage = "meta", options?: { cause?: unknown }) {
    super("INTEGRITY", m, options);
    this.name = "IntegrityError";
    this.stage = stage;
  }
}

export function isEngineError(e: unknown, code?: EngineErrorCode): e is EngineError {
  return e instanceof EngineError && (code === undefined || e.code === code);
}
