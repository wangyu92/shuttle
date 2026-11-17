/// <reference types="node" />
// First-run setup through the plugin's own setup calls (lead decision D14): a fresh server logs a
// setup code and link; the link parses with setup=1; signIn with the setup code makes the owner, then
// a vault is created and listed. A second setup with the same code fails as codeExpired.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scheduler } from "@shuttle/protocol";
import { startServer, type RunningServer } from "../../server/src/server";
import { removeDir, tempDir, testOptions } from "../../server/test/helpers";
import { requestUrlHttpClient, type RequestUrlFn } from "../src/platform/http";
import { PluginScheduler } from "../src/platform/timers";
import { SetupError, createRemoteVault, listVaults, probeEndpoints, signIn, type SetupEnv } from "../src/session/serverSetup";
import { parseEnrollLink } from "../src/util/enrollCode";

const requestUrl: RequestUrlFn = async (p) => {
  const headers: Record<string, string> = { ...(p.headers ?? {}) };
  if (p.contentType) headers["Content-Type"] = p.contentType;
  const init: RequestInit = { method: p.method ?? "GET", headers };
  if (p.body !== undefined) init.body = p.body;
  const r = await fetch(p.url, init);
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  return { status: r.status, headers: h, arrayBuffer: await r.arrayBuffer() };
};

let srv: RunningServer;
let dir: string;
const logs: string[] = [];
const env: SetupEnv = {
  http: requestUrlHttpClient(requestUrl), scheduler: new PluginScheduler() as Scheduler, now: () => Date.now(),
  client: { name: "mac", platform: "macos", version: "0.1.0" },
};

beforeAll(async () => {
  dir = await tempDir("plugin-setup");
  srv = await startServer(testOptions(dir, { log: (m) => logs.push(m), publicUrl: "http://127.0.0.1:1" }));
});
afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
});

describe("first-run setup from the plugin", () => {
  it("link → owner → vault", async () => {
    const line = logs.find((l) => l.includes("FIRST-RUN SETUP link:"))!;
    const link = parseEnrollLink(line.slice(line.indexOf("obsidian://")))!;
    expect(link.setup).toBe(true);
    expect(link.code).toMatch(/^SXE(-[0-9A-Z]{4}){5}$/);
    const conn = { urls: [srv.url], allowHttp: true };
    expect((await probeEndpoints(env, conn.urls))[0]?.ok).toBe(true);
    const auth = await signIn(env, conn, { setupCode: link.code!, username: "owner", password: "correct horse battery" }, "mac");
    expect(auth.user.role).toBe("owner");
    await createRemoteVault(env, conn, auth.token, "notes", "correct horse battery staple");
    expect((await listVaults(env, conn, auth.token)).map((v) => v.name)).toEqual(["notes"]);
    const again = await signIn(env, conn, { setupCode: link.code!, username: "x", password: "correct horse battery" }, "mac").catch((e) => e);
    expect(again).toBeInstanceOf(SetupError);
    expect((again as SetupError).kind).toBe("codeExpired");
  }, 60_000);
});
