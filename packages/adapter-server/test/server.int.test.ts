/// <reference types="node" />
// ServerAdapter against the real @shuttle/server on 127.0.0.1 (port 0), over fetch and the `ws`
// package, the way the headless client wires it. Data lives under ~/tmp/claude/shuttle-p1/adapter-test
// (never os.tmpdir(): the system temp dir is RAM on the NAS).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChangeBatch, CommitOp, VaultInfo, WsFactory, WsLike } from "@shuttle/protocol";
import { TestIds } from "@shuttle/testkit";
import { startServer, type RunningServer, type ServerOptions } from "../../server/src/server";
import { addUser, guardSuite, login, sealed, type Client } from "../../server/test/helpers";
import { guardLog } from "../../testkit/test/outputGuard";
import { ServerAdapter, fetchHttpClient, serverEnroll, serverLogin, type ServerAdapterOptions } from "../src/index";
import { RecSink, memState } from "./fakes";

// design §7.2 H3: server logs and console are scanned for the password and every login token.
guardSuite();

const ROOT = path.join(os.homedir(), "tmp/claude/shuttle-p1/adapter-test");
const ids = new TestIds("int");
const nodeWs: WsFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as WsLike;
const http = fetchHttpClient();
const device = { name: "laptop", platform: "linux", clientVersion: "0.1.0" };

let dir: string;
let srv: RunningServer;
let owner: Client;
const adapters: ServerAdapter[] = [];

function options(extra: Partial<ServerOptions> = {}): ServerOptions {
  return {
    host: "127.0.0.1", port: 0, dataDir: dir, jobs: false, scrypt: { N: 1024, r: 8, p: 1 },
    rates: { commitsPerSec: 100_000, blobReqPerSec: 100_000, loginFailuresPerMin: 50 },
    sourceUrl: "https://example.com/shuttle/source", coalesceMs: 5, log: guardLog, ...extra,
  };
}

function mk(token: string, vaultId: string, o: Partial<ServerAdapterOptions> = {}): ServerAdapter {
  const a = new ServerAdapter({
    config: { urls: [srv.url], vaultId }, token, http, ws: nodeWs,
    client: { name: "test", platform: "linux", version: "0.1.0", role: "headless" },
    state: memState(), random: () => 0, ...o,
  });
  adapters.push(a);
  return a;
}

const newVaultId = () => randomBytes(16).toString("base64url");

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isLive = (s: RecSink) => s.stateNames().at(-1) === "live";
const recordsOf = (s: RecSink) => s.batches.flatMap((b: ChangeBatch) => b.records);

/** Owner device with a fresh vault created through the adapter. */
async function vault(o: Partial<ServerAdapterOptions> = {}): Promise<{ a: ServerAdapter; vid: string; info: VaultInfo; etag: string }> {
  const vid = newVaultId();
  const a = mk(owner.token, vid, o);
  await a.connect();
  const info = ids.vaultInfo({ vaultId: vid });
  const { etag } = await a.createVaultInfo(info);
  return { a, vid, info, etag };
}

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  dir = await mkdtemp(path.join(ROOT, "int-"));
  srv = await startServer(options());
  await addUser(dir, "alice");
  owner = await login(srv, "alice");
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close()));
});

afterAll(async () => {
  await srv?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("onboarding and vault-info", () => {
  it("connect on a missing vault, create, read, CAS update", async () => {
    const vid = newVaultId();
    const a = mk(owner.token, vid);
    const c0 = await a.connect();
    expect(c0).toMatchObject({ deviceId: owner.deviceId, headSeq: 0, minSeq: 0, infoEtag: null });
    expect(await a.getVaultInfo()).toBeNull();

    const info = ids.vaultInfo({ vaultId: vid });
    const { etag } = await a.createVaultInfo(info);
    const got = await a.getVaultInfo();
    expect(got).toEqual({ info, etag });
    await expect(a.createVaultInfo(info)).rejects.toMatchObject({ code: "ALREADY_EXISTS" });

    const next = { ...info, infoRev: 2 };
    await expect(a.updateVaultInfo(next, "\"stale\"")).rejects.toMatchObject({ code: "PRECONDITION_FAILED", details: { etag } });
    const { etag: e2 } = await a.updateVaultInfo(next, etag);
    expect(e2).not.toBe(etag);

    const c1 = await a.connect();
    expect(c1).toMatchObject({ headSeq: 0, epoch: 1, infoEtag: e2, retention: { noteDays: 30 } });
    expect(c1.capabilities).toMatchObject({ changeFeed: "push", atomicCommit: true, enforcesActiveKv: true });
  });

  it("login and enroll helpers return a working token", async () => {
    const l = await serverLogin({ urls: ["http://127.0.0.1:1", srv.url], http }, "alice", "correct horse battery", device);
    expect(l.url).toBe(srv.url);
    expect(l.token.startsWith("sxd_")).toBe(true);
    await expect(serverLogin({ urls: [srv.url], http }, "alice", "wrong password", device)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const { a } = await vault();
    const { code } = await a.createEnrollCode(600);
    const e = await serverEnroll({ urls: [srv.url], http }, code, { ...device, name: "phone" });
    expect(e.token.startsWith("sxd_")).toBe(true);
    await expect(serverEnroll({ urls: [srv.url], http }, code, device)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a bad token is UNAUTHENTICATED", async () => {
    await expect(mk("sxd_nope", newVaultId()).connect()).rejects.toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
  });

  it("falls back to the next URL when the first does not answer", async () => {
    const a = mk(owner.token, newVaultId(), { config: { urls: ["http://127.0.0.1:1", srv.url], vaultId: newVaultId() } });
    await a.connect();
    expect(a.endpoint).toBe(srv.url);
  });
});

describe("blobs", () => {
  it("put, present, missing, get, NOT_FOUND, packs", async () => {
    const { a } = await vault();
    const b1 = sealed(1000);
    const id1 = ids.blobId();
    const id2 = ids.blobId();
    expect(await a.missingBlobs([id1, id2, id1])).toEqual([id1, id2]);
    expect(await a.putBlob(id1, b1)).toBe("stored");
    expect(await a.putBlob(id1, b1)).toBe("present");
    expect(await a.missingBlobs([id1, id2])).toEqual([id2]);
    expect(Buffer.from(await a.getBlob(id1)).equals(Buffer.from(b1))).toBe(true);
    await expect(a.getBlob(id2)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const items = Array.from({ length: 5 }, () => ({ id: ids.blobId(), bytes: sealed(300) as Uint8Array }));
    await a.putBlobs(items);
    const got = await a.getBlobs([...items.map((i) => i.id), id2], 8 * 1024 * 1024);
    for (const it of items) expect(Buffer.from(got.get(it.id)!).equals(Buffer.from(it.bytes))).toBe(true);
    expect(got.get(id2)).toBeNull();
  });
});

describe("feed and commits", () => {
  it("two devices: commit over the socket, live push, CONFLICT, PATH_TAKEN, replay, MISSING_BLOB", async () => {
    const { a, vid } = await vault();
    const bClient = await login(srv, "alice", "phone");
    const b = mk(bClient.token, vid, { state: memState({ "shuttle-server.epoch": 1 }) });
    await b.connect();
    const sa = new RecSink();
    const sb = new RecSink();
    a.subscribe(0, sa);
    b.subscribe(0, sb);
    await waitFor(() => isLive(sa) && isLive(sb), "both live");

    const op = ids.put();
    const cid = randomUUID();
    const r1 = await a.commit({ cid, ops: [op] });
    expect(r1).toMatchObject({ cid, replayed: false, results: [{ i: 0, ok: true, seqs: [1] }] });
    await waitFor(() => recordsOf(sb).some((r) => r.seq === 1), "B sees seq 1");
    const rec = recordsOf(sb).find((r) => r.seq === 1)!;
    expect(rec).toMatchObject({ fileId: op.fileId, pathKey: op.pathKey, kind: "put", device: owner.deviceId, cid });
    await waitFor(() => recordsOf(sa).some((r) => r.seq === 1), "A sees its own record");

    // Same cid again: the cached result (design §2.9.5).
    expect(await a.commit({ cid, ops: [op] })).toMatchObject({ replayed: true, results: [{ ok: true, seqs: [1] }] });

    // Stale base from B: CONFLICT with the current head.
    const stale = await b.commit({ cid: randomUUID(), ops: [{ ...ids.put({ fileId: op.fileId, pathKey: op.pathKey }), base: null }] });
    expect(stale.results[0]).toMatchObject({ ok: false, code: "CONFLICT", current: { seq: 1, fileId: op.fileId } });

    // Another file on the same path: PATH_TAKEN.
    const taken = await b.commit({ cid: randomUUID(), ops: [ids.put({ pathKey: op.pathKey })] });
    expect(taken.results[0]).toMatchObject({ ok: false, code: "PATH_TAKEN", current: { seq: 1 } });

    // MISSING_BLOB, upload, resend with the same cid: ops are re-evaluated.
    const blob = ids.blobId();
    const withBlob: CommitOp = ids.put({ blobs: [blob], inline: null });
    const cid2 = randomUUID();
    const m = await b.commit({ cid: cid2, ops: [withBlob] });
    expect(m.results[0]).toMatchObject({ ok: false, code: "MISSING_BLOB", missing: [blob] });
    await b.putBlob(blob, sealed(500));
    const ok = await b.commit({ cid: cid2, ops: [withBlob] });
    expect(ok.results[0]).toMatchObject({ ok: true });
    await waitFor(() => recordsOf(sa).some((r) => r.fileId === withBlob.fileId), "A sees B's blob file");

    // vault-info change is pushed to the other device (design §2.8.5 side effect).
    const cur = (await a.getVaultInfo())!;
    const { etag: newEtag } = await a.updateVaultInfo({ ...cur.info, infoRev: cur.info.infoRev + 1 }, cur.etag);
    await waitFor(() => sb.etags.includes(newEtag), "B told about the new vault-info");

    // Acks reached the server: B's cursor is persisted server-side.
    const head = ok.headSeq;
    await waitFor(() => sb.batches.some((x) => x.to >= head), "B persisted to head");
  });

  it("resubscribe after a restart resumes from the persisted cursor (no full re-read)", async () => {
    const { a, vid } = await vault();
    const s1 = new RecSink();
    a.subscribe(0, s1);
    await waitFor(() => isLive(s1), "live");
    for (let i = 0; i < 3; i++) await a.commit({ cid: randomUUID(), ops: [ids.put()] });
    await waitFor(() => s1.batches.some((x) => x.to >= 3), "persisted 3");
    const cursor = Math.max(...s1.batches.map((x) => x.to));
    await a.close();

    const a2 = mk(owner.token, vid, { state: memState({ "shuttle-server.epoch": 1 }) });
    await a2.commit({ cid: randomUUID(), ops: [ids.put()] }); // REST commit, no subscription
    const s2 = new RecSink();
    a2.subscribe(cursor, s2);
    await waitFor(() => isLive(s2), "live again");
    expect(s2.batches[0]!.from).toBe(cursor);
    expect(recordsOf(s2).map((r) => r.seq)).toEqual([4]);
  });

  it("reconnects after a server restart and keeps going", async () => {
    const { a, vid } = await vault();
    const port = srv.port;
    const s = new RecSink();
    a.subscribe(0, s);
    await waitFor(() => isLive(s), "live");
    await a.commit({ cid: randomUUID(), ops: [ids.put()] });
    await srv.close();
    await waitFor(() => s.stateNames().includes("offline"), "offline");
    srv = await startServer(options({ port }));
    await waitFor(() => s.stateNames().filter((x) => x === "live").length >= 2, "live after restart", 20_000);
    const r = await a.commit({ cid: randomUUID(), ops: [ids.put()] });
    expect(r.results[0]).toMatchObject({ ok: true, seqs: [2] });
    await waitFor(() => recordsOf(s).some((x) => x.seq === 2), "seq 2 delivered");
    expect(vid).toBeTruthy();
  });

  it("subscribe(null) is told no-cursor; snapshot bootstrap, then subscribe from the first page head", async () => {
    const { a, vid } = await vault();
    const ops = Array.from({ length: 5 }, () => ids.put());
    await a.commit({ cid: randomUUID(), ops });
    const b = mk(owner.token, vid); // fresh device state: no epoch known
    const sb = new RecSink();
    b.subscribe(null, sb);
    await waitFor(() => sb.snaps.length === 1, "no-cursor");
    expect(sb.snaps[0]).toMatchObject({ reason: "no-cursor", epoch: 1 });
    const p1 = await b.snapshot({ limit: 2, tombstones: false });
    const p2 = await b.snapshot({ pageToken: p1.next, limit: 2, tombstones: false });
    const p3 = await b.snapshot({ pageToken: p2.next, limit: 2, tombstones: false });
    expect([...p1.records, ...p2.records, ...p3.records].map((r) => r.fileId).sort()).toEqual(ops.map((o) => o.fileId).sort());
    expect(p3.next).toBeNull();
    b.subscribe(p1.headSeq, sb);
    await waitFor(() => isLive(sb), "live after bootstrap");
  });
});

describe("history, usage, devices, pairing", () => {
  it("pull, getVersion, listVersions, listDeleted, usage", async () => {
    const { a } = await vault();
    const op = ids.put();
    const r1 = await a.commit({ cid: randomUUID(), ops: [op] });
    const s1 = (r1.results[0] as { seqs: number[] }).seqs[0]!;
    const r2 = await a.commit({ cid: randomUUID(), ops: [ids.del({ fileId: op.fileId, base: s1, pathKey: op.pathKey })] });
    const s2 = (r2.results[0] as { seqs: number[] }).seqs[0]!;

    const page = await a.pull(0);
    expect(page).toMatchObject({ from: 0, to: s2, headSeq: s2, more: false, live: false });
    expect(page.records.map((r) => r.seq)).toEqual([s2]);
    expect(await a.getVersion(op.fileId, s1)).toMatchObject({ seq: s1, kind: "put" });
    expect(await a.getVersion(op.fileId, 999)).toBeNull();
    expect((await a.listVersions(op.fileId)).records.map((r) => r.seq)).toEqual([s2, s1]);
    expect((await a.listDeleted()).records.map((r) => r.fileId)).toEqual([op.fileId]);
    expect(await a.usage()).toMatchObject({ exact: true, quotaBytes: null });
  });

  it("REST pull reports seen.maxSeq like the hello (D9); outside a restore the server ignores it", async () => {
    const urls: string[] = [];
    const rec = { request: (r: Parameters<typeof http.request>[0]) => { urls.push(r.url); return http.request(r); } };
    const { a, vid } = await vault();
    await a.commit({ cid: randomUUID(), ops: [ids.put()] });
    const b = mk(owner.token, vid, { http: rec, state: memState({ "shuttle-server.epoch": 1 }), session: () => ({ seenMaxSeq: 50, rollbackAck: null }) });
    const page = await b.pull(0);
    expect(page.headSeq).toBe(1);
    expect(page.records).toHaveLength(1);
    const q = new URL(urls.find((u) => u.includes("/changes?"))!).searchParams;
    expect(q.get("seenMaxSeq")).toBe("50");
    // Not sent when it adds nothing to `since`.
    const c = mk(owner.token, vid, { http: rec, state: memState({ "shuttle-server.epoch": 1 }), session: () => ({ seenMaxSeq: 1, rollbackAck: null }) });
    urls.length = 0;
    await c.pull(1);
    expect(new URL(urls.find((u) => u.includes("/changes?"))!).searchParams.has("seenMaxSeq")).toBe(false);
  });

  it("devices, revoke closes the revoked device's feed with auth-error and no reconnect", async () => {
    const { a, vid } = await vault();
    const victim = await login(srv, "alice", "old phone");
    const b = mk(victim.token, vid, { state: memState({ "shuttle-server.epoch": 1 }) });
    const sb = new RecSink();
    b.subscribe(0, sb);
    await waitFor(() => isLive(sb), "live");
    const devs = await a.listDevices();
    expect(devs.find((d) => d.current)!.deviceId).toBe(owner.deviceId);
    expect(devs.some((d) => d.deviceId === victim.deviceId)).toBe(true);
    await a.revokeDevice(victim.deviceId);
    await waitFor(() => sb.stateNames().at(-1) === "auth-error", "auth-error");
    expect(sb.errors.at(-1)!.code).toBe("REVOKED");
    await expect(b.commit({ cid: randomUUID(), ops: [ids.put()] })).rejects.toMatchObject({ code: "REVOKED" });
    await expect(b.usage()).rejects.toMatchObject({ code: "REVOKED" });
  });

  it("pairing mailbox: put, take once, then null; occupied slot is ALREADY_EXISTS", async () => {
    const { a } = await vault();
    const pid = randomBytes(16).toString("base64url");
    await a.pairingPut(pid, JSON.stringify({ hello: "world" }));
    await expect(a.pairingPut(pid, "{}")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(await a.pairingTake(pid)).toBe("{\"hello\":\"world\"}");
    expect(await a.pairingTake(pid)).toBeNull();
  });
});

describe("rebuild", () => {
  it("other devices get snapshotRequired{epoch}; bootstrap adopts the new epoch", async () => {
    const { a, vid, info } = await vault();
    await a.commit({ cid: randomUUID(), ops: [ids.put()] });
    const bc = await login(srv, "alice", "tablet");
    const b = mk(bc.token, vid, { state: memState({ "shuttle-server.epoch": 1 }) });
    const sb = new RecSink();
    b.subscribe(0, sb);
    await waitFor(() => isLive(sb), "live");

    expect(await a.rebuild({ ...info, epoch: 2, infoRev: 2 })).toEqual({ epoch: 2 });
    await waitFor(() => sb.snaps.length === 1, "snapshotRequired");
    expect(sb.snaps[0]).toMatchObject({ reason: "epoch", epoch: 2 });
    await expect(b.commit({ cid: randomUUID(), ops: [ids.put()] })).rejects.toMatchObject({ code: "SNAPSHOT_REQUIRED" });

    const first = await b.snapshot({ tombstones: false });
    expect(first.epoch).toBe(2);
    b.subscribe(first.headSeq, sb);
    await waitFor(() => sb.stateNames().filter((x) => x === "live").length >= 2, "live in epoch 2");
    const r = await b.commit({ cid: randomUUID(), ops: [ids.put()] });
    expect(r.results[0]!.ok).toBe(true);
  });
});
