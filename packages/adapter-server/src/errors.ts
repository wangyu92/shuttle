// Error mapping from the own server's wire forms to RemoteError (design §2.9.3, §2.12).
// Three inputs: REST responses (status + `{"error":{…}}` body), WebSocket `error` frames and
// WebSocket close codes. Client-side failures (thrown HttpClient, our own timers) become NETWORK/TIMEOUT.

import {
  CloseCode, RemoteError, remoteError, remoteErrorFromWire, validateErrorBody,
} from "@shuttle/protocol";
import type { HttpResponse, RemoteErrorCode } from "@shuttle/protocol";

const decoder = new TextDecoder();

/** Case-insensitive response header lookup (HttpClient implementations differ in key case). */
export function header(res: HttpResponse, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const k of Object.keys(res.headers)) if (k.toLowerCase() === want) return res.headers[k];
  return undefined;
}

export function bodyText(res: HttpResponse): string {
  return decoder.decode(new Uint8Array(res.body));
}

/** Retry-After (seconds or HTTP date) as milliseconds, when present. */
function retryAfterHeader(res: HttpResponse): number | undefined {
  const v = header(res, "retry-after");
  if (v === undefined) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  return undefined;
}

/** Status-only fallback for bodies that are not a Shuttle error (a proxy page, an empty 502). */
export function codeFromStatus(status: number): RemoteErrorCode {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 408) return "TIMEOUT";
  if (status === 412) return "PRECONDITION_FAILED";
  if (status === 413) return "TOO_LARGE";
  if (status === 422) return "HASH_MISMATCH";
  if (status === 429) return "RATE_LIMITED";
  if (status === 507) return "QUOTA";
  if (status === 502 || status === 503 || status === 504) return "UNAVAILABLE";
  if (status >= 500) return "SERVER";
  return "PROTOCOL";
}

/** RemoteError for a non-2xx REST response (design §2.8.5 error body, §2.9.3 table). */
export function errorFromResponse(res: HttpResponse, what: string): RemoteError {
  let parsed: unknown = undefined;
  try {
    const text = bodyText(res);
    parsed = text ? JSON.parse(text) : undefined;
  } catch { /* not JSON: a proxy or an HTML error page */ }
  const v = validateErrorBody(parsed);
  if (v.ok) {
    const e = v.value.error;
    const retryAfterMs = e.retryAfterMs ?? retryAfterHeader(res);
    const err = remoteErrorFromWire({
      code: e.code, message: `${what}: ${e.message ?? e.code}`,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(e.details !== undefined ? { details: e.details } : {}),
    });
    // A Shuttle code the protocol table does not know, on a 5xx, is still a server-side failure.
    if (err.code === "PROTOCOL" && res.status >= 500) return remoteError(codeFromStatus(res.status), err.message, { details: { wireCode: e.code } });
    return err;
  }
  const retryAfterMs = retryAfterHeader(res);
  return remoteError(codeFromStatus(res.status), `${what}: HTTP ${res.status}`, retryAfterMs !== undefined ? { retryAfterMs } : {});
}

/** Wrap whatever an HttpClient or WsFactory threw. RemoteErrors pass through unchanged. */
export function networkError(e: unknown, what: string): RemoteError {
  if (e instanceof RemoteError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed? ?out|timeout/i.test(msg)) return remoteError("TIMEOUT", `${what}: ${msg}`);
  return remoteError("NETWORK", `${what}: ${msg}`);
}

/** What a close code means for reconnecting (design §2.9.3 close codes). */
export type CloseAction =
  | { kind: "stop"; error: RemoteError; state: "auth-error" | "offline" }
  | { kind: "reconnect"; delay: "jitter" | "restart" | "backoff" };

/**
 * Decide after a close. `fatal` is the last fatal `error` frame received on that socket, which names
 * the reason more precisely than the code (4403 carries both REVOKED and FORBIDDEN).
 */
export function closeAction(code: number, reason: string, fatal: RemoteError | null): CloseAction {
  const why = reason || (fatal?.message ?? `closed ${code}`);
  switch (code) {
    case CloseCode.UNAUTHENTICATED:
      return { kind: "stop", state: "auth-error", error: fatal?.code === "UNAUTHENTICATED" ? fatal : remoteError("UNAUTHENTICATED", why) };
    case CloseCode.FORBIDDEN:
      return {
        kind: "stop", state: "auth-error",
        error: fatal && (fatal.code === "REVOKED" || fatal.code === "FORBIDDEN") ? fatal : remoteError("FORBIDDEN", why),
      };
    case CloseCode.VAULT_NOT_FOUND:
      return { kind: "stop", state: "auth-error", error: fatal?.code === "VAULT_NOT_FOUND" ? fatal : remoteError("VAULT_NOT_FOUND", why) };
    case CloseCode.SUPERSEDED:
      // Another connection of this device to the vault is newer; reconnecting would make them fight.
      return { kind: "stop", state: "offline", error: remoteError("UNAVAILABLE", "superseded by a newer connection of this device") };
    case CloseCode.GOING_AWAY:
      return { kind: "reconnect", delay: "jitter" };
    case CloseCode.RESTART:
      return { kind: "reconnect", delay: "restart" };
    default:
      return { kind: "reconnect", delay: "backoff" };
  }
}
