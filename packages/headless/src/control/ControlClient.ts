// Client for the control socket (design §6.1.8), used by `status`, `guard`, `pause`, `resume`, `rescan`.

import http from "node:http";

export class ControlUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlUnreachable";
  }
}

export class ControlClient {
  constructor(readonly socketPath: string, private readonly timeoutMs = 8000) {}

  request(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        socketPath: this.socketPath, method, path: p, timeout: this.timeoutMs,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      }, (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { s += c; });
        res.on("end", () => {
          let data: unknown = null;
          try { data = s ? JSON.parse(s) : null; } catch { data = s; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      });
      req.on("timeout", () => req.destroy(new ControlUnreachable("control socket timed out")));
      req.on("error", (e) => reject(e instanceof ControlUnreachable ? e : new ControlUnreachable(`daemon unreachable (${(e as { code?: string }).code ?? e.message})`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(p: string): Promise<{ status: number; data: unknown }> {
    return this.request("GET", p);
  }

  post(p: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    return this.request("POST", p, body ?? {});
  }
}
