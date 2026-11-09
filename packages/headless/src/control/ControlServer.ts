// Control socket (design §6.1.8): HTTP/1.1 over the unix socket `<state>/control.sock`, mode 0600.
// GET /status, /health, /guards, /debug; POST /guards/<id> {choice}, /pause, /resume, /kick, /rescan.
// Only the CLI uses it, from inside the container. Responses never contain secrets (debugInfo has none,
// and every body passes through redact()).

import http from "node:http";
import { chmodSync, rmSync } from "node:fs";
import type { GuardChoice } from "@shuttle/protocol";
import { redact } from "../log";

export interface ControlHandlers {
  status(): unknown;
  health(): unknown;
  guards(): unknown;
  debug(): unknown;
  answerGuard(id: string, choice: GuardChoice): boolean | Promise<boolean>;
  pause(): void;
  resume(): void;
  kick(): void;
  rescan(): void;
}

const CHOICES: readonly GuardChoice[] = ["apply", "pause", "accept", "rebuild"];

export class ControlServer {
  private server: http.Server | null = null;
  constructor(readonly socketPath: string, private readonly h: ControlHandlers) {}

  async start(): Promise<void> {
    rmSync(this.socketPath, { force: true });              // stale socket of a killed daemon
    const srv = http.createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => send(res, 500, { error: String((e as Error)?.message ?? e) }));
    });
    srv.on("clientError", (_e, sock) => { try { sock.destroy(); } catch { /* ignore */ } });
    const old = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(this.socketPath, () => { srv.off("error", reject); resolve(); });
      });
    } finally {
      process.umask(old);
    }
    chmodSync(this.socketPath, 0o600);
    srv.unref();
    this.server = srv;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
    rmSync(this.socketPath, { force: true });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://control");
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (m === "GET") {
      if (p === "/status") return send(res, 200, this.h.status());
      if (p === "/health") return send(res, 200, this.h.health());
      if (p === "/guards") return send(res, 200, this.h.guards());
      if (p === "/debug") return send(res, 200, this.h.debug());
      return send(res, 404, { error: "not found" });
    }
    if (m !== "POST") return send(res, 405, { error: "method not allowed" });
    const body = await readBody(req);
    if (p.startsWith("/guards/")) {
      const id = decodeURIComponent(p.slice("/guards/".length));
      let choice: unknown;
      try { choice = (JSON.parse(body || "{}") as { choice?: unknown }).choice; } catch { choice = undefined; }
      if (!CHOICES.includes(choice as GuardChoice)) return send(res, 400, { error: "choice must be apply, pause, accept or rebuild" });
      const ok = await this.h.answerGuard(id, choice as GuardChoice);
      return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "no such guard" });
    }
    if (p === "/pause") { this.h.pause(); return send(res, 200, { ok: true }); }
    if (p === "/resume") { this.h.resume(); return send(res, 200, { ok: true }); }
    if (p === "/kick") { this.h.kick(); return send(res, 200, { ok: true }); }
    if (p === "/rescan") { this.h.rescan(); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: "not found" });
  }
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = redact(JSON.stringify(body ?? null));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { s += c; if (s.length > 65536) req.destroy(); });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
