/// <reference types="node" />
// End to end through the real @shuttle/server on 127.0.0.1: the plugin's own glue (requestUrl
// HttpClient, browser-style WebSocket factory, ObsidianLocalFs over a fake Vault, IdbStateStore over
// the in-memory IndexedDB, localStorage records) drives two devices through onboarding (§5.5.3 login,
// §5.5.5 create, §5.5.9 enrollment code, §5.5.6 unlock) and syncs edits both ways. Also: lock and
// unlock, restart from cached keys, and the pairing envelope against the headless implementation.
// Server data lives under ~/tmp/claude/shuttle-p1/server-test. Fixtures only: user "alice".
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scheduler } from "@shuttle/protocol";
import { startServer, type RunningServer } from "../../server/src/server";
import { PASSWORD, addUser, removeDir, tempDir, testOptions } from "../../server/test/helpers";
import { startPairing, validatePairedKeys } from "../../headless/src/pair";
import { requestUrlHttpClient, type RequestUrlFn } from "../src/platform/http";
import { browserWsFactory, type WebSocketCtor } from "../src/platform/ws";
import { PluginScheduler, pluginClock } from "../src/platform/timers";
import { ObsidianLocalFs } from "../src/platform/ObsidianLocalFs";
import { IdbStateStore, idbName } from "../src/state/IdbStateStore";
import { DeviceStore, MemKv } from "../src/store/localStore";
import { Session } from "../src/session/Session";
import { commitSetup } from "../src/session/commit";
import {
  SetupError, createRemoteVault, listVaults, probeEndpoints, signIn, unlockVault, type SetupEnv,
} from "../src/session/serverSetup";
import { parseEnrollLink } from "../src/util/enrollCode";
import { normalizeServerUrl } from "../src/util/url";
import { parsePairLink, payloadOf, sealPairingEnvelope } from "../src/session/pairing";
import { FakeVault } from "./fakeVault";
import { FakeIndexedDb, fakeIdbEnv } from "./fakeIdb";

const TIMEOUT = 180_000;
const PASS = "correct horse battery staple";

/** Obsidian's requestUrl, played by fetch (the plugin never sees fetch). */
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

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

class Device {
  readonly vault = new FakeVault();
  readonly store = new DeviceStore(new MemKv());
  readonly scheduler = new PluginScheduler();
  readonly idb = new FakeIndexedDb();
  readonly fs: ObsidianLocalFs;
  readonly session: Session;
  readonly env: SetupEnv;

  constructor(readonly name: string) {
    this.fs = new ObsidianLocalFs({ vault: this.vault, fileManager: this.vault.fileManager, platform: "desktop", caseInsensitive: false });
    this.env = { http, scheduler: this.scheduler as Scheduler, now: () => Date.now(), client: { name, platform: "linux", version: "0.1.0" } };
    this.session = new Session({
      store: this.store, fs: this.fs, http, ws, clock: pluginClock, scheduler: this.scheduler,
      openState: (id) => IdbStateStore.open(idbName("app-" + name, id), fakeIdbEnv(this.idb)),
      platformName: "linux", os: "linux", defaultDeviceName: name,
      engineOverrides: { timings: { settleMs: 100, maxWaitMs: 1000, deleteHoldMs: 50, rawDebounceMs: 100 } },
    });
  }

  synced(): boolean {
    const s = this.session.status();
    return !!s && s.status === "synced" && s.pendingUp === 0 && s.pendingDown === 0;
  }

  async close(): Promise<void> {
    await this.session.stop().catch(() => undefined);
    this.scheduler.dispose();
  }
}

let dir: string | undefined;
let srv: RunningServer;
const devices: Device[] = [];

beforeAll(async () => {
  dir = await tempDir("plugin-e2e");
  srv = await startServer(testOptions(dir));
  await addUser(dir, "alice");
}, TIMEOUT);

afterAll(async () => {
  for (const d of devices) await d.close();
  await srv?.close();
  await removeDir(dir);
}, TIMEOUT);

describe("plugin glue against the real server", () => {
  it("onboards two devices, syncs both ways, locks, unlocks, restarts and pairs a mirror", async () => {
    const a = new Device("Mac");
    const b = new Device("iPhone");
    devices.push(a, b);

    // §5.5.3 on A: address check, health probe, login.
    const u = normalizeServerUrl(srv.url, { allowHttp: false });
    expect(u.ok).toBe(true);
    const url = u.ok ? u.url : "";
    const reach = await probeEndpoints(a.env, [url, "http://127.0.0.1:1"]);
    expect(reach[0]).toMatchObject({ ok: true });
    expect(reach[1]).toMatchObject({ ok: false, error: "unreachable" });
    const conn = { urls: [url], allowHttp: false };
    await expect(signIn(a.env, conn, { username: "alice", password: "wrong password" }, "Mac")).rejects.toSatisfy((e: unknown) => e instanceof SetupError && e.kind === "badCredentials");
    const authA = await signIn(a.env, conn, { username: "alice", password: PASSWORD }, "Mac");
    expect(authA.token.startsWith("sxd_")).toBe(true);

    // §5.5.5: no vaults yet → create one; §5.5.6 is skipped (password just entered).
    expect(await listVaults(a.env, conn, authA.token)).toEqual([]);
    const created = await createRemoteVault(a.env, conn, authA.token, "Notes", PASS);
    const profA = await commitSetup(a.store, {
      vaultId: created.vaultId, vaultName: "Notes", endpoints: [{ url, label: "Public" }], allowHttp: false,
      auth: { token: authA.token, deviceId: authA.deviceId, username: "alice", owner: true }, cache: created.cache, info: created.info,
    }, Date.now());
    expect(a.store.activeProfile()?.id).toBe(profA.id);
    expect(profA.id).toMatch(/^[0-9a-f]{16}$/);

    a.vault.userWrite("Hello.md", "hello from the Mac\n");
    await a.session.start(profA);
    expect(a.session.keySource).toBe("verified");
    await waitFor("A uploads", () => a.synced() && a.session.debugInfo()!.cursor !== null && a.session.debugInfo()!.cursor! > 0);

    // §5.5.9: A creates an enrollment code; B signs in with the link and unlocks.
    const enroll = await a.session.adapter!.createEnrollCode(900);
    const link = parseEnrollLink(enroll.link);
    expect(link?.code).toBe(enroll.code);
    expect(link?.server).toBe(url);
    const connB = { urls: [link!.server!], allowHttp: false };
    const authB = await signIn(b.env, connB, { code: link!.code! }, "iPhone");
    await expect(signIn(b.env, connB, { code: link!.code! }, "iPhone")).rejects.toSatisfy((e: unknown) => e instanceof SetupError && e.kind === "codeExpired");
    const vaults = await listVaults(b.env, connB, authB.token);
    expect(vaults.map((v) => v.name)).toEqual(["Notes"]);
    await expect(unlockVault(b.env, connB, authB.token, vaults[0]!.vaultId, "not the passphrase", null))
      .rejects.toSatisfy((e: unknown) => e instanceof SetupError && e.kind === "pwWrong");
    expect(b.store.keys(vaults[0]!.vaultId)).toBeNull();
    const un = await unlockVault(b.env, connB, authB.token, vaults[0]!.vaultId, PASS, null);
    const profB = await commitSetup(b.store, {
      vaultId: vaults[0]!.vaultId, vaultName: vaults[0]!.name, endpoints: [{ url, label: "Public" }], allowHttp: false,
      auth: { token: authB.token, deviceId: authB.deviceId }, cache: un.cache, info: un.info,
    }, Date.now());
    expect(profB.id).toBe(profA.id);
    await b.session.start(profB);
    await waitFor("B downloads Hello.md", () => b.vault.text("Hello.md") === "hello from the Mac\n");

    // B edits (an Obsidian modify event), A receives it over the WebSocket feed.
    b.vault.userWrite("Hello.md", "hello from the Mac\nand from the iPhone\n");
    b.vault.userWrite("folder/New note.md", "new");
    await waitFor("A receives B's edits", () => a.vault.text("Hello.md") === "hello from the Mac\nand from the iPhone\n" && a.vault.text("folder/New note.md") === "new");

    // Lock drops the key cache; unlock with the passphrase restores it (design §4.11.7, §5.6.4).
    await b.session.lock();
    expect(b.store.keys(profB.vaultId)).toBeNull();
    expect(b.session.status()?.locked).toBe(true);
    await b.session.unlock(PASS);
    expect(b.store.keys(profB.vaultId)).not.toBeNull();
    expect(b.session.status()?.locked).toBe(false);

    // Restart B from the cached keys and the persisted IndexedDB state.
    await b.session.stop();
    a.vault.userWrite("Hello.md", "edited while B was stopped\n");
    await waitFor("A uploads again", () => a.synced());
    await b.session.start(profB);
    expect(b.session.keySource).toBe("verified");
    await waitFor("B catches up after restart", () => b.vault.text("Hello.md") === "edited while B was stopped\n");

    // Cold start without cached keys (localStorage cleared, design §3.3.5 / §5.2.1 row 2): the engine
    // starts Locked, collects local edits, and syncs after the passphrase is entered.
    await b.session.stop();
    b.store.dropKeys(profB.vaultId);
    await b.session.start(profB);
    expect(b.session.keySource).toBe("none");
    expect(b.session.status()?.locked).toBe(true);
    await waitFor("B connects while Locked", () => b.session.status()?.status === "paused" && b.session.status()?.locked === true);
    b.vault.userWrite("While locked.md", "queued while locked");
    a.vault.userWrite("Hello.md", "edited while B was locked\n");
    await waitFor("A uploads its edit", () => a.synced() && a.vault.text("Hello.md") === "edited while B was locked\n");
    await new Promise((r) => setTimeout(r, 300));
    expect(b.vault.text("Hello.md")).toBe("edited while B was stopped\n");
    await expect(b.session.unlock("not the passphrase")).rejects.toThrow();
    expect(b.store.keys(profB.vaultId)).toBeNull();
    await b.session.unlock(PASS);
    expect(b.store.keys(profB.vaultId)).not.toBeNull();
    await waitFor("B syncs both ways after unlock", () => b.vault.text("Hello.md") === "edited while B was locked\n" && a.vault.text("While locked.md") === "queued while locked");

    // design §4.12.2: the plugin seals the key bundle; the headless implementation opens and checks it.
    const pair = await startPairing(profA.vaultId);
    const env = await sealPairingEnvelope(parsePairLink(pair.link), payloadOf(a.store.keys(profA.vaultId)!, created.info.infoRev));
    await a.session.adapter!.pairingPut(pair.pairId, env);
    const taken = await b.session.adapter!.pairingTake(pair.pairId);
    expect(taken).toBe(env);
    const payload = await pair.open(taken!);
    expect(payload.keys).toEqual(Object.fromEntries(Object.entries(a.store.keys(profA.vaultId)!.kvs).map(([k, v]) => [String(k), v])));
    await expect(validatePairedKeys(payload, created.info, null)).resolves.toMatchObject({ pullOnly: false });
    pair.dispose();
  }, TIMEOUT);
});
