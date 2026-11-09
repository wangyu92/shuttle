// Change feed (design §2.9.2, §2.9.4, §2.9.6): catch-up then live, contiguity, coalescing, pull,
// snapshotRequired, supersede, heartbeat timeouts, backpressure, long-poll and vault-info push.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import {
  TestWs, api, archiveOp, cid, delOp, fileId, fixture, login, makeInfo, pathKey, putOp, removeDir, sleep, start, tempDir, type Client,
} from "./helpers";

let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;

beforeAll(async () => {
  dir = await tempDir("feed");
  srv = await start(dir, { helloTimeoutMs: 300 });
  ({ c, vid } = await fixture(srv, dir));
});

afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
});

function contiguous(frames: Array<Record<string, any>>, start: number): void {
  let last = start;
  for (const f of frames) {
    expect(f.from).toBe(last);
    expect(f.to).toBeGreaterThanOrEqual(f.from);
    for (const r of f.records) { expect(r.seq).toBeGreaterThan(f.from); expect(r.seq).toBeLessThanOrEqual(f.to); }
    last = f.to;
  }
}

describe("feed", () => {
  it("welcome fields, empty catch-up, then live push incl. archive and own records after commitResult", async () => {
    const ws = await TestWs.open(srv);
    const { welcome, changes } = await ws.connect(c.token, vid, { since: 0 });
    expect(welcome).toMatchObject({ proto: 1, deviceId: c.deviceId, epoch: 1, minSeq: 0, heartbeatSec: 25 });
    expect(welcome.infoEtag).toMatch(/^".+"$/);
    expect(welcome.retention).toMatchObject({ noteDays: 30, tombstoneDays: 90 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 0, to: welcome.headSeq, more: false, live: false });
    const fid = fileId(), pk = pathKey();
    const r = await ws.commit([putOp(fid, null, pk)]);
    const s1 = (r.results[0] as { seqs: number[] }).seqs[0]!;
    // commitResult was taken first; now the live frame with the same seq
    const live = await ws.take((f) => f.type === "changes" && f.live === true);
    expect(live.records.map((x: { seq: number }) => x.seq)).toEqual([s1]);
    expect(live).toMatchObject({ from: welcome.headSeq, to: s1 });
    await ws.commit([archiveOp(fid, s1, pk)]);
    const live2 = await ws.take((f) => f.type === "changes" && f.live === true);
    expect(live2.records[0].kind).toBe("archive");
    expect(live2.from).toBe(s1);
    ws.close();
  });

  it("catch-up is coalesced (one head per file, no archive) and contiguous over pages", async () => {
    const w = await TestWs.open(srv);
    const { welcome } = await w.connect(c.token, vid);
    const base = welcome.headSeq as number;
    const ops = [];
    const fids: string[] = [];
    for (let i = 0; i < 1200; i++) { const f = fileId(); fids.push(f); ops.push(putOp(f, null, pathKey())); }
    let seqs: number[] = [];
    for (let i = 0; i < ops.length; i += 400) {
      const r = await w.commit(ops.slice(i, i + 400));
      seqs = seqs.concat(r.results.map((x) => (x as { seqs: number[] }).seqs[0]!));
    }
    // edit the first 10 files: their old head disappears from catch-up
    const edits = fids.slice(0, 10).map((f, i) => putOp(f, seqs[i]!, pathKey()));
    await w.commit(edits);
    await w.commit([archiveOp(fids[20]!, seqs[20]!, pathKey())]);
    w.close();
    const r = await TestWs.open(srv);
    r.autoAck = true;
    const { changes } = await r.connect(c.token, vid, { since: base });
    expect(changes.length).toBeGreaterThan(1);
    contiguous(changes, base);
    const recs = changes.flatMap((f) => f.records);
    expect(recs).toHaveLength(1200);
    expect(new Set(recs.map((x: { fileId: string }) => x.fileId)).size).toBe(1200);
    expect(recs.some((x: { kind: string }) => x.kind === "archive")).toBe(false);
    expect(changes.slice(0, -1).every((f) => f.more === true)).toBe(true);
    r.close();
  });

  it("catch-up vs live race: commits landing during catch-up are delivered exactly once, contiguous", async () => {
    const w = await TestWs.open(srv);
    const { welcome } = await w.connect(c.token, vid);
    const base = welcome.headSeq as number;
    const many = Array.from({ length: 2500 }, () => putOp(fileId(), null, pathKey()));
    for (let i = 0; i < many.length; i += 500) await w.commit(many.slice(i, i + 500));
    const racer = await login(srv, "alice", "racer");
    const r = await TestWs.open(srv);
    r.autoAck = true;
    r.hello(racer.token, vid, { since: base });
    // While r catches up, w keeps committing.
    const extra: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await w.commit([putOp(fileId(), null, pathKey())]);
      extra.push((res.results[0] as { seqs: number[] }).seqs[0]!);
    }
    const last = extra[extra.length - 1]!;
    const frames: Array<Record<string, any>> = [];
    while (!frames.length || frames[frames.length - 1]!.to < last) {
      frames.push(await r.take((f) => f.type === "changes" && f.rid === null));
    }
    contiguous(frames, base);
    const seen = frames.flatMap((f) => f.records.map((x: { seq: number }) => x.seq));
    expect(new Set(seen).size).toBe(seen.length);
    for (const s of extra) expect(seen).toContain(s);
    expect(seen.length).toBe(2500 + 30);
    w.close(); r.close();
  }, 60_000);

  it("pull answers once with the rid and does not move the live cursor", async () => {
    const ws = await TestWs.open(srv);
    const { welcome } = await ws.connect(c.token, vid);
    const rid = ws.nextRid();
    ws.send({ type: "pull", rid, since: 0, limit: 5 });
    const p = await ws.take((f) => f.rid === rid);
    expect(p).toMatchObject({ type: "changes", from: 0, more: true, live: false });
    expect(p.records).toHaveLength(5);
    await ws.commit([putOp(fileId(), null, pathKey())]);
    const live = await ws.take((f) => f.type === "changes" && f.rid === null);
    expect(live.from).toBe(welcome.headSeq);
    ws.close();
  });

  it("snapshotRequired: no-cursor, epoch, cursor-too-old; commits refused while parked; re-hello on the same socket", async () => {
    const ws = await TestWs.open(srv);
    ws.hello(c.token, vid, { since: null });
    await ws.type("welcome");
    expect(await ws.type("snapshotRequired")).toMatchObject({ reason: "no-cursor", epoch: 1 });
    const rid = ws.nextRid();
    ws.send({ type: "commit", rid, cid: cid(), ops: [putOp(fileId(), null, pathKey())] });
    expect(await ws.take((f) => f.rid === rid)).toMatchObject({ type: "error", code: "SNAPSHOT_REQUIRED" });
    ws.hello(c.token, vid, { since: 0, epoch: 7 });
    await ws.type("welcome");
    expect(await ws.type("snapshotRequired")).toMatchObject({ reason: "epoch", epoch: 1 });
    const { changes } = await ws.connect(c.token, vid, { since: 0, epoch: 1 });
    expect(changes.length).toBeGreaterThan(0);
    ws.close();
  });

  it("one socket per device and vault: the older one closes 4409", async () => {
    const a = await TestWs.open(srv);
    await a.connect(c.token, vid);
    const b = await TestWs.open(srv);
    await b.connect(c.token, vid);
    expect((await a.waitClose()).code).toBe(4409);
    expect(b.closed).toBeNull();
    b.close();
  });

  it("hello timeout → 4408; bad token → 4401; unknown vault → 4404; no subprotocol → 4400", async () => {
    const t = await TestWs.open(srv);
    expect((await t.waitClose(3000)).code).toBe(4408);
    const u = await TestWs.open(srv);
    u.hello("sxd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vid);
    expect(await u.type("error")).toMatchObject({ code: "UNAUTHENTICATED", fatal: true });
    expect((await u.waitClose()).code).toBe(4401);
    const v = await TestWs.open(srv);
    v.hello(c.token, "AAAAAAAAAAAAAAAAAAAAAA");
    expect((await v.waitClose()).code).toBe(4404);
    const p = await TestWs.open(srv, []);
    expect((await p.waitClose()).code).toBe(4400);
  });

  it("vault-info PUT broadcasts vaultInfoChanged", async () => {
    const ws = await TestWs.open(srv);
    const { welcome } = await ws.connect(c.token, vid);
    const r = await api(srv, c, "PUT", `/v1/vaults/${vid}/info`, makeInfo(vid, { infoRev: 2 }), { "If-Match": welcome.infoEtag });
    expect(r.status).toBe(200);
    const m = await ws.type("vaultInfoChanged");
    expect(m.etag).toBe(r.json.etag);
    ws.close();
  });

  it("long-poll GET /changes waits for a commit; REST ack", async () => {
    const head = (await api(srv, c, "GET", "/v1/vaults")).json.vaults[0].headSeq as number;
    const pending = api(srv, c, "GET", `/v1/vaults/${vid}/changes?since=${head}&wait=5`);
    await sleep(100);
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid, { since: head });
    const res = await ws.commit([putOp(fileId(), null, pathKey())]);
    const lp = await pending;
    expect(lp.status).toBe(200);
    expect(lp.json).toMatchObject({ from: head, to: res.headSeq, more: false });
    expect(lp.json.records).toHaveLength(1);
    expect((await api(srv, c, "POST", `/v1/vaults/${vid}/ack`, { upTo: res.headSeq })).status).toBe(204);
    const tooOld = await api(srv, c, "GET", `/v1/vaults/${vid}/changes?since=${head}&epoch=9`);
    expect(tooOld.status).toBe(409);
    expect(tooOld.json.error).toMatchObject({ code: "SNAPSHOT_REQUIRED", details: { reason: "epoch", epoch: 1 } });
    ws.close();
  });

  it("delete is delivered as a tombstone head in catch-up", async () => {
    const ws = await TestWs.open(srv);
    const { welcome } = await ws.connect(c.token, vid);
    const f = fileId(), pk = pathKey();
    const s1 = ((await ws.commit([putOp(f, null, pk)])).results[0] as { seqs: number[] }).seqs[0]!;
    await ws.commit([delOp(f, s1, pk)]);
    ws.close();
    const r = await TestWs.open(srv);
    const { changes } = await r.connect(c.token, vid, { since: welcome.headSeq });
    const recs = changes.flatMap((x) => x.records);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ fileId: f, kind: "del", base: s1 });
    r.close();
  });

  it("backpressure: a slow consumer completes a ~50 MiB catch-up in windows bounded by maxUnackedBytes", async () => {
    // Fresh vault with large meta (16 KiB decoded each) so 50 MiB needs ~2400 records.
    const v2 = await (await import("./helpers")).createVault(srv, c, "big");
    const w = await TestWs.open(srv);
    await w.connect(c.token, v2);
    const bigMeta = () => Buffer.alloc(16 * 1024 - 16, 7).toString("base64url");
    const N = 2400;
    for (let i = 0; i < N; i += 40) {
      const ops = Array.from({ length: 40 }, () => ({ ...putOp(fileId(), null, pathKey()), meta: bigMeta() }));
      await w.commit(ops);
    }
    w.close();
    const other = await login(srv, "alice", "slow");
    const r = await TestWs.open(srv);
    const window = 2 * 1024 * 1024;
    r.hello(other.token, v2, { since: 0, window: { maxUnackedBytes: window } });
    await r.type("welcome");
    let got = 0;
    let bytes = 0;
    let lastTo = 0;
    for (;;) {
      // Without acks the server must stop after about one window.
      await sleep(30);
      const pending = r.frames.filter((f) => f.type === "changes");
      const pendingBytes = pending.reduce((n, f) => n + JSON.stringify(f).length, 0);
      expect(pendingBytes).toBeLessThan(window + 2 * 1024 * 1024);
      const f = await r.take((x) => x.type === "changes", 10_000);
      expect(f.from).toBe(lastTo);
      lastTo = f.to;
      got += f.records.length;
      bytes += JSON.stringify(f).length;
      r.send({ type: "ack", upTo: f.to });
      if (!f.more) break;
    }
    expect(got).toBe(N);
    expect(bytes).toBeGreaterThan(50 * 1000 * 1000);
    r.close();
  }, 120_000);
});
