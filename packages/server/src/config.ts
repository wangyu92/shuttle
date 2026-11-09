// Server configuration: §2.8.6 limits (env-configurable), auth knobs and test hooks. AGPL-3.0-only.
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS, MAX_PACK_ENTRIES } from "@shuttle/protocol";
import type { WelcomeLimits } from "@shuttle/protocol";

export interface RateLimits {
  /** Commits per second per device (token bucket, burst = rate). design §2.9.4: 20. */
  commitsPerSec: number;
  /** Blob requests per second per device. design §2.9.4: 200. */
  blobReqPerSec: number;
  /** Login failures per minute per IP and per username before 429. design §2.8.4: 5. */
  loginFailuresPerMin: number;
}

/** scrypt cost (design §2.8.4: N=2^15, r=8, p=1). Tests may lower N; the stored hash records its own params. */
export interface ScryptParams { N: number; r: number; p: number }

export interface ServerOptions {
  host?: string;               // default 127.0.0.1
  port?: number;               // 0 = random
  dataDir: string;
  limits?: Partial<WelcomeLimits>;
  maxPackEntries?: number;
  rates?: Partial<RateLimits>;
  sourceUrl?: string;
  /** Base URL used in enroll links (SHUTTLE_PUBLIC_URL). Default: derived from the request Host. */
  publicUrl?: string;
  /** SHUTTLE_TRUST_PROXY=1: client IP from X-Forwarded-For. */
  trustProxy?: boolean;
  /** SHUTTLE_ALLOWED_ORIGINS: optional allowlist; requests without Origin always pass. */
  allowedOrigins?: string[];
  scrypt?: ScryptParams;
  /** Clock (ms). Tests inject a fake clock for retention and TTLs. */
  now?: () => number;
  /** Run the hourly maintenance job and nightly backup on timers (default true). */
  jobs?: boolean;
  /** Run maintenance once at start (default = jobs). */
  gcOnStart?: boolean;
  /** Heartbeat: server protocol ping interval and idle timeout (design §2.9.4: 30 s / 60 s). */
  pingIntervalMs?: number;
  idleTimeoutSec?: number;
  helloTimeoutMs?: number;
  /** Live coalescing window (design §2.9.2: 50 ms). */
  coalesceMs?: number;
  /** Interval for the revoked-device sweep of open sockets (admin CLI revocations). */
  revocationSweepMs?: number;
  log?: (msg: string) => void;
}

export interface ResolvedConfig {
  host: string;
  port: number;
  dataDir: string;
  limits: WelcomeLimits;
  maxPackEntries: number;
  rates: RateLimits;
  sourceUrl: string;
  publicUrl: string | null;
  trustProxy: boolean;
  allowedOrigins: string[] | null;
  scrypt: ScryptParams;
  now: () => number;
  jobs: boolean;
  gcOnStart: boolean;
  pingIntervalMs: number;
  idleTimeoutSec: number;
  helloTimeoutMs: number;
  coalesceMs: number;
  revocationSweepMs: number;
  log: (msg: string) => void;
}

// The AGPL source offer (design §8.6). Operators set SHUTTLE_SOURCE_URL; the public repo URL replaces
// this placeholder once the repository is published.
export const DEFAULT_SOURCE_URL = "https://example.com/shuttle/source";
export const DEFAULT_SCRYPT: ScryptParams = Object.freeze({ N: 1 << 15, r: 8, p: 1 });
export const DEFAULT_RATES: RateLimits = Object.freeze({ commitsPerSec: 20, blobReqPerSec: 200, loginFailuresPerMin: 5 });

export function resolveConfig(o: ServerOptions): ResolvedConfig {
  const limits: WelcomeLimits = { ...DEFAULT_LIMITS, ...o.limits };
  // Request body cap is derived (§2.8.6): the larger of a pack and a blob plus 256 KiB of slack.
  if (o.limits?.maxRequestBody === undefined) {
    limits.maxRequestBody = Math.max(limits.maxPackBytes, limits.maxBlobSize, limits.maxCommitBytes) + 256 * 1024;
  }
  const jobs = o.jobs ?? true;
  return {
    host: o.host ?? "127.0.0.1",
    port: o.port ?? 0,
    dataDir: path.resolve(o.dataDir),
    limits,
    maxPackEntries: o.maxPackEntries ?? MAX_PACK_ENTRIES,
    rates: { ...DEFAULT_RATES, ...o.rates },
    sourceUrl: o.sourceUrl ?? DEFAULT_SOURCE_URL,
    publicUrl: o.publicUrl ? o.publicUrl.replace(/\/+$/, "") : null,
    trustProxy: o.trustProxy ?? false,
    allowedOrigins: o.allowedOrigins && o.allowedOrigins.length > 0 ? o.allowedOrigins : null,
    scrypt: o.scrypt ?? DEFAULT_SCRYPT,
    now: o.now ?? Date.now,
    jobs,
    gcOnStart: o.gcOnStart ?? jobs,
    pingIntervalMs: o.pingIntervalMs ?? 30_000,
    idleTimeoutSec: o.idleTimeoutSec ?? 60,
    helloTimeoutMs: o.helloTimeoutMs ?? 10_000,
    coalesceMs: o.coalesceMs ?? 50,
    revocationSweepMs: o.revocationSweepMs ?? 15_000,
    log: o.log ?? (() => {}),
  };
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, min = 1): number | undefined {
  const v = env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got ${v}`);
  return n;
}

/** Server options from the environment (design §2.8.6, §2.8.9). */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const dataDir = expandHome(env.SHUTTLE_DATA || path.join(os.homedir(), "tmp/claude/shuttle-dev-data"));
  const limits: Partial<WelcomeLimits> = {};
  const set = (k: keyof WelcomeLimits, name: string) => { const n = intEnv(env, name); if (n !== undefined) limits[k] = n; };
  set("maxBlobSize", "SHUTTLE_MAX_BLOB");
  set("maxPackBytes", "SHUTTLE_MAX_PACK");
  set("maxCommitBytes", "SHUTTLE_MAX_COMMIT_BYTES");
  set("maxCommitOps", "SHUTTLE_MAX_COMMIT_OPS");
  set("maxFileSize", "SHUTTLE_MAX_FILE");
  set("maxRequestBody", "SHUTTLE_MAX_REQUEST_BODY");
  const o: ServerOptions = {
    // In the container the published port 127.0.0.1:8787:8787 needs the server on all interfaces.
    host: env.SHUTTLE_HOST || (env.SHUTTLE_DATA === "/data" ? "0.0.0.0" : "127.0.0.1"),
    port: intEnv(env, "SHUTTLE_PORT", 0) ?? 8787,
    dataDir,
    limits,
    trustProxy: env.SHUTTLE_TRUST_PROXY === "1",
    log: (m) => console.log(m),
  };
  if (env.SHUTTLE_SOURCE_URL) o.sourceUrl = env.SHUTTLE_SOURCE_URL;
  if (env.SHUTTLE_PUBLIC_URL) o.publicUrl = env.SHUTTLE_PUBLIC_URL;
  if (env.SHUTTLE_ALLOWED_ORIGINS) o.allowedOrigins = env.SHUTTLE_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return o;
}
