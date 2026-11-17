// First-run setup (lead decision D14): while the DB has no users the server logs a one-time setup
// code; POST /v1/auth/setup with it creates the owner and its first device. Closed for good once any
// user exists, whether made by setup or by the admin CLI.
import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import { PASSWORD, addUser, api, guardSuite, removeDir, start, tempDir } from "./helpers";

guardSuite();

let srv: RunningServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await srv?.close();
  await removeDir(dir);
  srv = undefined;
  dir = undefined;
});

const device = { name: "MacBook", platform: "macos", clientVersion: "0.1.0" };
const body = (code: string, extra: Record<string, unknown> = {}) => ({ code, username: "owner", password: PASSWORD, device, ...extra });

async function boot(publicUrl?: string): Promise<{ logs: string[]; code: string | null }> {
  dir = await tempDir("setup");
  const logs: string[] = [];
  srv = await start(dir, { log: (m) => logs.push(m), ...(publicUrl ? { publicUrl } : {}) });
  const line = logs.find((l) => l.includes("setup code:"));
  return { logs, code: line ? /(SXE(?:-[0-9A-Z]{4}){5})/.exec(line)![1]! : null };
}

describe("first-run setup", () => {
  it("logs a code and a link on an empty server, and health says setup", async () => {
    const { logs, code } = await boot("https://sync.example.com");
    expect(code).not.toBeNull();
    expect(logs.some((l) => l.includes("obsidian://shuttle-enroll?server=https%3A%2F%2Fsync.example.com&code=") && l.endsWith("&setup=1"))).toBe(true);
    const h = await api(srv!, null, "GET", "/v1/health");
    expect(h.json.setup).toBe(true);
  });

  it("creates the owner and a device once; then setup is closed", async () => {
    const { code } = await boot();
    const r = await api(srv!, null, "POST", "/v1/auth/setup", body(code!));
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ username: "owner", role: "owner" });
    const me = await api(srv!, { token: r.json.token, deviceId: r.json.deviceId, auth: { Authorization: `Bearer ${r.json.token}` } }, "GET", "/v1/me");
    expect(me.status).toBe(200);
    expect((await api(srv!, null, "GET", "/v1/health")).json.setup).toBeUndefined();
    const again = await api(srv!, null, "POST", "/v1/auth/setup", body(code!, { username: "intruder" }));
    expect(again.status).toBe(410);
    const login = await api(srv!, null, "POST", "/v1/auth/login", { username: "owner", password: PASSWORD, device });
    expect(login.status).toBe(200);
  });

  it("a wrong code fails and counts toward the rate limit", async () => {
    const { code } = await boot();
    const wrong = code!.slice(0, -1) + (code!.endsWith("0") ? "1" : "0");
    for (let i = 0; i < 5; i++) expect((await api(srv!, null, "POST", "/v1/auth/setup", body(wrong))).status).toBe(410);
    expect((await api(srv!, null, "POST", "/v1/auth/setup", body(code!))).status).toBe(429);
  });

  it("an admin-created user closes setup even with the logged code", async () => {
    const { code } = await boot();
    await addUser(dir!, "alice");
    expect((await api(srv!, null, "GET", "/v1/health")).json.setup).toBeUndefined();
    expect((await api(srv!, null, "POST", "/v1/auth/setup", body(code!))).status).toBe(410);
  });

  it("a server that already has users logs no code", async () => {
    dir = await tempDir("setup");
    const logs: string[] = [];
    srv = await start(dir, { log: (m) => logs.push(m) });
    await addUser(dir, "alice");
    await srv.close();
    logs.length = 0;
    srv = await start(dir, { log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes("SETUP"))).toBe(false);
  });

  it("concurrent claims create exactly one owner", async () => {
    const { code } = await boot();
    const rs = await Promise.all([1, 2, 3].map((i) => api(srv!, null, "POST", "/v1/auth/setup", body(code!, { username: `o${i}` }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("rejects short passwords and bad usernames before touching the code", async () => {
    const { code } = await boot();
    expect((await api(srv!, null, "POST", "/v1/auth/setup", body(code!, { password: "short" }))).status).toBe(400);
    expect((await api(srv!, null, "POST", "/v1/auth/setup", body(code!, { username: "no spaces" }))).status).toBe(400);
    expect((await api(srv!, null, "POST", "/v1/auth/setup", body(code!))).status).toBe(200);
  });
});
