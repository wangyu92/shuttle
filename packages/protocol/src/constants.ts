// Protocol constants (design §2.2, §2.3.1, §2.8.4–2.8.6, §2.9).
// Limits here are the defaults; the server may lower or raise them through env and reports the
// effective values in `welcome.limits`. Clients MUST use `welcome.limits` once connected.

import type { WelcomeLimits } from "./types";

export const PROTO_VERSION = 1;
export const SUPPORTED_PROTOCOLS: readonly number[] = [1];
export const WS_SUBPROTOCOL = "shuttle.1";
export const WS_PATH = "/v1/ws";
export const API_PREFIX = "/v1";

export const VAULT_INFO_FORMAT = "shuttle.vault-info";
export const VAULT_INFO_FORMAT_VERSION = 1;
export const S3_HEAD_FORMAT = "shuttle.head";
export const S3_LOG_FORMAT = "shuttle.log";
export const CRYPTO_SUITE = "sx1";

export const PACK_CONTENT_TYPE = "application/x-shuttle-pack";
export const PACK_MAGIC = "SXPK";
export const PACK_VERSION = 1;
export const PACK_MISSING = 0xffffffff;

export const DEVICE_TOKEN_PREFIX = "sxd_";
export const ENROLL_CODE_PREFIX = "SXE-";
export const ENROLL_URI_ACTION = "shuttle-enroll";

export const HEADER_SERVER = "X-Shuttle-Server";
export const HEADER_REQUEST_ID = "X-Shuttle-Request-Id";
export const HEADER_SHA256 = "X-Shuttle-Sha256";
export const HEADER_CONFIRM = "X-Shuttle-Confirm";

const KiB = 1024;
const MiB = 1024 * KiB;

/** §2.8.6 defaults, in the exact shape of `welcome.limits`. */
export const DEFAULT_LIMITS: Readonly<WelcomeLimits> = Object.freeze({
  maxBlobSize: 4 * MiB + KiB,            // 4195328
  maxPackBytes: 8 * MiB,                 // 8388608
  maxCommitOps: 500,
  maxCommitBytes: MiB,                   // 1048576
  maxInFlightCommits: 4,
  maxFileSize: 200 * MiB,                // 209715200
  inlineMax: 4096,
  maxRequestBody: 8 * MiB + 256 * KiB,   // 8650752
});

export const MAX_PACK_ENTRIES = 256;
export const MAX_MISSING_IDS = 1000;
export const MAX_META_BYTES = 16 * KiB;   // decoded
export const MAX_INLINE_BYTES = 6 * KiB;  // decoded
export const MAX_WS_FRAME = 2 * MiB;
export const MAX_PAIRING_BODY = 4 * KiB;
export const ENCSIZE_SLACK = 64 * KiB;    // encSize > maxFileSize + slack → reject (§2.9.7)
export const MAX_UNACKED_BYTES = 8 * MiB;
export const SNAPSHOT_PAGE_DEFAULT = 2000;
export const SNAPSHOT_PAGE_MAX = 5000;
export const CHANGES_WAIT_MAX_SEC = 25;
export const CHANGES_LIMIT_DEFAULT = 1000;
export const HEARTBEAT_SEC = 25;
export const IDLE_TIMEOUT_SEC = 60;
export const HELLO_TIMEOUT_SEC = 10;
export const PONG_TIMEOUT_SEC = 10;
export const LIVE_COALESCE_MS = 50;
export const LIVE_MAX_RECORDS = 500;
export const LIVE_MAX_BYTES = MiB;
export const CID_CACHE_DAYS = 7;
export const ENROLL_CODE_TTL_SEC = 900;
export const PAIRING_TTL_SEC = 900;

/** WebSocket close codes (§2.9.3). */
export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL: 4400,
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,           // revoked or forbidden
  VAULT_NOT_FOUND: 4404,
  TIMEOUT: 4408,             // hello or idle timeout
  SUPERSEDED: 4409,
  RATE_LIMITED: 4429,
  INTERNAL: 4500,
  RESTART: 4503,             // restart or maintenance; reconnect after 2–5 s
} as const);
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Close codes after which the client MUST NOT reconnect. */
export const NO_RECONNECT_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.UNAUTHENTICATED, CloseCode.FORBIDDEN, CloseCode.VAULT_NOT_FOUND,
]);
