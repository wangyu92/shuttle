// Onboarding operations against a SHUTTLE server (design §5.5.3, §5.5.5, §5.5.6, §5.5.9).
// No UI here: the wizard calls these and renders the results, tests call them with a fake or a real
// HttpClient. Every error a user can see is classified into a SetupError kind with an i18n key.

import {
  API_PREFIX, PROTO_VERSION, isRemoteError, validateHealthResponse, validateVaultsResponse,
} from "@shuttle/protocol";
import type {
  AuthResponse, DeviceDescriptor, HttpClient, Scheduler, VaultInfo, VaultSummary, WsFactory,
} from "@shuttle/protocol";
import { RestClient, ServerAdapter, serverEnroll, serverLogin } from "@shuttle/adapter-server";
import { createVault, isCryptoError, unlock, type CachedSecrets, type Keyring as CryptoKeyring, type Seen, type VaultInfo as CryptoVaultInfo } from "@shuttle/crypto";
import { normalizeBaseUrls } from "@shuttle/adapter-server";
import { redact } from "../util/redact";

export type SetupErrorKind =
  | "unreachable" | "tls" | "notShuttle" | "protocol" | "proxy" | "badCredentials" | "codeExpired" | "rateLimited"
  | "nameTaken" | "notOwner" | "pwWrong" | "keyCheck" | "requires" | "pwShort" | "httpNotAllowed" | "unknown";

/** i18n key per kind (design §5.5.3 error table, §5.5.5, §5.5.6). */
export const SETUP_ERROR_KEYS: Readonly<Record<SetupErrorKind, string>> = Object.freeze({
  unreachable: "err.unreachable", tls: "err.tls", notShuttle: "err.notShuttle", protocol: "err.protocol", proxy: "err.proxy",
  badCredentials: "err.badCredentials", codeExpired: "err.codeExpired", rateLimited: "err.rateLimited", nameTaken: "err.nameTaken",
  notOwner: "err.notOwner", pwWrong: "err.pwWrong", keyCheck: "err.keyCheck", requires: "err.requires", pwShort: "err.pwShort",
  httpNotAllowed: "err.httpNotAllowed", unknown: "err.unknown",
});

export class SetupError extends Error {
  constructor(readonly kind: SetupErrorKind, readonly params: Record<string, string | number> = {}, detail?: string) {
    super(detail ? `${kind}: ${redact(detail)}` : kind);
    this.name = "SetupError";
  }
  get key(): string {
    return SETUP_ERROR_KEYS[this.kind];
  }
}

export interface SetupEnv {
  http: HttpClient;
  scheduler: Scheduler;
  now(): number;
  client: { name: string; platform: string; version: string };
}

export interface Connection { urls: string[]; allowHttp: boolean }

export type ReachResult =
  | { url: string; ok: true; ms: number; version: string }
  | { url: string; ok: false; error: SetupErrorKind; params: Record<string, string | number> };

export const PROBE_TIMEOUT_MS = 3000;

const TLS = /cert|ssl|tls|handshake/i;

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** design §5.5.3 step 1: GET /v1/health per URL (3 s each, in parallel), classified. */
export async function probeEndpoints(env: SetupEnv, urls: readonly string[]): Promise<ReachResult[]> {
  return Promise.all(urls.map(async (url): Promise<ReachResult> => {
    const t0 = env.now();
    let res;
    try {
      res = await env.http.request({ url: url + API_PREFIX + "/health", method: "GET", timeoutMs: PROBE_TIMEOUT_MS, headers: { Accept: "application/json" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (TLS.test(msg)) return { url, ok: false, error: "tls", params: { host: hostOf(url) } };
      return { url, ok: false, error: "unreachable", params: { url } };
    }
    if (res.status === 0) return { url, ok: false, error: "unreachable", params: { url } };
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(res.body)));
    } catch {
      if (res.status === 502 || res.status === 503 || res.status === 504) return { url, ok: false, error: "proxy", params: { status: res.status } };
      return { url, ok: false, error: "notShuttle", params: { url } };
    }
    const v = validateHealthResponse(json);
    if (res.status !== 200 || !v.ok) {
      if (res.status === 502 || res.status === 503 || res.status === 504) return { url, ok: false, error: "proxy", params: { status: res.status } };
      return { url, ok: false, error: "notShuttle", params: { url } };
    }
    if (!v.value.protocols.includes(PROTO_VERSION)) return { url, ok: false, error: "protocol", params: { version: v.value.server } };
    return { url, ok: true, ms: Math.max(0, Math.round(env.now() - t0)), version: v.value.server };
  }));
}

/** Map a RemoteError (or anything thrown) from a setup call. */
export function classify(e: unknown, ctx: "login" | "enroll" | "other"): SetupError {
  if (e instanceof SetupError) return e;
  if (isCryptoError(e)) {
    if (e.code === "WrongPassphrase") return new SetupError("pwWrong");
    if (e.code === "UpdateRequired" || e.code === "UnsupportedKdf") return new SetupError("requires");
    return new SetupError("keyCheck", {}, e.code);
  }
  if (isRemoteError(e)) {
    switch (e.code) {
      case "UNAUTHENTICATED":
        return new SetupError(ctx === "enroll" ? "codeExpired" : "badCredentials", {}, e.message);
      case "NOT_FOUND":
        return new SetupError(ctx === "enroll" ? "codeExpired" : "unknown", {}, e.message);
      case "RATE_LIMITED":
        return new SetupError("rateLimited", { s: Math.ceil((e.retryAfterMs ?? 30_000) / 1000) }, e.message);
      case "ALREADY_EXISTS":
        return new SetupError("nameTaken", {}, e.message);
      case "FORBIDDEN":
        return new SetupError("notOwner", {}, e.message);
      case "UNSUPPORTED":
        return new SetupError(/http/i.test(e.message) ? "httpNotAllowed" : "protocol", { version: "?" }, e.message);
      case "NETWORK": case "TIMEOUT":
        return new SetupError(TLS.test(e.message) ? "tls" : "unreachable", { url: "", host: "" }, e.message);
      case "UNAVAILABLE":
        return new SetupError("proxy", { status: 502 }, e.message);
      default:
        return new SetupError("unknown", { code: e.code }, e.message);
    }
  }
  if (e instanceof RangeError) return new SetupError("pwShort", {}, e.message);
  return new SetupError("unknown", {}, e instanceof Error ? e.message : String(e));
}

function authOpts(env: SetupEnv, c: Connection): { urls: string[]; http: HttpClient; allowHttp: boolean; scheduler: Scheduler } {
  return { urls: c.urls, http: env.http, allowHttp: c.allowHttp, scheduler: env.scheduler };
}

export type SignInMethod = { code: string } | { username: string; password: string };

/** design §5.5.3 step 2: /v1/auth/enroll or /v1/auth/login. */
export async function signIn(env: SetupEnv, c: Connection, method: SignInMethod, deviceName: string): Promise<AuthResponse & { url: string }> {
  const device: DeviceDescriptor = { name: deviceName, platform: env.client.platform, clientVersion: env.client.version };
  const ctx = "code" in method ? "enroll" : "login";
  try {
    return "code" in method
      ? await serverEnroll(authOpts(env, c), method.code, device)
      : await serverLogin(authOpts(env, c), method.username, method.password, device);
  } catch (e) {
    throw classify(e, ctx);
  }
}

function rest(env: SetupEnv, c: Connection, token: string): RestClient {
  return new RestClient({
    urls: c.urls, http: env.http, token, scheduler: env.scheduler, allowHttp: c.allowHttp,
    timeouts: { probeMs: PROBE_TIMEOUT_MS, requestMs: 30_000, transferMs: 120_000 },
  });
}

/** design §5.5.5: GET /v1/vaults. */
export async function listVaults(env: SetupEnv, c: Connection, token: string): Promise<VaultSummary[]> {
  try {
    const { data } = await rest(env, c, token).json("GET", "/vaults", "vaults");
    const v = validateVaultsResponse(data);
    if (!v.ok) throw new SetupError("notShuttle", { url: c.urls[0] ?? "" }, `${v.path}: ${v.reason}`);
    return v.value.vaults;
  } catch (e) {
    throw classify(e, "other");
  }
}

/** The adapter-level calls below never open the WebSocket; this factory must not be reached. */
const noWs: WsFactory = () => {
  throw new Error("setup does not open a WebSocket");
};

function adapter(env: SetupEnv, c: Connection, token: string, vaultId: string, vaultName?: string): ServerAdapter {
  return new ServerAdapter({
    config: { urls: c.urls, vaultId }, token, http: env.http, ws: noWs, scheduler: env.scheduler,
    client: { ...env.client, role: "plugin" }, allowHttp: c.allowHttp,
    ...(vaultName !== undefined ? { vaultName } : {}),
  });
}

export interface CreatedVault { vaultId: string; info: VaultInfo; cache: CachedSecrets; ring: CryptoKeyring }

/** design §5.5.5 Create: KDF + sealed vault-info, then POST /v1/vaults. Nothing is stored here. */
export async function createRemoteVault(env: SetupEnv, c: Connection, token: string, name: string, passphrase: string): Promise<CreatedVault> {
  let made: Awaited<ReturnType<typeof createVault>>;
  try {
    made = await createVault(passphrase);
  } catch (e) {
    throw classify(e, "other");
  }
  const info = made.info as unknown as VaultInfo;
  const a = adapter(env, c, token, info.vaultId, name);
  try {
    await a.connect();
    await a.createVaultInfo(info);
  } catch (e) {
    throw classify(e, "other");
  } finally {
    await a.close().catch(() => undefined);
  }
  return { vaultId: info.vaultId, info, cache: made.cache, ring: made.ring };
}

/** Fetch the vault-info (null when the vault has none yet). */
export async function fetchVaultInfo(env: SetupEnv, c: Connection, token: string, vaultId: string): Promise<VaultInfo | null> {
  const a = adapter(env, c, token, vaultId);
  try {
    return (await a.getVaultInfo())?.info ?? null;
  } catch (e) {
    throw classify(e, "other");
  } finally {
    await a.close().catch(() => undefined);
  }
}

/**
 * design §5.5.6: unlock with the passphrase against the live vault-info (design §4.5.3 checks 1-10).
 * Returns the key cache to store; nothing is written on failure.
 */
export async function unlockVault(env: SetupEnv, c: Connection, token: string, vaultId: string, passphrase: string, seen: Seen | null): Promise<{ info: VaultInfo; cache: CachedSecrets; pullOnly: boolean }> {
  const info = await fetchVaultInfo(env, c, token, vaultId);
  if (!info) throw new SetupError("keyCheck", {}, "the remote vault has no vault-info");
  try {
    const u = await unlock(passphrase, info as unknown as CryptoVaultInfo, seen);
    return { info, cache: u.cache, pullOnly: u.pullOnly };
  } catch (e) {
    throw classify(e, "other");
  }
}

/** Check a URL list with the adapter's own rules (throws SetupError httpNotAllowed). */
export function checkUrls(urls: readonly string[], allowHttp: boolean): string[] {
  try {
    return normalizeBaseUrls(urls, allowHttp);
  } catch (e) {
    throw classify(e, "other");
  }
}

/** What the wizard saves after a successful unlock (design §5.5.6 "On success"). */
export interface SetupResult {
  vaultId: string;
  vaultName: string;
  endpoints: Array<{ url: string; label: string }>;
  allowHttp: boolean;
  auth: { token: string; deviceId: string; username?: string; owner?: boolean };
  cache: CachedSecrets;
  info: VaultInfo;
}
