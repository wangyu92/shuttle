// Server probes M4..M8 against the real server (packages/server, design §2.8, §2.9): GET /v1/health,
// PUT/GET /v1/vaults/{vid}/blobs/{blobId}, WebSocket /v1/ws with subprotocol "shuttle.1".
// Auth (design §2.8.4): a device token pasted in the settings, or an enroll code swapped for one via
// POST /v1/auth/enroll. Every probe works in its own vault "shuttle-spike", created on first use.
import { HEADER_SHA256, VAULT_INFO_FORMAT, VAULT_INFO_FORMAT_VERSION, WS_PATH, WS_SUBPROTOCOL } from "@shuttle/protocol";
import type { AuthResponse, CreateVaultResponse, VaultSummary } from "@shuttle/protocol";
import { Platform, apiVersion, requestUrl } from "obsidian";
import type { Ctx, Probe, ProbeOutcome } from "../types.js";
import { KiB, MiB, b64u, errMsg, now, randomBytes, round, sha256hex, sleep, withTimeout } from "../util.js";

const HEALTH_TIMEOUT_MS = 3000;

function base(ctx: Ctx): string {
  return ctx.settings.serverUrl.replace(/\/+$/, "");
}

function wsUrl(ctx: Ctx): string {
  return base(ctx).replace(/^http/, "ws") + WS_PATH;
}

let healthCache: { url: string; at: number; result: HealthResult } | null = null;
interface HealthResult {
  ok: boolean;
  ms: number;
  body?: unknown;
  error?: string;
}

export async function health(ctx: Ctx, fresh = false): Promise<HealthResult> {
  const url = base(ctx) + "/v1/health";
  if (!fresh && healthCache && healthCache.url === url && Date.now() - healthCache.at < 60_000) return healthCache.result;
  const t0 = now();
  let result: HealthResult;
  try {
    const r = await withTimeout(requestUrl({ url, method: "GET", throw: false }), HEALTH_TIMEOUT_MS);
    const body: unknown = (() => {
      try {
        return r.json as unknown;
      } catch {
        return null;
      }
    })();
    const ok = r.status === 200 && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
    result = { ok, ms: round(now() - t0), body, ...(ok ? {} : { error: `HTTP ${r.status}, not a Shuttle health body` }) };
  } catch (e) {
    result = { ok: false, ms: round(now() - t0), error: errMsg(e) };
  }
  healthCache = { url, at: Date.now(), result };
  return result;
}

function skipped(ctx: Ctx, h: HealthResult): ProbeOutcome {
  return { status: "skipped", summary: `server unreachable (${base(ctx)}): ${h.error ?? "?"}`, data: { health: h } };
}

/** The vault every server probe writes into. Never a real vault: blobs here are random bytes. */
const SPIKE_VAULT_NAME = "shuttle-spike";

/** 16 random bytes as 22-char base64url (vaultId format, design §2.2). */
function newVaultId(): string {
  for (;;) {
    const id = b64u(randomBytes(16));
    if (/^[A-Za-z0-9_-]{21}[AQgw]$/.test(id)) return id;
  }
}

interface Session { url: string; token: string; vaultId: string }
let session: Session | null = null;

function authHeaders(s: Session): Record<string, string> {
  return { Authorization: `Bearer ${s.token}` };
}

function bodyJson(r: { json: unknown }): Record<string, unknown> | null {
  try {
    const j = r.json as unknown;
    return typeof j === "object" && j !== null ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errCode(r: { status: number; json: unknown }): string {
  const e = bodyJson(r)?.error as { code?: unknown; message?: unknown } | undefined;
  return `HTTP ${r.status}${e && typeof e.code === "string" ? ` ${e.code}` : ""}${e && typeof e.message === "string" ? `: ${e.message}` : ""}`;
}

/**
 * Token and spike vault for this server URL, cached per plugin session. An enroll code in the settings
 * is redeemed once and replaced by the device token it returns (saved in the plugin data).
 */
export async function ensureSession(ctx: Ctx): Promise<Session> {
  const url = base(ctx);
  const raw = ctx.settings.serverToken.trim();
  if (session && session.url === url && session.token === raw) return session;
  if (raw === "") throw new SpikeAuthError("no server token in the spike settings (paste a device token or an enroll code)");
  let token = raw;
  if (!raw.startsWith("sxd_")) {
    const r = await requestUrl({
      url: `${url}/v1/auth/enroll`, method: "POST", contentType: "application/json", throw: false,
      body: JSON.stringify({ code: raw, device: { name: ctx.settings.deviceName || "spike", platform: platformName(), clientVersion: `spike/${apiVersion}` } }),
    });
    if (r.status !== 200) throw new SpikeAuthError(`enroll failed: ${errCode(r)}`);
    token = (r.json as AuthResponse).token;
    ctx.settings.serverToken = token;
    await ctx.saveSettings();
  }
  const s: Session = { url, token, vaultId: "" };
  const list = await requestUrl({ url: `${url}/v1/vaults`, method: "GET", headers: authHeaders(s), throw: false });
  if (list.status !== 200) throw new SpikeAuthError(`token rejected: ${errCode(list)}`);
  const found = ((bodyJson(list)?.vaults ?? []) as VaultSummary[]).find((v) => v.name === SPIKE_VAULT_NAME);
  if (found) s.vaultId = found.vaultId;
  else {
    const vaultId = newVaultId();
    // The server stores vault-info opaquely (design §2.8.5); this one is a placeholder no client can unlock.
    const info = {
      format: VAULT_INFO_FORMAT, formatVersion: VAULT_INFO_FORMAT_VERSION, vaultId, createdAt: Date.now(),
      infoRev: 1, epoch: 1, activeKv: 1, infoMac: "spike-placeholder", spike: true,
    };
    const r = await requestUrl({
      url: `${url}/v1/vaults`, method: "POST", contentType: "application/json", headers: authHeaders(s), throw: false,
      body: JSON.stringify({ name: SPIKE_VAULT_NAME, info }),
    });
    if (r.status !== 201) throw new SpikeAuthError(`could not create the vault "${SPIKE_VAULT_NAME}": ${errCode(r)}`);
    s.vaultId = (r.json as CreateVaultResponse).vaultId;
  }
  session = s;
  return s;
}

export class SpikeAuthError extends Error {}

/** Health, then auth: a skipped outcome when either is missing, else the session. */
async function ready(ctx: Ctx, fresh = false): Promise<{ h: HealthResult; s: Session } | ProbeOutcome> {
  const h = await health(ctx, fresh);
  if (!h.ok) return skipped(ctx, h);
  try {
    return { h, s: await ensureSession(ctx) };
  } catch (e) {
    return { status: e instanceof SpikeAuthError ? "skipped" : "fail", summary: `server auth: ${errMsg(e)}`, data: { health: h } };
  }
}

/** A fake sealed blob: "SXB1", kv 1, flags 0, then random bytes. The server only checks magic, length and sha256. */
function fakeBlob(size: number): Uint8Array<ArrayBuffer> {
  const b = randomBytes(size);
  b.set([0x53, 0x58, 0x42, 0x31, 1, 0], 0);
  return b;
}

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

async function putBlob(s: Session, body: Uint8Array<ArrayBuffer>) {
  const blobId = await sha256hex(body);
  const url = `${s.url}/v1/vaults/${s.vaultId}/blobs/${blobId}`;
  const t0 = now();
  const r = await requestUrl({
    url,
    method: "PUT",
    body: body.buffer,
    contentType: "application/octet-stream",
    headers: { ...authHeaders(s), [HEADER_SHA256]: blobId },
    throw: false,
  });
  const h = lowerHeaders(r.headers);
  return { blobId, url, status: r.status, ms: round(now() - t0), fromShuttle: "x-shuttle-server" in h, text: r.status >= 400 ? safeText(r) : "" };
}

function safeText(r: { text: string }): string {
  try {
    return r.text.slice(0, 200);
  } catch {
    return "";
  }
}

function netInfo(): Record<string, unknown> {
  const c = (navigator as { connection?: { effectiveType?: string; type?: string; downlink?: number } }).connection;
  return c ? { effectiveType: c.effectiveType ?? null, type: c.type ?? null, downlinkMbps: c.downlink ?? null } : { connection: "n/a" };
}

interface WsSession {
  ws: WebSocket;
  protocol: string;
  connectMs: number;
  welcomeMs: number;
  welcome: Record<string, unknown>;
  closeInfo: { code: number; reason: string; at: number } | null;
}

/** Opens /v1/ws, sends hello and waits for welcome. */
export async function openWs(ctx: Ctx, timeoutMs = 5000): Promise<WsSession> {
  const auth = await ensureSession(ctx);
  const t0 = now();
  const ws = new WebSocket(wsUrl(ctx), [WS_SUBPROTOCOL]);
  const session: Partial<WsSession> & { closeInfo: WsSession["closeInfo"] } = { ws, closeInfo: null };
  ws.addEventListener("close", (ev) => {
    session.closeInfo = { code: ev.code, reason: ev.reason, at: Date.now() };
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket error before open")), { once: true });
    }),
    timeoutMs,
  ).catch((e: unknown) => {
    ws.close();
    throw e;
  });
  session.connectMs = round(now() - t0);
  session.protocol = ws.protocol;
  const welcome = await withTimeout(
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMsg = (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (m.type === "welcome") {
            ws.removeEventListener("message", onMsg);
            resolve(m);
          } else if (m.type === "error") reject(new Error(`server error ${String(m.code)}: ${String(m.message)}`));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      ws.addEventListener("message", onMsg);
      ws.addEventListener("close", (ev) => reject(new Error(`closed before welcome: ${ev.code} ${ev.reason}`)), { once: true });
      ws.send(
        JSON.stringify({
          type: "hello",
          rid: 1,
          proto: 1,
          token: auth.token,
          vaultId: auth.vaultId,
          since: null,
          epoch: null,
          seenMaxSeq: null,
          rollbackAck: null,
          client: { name: ctx.settings.deviceName || "spike", platform: platformName(), version: `spike/${apiVersion}`, role: "plugin" },
          window: { maxUnackedBytes: 8 * MiB },
        }),
      );
    }),
    timeoutMs,
  ).catch((e: unknown) => {
    ws.close();
    throw e;
  });
  session.welcomeMs = round(now() - t0);
  session.welcome = welcome;
  return session as WsSession;
}

async function pingRtt(ws: WebSocket, rid: number): Promise<number> {
  const t0 = now();
  await withTimeout(
    new Promise<void>((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as { type?: string; rid?: number };
          if (m.type === "pong" && m.rid === rid) {
            ws.removeEventListener("message", onMsg);
            resolve();
          }
        } catch {
          /* ignore */
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ type: "ping", rid, ts: Date.now() }));
    }),
    5000,
  );
  return round(now() - t0);
}

export function platformName(): string {
  if (Platform.isIosApp) return Platform.isTablet ? "ipados" : "ios";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isMacOS) return "macos";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  return "unknown";
}

export const serverProbes: Probe[] = [
  {
    id: "M4",
    title: "requestUrl PUT and GET of 4 MiB",
    safe: true,
    needsServer: true,
    async run(ctx): Promise<ProbeOutcome> {
      const rd = await ready(ctx);
      if (!("s" in rd)) return rd;
      const { h, s } = rd;
      ctx.progress("M4: PUT 4 MiB");
      const body = fakeBlob(4 * MiB);
      const put = await putBlob(s, body);
      if (put.status !== 201 && put.status !== 200) {
        return { status: "fail", summary: `PUT HTTP ${put.status} ${put.text}`, data: { put, net: netInfo() } };
      }
      ctx.progress("M4: GET 4 MiB");
      const t0 = now();
      const r = await requestUrl({ url: put.url, method: "GET", headers: authHeaders(s), throw: false });
      const getMs = round(now() - t0);
      const match = r.status === 200 && (await sha256hex(r.arrayBuffer)) === put.blobId;
      const data = { healthMs: h.ms, putMs: put.ms, putStatus: put.status, getMs, getStatus: r.status, hashMatch: match, net: netInfo() };
      const fast = put.ms < 3000 && getMs < 3000;
      return {
        status: !match ? "fail" : fast ? "pass" : "info",
        summary: `PUT ${put.ms} ms, GET ${getMs} ms, hash ${match ? "matches" : "MISMATCH"} (Wi-Fi limit 3 s, LTE 8 s: note which network)`,
        data,
      };
    },
  },
  {
    id: "M5",
    title: "Large PUT (8 MiB target); largest size that passes",
    safe: true,
    needsServer: true,
    async run(ctx): Promise<ProbeOutcome> {
      const rd = await ready(ctx);
      if (!("s" in rd)) return rd;
      const { s } = rd;
      // The server caps a blob at maxBlobSize (4 MiB + 1 KiB) itself, so this measures where a 413 comes
      // from (fromShuttle = the server answered; otherwise a proxy such as DSM nginx).
      const sizes = [8 * MiB, 6 * MiB, 4 * MiB + KiB, 4 * MiB];
      const tries: Record<string, unknown>[] = [];
      let largestPass = 0;
      for (const size of sizes) {
        ctx.progress(`M5: PUT ${size} B`);
        try {
          const p = await putBlob(s, fakeBlob(size));
          tries.push({ size, status: p.status, fromShuttle: p.fromShuttle, ms: p.ms, text: p.text });
          if (p.status < 300) {
            largestPass = Math.max(largestPass, size);
            break;
          }
        } catch (e) {
          tries.push({ size, error: errMsg(e) });
        }
      }
      const proxy413 = tries.some((t) => t.status === 413 && t.fromShuttle === false);
      // 8 MiB answered 2xx, or 413 by Shuttle itself: either way the body got through the proxy.
      const t8 = tries.find((t) => t.size === 8 * MiB);
      const through8 = !!t8 && typeof t8.status === "number" && (t8.status < 300 || (t8.status === 413 && t8.fromShuttle === true));
      return {
        status: through8 ? "pass" : proxy413 ? "fail" : "info",
        summary: `${through8 ? (largestPass >= 8 * MiB ? "8 MiB PUT 2xx" : "8 MiB body reached the server (its own 413; run it with SHUTTLE_MAX_BLOB=8650752 for a 2xx)") : "8 MiB did not reach the server"}; largest passing PUT ${largestPass} B; ${proxy413 ? "a PROXY returned 413" : "no proxy 413"}`,
        data: { tries, largestPass, proxy413, through8 },
      };
    },
  },
  {
    id: "M6",
    title: "requestUrl throw:false with If-None-Match (304?)",
    safe: true,
    needsServer: true,
    async run(ctx): Promise<ProbeOutcome> {
      const rd = await ready(ctx);
      if (!("s" in rd)) return rd;
      const { s } = rd;
      const put = await putBlob(s, fakeBlob(64 * KiB));
      try {
        const r = await requestUrl({ url: put.url, method: "GET", headers: { ...authHeaders(s), "If-None-Match": `"${put.blobId}"` }, throw: false });
        const etag = lowerHeaders(r.headers)["etag"] ?? null;
        return {
          status: r.status === 304 ? "pass" : "info",
          summary: r.status === 304
            ? "304 returned through requestUrl"
            : `got ${r.status} (the server does not answer 304; the fallback is a plain 200), etag header ${etag ? "visible" : "NOT visible"}`,
          data: { status: r.status, etag },
        };
      } catch (e) {
        return { status: "fail", summary: `requestUrl threw despite throw:false: ${errMsg(e)}`, data: { error: errMsg(e) } };
      }
    },
  },
  {
    id: "M7",
    title: "wss:// connect with subprotocol echo, hello/welcome, ping RTT",
    safe: true,
    needsServer: true,
    async run(ctx): Promise<ProbeOutcome> {
      const rd = await ready(ctx);
      if (!("s" in rd)) return rd;
      try {
        const s = await openWs(ctx);
        const rtt = await pingRtt(s.ws, 2);
        s.ws.send(JSON.stringify({ type: "bye" }));
        s.ws.close();
        const echo = s.protocol === WS_SUBPROTOCOL;
        return {
          status: echo && s.welcomeMs < 2000 ? "pass" : "fail",
          summary: `open ${s.connectMs} ms, welcome ${s.welcomeMs} ms, subprotocol "${s.protocol}", ping ${rtt} ms (10 min idle: run "M7 idle hold")`,
          data: { url: wsUrl(ctx), connectMs: s.connectMs, welcomeMs: s.welcomeMs, protocol: s.protocol, rttMs: rtt, server: s.welcome.server ?? null },
        };
      } catch (e) {
        return { status: "fail", summary: `WebSocket failed: ${errMsg(e)}`, data: { url: wsUrl(ctx), error: errMsg(e) } };
      }
    },
  },
  {
    id: "M7-idle",
    title: "WebSocket foreground idle hold (default 10 min)",
    safe: false,
    needsServer: true,
    confirm: "Holds a WebSocket open for the configured minutes. Keep Obsidian in the foreground and the screen on.",
    async run(ctx): Promise<ProbeOutcome> {
      const rd = await ready(ctx, true);
      if (!("s" in rd)) return rd;
      const minutes = Math.max(1, ctx.settings.m7IdleMinutes);
      const s = await openWs(ctx);
      const start = Date.now();
      const end = start + minutes * 60_000;
      let pings = 0;
      let rid = 10;
      let pongMissed = false;
      const rtts: number[] = [];
      while (Date.now() < end && s.ws.readyState === WebSocket.OPEN) {
        await sleep(Math.min(25_000, Math.max(0, end - Date.now())));
        if (s.ws.readyState !== WebSocket.OPEN) break;
        try {
          rtts.push(await pingRtt(s.ws, rid++));
          pings++;
        } catch {
          // A missed pong on an OPEN socket is the half-open case behind a proxy: that is a failure.
          pongMissed = true;
          break;
        }
        ctx.progress(`M7 idle: ${Math.max(0, Math.round((end - Date.now()) / 1000))} s left, ${pings} pings`);
      }
      const heldMs = Date.now() - start;
      const open = s.ws.readyState === WebSocket.OPEN;
      if (open) s.ws.close();
      const ok = !pongMissed && open && heldMs >= minutes * 60_000;
      const why = pongMissed ? `pong missed after ${Math.round(heldMs / 1000)} s (half-open socket?)` : !open ? `closed after ${Math.round(heldMs / 1000)} s: ${JSON.stringify(s.closeInfo)}` : `ended early after ${Math.round(heldMs / 1000)} s`;
      return {
        status: ok ? "pass" : "fail",
        summary: ok ? `stayed open ${minutes} min (${pings} app pings, all answered)` : why,
        data: { minutes, heldMs, pings, pongMissed, maxRttMs: Math.max(0, ...rtts), closeInfo: s.closeInfo },
      };
    },
  },
];

// ---------- M8: return from background (armed recorder) ----------

export class M8Recorder {
  private session: WsSession | null = null;
  private hiddenAt = 0;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private listener: (() => void) | null = null;
  armed = false;

  async arm(ctx: Ctx, done: (o: ProbeOutcome) => void): Promise<string> {
    const rd = await ready(ctx, true);
    if (!("s" in rd)) {
      done(rd);
      return rd.summary;
    }
    this.disarm();
    this.session = await openWs(ctx);
    this.armed = true;
    const events: string[] = [];
    this.listener = () => {
      const st = document.visibilityState;
      events.push(`${st}@${Date.now()}`);
      if (st === "hidden") {
        this.hiddenAt = Date.now();
        // §10.2: the client closes the socket after 5 s in the background.
        this.closeTimer = setTimeout(() => this.session?.ws.close(1000, "background"), 5000);
      } else if (st === "visible" && this.hiddenAt) {
        clearTimeout(this.closeTimer);
        const awayMs = Date.now() - this.hiddenAt;
        const stillOpen = this.session?.ws.readyState === WebSocket.OPEN;
        const closeInfo = this.session?.closeInfo ?? null;
        this.session?.ws.close();
        const t0 = now();
        openWs(ctx)
          .then((s2) => {
            const ms = round(now() - t0);
            s2.ws.close();
            // §10.2 needs a real absence: more than 5 s away and the old socket closed by the timer.
            const realAbsence = awayMs > 5000 && !stillOpen;
            done({
              status: !realAbsence ? "info" : ms < 3000 ? "pass" : "fail",
              summary: `${realAbsence ? "" : "RETRY (stay away more than 5 s): "}visibilitychange fired; away ${Math.round(awayMs / 1000)} s, old socket ${stillOpen ? "still open" : "closed"}, reconnect+welcome ${ms} ms (catch-up of 100 records UNVERIFIED: the spike vault has no records)`,
              data: { events, awayMs, stillOpen, closeInfo, reconnectMs: ms },
            });
          })
          .catch((e: unknown) => done({ status: "fail", summary: `reconnect failed: ${errMsg(e)}`, data: { events, awayMs, error: errMsg(e) } }))
          .finally(() => this.disarm());
      }
    };
    document.addEventListener("visibilitychange", this.listener);
    return "armed: switch to another app for more than 5 s, then come back";
  }

  disarm(): void {
    if (this.listener) document.removeEventListener("visibilitychange", this.listener);
    this.listener = null;
    clearTimeout(this.closeTimer);
    if (this.session && this.session.ws.readyState <= WebSocket.OPEN) this.session.ws.close();
    this.session = null;
    this.hiddenAt = 0;
    this.armed = false;
  }
}
