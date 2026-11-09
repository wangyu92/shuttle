// shuttle-server: HTTP + WebSocket wiring, timers and shutdown (design §2.8, §2.9). AGPL-3.0-only.
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { CloseCode, MAX_WS_FRAME, WS_PATH, WS_SUBPROTOCOL } from "@shuttle/protocol";
import { resolveConfig, type ServerOptions } from "./config";
import { Maintenance, type GcStats } from "./gc";
import { clientIp, handleRest, originAllowed } from "./rest";
import { SERVER_VERSION, Server } from "./server-core";
import { HOUR_MS, errText } from "./util";
import { Conn } from "./ws";

export { SERVER_VERSION } from "./server-core";
export { DEFAULT_SOURCE_URL } from "./config";
export type { ServerOptions } from "./config";

export interface RunningServer {
  port: number;
  host: string;
  url: string;
  /** Server state (tests, admin in-process). */
  core: Server;
  /** One maintenance run now (retention, thinning, GC, pruning; backup when asked). */
  runMaintenance(opts?: { backup?: boolean }): Promise<GcStats>;
  maintenance: Maintenance;
  /** Graceful stop: sockets close 4503, hwm written, WAL checkpointed, DB closed. */
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const cfg = resolveConfig(opts);
  const core = new Server(cfg);
  const maint = new Maintenance(core);
  const timers: NodeJS.Timeout[] = [];

  const http: HttpServer = createServer({ requestTimeout: 0, headersTimeout: 60_000 }, (req, res) => { void handleRest(core, req, res); });
  http.keepAliveTimeout = 65_000;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_FRAME,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });

  let closing = false;
  http.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (pathname !== WS_PATH) return reject("404 Not Found");
    if (closing) return reject("503 Service Unavailable");
    if (!originAllowed(core, req.headers.origin)) return reject("403 Forbidden");
    const ip = clientIp(req, cfg.trustProxy);
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Subprotocol not negotiated: the client sees no echo and closes 4400 itself; we close too.
      if (ws.protocol !== WS_SUBPROTOCOL) { ws.close(CloseCode.PROTOCOL, "subprotocol"); return; }
      core.hub.conns.add(new Conn(ws, core, ip));
    });
  });

  // Heartbeat (design §2.9.4): protocol ping every 30 s, close 4408 after idleTimeoutSec without inbound frames.
  timers.push(setInterval(() => {
    const now = Date.now();
    for (const c of core.hub.conns) {
      if (now - c.lastInbound > cfg.idleTimeoutSec * 1000) c.close(CloseCode.TIMEOUT, "idle");
      else if (c.ws.readyState === c.ws.OPEN) c.ws.ping();
    }
  }, cfg.pingIntervalMs));
  timers.push(setInterval(() => {
    try { core.sweepRevoked(); } catch (e) { cfg.log(`revocation sweep failed: ${errText(e)}`); }
  }, cfg.revocationSweepMs));

  const runMaintenance = (o?: { backup?: boolean }) => maint.run(o);
  if (cfg.jobs) {
    timers.push(setInterval(() => {
      runMaintenance({ backup: true }).catch((e) => cfg.log(`maintenance failed: ${errText(e)}`));
    }, HOUR_MS));
  }
  if (cfg.gcOnStart) runMaintenance({ backup: cfg.jobs }).catch((e) => cfg.log(`maintenance failed: ${errText(e)}`));

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(cfg.port, cfg.host, () => { http.off("error", reject); resolve(); });
  });
  const port = (http.address() as AddressInfo).port;
  cfg.log(`shuttle-server ${SERVER_VERSION} listening on http://${cfg.host}:${port}`);

  let closed: Promise<void> | null = null;
  return {
    port, host: cfg.host, url: `http://${cfg.host}:${port}`, core, maintenance: maint, runMaintenance,
    close() {
      closed ??= (async () => {
        closing = true;
        for (const t of timers) clearInterval(t);
        // Finish the commits already received (their results still reach the sockets), refuse new ones.
        core.drainCommits();
        core.hub.stop();
        for (const c of [...core.hub.conns]) c.close(CloseCode.RESTART, "restart");
        await new Promise<void>((r) => wss.close(() => r()));
        await new Promise<void>((r) => { http.close(() => r()); http.closeIdleConnections(); setTimeout(() => http.closeAllConnections(), 2000).unref(); });
        for (const c of wss.clients) c.terminate();
        core.drainCommits();
        // Commits are synchronous, so none is half-done here. Write the high-water marks, checkpoint, close.
        try { await core.hwm.flushAll(); } catch (e) { cfg.log(`hwm flush failed: ${errText(e)}`); }
        core.hwm.stop();
        try { core.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* busy: WAL replays on next open */ }
        core.db.close();
      })();
      return closed;
    },
  };
}
