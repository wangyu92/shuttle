// REST transport for the own server (design §2.8.4, §2.8.5): base-URL selection over the ordered
// `urls` list (design §2.8.10: the first that answers /v1/health within 3 s), bearer auth, timeouts and
// error mapping. Nothing here retries a request: the engine owns retries, and several endpoints are not
// safe to repeat blindly (pairing take is read-and-delete).

import { API_PREFIX, PROTO_VERSION, WS_PATH, remoteError, validateHealthResponse } from "@shuttle/protocol";
import type { HealthResponse, HttpClient, HttpRequest, HttpResponse, Scheduler } from "@shuttle/protocol";
import { bodyText, errorFromResponse, networkError } from "./errors";
import { withTimeout } from "./runtime";

export type TokenSource = string | (() => string | null | Promise<string | null>);

export interface RestTimeouts {
  /** Per-URL health probe (design §2.8.10: 3 s). */
  probeMs: number;
  /** JSON requests. */
  requestMs: number;
  /** Single blob and pack transfers (up to 8 MiB on a phone link). */
  transferMs: number;
}

export const DEFAULT_REST_TIMEOUTS: RestTimeouts = Object.freeze({ probeMs: 3_000, requestMs: 30_000, transferMs: 120_000 });

export interface RestOptions {
  urls: readonly string[];
  http: HttpClient;
  token: TokenSource;
  scheduler: Scheduler;
  timeouts: RestTimeouts;
  /** Allow plain http:// to hosts other than loopback (headless on a private network, design §6.1). */
  allowHttp: boolean;
}

export interface CallOptions {
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  /** Statuses returned to the caller instead of thrown (e.g. 404 → null). */
  accept?: readonly number[];
  timeoutMs?: number;
  auth?: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Normalize and check the configured base URLs. Throws UNSUPPORTED for unusable entries. */
export function normalizeBaseUrls(urls: readonly string[], allowHttp: boolean): string[] {
  if (urls.length === 0) throw remoteError("UNSUPPORTED", "no server URL configured");
  return urls.map((raw) => {
    let u: URL;
    try { u = new URL(raw); } catch { throw remoteError("UNSUPPORTED", `not a URL: ${raw}`); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw remoteError("UNSUPPORTED", `unsupported scheme in ${raw}`);
    // The device token travels in every request; plain http only on loopback unless explicitly allowed.
    if (u.protocol === "http:" && !allowHttp && !LOOPBACK.has(u.hostname)) {
      throw remoteError("UNSUPPORTED", `plain http to ${u.hostname} needs allowHttp`);
    }
    if (u.search || u.hash) throw remoteError("UNSUPPORTED", `server URL must not carry a query or fragment: ${raw}`);
    let s = u.origin + u.pathname;
    while (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  });
}

/** ws:// or wss:// URL of the WebSocket endpoint under a base URL. */
export function wsUrlOf(base: string): string {
  if (base.startsWith("https://")) return "wss://" + base.slice("https://".length) + WS_PATH;
  if (base.startsWith("http://")) return "ws://" + base.slice("http://".length) + WS_PATH;
  throw remoteError("UNSUPPORTED", `cannot derive a WebSocket URL from ${base}`);
}

export class RestClient {
  readonly urls: string[];
  private selected: string | null = null;
  private probing: Promise<string> | null = null;
  lastHealth: HealthResponse | null = null;

  constructor(private readonly o: RestOptions) {
    this.urls = normalizeBaseUrls(o.urls, o.allowHttp);
  }

  get current(): string | null {
    return this.selected;
  }

  /** Forget the chosen URL; the next call probes again (after a network failure). */
  invalidate(): void {
    this.selected = null;
  }

  /** The chosen base URL, probing when none is chosen. Concurrent callers share one probe. */
  base(): Promise<string> {
    if (this.selected) return Promise.resolve(this.selected);
    return this.probe();
  }

  /**
   * Probe every URL at once and take the first one **in list order** that answers /v1/health with a
   * supported protocol within `probeMs` (design §2.8.10, UX-D1 endpoint mode `auto`).
   */
  probe(): Promise<string> {
    if (this.probing) return this.probing;
    const run = async (): Promise<string> => {
      const attempts = this.urls.map((base) => this.health(base).then(
        (h) => ({ base, h, err: null as unknown }),
        (err: unknown) => ({ base, h: null as HealthResponse | null, err }),
      ));
      let unsupported = false;
      let lastErr: unknown = null;
      for (const a of attempts) {
        const r = await a;
        if (r.h && r.h.ok && r.h.protocols.includes(PROTO_VERSION)) {
          this.selected = r.base;
          this.lastHealth = r.h;
          return r.base;
        }
        if (r.h) unsupported = true;
        else lastErr = r.err;
      }
      if (unsupported) throw remoteError("UNSUPPORTED", `no server speaks protocol ${PROTO_VERSION}`);
      throw networkError(lastErr ?? "no server URL answered", "server unreachable");
    };
    const p = run().finally(() => { this.probing = null; });
    this.probing = p;
    return p;
  }

  private async health(base: string): Promise<HealthResponse> {
    const res = await this.raw({ url: base + API_PREFIX + "/health", method: "GET", timeoutMs: this.o.timeouts.probeMs }, "health");
    if (res.status !== 200) throw errorFromResponse(res, "health");
    const v = validateHealthResponse(parseJson(res));
    if (!v.ok) throw remoteError("PROTOCOL", `health: ${v.path}: ${v.reason}`);
    return v.value;
  }

  private async raw(req: HttpRequest, what: string): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await withTimeout(this.o.http.request(req), req.timeoutMs, this.o.scheduler, what);
    } catch (e) {
      throw networkError(e, what);
    }
    // Some HttpClients report a connection failure as status 0.
    if (res.status === 0) throw remoteError("NETWORK", `${what}: no response`);
    return res;
  }

  async token(): Promise<string> {
    const t = typeof this.o.token === "string" ? this.o.token : await this.o.token();
    if (!t) throw remoteError("UNAUTHENTICATED", "no device token: log in or enroll first");
    return t;
  }

  /** One request below the chosen base. Throws RemoteError for non-2xx outside `accept`. */
  async call(method: HttpRequest["method"], path: string, what: string, o: CallOptions = {}): Promise<HttpResponse> {
    const base = await this.base();
    const headers: Record<string, string> = { Accept: "application/json", ...o.headers };
    if (o.auth !== false) headers["Authorization"] = `Bearer ${await this.token()}`;
    const req: HttpRequest = { url: base + API_PREFIX + path, method, headers, timeoutMs: o.timeoutMs ?? this.o.timeouts.requestMs };
    if (o.body !== undefined) req.body = o.body;
    let res: HttpResponse;
    try {
      res = await this.raw(req, what);
    } catch (e) {
      // A dead endpoint: let the next call re-probe and maybe fall back to the next URL.
      this.invalidate();
      throw e;
    }
    if ((res.status >= 200 && res.status < 300) || o.accept?.includes(res.status)) return res;
    if (res.status === 502 || res.status === 503 || res.status === 504) this.invalidate();
    throw errorFromResponse(res, what);
  }

  /** JSON request and response. */
  async json(method: HttpRequest["method"], path: string, what: string, body?: unknown, o: CallOptions = {}): Promise<{ res: HttpResponse; data: unknown }> {
    const headers = body !== undefined ? { "Content-Type": "application/json", ...o.headers } : o.headers;
    const res = await this.call(method, path, what, {
      ...o, ...(headers ? { headers } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { res, data: res.status === 204 ? null : parseJson(res) };
  }
}

export function parseJson(res: HttpResponse): unknown {
  const text = bodyText(res);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw remoteError("PROTOCOL", `expected JSON, got ${text.slice(0, 80)}`);
  }
}
