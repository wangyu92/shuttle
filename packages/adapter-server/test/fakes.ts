// Unit-test fakes: a scripted WebSocket, a scripted HttpClient and a recording ChangeSink.
import type {
  ChangeBatch, ChangeSink, ConnectionState, HttpClient, HttpRequest, HttpResponse, RemoteError, SnapshotRequiredInfo,
  WelcomeMsg, WsFactory, WsLike,
} from "@shuttle/protocol";
import { DEFAULT_LIMITS, WS_SUBPROTOCOL } from "@shuttle/protocol";
import { FakeClock, FakeScheduler, drainMicrotasks } from "@shuttle/testkit";
import { ServerAdapter, type ServerAdapterOptions } from "../src/index";

export const VID = "AAAAAAAAAAAAAAAAAAAAAA";
export const DEV = "BBBBBBBBBBBBBBBBBBBBBB";

const enc = new TextEncoder();

export class FakeWs implements WsLike {
  readyState = 0;
  protocol: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Array<Record<string, any>> = [];
  closedByClient: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string, readonly protocols: string[], protocol = WS_SUBPROTOCOL) {
    this.protocol = protocol;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedByClient = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    this.readyState = 3;
  }

  // ---- server side ----
  open(): void { this.readyState = 1; this.onopen?.(); }
  push(m: object): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop(code = 1006, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  ofType(t: string) { return this.sent.filter((f) => f.type === t); }
  last(t: string): Record<string, any> { const a = this.ofType(t); return a[a.length - 1]!; }
}

export class WsPool {
  readonly sockets: FakeWs[] = [];
  autoOpen = true;
  protocol = WS_SUBPROTOCOL;
  factory: WsFactory = (url, protocols) => {
    const ws = new FakeWs(url, protocols, this.protocol);
    this.sockets.push(ws);
    if (this.autoOpen) queueMicrotask(() => ws.open());
    return ws;
  };
  get current(): FakeWs { return this.sockets[this.sockets.length - 1]!; }
}

export type Route = (req: HttpRequest) => HttpResponse | Promise<HttpResponse> | null;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: enc.encode(JSON.stringify(body)).buffer as ArrayBuffer };
}

export class FakeHttp implements HttpClient {
  readonly log: HttpRequest[] = [];
  /** base URL → health behaviour */
  health = new Map<string, "ok" | "down" | "hang" | "old">();
  routes: Route[] = [];
  /** `limits` the health answer carries (absent when unset, like an older server). */
  healthLimits: Record<string, number> | null = null;
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.log.push(req);
    const m = /^(.*)\/v1\/health$/.exec(req.url);
    if (m) {
      const h = this.health.get(m[1]!) ?? "ok";
      if (h === "down") throw new Error("ECONNREFUSED");
      if (h === "hang") return new Promise(() => { /* never */ });
      return json(200, { ok: true, server: "0.1.0", protocols: h === "old" ? [2] : [1], time: 1, source: "https://example.com/src", ...(this.healthLimits ? { limits: this.healthLimits } : {}) });
    }
    for (const r of this.routes) {
      const out = await r(req);
      if (out) return out;
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no route" } });
  }
}

export class RecSink implements ChangeSink {
  readonly batches: ChangeBatch[] = [];
  readonly states: Array<[ConnectionState, string | undefined]> = [];
  readonly errors: RemoteError[] = [];
  readonly snaps: SnapshotRequiredInfo[] = [];
  readonly etags: string[] = [];
  /** When set, onChanges waits on this gate. */
  gate: Promise<void> | null = null;
  fail: Error | null = null;
  async onChanges(b: ChangeBatch): Promise<void> {
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    this.batches.push(b);
  }
  headOf() { return null; }
  liveHeadByPathKey() { return null; }
  onSnapshotRequired(i: SnapshotRequiredInfo) { this.snaps.push(i); }
  onVaultInfoChanged(e: string) { this.etags.push(e); }
  onState(s: ConnectionState, d?: string) { this.states.push([s, d]); }
  onError(e: RemoteError) { this.errors.push(e); }
  stateNames() { return this.states.map((s) => s[0]); }
}

export function welcome(rid: number, o: Partial<WelcomeMsg> = {}): WelcomeMsg {
  return {
    type: "welcome", rid, proto: 1, server: "0.1.0", deviceId: DEV, epoch: 1, headSeq: 10, minSeq: 0, infoEtag: "\"e1\"",
    retention: { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90 }, limits: { ...DEFAULT_LIMITS },
    heartbeatSec: 25, idleTimeoutSec: 60, serverTime: 1, ...o,
  };
}

export function changes(from: number, to: number, o: Partial<ChangeBatch> = {}) {
  return { type: "changes", rid: null, from, to, headSeq: to, minSeq: 0, live: false, more: false, records: [], ...o };
}

export interface Harness {
  clock: FakeClock;
  sched: FakeScheduler;
  pool: WsPool;
  http: FakeHttp;
  adapter: ServerAdapter;
  /** Run timers up to `ms` and settle microtasks. */
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
}

export function harness(o: Partial<ServerAdapterOptions> = {}, urls = ["https://sync.example.com"]): Harness {
  const clock = new FakeClock();
  const sched = new FakeScheduler(clock);
  const pool = new WsPool();
  const http = new FakeHttp();
  const adapter = new ServerAdapter({
    config: { urls, vaultId: VID }, token: "sxd_test", http, ws: pool.factory,
    client: { name: "test", platform: "linux", version: "0.1.0", role: "headless" },
    clock, scheduler: sched, random: () => 0.5, state: memState({ "shuttle-server.epoch": 1 }), ...o,
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await drainMicrotasks(); };
  return {
    clock, sched, pool, http, adapter, settle,
    async advance(ms: number) {
      await settle();
      await sched.advance(ms);
      await settle();
    },
  };
}

export function memState(init: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(init));
  return { map: m, get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } };
}
