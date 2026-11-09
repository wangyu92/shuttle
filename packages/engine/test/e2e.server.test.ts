/// <reference types="node" />
// End to end: two engines (createEngine over MemLocalFs + MemStateStore) syncing through the real
// @shuttle/server via ServerAdapter, over fetch and the `ws` package on 127.0.0.1 (design §7.5, §2.13).
// Covers create, concurrent edits that merge (dmp3), rename, delete, a multi-chunk binary file and a
// conflict copy. Server data lives under ~/tmp/claude/shuttle-p1/server-test (never the system temp
// dir). Fixtures only: user "alice", no real hosts.
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SxKeyring } from "@shuttle/crypto";
import type { AdapterStateStore, Keyring, WsFactory, WsLike } from "@shuttle/protocol";
import { FakeClock, FakeScheduler, MemLocalFs, MemStateStore, TestIds, drainMicrotasks } from "@shuttle/testkit";
import { ServerAdapter, fetchHttpClient } from "../../adapter-server/src/index";
import { startServer, type RunningServer } from "../../server/src/server";
import { addUser, login, removeDir, tempDir, testOptions, type Client } from "../../server/test/helpers";
import { createEngine, type ShuttleEngine } from "../src/index";
import { LocalStorageFake } from "./engineHarness";
import { CFG, TEST_PARAMS, bigBytes, sortedEntries } from "./harness";

const TIMEOUT = 120_000;
const nodeWs: WsFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as WsLike;
const http = fetchHttpClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memState(): AdapterStateStore {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}

let dir: string | undefined;
let srv: RunningServer;
let alpha: Client;
let beta: Client;
const live: E2ENode[] = [];

interface Vault { vaultId: string; ring: Keyring; clock: FakeClock }

/** A fresh vault on the real server, with a real infoMac and small chunker params (multi-chunk files). */
async function newVault(seed: string): Promise<Vault> {
  const ids = new TestIds(seed);
  const vaultId = randomBytes(16).toString("base64url");
  const vmk = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
  const ring = await SxKeyring.fromVmks(vaultId, new Map([[1, vmk]]), 1);
  const info = ids.vaultInfo({ vaultId });
  info.params.chunker = { alg: "fastcdc-k1", ...TEST_PARAMS.chunker };
  const { infoMac: _mac, ...unsigned } = info;
  info.infoMac = await ring.macVaultInfo(unsigned as unknown as Parameters<typeof ring.macVaultInfo>[0]);
  const boot = new ServerAdapter({
    config: { urls: [srv.url], vaultId }, token: alpha.token, http, ws: nodeWs,
    client: { name: "boot", platform: "linux", version: "0.1.0", role: "headless" }, state: memState(), random: () => 0,
  });
  await boot.connect();
  await boot.createVaultInfo(info);
  await boot.close();
  return { vaultId, ring, clock: new FakeClock() };
}

class E2ENode {
  readonly fs: MemLocalFs;
  readonly store = new MemStateStore();
  readonly scheduler: FakeScheduler;
  readonly ls = new LocalStorageFake();
  readonly adapter: ServerAdapter;
  engine!: ShuttleEngine;

  constructor(readonly v: Vault, readonly name: string, client: Client) {
    this.fs = new MemLocalFs({ clock: v.clock, emitOwnEvents: false, configDir: CFG, platform: "desktop", writeCreatesParents: false });
    this.scheduler = new FakeScheduler(v.clock);
    this.adapter = new ServerAdapter({
      config: { urls: [srv.url], vaultId: v.vaultId }, token: client.token, http, ws: nodeWs,
      client: { name, platform: "linux", version: "0.1.0", role: "headless" }, state: memState(), random: () => 0,
    });
    live.push(this);
  }

  async start(): Promise<void> {
    this.engine = createEngine({
      fs: this.fs, state: this.store, remote: this.adapter, keyring: this.v.ring, clock: this.v.clock, scheduler: this.scheduler,
      adapterState: memState(),
    }, {
      settings: { deviceName: this.name }, manual: true, selfTest: async () => true, local: this.ls.local, seen: this.ls.seenStore,
      random: () => 0.5, tzOffset: () => 0,
    });
    await this.engine.start();
    expect(await this.engine.whenConnected()).toBe(true);
  }

  /** External edit with a later mtime; the next iteration scans. */
  edit(path: string, content: string | Uint8Array): void {
    this.v.clock.tick(1000);
    this.fs.external.write(path, content, { mtime: this.v.clock.now() });
    this.engine.requestScan();
  }

  async step(): Promise<number> {
    this.engine.events.flushAll();
    await this.engine.events.idle();
    await drainMicrotasks();
    const r = await this.engine.runOnce();
    return r.work + this.engine.dirty.size;
  }

  busy(): boolean {
    const s = this.engine.status();
    return s.status === "syncing" || s.pendingUp > 0 || s.pendingDown > 0;
  }

  async diskMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [p, bytes] of this.fs.files({ includeConfigDir: true })) {
      if (this.engine.filter.scope(p, bytes.length) !== "active") continue;
      const d = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
      out.set(p, Buffer.from(d).toString("hex"));
    }
    return out;
  }

  async stop(): Promise<void> {
    await this.engine?.stop().catch(() => undefined);
    await this.adapter.close().catch(() => undefined);
  }
}

/**
 * Drive both engines until the network is quiet: the feed arrives on real sockets, so between rounds
 * we wait real time. Quiet = three rounds in a row with no work, nothing dirty and nothing pending.
 */
async function converge(nodes: readonly E2ENode[], rounds = 120): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < rounds; i++) {
    let work = 0;
    for (const n of nodes) work += await n.step();
    await sleep(40);
    const busy = nodes.some((n) => n.busy());
    if (work === 0 && !busy) {
      if (++quiet >= 3) return;
      continue;
    }
    quiet = 0;
    // Let backed-off ops (fake clock) become due.
    if (work === 0) nodes[0]!.v.clock.tick(10 * 60 * 1000);
  }
  throw new Error("engines did not converge");
}

async function expectSame(a: E2ENode, b: E2ENode): Promise<void> {
  expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(await a.diskMap()));
}

async function pair(seed: string): Promise<{ a: E2ENode; b: E2ENode }> {
  const v = await newVault(seed);
  const a = new E2ENode(v, "alpha", alpha);
  const b = new E2ENode(v, "beta", beta);
  await a.start();
  await b.start();
  return { a, b };
}

const copies = (n: E2ENode): string[] => [...n.fs.files().keys()].filter((p) => p.includes("Conflicted copy"));

beforeAll(async () => {
  dir = await tempDir("e2e");
  srv = await startServer(testOptions(dir, { coalesceMs: 5, log: () => undefined }));
  await addUser(dir, "alice");
  alpha = await login(srv, "alice", "alpha");
  beta = await login(srv, "alice", "beta");
}, TIMEOUT);

afterEach(async () => {
  await Promise.all(live.splice(0).map((n) => n.stop()));
});

afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
}, TIMEOUT);

describe("two engines through the real server", () => {
  it("create, binary, rename and delete reach the other device", async () => {
    const { a, b } = await pair("e2e-basic");
    const bin = bigBytes("pic");
    expect(bin.length).toBeGreaterThan(TEST_PARAMS.chunker.max);
    a.edit("notes/one.md", "hello\n");
    a.edit("att/pic.bin", bin);
    a.edit("empty.md", "");
    await converge([a, b]);
    await expectSame(a, b);
    expect(b.fs.readText("notes/one.md")).toBe("hello\n");
    expect(b.fs.files().get("att/pic.bin")).toEqual(bin);
    expect(b.fs.exists("empty.md")).toBe(true);

    // Edit on B flows back to A.
    b.edit("notes/one.md", "hello\nfrom beta\n");
    await converge([a, b]);
    expect(a.fs.readText("notes/one.md")).toBe("hello\nfrom beta\n");

    // Rename (an fs rename event on A).
    a.v.clock.tick(1000);
    a.fs.external.rename("att/pic.bin", "moved/pic.bin");
    a.engine.requestScan();
    await converge([a, b]);
    await expectSame(a, b);
    expect(b.fs.exists("att/pic.bin")).toBe(false);
    expect(b.fs.files().get("moved/pic.bin")).toEqual(bin);

    // Delete: B moves its copy to the trash.
    a.fs.external.remove("notes/one.md");
    a.engine.requestScan();
    await converge([a, b]);
    await expectSame(a, b);
    expect(b.fs.exists("notes/one.md")).toBe(false);
    expect(b.fs.trash.some((t) => t.path === "notes/one.md")).toBe(true);
    expect(a.engine.status().status).toBe("synced");
    expect(b.engine.status().status).toBe("synced");
  }, TIMEOUT);

  it("concurrent edits of different lines merge on both devices (dmp3)", async () => {
    const { a, b } = await pair("e2e-merge");
    a.edit("n.md", "l1\nl2\nl3\nl4\nl5\n");
    await converge([a, b]);
    expect(b.fs.readText("n.md")).toBe("l1\nl2\nl3\nl4\nl5\n");
    a.edit("n.md", "L1\nl2\nl3\nl4\nl5\n");
    b.edit("n.md", "l1\nl2\nl3\nl4\nL5\n");
    // Both commit against the same base before either sees the other: B's push gets CONFLICT.
    await a.step();
    await b.step();
    await converge([a, b]);
    expect(a.fs.readText("n.md")).toBe("L1\nl2\nl3\nl4\nL5\n");
    expect(b.fs.readText("n.md")).toBe("L1\nl2\nl3\nl4\nL5\n");
    expect(copies(a)).toEqual([]);
    expect(copies(b)).toEqual([]);
  }, TIMEOUT);

  it("overlapping edits keep both versions as a conflict copy (I10)", async () => {
    const { a, b } = await pair("e2e-conflict");
    a.edit("n.md", "same line\n");
    await converge([a, b]);
    a.edit("n.md", "alpha line\n");
    b.edit("n.md", "beta line\n");
    await a.step();
    await b.step();
    await converge([a, b]);
    await expectSame(a, b);
    const cs = copies(b);
    expect(cs.length).toBe(1);
    expect(cs[0]).toContain("Conflicted copy");
    const texts = [b.fs.readText("n.md"), b.fs.readText(cs[0]!)].sort();
    expect(texts).toEqual(["alpha line\n", "beta line\n"]);
    expect(a.fs.readText(cs[0]!)).toBe(b.fs.readText(cs[0]!));
  }, TIMEOUT);
});

