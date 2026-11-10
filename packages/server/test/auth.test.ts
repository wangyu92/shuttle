// Auth and device enrollment (design §2.8.4): login, rate limit, enroll codes, me, devices, revoke,
// logout, admin CLI. H3: no token or password appears in server logs or admin output.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNoSecrets } from "@shuttle/testkit";
import { normalizeEnrollCode } from "../src/auth";
import { parseTtl, runAdmin } from "../src/adminCli";
import type { RunningServer } from "../src/server";
import { FakeTime, PASSWORD, TestWs, addUser, api, fixture, login, removeDir, silentIo, start, tempDir, type Client, guardSuite } from "./helpers";

// design §7.2 H3: logs, admin output and console are scanned for the password and tokens.
guardSuite();

let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;
const time = new FakeTime();
const logs: string[] = [];
const adminOut: string[] = [];
const secrets: string[] = [PASSWORD];

beforeAll(async () => {
  dir = await tempDir("auth");
  srv = await start(dir, { now: time.now, log: (m) => logs.push(m), publicUrl: "https://sync.example.com" });
  ({ c, vid } = await fixture(srv, dir));
  secrets.push(c.token);
});

afterAll(async () => {
  await srv?.close();
  assertNoSecrets({ logs: logs.join("\n"), admin: adminOut.join("\n") }, secrets);
  await removeDir(dir);
});

const enrollBody = (code: string) => ({ code, device: { name: "iPhone", platform: "ios", clientVersion: "0.1.0" } });

describe("auth", () => {
  it("login returns a device token; me and devices reflect it", async () => {
    expect(c.token).toMatch(/^sxd_[A-Za-z0-9_-]{43}$/);
    const me = await api(srv, c, "GET", "/v1/me");
    expect(me.json).toMatchObject({ user: { username: "alice", role: "owner" }, device: { deviceId: c.deviceId, current: true, revoked: false } });
    const d = await api(srv, c, "GET", "/v1/devices");
    expect(d.json.devices).toEqual([expect.objectContaining({ deviceId: c.deviceId, name: "laptop", current: true })]);
    expect((await api(srv, c, "PATCH", `/v1/devices/${c.deviceId}`, { name: "Work laptop" })).status).toBe(204);
    expect((await api(srv, c, "GET", "/v1/me")).json.device.name).toBe("Work laptop");
    expect((await api(srv, null, "GET", "/v1/me")).status).toBe(401);
  });

  it("wrong password → 401 BAD_CREDENTIALS; 5 failures/min → 429 with retryAfterMs; clears after a minute", async () => {
    await addUser(dir, "carol");
    const bad = () => api(srv, null, "POST", "/v1/auth/login", { username: "carol", password: "wrong-password", device: { name: "x", platform: "linux", clientVersion: "0" } });
    for (let i = 0; i < 5; i++) {
      const r = await bad();
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe("BAD_CREDENTIALS");
    }
    const limited = await bad();
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("RATE_LIMITED");
    expect(limited.json.error.retryAfterMs).toBeGreaterThan(0);
    // the same IP is blocked for other usernames too
    expect((await login(srv, "alice").catch((e: Error) => e.message))).toContain("429");
    time.advance(61_000);
    expect((await login(srv, "carol")).token).toMatch(/^sxd_/);
    const unknown = await api(srv, null, "POST", "/v1/auth/login", { username: "nobody", password: "x", device: { name: "x", platform: "linux", clientVersion: "0" } });
    expect(unknown.status).toBe(401);
  });

  it("enroll codes: owner only, single use, expiring; link carries server and code only", async () => {
    const r = await api(srv, c, "POST", "/v1/enroll-codes", { ttlSec: 900 });
    expect(r.status).toBe(200);
    expect(r.json.code).toMatch(/^SXE-[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    expect(r.json.link).toBe(`obsidian://shuttle-enroll?server=${encodeURIComponent("https://sync.example.com")}&code=${encodeURIComponent(r.json.code)}`);
    const e1 = await api(srv, null, "POST", "/v1/auth/enroll", enrollBody(r.json.code));
    expect(e1.status).toBe(200);
    expect(e1.json).toMatchObject({ user: { username: "alice" } });
    secrets.push(e1.json.token);
    const e2 = await api(srv, null, "POST", "/v1/auth/enroll", enrollBody(r.json.code));
    expect(e2.status).toBe(410);
    expect(e2.json.error.code).toBe("CODE_EXPIRED");
    const r2 = await api(srv, c, "POST", "/v1/enroll-codes", { ttlSec: 60 });
    time.advance(61_000);
    expect((await api(srv, null, "POST", "/v1/auth/enroll", enrollBody(r2.json.code))).status).toBe(410);
    expect((await api(srv, null, "POST", "/v1/auth/enroll", enrollBody("SXE-0000-0000-0000-0000-0000"))).status).toBe(410);
    await addUser(dir, "dave", false);
    const dave = await login(srv, "dave");
    secrets.push(dave.token);
    expect((await api(srv, dave, "POST", "/v1/enroll-codes", { ttlSec: 60 })).status).toBe(403);
  });

  it("revoke closes that device's sockets with 4403; later REST gets REVOKED", async () => {
    const phone = await login(srv, "alice", "phone");
    secrets.push(phone.token);
    const ws = await TestWs.open(srv);
    await ws.connect(phone.token, vid);
    expect((await api(srv, c, "DELETE", `/v1/devices/${phone.deviceId}`)).status).toBe(204);
    expect(await ws.type("error")).toMatchObject({ code: "REVOKED", fatal: true });
    expect((await ws.waitClose()).code).toBe(4403);
    const after = await api(srv, phone, "GET", "/v1/me");
    expect(after.status).toBe(401);
    expect(after.json.error.code).toBe("REVOKED");
    const ws2 = await TestWs.open(srv);
    ws2.hello(phone.token, vid);
    expect((await ws2.waitClose()).code).toBe(4403);
  });

  it("logout revokes the calling token", async () => {
    const t = await login(srv, "alice", "tmp");
    secrets.push(t.token);
    expect((await api(srv, t, "POST", "/v1/auth/logout")).status).toBe(204);
    expect((await api(srv, t, "GET", "/v1/me")).json.error.code).toBe("REVOKED");
  });

  it("admin revocation is picked up by the socket sweep", async () => {
    const t = await login(srv, "alice", "swept");
    secrets.push(t.token);
    const ws = await TestWs.open(srv);
    await ws.connect(t.token, vid);
    const { io, out } = silentIo(dir);
    expect(await runAdmin(["devices", "revoke", t.deviceId], io)).toBe(0);
    adminOut.push(...out);
    srv.core.sweepRevoked();
    expect((await ws.waitClose()).code).toBe(4403);
  });

  it("allowed-origins allowlist rejects other origins but not requests without Origin", async () => {
    const s2dir = await tempDir("origin");
    const s2 = await start(s2dir, { allowedOrigins: ["app://obsidian.md"] });
    try {
      expect((await fetch(`${s2.url}/v1/health`)).status).toBe(200);
      expect((await fetch(`${s2.url}/v1/health`, { headers: { Origin: "app://obsidian.md" } })).status).toBe(200);
      expect((await fetch(`${s2.url}/v1/health`, { headers: { Origin: "https://evil.example.com" } })).status).toBe(403);
    } finally {
      await s2.close();
      await removeDir(s2dir);
    }
  });
});

describe("admin CLI", () => {
  it("user, enroll-code, devices, vault, status; output never contains tokens", async () => {
    const { io, out, err } = silentIo(dir);
    expect(await runAdmin(["user", "add", "erin", "--password-stdin"], io)).toBe(0);
    expect(await runAdmin(["user", "add", "erin", "--password-stdin"], io)).toBe(1);
    expect(await runAdmin(["user", "list"], io)).toBe(0);
    expect(await runAdmin(["enroll-code", "--user", "erin", "--ttl", "15m"], io)).toBe(0);
    const code = out.find((l) => l.startsWith("SXE-"))!;
    expect(normalizeEnrollCode(code)).not.toBeNull();
    const e = await api(srv, null, "POST", "/v1/auth/enroll", enrollBody(code));
    expect(e.status).toBe(200);
    secrets.push(e.json.token);
    expect(await runAdmin(["devices", "list", "--user", "erin"], io)).toBe(0);
    expect(out.some((l) => l.includes("erin") && l.includes("iPhone"))).toBe(true);
    expect(await runAdmin(["vault", "list"], io)).toBe(0);
    expect(await runAdmin(["vault", "member", "add", "vault-alice", "erin"], io)).toBe(0);
    const erin = { token: e.json.token, deviceId: e.json.deviceId, auth: { Authorization: `Bearer ${e.json.token}` } };
    expect((await api(srv, erin, "GET", `/v1/vaults/${vid}/info`)).status).toBe(200);
    expect(await runAdmin(["status"], io)).toBe(0);
    expect(out.some((l) => l.startsWith("vault vault-alice"))).toBe(true);
    expect(await runAdmin(["bogus"], io)).toBe(1);
    expect(err.some((l) => l.includes("unknown command"))).toBe(true);
    adminOut.push(...out, ...err);
    expect(parseTtl("15m")).toBe(900);
    expect(parseTtl("2h")).toBe(7200);
    expect(() => parseTtl("x")).toThrow();
  });
});
