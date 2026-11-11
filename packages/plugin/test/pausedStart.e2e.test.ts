/// <reference types="node" />
// "Not now" at the end of setup (design §5.5.8): a session started paused pushes nothing, also not the
// files that were already in the vault, and stays paused after a plugin reload. Regression for the
// 0.1.0-dev.1 field report (a fresh vault pushed its Welcome note and config files 3 s after setup).
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scheduler } from "@shuttle/protocol";
import { startServer, type RunningServer } from "../../server/src/server";
import { PASSWORD, addUser, removeDir, tempDir, testOptions } from "../../server/test/helpers";
import { requestUrlHttpClient, type RequestUrlFn } from "../src/platform/http";
import { browserWsFactory, type WebSocketCtor } from "../src/platform/ws";
import { PluginScheduler, pluginClock } from "../src/platform/timers";
import { ObsidianLocalFs } from "../src/platform/ObsidianLocalFs";
import { IdbStateStore, idbName } from "../src/state/IdbStateStore";
import { DeviceStore, MemKv } from "../src/store/localStore";
import { Session } from "../src/session/Session";
import { commitSetup } from "../src/session/commit";
import { createRemoteVault, signIn, type SetupEnv } from "../src/session/serverSetup";
import { FakeVault } from "./fakeVault";
import { FakeIndexedDb, fakeIdbEnv } from "./fakeIdb";

const TIMEOUT = 120_000;
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
const http = requestUrlHttpClient(requestUrl);
const ws = browserWsFactory(WebSocket as unknown as WebSocketCtor);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string | undefined;
let srv: RunningServer;
beforeAll(async () => {
  dir = await tempDir("plugin-paused");
  srv = await startServer(testOptions(dir));
  await addUser(dir, "alice");
}, TIMEOUT);
afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
}, TIMEOUT);

describe("start paused", () => {
  it("pushes nothing after Not now, also after a reload", async () => {
    const vault = new FakeVault();
    const store = new DeviceStore(new MemKv());
    const scheduler = new PluginScheduler();
    const idb = new FakeIndexedDb();
    const fs = new ObsidianLocalFs({ vault, fileManager: vault.fileManager, platform: "desktop", caseInsensitive: false });
    const mk = () => new Session({
      store, fs, http, ws, clock: pluginClock, scheduler,
      openState: (id) => IdbStateStore.open(idbName("app-mac", id), fakeIdbEnv(idb)),
      platformName: "linux", os: "linux", defaultDeviceName: "Mac",
      engineOverrides: { timings: { settleMs: 50, maxWaitMs: 200, deleteHoldMs: 50, rawDebounceMs: 50 } },
    });
    const env: SetupEnv = { http, scheduler: scheduler as Scheduler, now: () => Date.now(), client: { name: "Mac", platform: "linux", version: "0.1.0" } };
    vault.userWrite("Welcome.md", "fresh vault note\n");
    const conn = { urls: [srv.url], allowHttp: true };
    const auth = await signIn(env, conn, { username: "alice", password: PASSWORD }, "Mac");
    const created = await createRemoteVault(env, conn, auth.token, "main", "correct horse battery staple");
    const prof = await commitSetup(store, {
      vaultId: created.vaultId, vaultName: "main", endpoints: [{ url: srv.url, label: "Local" }], allowHttp: true,
      auth: { token: auth.token, deviceId: auth.deviceId, username: "alice", owner: true }, cache: created.cache, info: created.info,
    }, Date.now());
    const head = () => srv.core.s.get<{ head_seq: number }>("SELECT head_seq FROM vaults WHERE vault_id = ?", created.vaultId)!.head_seq;

    let s = mk();
    await s.start(prof, { paused: true });
    expect(s.status()?.status).toBe("paused");
    vault.userWrite("Later.md", "edited while paused\n");
    await sleep(2500);
    expect(head()).toBe(0);

    // Plugin reload: onload starts the active profile without the paused flag (index.ts).
    await s.stop();
    s = mk();
    await s.start(prof);
    await sleep(2500);
    expect(s.status()?.status).toBe("paused");
    expect(head()).toBe(0);
    await s.stop();
    scheduler.dispose();
  }, TIMEOUT);
});
