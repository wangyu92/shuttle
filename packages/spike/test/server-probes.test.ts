// Runs the M4-M7 server probes against the real server in-process, with requestUrl mapped to fetch.
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({
  apiVersion: "1.0.0",
  Platform: { isLinux: true },
  requestUrl: async (o: { url: string; method: string; headers?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string }) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.contentType) headers["Content-Type"] = o.contentType;
    const r = await fetch(o.url, { method: o.method, headers, body: o.body as BodyInit | undefined });
    const buf = await r.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, headers: h, arrayBuffer: buf, text, get json() { return JSON.parse(text); } };
  },
}));
import { startServer } from "../../server/src/server";
import { addUser, tempDir, removeDir, login, FAST_SCRYPT } from "../../server/test/helpers";
import { serverProbes } from "../src/probes/server";

describe("spike server probes against the real server", () => {
  it("M4, M5, M6, M7 with an enroll code", async () => {
    const dir = await tempDir("spike");
    const srv = await startServer({ host: "127.0.0.1", port: 0, dataDir: dir, jobs: false, scrypt: FAST_SCRYPT });
    try {
      await addUser(dir, "alice");
      const c = await login(srv, "alice");
      const ec = await fetch(`${srv.url}/v1/enroll-codes`, { method: "POST", headers: { ...c.auth, "Content-Type": "application/json" }, body: JSON.stringify({ ttlSec: 900 }) });
      const code = ((await ec.json()) as { code: string }).code;
      const settings = { serverUrl: srv.url, serverToken: code, deviceName: "spike", m7IdleMinutes: 1, postResults: false };
      let saved = 0;
      const ctx = { settings, progress: () => {}, saveSettings: async () => { saved++; } } as never;
      for (const id of ["M4", "M5", "M6", "M7"]) {
        const o = await serverProbes.find((p) => p.id === id)!.run(ctx);
        console.log(id, o.status, o.summary);
        expect(["pass", "info"]).toContain(o.status);
      }
      expect(saved).toBe(1);
      expect((settings as { serverToken: string }).serverToken.startsWith("sxd_")).toBe(true);
    } finally {
      await srv.close();
      await removeDir(dir);
    }
  }, 60_000);
});
