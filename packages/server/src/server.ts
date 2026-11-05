// P0 dev server stub (design §2.8, §2.9, §9 P0). AGPL-3.0-only.
// Implements: GET /v1/health, HEAD/PUT/GET /v1/vaults/{vid}/blobs/{blobId}, and the
// WebSocket endpoint /v1/ws (subprotocol shuttle.1) answering hello with a stub welcome.
// Not implemented yet: auth, SQLite, commits, changes, quota, packs (P1).
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CloseCode,
  DEFAULT_LIMITS,
  HEADER_REQUEST_ID,
  HEADER_SERVER,
  HEADER_SHA256,
  HEARTBEAT_SEC,
  HELLO_TIMEOUT_SEC,
  IDLE_TIMEOUT_SEC,
  MAX_WS_FRAME,
  PROTO_VERSION,
  SUPPORTED_PROTOCOLS,
  WS_PATH,
  WS_SUBPROTOCOL,
  isBlobId,
  isSha256Hex,
  isVaultId,
} from "@shuttle/protocol";
import type { ErrorBody, ErrorMsg, HelloMsg, PongMsg, Retention, WelcomeLimits, WelcomeMsg } from "@shuttle/protocol";

// TODO(P1): take the version from package.json at build time.
export const SERVER_VERSION = "0.0.0";
// TODO(P1): replace with the public repo URL once §10.1 Q2 (repo visibility) is answered.
export const DEFAULT_SOURCE_URL = "https://github.com/wangyu92/shuttle";
// TODO: move to @shuttle/protocol if it ever exports blob header constants (crypto has BLOB_MAGIC; the
// server must not import @shuttle/crypto). §4.6.1: "SXB1" magic, minimum sealed length 34.
const BLOB_MAGIC = [0x53, 0x58, 0x42, 0x31] as const;
const BLOB_MIN_LEN = 34;
// TODO(P1): retention comes from vault-info / server config; §2.9.2 example values.
const STUB_RETENTION: Retention = { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90 };

export interface ServerOptions {
  host?: string;          // default 127.0.0.1
  port?: number;          // 0 = random
  dataDir: string;
  maxBlobSize?: number;   // default DEFAULT_LIMITS.maxBlobSize
  sourceUrl?: string;
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const dataDir = path.resolve(opts.dataDir);
  const maxBlobSize = opts.maxBlobSize ?? DEFAULT_LIMITS.maxBlobSize;
  const sourceUrl = opts.sourceUrl ?? DEFAULT_SOURCE_URL;
  const log = opts.log ?? (() => {});
  const limits: WelcomeLimits = { ...DEFAULT_LIMITS, maxBlobSize };
  const tmpDir = path.join(dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.join(dataDir, "vaults"), { recursive: true });

  const blobPath = (vid: string, blobId: string) =>
    path.join(dataDir, "vaults", vid, "blobs", blobId.slice(0, 2), blobId.slice(2, 4), blobId);

  function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(data.length), ...extra });
    res.end(data);
  }
  function sendError(res: ServerResponse, err: HttpError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, err.status, body);
  }

  async function putBlob(req: IncomingMessage, res: ServerResponse, vid: string, blobId: string) {
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > maxBlobSize) {
      req.resume();
      throw new HttpError(413, "TOO_LARGE", `blob exceeds ${maxBlobSize} bytes`);
    }
    const shaHeader = req.headers[HEADER_SHA256.toLowerCase()];
    const expected = typeof shaHeader === "string" ? shaHeader.toLowerCase() : undefined;
    if (!isSha256Hex(expected)) {
      req.resume();
      throw new HttpError(400, "INVALID", `missing or malformed ${HEADER_SHA256}`);
    }
    const tmp = path.join(tmpDir, randomBytes(12).toString("hex"));
    const fh = await open(tmp, "wx");
    const hash = createHash("sha256");
    let size = 0;
    const head: number[] = [];
    let committed = false;
    try {
      try {
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > maxBlobSize) {
            req.resume();
            throw new HttpError(413, "TOO_LARGE", `blob exceeds ${maxBlobSize} bytes`);
          }
          for (let i = 0; head.length < 4 && i < chunk.length; i++) head.push(chunk[i]!);
          hash.update(chunk);
          await fh.write(chunk);
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (hash.digest("hex") !== expected) throw new HttpError(422, "HASH_MISMATCH", "body sha256 does not match");
      if (size < BLOB_MIN_LEN || BLOB_MAGIC.some((b, i) => head[i] !== b)) {
        throw new HttpError(422, "BAD_BLOB", "not a sealed blob (magic or length)");
      }
      const dest = blobPath(vid, blobId);
      let existed = false;
      try { await stat(dest); existed = true; } catch { /* new */ }
      if (existed) {
        // TODO(P1): touched_at / state=live in SQLite (§2.8.5). Content is keyed by blobId, so keep the first copy.
        sendJson(res, 200, { blobId, size, created: false });
        return;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(tmp, dest);
      committed = true;
      sendJson(res, 201, { blobId, size, created: true });
    } finally {
      if (!committed) await rm(tmp, { force: true });
    }
  }

  async function getBlob(req: IncomingMessage, res: ServerResponse, vid: string, blobId: string, headOnly: boolean) {
    const file = blobPath(vid, blobId);
    let size: number;
    try { size = (await stat(file)).size; } catch { throw new HttpError(404, "NOT_FOUND", "blob not found"); }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      ETag: `"${blobId}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    if (headOnly || req.method === "HEAD") { res.end(); return; }
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(file);
      rs.on("error", reject);
      res.on("close", () => { rs.destroy(); resolve(); });
      rs.pipe(res);
    });
  }

  const BLOB_ROUTE = /^\/v1\/vaults\/([^/]+)\/blobs\/([^/]+)$/;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader(HEADER_SERVER, SERVER_VERSION);
    const rid = req.headers[HEADER_REQUEST_ID.toLowerCase()];
    if (typeof rid === "string") res.setHeader(HEADER_REQUEST_ID, rid);
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    try {
      if (url.pathname === "/v1/health") {
        if (method !== "GET") throw new HttpError(405, "INVALID", "method not allowed");
        sendJson(res, 200, { ok: true, server: SERVER_VERSION, protocols: [...SUPPORTED_PROTOCOLS], time: Date.now(), source: sourceUrl });
        return;
      }
      const m = BLOB_ROUTE.exec(url.pathname);
      if (m) {
        let vid: string;
        let blobId: string;
        try {
          vid = decodeURIComponent(m[1]!);
          blobId = decodeURIComponent(m[2]!);
        } catch {
          req.resume();
          throw new HttpError(400, "BAD_ID", "malformed percent-encoding in vaultId or blobId");
        }
        // Validate before building any filesystem path.
        if (!isVaultId(vid) || !isBlobId(blobId)) { req.resume(); throw new HttpError(400, "BAD_ID", "bad vaultId or blobId"); }
        // TODO(P1): Authorization: Bearer sxd_… and vault membership (§2.8.4). The stub accepts any caller.
        if (method === "PUT") return await putBlob(req, res, vid, blobId);
        if (method === "GET" || method === "HEAD") return await getBlob(req, res, vid, blobId, method === "HEAD");
        req.resume();
        throw new HttpError(405, "INVALID", "method not allowed");
      }
      req.resume();
      throw new HttpError(404, "NOT_FOUND", "no such endpoint");
    } catch (e) {
      if (e instanceof HttpError) sendError(res, e);
      else { log(`error ${method} ${url.pathname}: ${String(e)}`); sendError(res, new HttpError(500, "SERVER", "internal error")); }
    }
  }

  const http: Server = createServer((req, res) => { void handle(req, res); });

  // ---------- WebSocket ----------
  const timers = new Set<NodeJS.Timeout>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_FRAME,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });

  http.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    const send = (msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    const fail = (rid: number | null, code: string, message: string, close: number) => {
      const err: ErrorMsg = { type: "error", rid, code, message, fatal: true, retryAfterMs: null };
      send(err);
      ws.close(close, code);
    };
    if (ws.protocol !== WS_SUBPROTOCOL) { ws.close(CloseCode.PROTOCOL, "subprotocol"); return; }

    let greeted = false;
    let lastInbound = Date.now();
    // No hello within 10 s: close 4408 "hello or idle timeout" (§2.9.1, §2.9.3).
    const helloTimer = setTimeout(() => { if (!greeted) ws.close(CloseCode.TIMEOUT, "hello timeout"); }, HELLO_TIMEOUT_SEC * 1000);
    const beat = setInterval(() => {
      if (Date.now() - lastInbound > IDLE_TIMEOUT_SEC * 1000) { ws.close(CloseCode.TIMEOUT, "idle"); return; }
      ws.ping();
    }, 30_000);
    timers.add(helloTimer); timers.add(beat);
    ws.on("close", () => { clearTimeout(helloTimer); clearInterval(beat); timers.delete(helloTimer); timers.delete(beat); });
    ws.on("pong", () => { lastInbound = Date.now(); });

    ws.on("message", (data, isBinary) => {
      lastInbound = Date.now();
      if (isBinary) return fail(null, "PROTOCOL", "binary frames are not allowed", CloseCode.PROTOCOL);
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return fail(null, "PROTOCOL", "frame is not a JSON object", CloseCode.PROTOCOL);
      }
      const rid = typeof msg.rid === "number" ? msg.rid : null;
      switch (msg.type) {
        case "hello": {
          const hello = msg as unknown as HelloMsg;
          if (rid === null) return fail(null, "PROTOCOL", "hello without rid", CloseCode.PROTOCOL);
          if (!SUPPORTED_PROTOCOLS.includes(hello.proto)) return fail(rid, "PROTOCOL", `unsupported proto ${String(hello.proto)}`, CloseCode.PROTOCOL);
          if (!isVaultId(hello.vaultId)) return fail(rid, "PROTOCOL", "bad vaultId", CloseCode.PROTOCOL);
          // TODO(P1): verify hello.token (sha256 lookup in devices), vault membership, cursors, epoch (§2.9.6).
          greeted = true;
          clearTimeout(helloTimer);
          const welcome: WelcomeMsg = {
            type: "welcome", rid, proto: PROTO_VERSION, server: SERVER_VERSION,
            deviceId: "stub-device", epoch: typeof hello.epoch === "number" ? hello.epoch : 1,
            headSeq: 0, minSeq: 0, infoEtag: null,
            retention: STUB_RETENTION, limits,
            heartbeatSec: HEARTBEAT_SEC, idleTimeoutSec: IDLE_TIMEOUT_SEC, serverTime: Date.now(),
          };
          send(welcome);
          return;
        }
        case "ping": {
          // rid must be a positive safe integer (§2.9.1); a pong with rid 0 would fail parseServerFrame.
          if (rid === null || !Number.isSafeInteger(rid) || rid <= 0) {
            const err: ErrorMsg = { type: "error", rid: null, code: "PROTOCOL", message: "ping without a positive rid", fatal: false, retryAfterMs: null };
            send(err);
            return;
          }
          const pong: PongMsg = { type: "pong", rid, ts: typeof msg.ts === "number" ? msg.ts : 0, serverTime: Date.now() };
          send(pong);
          return;
        }
        case "bye":
          ws.close(CloseCode.NORMAL, "bye");
          return;
        case "commit": case "ack": case "pull": {
          if (!greeted) return fail(rid, "PROTOCOL", "hello required first", CloseCode.PROTOCOL);
          if (msg.type === "ack") return;
          const err: ErrorMsg = { type: "error", rid, code: "UNAVAILABLE", message: `${String(msg.type)} not implemented in the dev stub`, fatal: false, retryAfterMs: null };
          send(err);
          return;
        }
        default:
          return fail(rid, "PROTOCOL", `unknown message type ${String(msg.type)}`, CloseCode.PROTOCOL);
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, host, () => { http.off("error", reject); resolve(); });
  });
  const port = (http.address() as AddressInfo).port;
  log(`shuttle-server ${SERVER_VERSION} (dev stub) listening on http://${host}:${port}, data ${dataDir}`);

  return {
    port, host, url: `http://${host}:${port}`,
    async close() {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers.clear();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
