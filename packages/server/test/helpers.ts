// Shared helpers for the server integration tests: real HTTP and WebSocket on 127.0.0.1, port 0.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { WS_PATH, WS_SUBPROTOCOL } from "@shuttle/protocol";
import type { CommitOp, CommitResultMsg, HelloMsg, VaultInfoEnvelope } from "@shuttle/protocol";
import { runAdmin } from "../src/adminCli";
import { startServer, type RunningServer, type ServerOptions } from "../src/server";

// Never os.tmpdir(): the system temp dir is RAM on the NAS (design §8.2).
export const TEST_ROOT = path.join(os.homedir(), "tmp/claude/shuttle-p1/server-test");
export const FAST_SCRYPT = { N: 1024, r: 8, p: 1 };
export const PASSWORD = "correct horse battery";

export async function tempDir(prefix: string): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(path.join(TEST_ROOT, `${prefix}-`));
}

export async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true });
}

export class FakeTime {
  t = Date.UTC(2026, 10, 1, 12, 0, 0);
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

export function testOptions(dataDir: string, extra: Partial<ServerOptions> = {}): ServerOptions {
  return {
    host: "127.0.0.1", port: 0, dataDir, jobs: false, scrypt: FAST_SCRYPT,
    rates: { commitsPerSec: 100_000, blobReqPerSec: 100_000, loginFailuresPerMin: 5 },
    sourceUrl: "https://example.invalid/shuttle", ...extra,
  };
}

export async function start(dataDir: string, extra: Partial<ServerOptions> = {}): Promise<RunningServer> {
  return startServer(testOptions(dataDir, extra));
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const fileId = () => randomBytes(16).toString("hex");
export const pathKey = () => randomBytes(16).toString("base64url");
export const vaultId = () => randomBytes(16).toString("base64url");
export const cid = () => randomUUID();
export const meta = (n = 48) => randomBytes(n).toString("base64url");
export const blobId = () => randomBytes(32).toString("hex");

export function sealed(size: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set(randomBytes(size));
  b.set([0x53, 0x58, 0x42, 0x31, 1, 0]); // "SXB1", kv 1, flags 0
  return b;
}

export function makeInfo(vid: string, o: { epoch?: number; infoRev?: number; activeKv?: number; extra?: Record<string, unknown> } = {}): VaultInfoEnvelope {
  return {
    format: "shuttle.vault-info", formatVersion: 1, vaultId: vid, createdAt: 1, infoRev: o.infoRev ?? 1, epoch: o.epoch ?? 1,
    activeKv: o.activeKv ?? 1, infoMac: "mac-" + (o.infoRev ?? 1),
    retention: { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90 },
    unknownField: { kept: true }, ...o.extra,
  };
}

export function silentIo(dataDir: string, password = PASSWORD) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { dataDir, out: (l: string) => out.push(l), err: (l: string) => err.push(l), readPassword: async () => password, scrypt: FAST_SCRYPT },
    out, err,
  };
}

export async function addUser(dataDir: string, name: string, owner = true): Promise<void> {
  const { io, err } = silentIo(dataDir);
  const code = await runAdmin(["user", "add", name, ...(owner ? ["--owner"] : []), "--password-stdin"], io);
  if (code !== 0) throw new Error(`user add failed: ${err.join("\n")}`);
}

export interface Client { token: string; deviceId: string; auth: Record<string, string> }

export async function login(srv: RunningServer, username: string, deviceName = "laptop"): Promise<Client> {
  const r = await fetch(`${srv.url}/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD, device: { name: deviceName, platform: "linux", clientVersion: "0.1.0" } }),
  });
  if (r.status !== 200) throw new Error(`login ${r.status} ${await r.text()}`);
  const b = (await r.json()) as { token: string; deviceId: string };
  return { token: b.token, deviceId: b.deviceId, auth: { Authorization: `Bearer ${b.token}` } };
}

export async function api(srv: RunningServer, c: Client | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const init: RequestInit = { method, headers: { ...(c ? c.auth : {}), ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const r = await fetch(`${srv.url}${p}`, init);
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}

export async function createVault(srv: RunningServer, c: Client, name = "Vault", info?: VaultInfoEnvelope): Promise<string> {
  const vid = info?.vaultId ?? vaultId();
  const r = await api(srv, c, "POST", "/v1/vaults", { name, info: info ?? makeInfo(vid) });
  if (r.status !== 201) throw new Error(`create vault ${r.status} ${JSON.stringify(r.json)}`);
  return vid;
}

export async function putBlob(srv: RunningServer, c: Client, vid: string, id: string, body: Uint8Array<ArrayBuffer>, hash = sha256(body)): Promise<Response> {
  return fetch(`${srv.url}/v1/vaults/${vid}/blobs/${id}`, {
    method: "PUT", body, headers: { ...c.auth, "Content-Type": "application/octet-stream", "X-Shuttle-Sha256": hash },
  });
}

/** Setup: one owner user, one logged-in device, one vault. */
export async function fixture(srv: RunningServer, dataDir: string, user = "alice"): Promise<{ c: Client; vid: string }> {
  await addUser(dataDir, user);
  const c = await login(srv, user);
  const vid = await createVault(srv, c, `vault-${user}`);
  return { c, vid };
}

type Frame = Record<string, any>;

/** WebSocket test client with a frame queue. */
export class TestWs {
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  private rid = 100;
  autoAck = false;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const f = JSON.parse(String(d)) as Frame;
      this.frames.push(f);
      if (this.autoAck && f.type === "changes" && f.rid === null) this.send({ type: "ack", upTo: f.to });
      this.notify();
    });
    ws.on("close", (code, reason) => { this.closed = { code, reason: String(reason) }; this.notify(); });
  }

  static async open(srv: RunningServer, protocols: string[] = [WS_SUBPROTOCOL]): Promise<TestWs> {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${WS_PATH}`, protocols);
    const t = new TestWs(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return t;
  }

  private notify() { for (const w of this.waiters.splice(0)) w(); }

  nextRid(): number { return ++this.rid; }

  send(m: object) { this.ws.send(JSON.stringify(m)); }

  /** Waits for the first unconsumed frame matching pred and removes it (and everything before it if `drop`). */
  async take(pred: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.frames.findIndex(pred);
      if (i >= 0) return this.frames.splice(i, 1)[0]!;
      if (this.closed) throw new Error(`socket closed ${this.closed.code} ${this.closed.reason} while waiting; frames=${JSON.stringify(this.frames).slice(0, 500)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; frames=${JSON.stringify(this.frames).slice(0, 800)}`);
      await new Promise<void>((r) => { const t = setTimeout(r, left); this.waiters.push(() => { clearTimeout(t); r(); }); });
    }
  }

  type(type: string, timeoutMs?: number) { return this.take((f) => f.type === type, timeoutMs); }

  async waitClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout waiting for close");
      await new Promise<void>((r) => { const t = setTimeout(r, left); this.waiters.push(() => { clearTimeout(t); r(); }); });
    }
    return this.closed;
  }

  hello(token: string, vid: string, o: Partial<HelloMsg> = {}): number {
    const rid = this.nextRid();
    this.send({
      type: "hello", rid, proto: 1, token, vaultId: vid, since: 0, epoch: 1, seenMaxSeq: null, rollbackAck: null,
      client: { name: "test", platform: "linux", version: "0.1.0", role: "headless" }, window: { maxUnackedBytes: 8 * 1024 * 1024 }, ...o,
    });
    return rid;
  }

  /** hello → welcome, then waits for the catch-up frame with more:false (unless parked). */
  async connect(token: string, vid: string, o: Partial<HelloMsg> = {}): Promise<{ welcome: Frame; changes: Frame[] }> {
    const rid = this.hello(token, vid, o);
    const welcome = await this.take((f) => f.type === "welcome" && f.rid === rid);
    const changes: Frame[] = [];
    if (o.since === null) return { welcome, changes };
    for (;;) {
      const f = await this.take((x) => (x.type === "changes" && x.rid === null) || x.type === "snapshotRequired");
      if (f.type === "snapshotRequired") { this.frames.unshift(f); return { welcome, changes }; }
      changes.push(f);
      if (!f.more) return { welcome, changes };
    }
  }

  async commit(ops: CommitOp[], o: { cid?: string; atomic?: boolean } = {}): Promise<CommitResultMsg> {
    const rid = this.nextRid();
    this.send({ type: "commit", rid, cid: o.cid ?? cid(), ops, ...(o.atomic !== undefined ? { atomic: o.atomic } : {}) });
    const f = await this.take((x) => x.rid === rid);
    if (f.type !== "commitResult") throw new Error(`commit answered with ${JSON.stringify(f)}`);
    return f as unknown as CommitResultMsg;
  }

  close() { if (!this.closed) this.ws.close(1000); }
}

export function putOp(fid: string, base: number | null, pk: string, o: Partial<{ blobs: string[]; inline: string | null; kv: number; rc: "note" | "attachment" | "config" }> = {}): CommitOp {
  const blobs = o.blobs ?? [];
  return { op: "put", fileId: fid, base, pathKey: pk, rc: o.rc ?? "note", kv: o.kv ?? 1, meta: meta(), blobs, inline: o.inline !== undefined ? o.inline : (blobs.length ? null : meta(20)) };
}

export function delOp(fid: string, base: number, pk: string, kv = 1): CommitOp {
  return { op: "del", fileId: fid, base, pathKey: pk, rc: "note", kv, meta: meta() };
}

export function archiveOp(fid: string, base: number, pk: string): CommitOp {
  return { op: "archive", fileId: fid, base, pathKey: pk, rc: "note", kv: 1, meta: meta(), blobs: [], inline: meta(10) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
