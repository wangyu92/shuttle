/// <reference types="node" />
// One RemoteAdapter conformance suite run against testkit's FakeRemote and against ServerAdapter over
// the real @shuttle/server. testkit exposes no shared suite, so this file holds the scenarios both must
// agree on (design §2.5 CAS and pathKey, §2.9.5 cid replay, MISSING_BLOB resend, feed delivery,
// snapshot paging, vault-info CAS, pairing). Engine tests written against FakeRemote then hold for the
// real transport too.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChangeBatch, OpResult, RemoteAdapter, VersionRecord, WsFactory, WsLike } from "@shuttle/protocol";
import { FakeRemoteServer, TestIds } from "@shuttle/testkit";
import { startServer, type RunningServer } from "../../server/src/server";
import { addUser, login, sealed } from "../../server/test/helpers";
import { ServerAdapter, fetchHttpClient } from "../src/index";
import { RecSink, memState } from "./fakes";

interface Pair { a: RemoteAdapter; b: RemoteAdapter; vaultId: string; close(): Promise<void> }
type Factory = () => Promise<Pair>;

const ids = new TestIds("conformance");

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function seqOf(r: OpResult | undefined): number {
  if (!r || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.seqs[0]!;
}
function failure(r: OpResult | undefined): { code: string; current?: VersionRecord | null; missing?: string[] } {
  if (!r || r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r)}`);
  return r as never;
}

function suite(name: string, factory: Factory) {
  describe(name, () => {
    let p: Pair;
    afterEach(async () => { await p?.close(); });

    it("vault-info CAS", async () => {
      p = await factory();
      const got = await p.a.getVaultInfo();
      expect(got).not.toBeNull();
      await expect(p.a.createVaultInfo(got!.info)).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
      await expect(p.a.updateVaultInfo({ ...got!.info, infoRev: got!.info.infoRev + 1 }, "\"nope\"")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const { etag } = await p.a.updateVaultInfo({ ...got!.info, infoRev: got!.info.infoRev + 1 }, got!.etag);
      expect((await p.b.getVaultInfo())!.etag).toBe(etag);
    });

    it("CAS: create, stale create, update with base, stale delete", async () => {
      p = await factory();
      const op = ids.put();
      const s1 = seqOf((await p.a.commit({ cid: randomUUID(), ops: [op] })).results[0]);
      const again = failure((await p.b.commit({ cid: randomUUID(), ops: [ids.put({ fileId: op.fileId, pathKey: op.pathKey })] })).results[0]);
      expect(again.code).toBe("CONFLICT");
      expect(again.current).toMatchObject({ seq: s1, fileId: op.fileId });
      const s2 = seqOf((await p.b.commit({ cid: randomUUID(), ops: [ids.put({ fileId: op.fileId, pathKey: op.pathKey, base: s1 })] })).results[0]);
      expect(s2).toBeGreaterThan(s1);
      const del = failure((await p.a.commit({ cid: randomUUID(), ops: [ids.del({ fileId: op.fileId, base: s1, pathKey: op.pathKey })] })).results[0]);
      expect(del.code).toBe("CONFLICT");
      expect(del.current!.seq).toBe(s2);
    });

    it("pathKey: PATH_TAKEN, and an atomic swap checked on the final state", async () => {
      p = await factory();
      const x = ids.put();
      const y = ids.put();
      const r = await p.a.commit({ cid: randomUUID(), ops: [x, y] });
      const sx = seqOf(r.results[0]);
      const sy = seqOf(r.results[1]);
      const taken = failure((await p.b.commit({ cid: randomUUID(), ops: [ids.put({ pathKey: x.pathKey })] })).results[0]);
      expect(taken.code).toBe("PATH_TAKEN");
      expect(taken.current!.fileId).toBe(x.fileId);
      const swap = await p.a.commit({
        cid: randomUUID(), atomic: true, ops: [
          ids.put({ fileId: x.fileId, base: sx, pathKey: y.pathKey }),
          ids.put({ fileId: y.fileId, base: sy, pathKey: x.pathKey }),
        ],
      });
      expect(swap.results.every((o) => o.ok)).toBe(true);
    });

    it("same cid replays the cached result", async () => {
      p = await factory();
      const req = { cid: randomUUID(), ops: [ids.put()] };
      const first = await p.a.commit(req);
      const second = await p.a.commit(req);
      expect(second.replayed).toBe(true);
      expect(second.results).toEqual(first.results);
    });

    it("MISSING_BLOB, upload, resend with the same cid", async () => {
      p = await factory();
      const blob = ids.blobId();
      const req = { cid: randomUUID(), ops: [ids.put({ blobs: [blob], inline: null })] };
      const m = failure((await p.a.commit(req)).results[0]);
      expect(m).toMatchObject({ code: "MISSING_BLOB", missing: [blob] });
      expect(await p.a.missingBlobs([blob])).toEqual([blob]);
      expect(await p.a.putBlob(blob, sealed(400))).toBe("stored");
      expect(await p.a.putBlob(blob, sealed(400))).toBe("present");
      expect(seqOf((await p.a.commit(req)).results[0])).toBeGreaterThan(0);
    });

    it("feed: catch-up holds one head per fileId, then live pushes reach the other device", async () => {
      p = await factory();
      const op = ids.put();
      const s1 = seqOf((await p.a.commit({ cid: randomUUID(), ops: [op] })).results[0]);
      const s2 = seqOf((await p.a.commit({ cid: randomUUID(), ops: [ids.put({ fileId: op.fileId, pathKey: op.pathKey, base: s1 })] })).results[0]);
      const sink = new RecSink();
      p.b.subscribe(0, sink);
      await waitFor(() => sink.batches.some((b) => !b.more && b.to >= s2), "catch-up");
      const catchUp = sink.batches.flatMap((b: ChangeBatch) => b.records);
      expect(catchUp.map((r) => r.seq)).toEqual([s2]);
      const live = ids.put();
      const s3 = seqOf((await p.a.commit({ cid: randomUUID(), ops: [live] })).results[0]);
      await waitFor(() => sink.batches.some((b) => b.records.some((r) => r.seq === s3)), "live record");
      // Contiguous batches (design §2.9.2).
      for (let i = 1; i < sink.batches.length; i++) expect(sink.batches[i]!.from).toBe(sink.batches[i - 1]!.to);
    });

    it("snapshot pages cover every head; tombstones only on request", async () => {
      p = await factory();
      const ops = Array.from({ length: 5 }, () => ids.put());
      const r = await p.a.commit({ cid: randomUUID(), ops });
      const victim = ops[0]!;
      await p.a.commit({ cid: randomUUID(), ops: [ids.del({ fileId: victim.fileId, base: seqOf(r.results[0]), pathKey: victim.pathKey })] });
      const collect = async (tombstones: boolean) => {
        const out: string[] = [];
        let token: string | null = null;
        do {
          const page = await p.b.snapshot({ pageToken: token, limit: 2, tombstones });
          out.push(...page.records.map((x) => x.fileId));
          token = page.next;
        } while (token);
        return out.sort();
      };
      expect(await collect(false)).toEqual(ops.slice(1).map((o) => o.fileId).sort());
      expect(await collect(true)).toEqual(ops.map((o) => o.fileId).sort());
    });

    it("pairing take is read-once", async () => {
      p = await factory();
      const pid = randomBytes(16).toString("base64url");
      await p.a.pairingPut(pid, "{\"k\":1}");
      expect(await p.b.pairingTake(pid)).toBe("{\"k\":1}");
      expect(await p.b.pairingTake(pid)).toBeNull();
    });
  });
}

// ---------------- FakeRemote ----------------

suite("FakeRemote", async () => {
  const server = new FakeRemoteServer();
  const a = server.adapter(ids.deviceId(), { name: "mac" });
  const b = server.adapter(ids.deviceId(), { name: "phone" });
  await a.connect();
  await b.connect();
  const info = ids.vaultInfo();
  await a.createVaultInfo(info);
  return { a, b, vaultId: info.vaultId, close: async () => { await a.close(); await b.close(); } };
});

// ---------------- ServerAdapter over the real server ----------------

const ROOT = path.join(os.homedir(), "tmp/claude/shuttle-p1/adapter-test");
let dir: string;
let srv: RunningServer;
let tokens: [string, string];
const nodeWs: WsFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as WsLike;

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  dir = await mkdtemp(path.join(ROOT, "conf-"));
  srv = await startServer({
    host: "127.0.0.1", port: 0, dataDir: dir, jobs: false, scrypt: { N: 1024, r: 8, p: 1 }, coalesceMs: 5, log: () => undefined,
    rates: { commitsPerSec: 100_000, blobReqPerSec: 100_000, loginFailuresPerMin: 50 }, sourceUrl: "https://example.com/shuttle/source",
  });
  await addUser(dir, "alice");
  tokens = [(await login(srv, "alice", "mac")).token, (await login(srv, "alice", "phone")).token];
});

afterAll(async () => {
  await srv?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

suite("ServerAdapter", async () => {
  const vaultId = randomBytes(16).toString("base64url");
  const make = (token: string) => new ServerAdapter({
    config: { urls: [srv.url], vaultId }, token, http: fetchHttpClient(), ws: nodeWs,
    client: { name: "conformance", platform: "linux", version: "0.1.0", role: "headless" }, state: memState(), random: () => 0,
  });
  const a = make(tokens[0]);
  const b = make(tokens[1]);
  await a.connect();
  await a.createVaultInfo(ids.vaultInfo({ vaultId }));
  await b.connect();
  // b bootstraps into the vault's epoch the normal way (first snapshot page) before subscribing.
  await b.snapshot({ limit: 1, tombstones: false });
  return { a, b, vaultId, close: async () => { await a.close(); await b.close(); } };
});
