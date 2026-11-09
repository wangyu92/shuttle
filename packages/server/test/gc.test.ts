// Retention, thinning, tombstone purge, two-phase blob GC (design §2.7) with a fake clock.
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import {
  FakeTime, TestWs, api, archiveOp, blobId, cid, createVault, delOp, fileId, fixture, pathKey, putBlob, putOp, removeDir,
  sealed, sha256, sleep, start, tempDir, type Client,
} from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;
let ws: TestWs;
const time = new FakeTime();

beforeAll(async () => {
  dir = await tempDir("gc");
  srv = await start(dir, { now: time.now });
  ({ c, vid } = await fixture(srv, dir));
  ws = await TestWs.open(srv);
  await ws.connect(c.token, vid);
});

afterAll(async () => {
  ws?.close();
  await srv?.close();
  await removeDir(dir);
});

const seqOf = (r: { results: unknown[] }, i = 0) => (r.results[i] as { seqs: number[] }).seqs[0]!;
async function versions(v: string, fid: string): Promise<number[]> {
  const r = await api(srv, c, "GET", `/v1/vaults/${v}/files/${fid}/versions?limit=500`);
  return r.json.records.map((x: { seq: number }) => x.seq).sort((a: number, b: number) => a - b);
}

describe("retention and thinning", () => {
  it("non-head versions expire per class; the head's base survives; thinning keeps the newest per bucket", async () => {
    const v = await createVault(srv, c, "ret");
    const w = await TestWs.open(srv);
    await w.connect(c.token, v);
    // File A (note): three versions a minute apart.
    const A = fileId(), pa = pathKey();
    const a1 = seqOf(await w.commit([putOp(A, null, pa)]));
    time.advance(60_000);
    const a2 = seqOf(await w.commit([putOp(A, a1, pa)]));
    time.advance(60_000);
    const a3 = seqOf(await w.commit([putOp(A, a2, pa)]));
    // File B (note): five versions; b1-b3 in one 60-min bucket, b4 in the next, b5 head.
    const B = fileId(), pb = pathKey();
    time.t = Math.ceil(time.t / HOUR) * HOUR + 60_000;
    const b1 = seqOf(await w.commit([putOp(B, null, pb)]));
    time.advance(10 * 60_000);
    const b2 = seqOf(await w.commit([putOp(B, b1, pb)]));
    time.advance(10 * 60_000);
    const b3 = seqOf(await w.commit([putOp(B, b2, pb)]));
    time.advance(50 * 60_000);
    const b4 = seqOf(await w.commit([putOp(B, b3, pb)]));
    time.advance(10 * 60_000);
    const b5 = seqOf(await w.commit([putOp(B, b4, pb)]));
    const ar = seqOf(await w.commit([archiveOp(B, b3, pb)]));
    // File D (attachment): two versions.
    const D = fileId(), pd = pathKey();
    const d1 = seqOf(await w.commit([putOp(D, null, pd, { rc: "attachment" })]));
    const d2 = seqOf(await w.commit([putOp(D, d1, pd, { rc: "attachment" })]));
    const d3 = seqOf(await w.commit([putOp(D, d2, pd, { rc: "attachment" })]));

    time.advance(25 * HOUR);
    const s1 = await srv.runMaintenance();
    expect(s1.versionsDeleted).toBeGreaterThan(0);
    expect(await versions(v, B)).toEqual([b3, b4, b5, ar].sort((x, y) => x - y)); // b1, b2 thinned; archive kept
    expect(await versions(v, A)).toEqual([a1, a2, a3]); // a1 is alone among thinnable versions in its bucket
    expect(await versions(v, D)).toEqual([d1, d2, d3]);

    time.advance(15 * DAY);
    await srv.runMaintenance();
    expect(await versions(v, D)).toEqual([d2, d3]); // past attachmentDays: only head and its base remain
    expect(await versions(v, A)).toEqual([a1, a2, a3]); // notes still inside noteDays
    time.advance(15 * DAY);
    await srv.runMaintenance();
    expect(await versions(v, B)).toEqual([b4, b5]); // b3 and archive gone after noteDays; b4 = base of head
    expect(await versions(v, A)).toEqual([a2, a3]);
    w.close();
  });

  it("tombstone keeps its base for tombstoneDays, then the whole file is purged and minSeq advances", async () => {
    const v = await createVault(srv, c, "tomb");
    const w = await TestWs.open(srv);
    await w.connect(c.token, v);
    const C = fileId(), pc = pathKey();
    const c1 = seqOf(await w.commit([putOp(C, null, pc)]));
    const c2 = seqOf(await w.commit([delOp(C, c1, pc)]));
    const other = seqOf(await w.commit([putOp(fileId(), null, pathKey())]));
    time.advance(31 * DAY);
    await srv.runMaintenance();
    expect(await versions(v, C)).toEqual([c1, c2]); // restorable: the base of the tombstone
    time.advance(60 * DAY);
    const st = await srv.runMaintenance();
    expect(st.tombstonesPurged).toBe(1);
    expect(await versions(v, C)).toEqual([]);
    const snap = await api(srv, c, "GET", `/v1/vaults/${v}/snapshot?tombstones=1`);
    expect(snap.json.minSeq).toBe(c2);
    expect(snap.json.records.map((x: { seq: number }) => x.seq)).toEqual([other]);
    w.close();
    // CursorExpired: a cursor before minSeq must bootstrap.
    const r = await TestWs.open(srv);
    r.hello(c.token, v, { since: c1 });
    await r.type("welcome");
    expect(await r.type("snapshotRequired")).toMatchObject({ reason: "cursor-too-old", minSeq: c2 });
    r.close();
    const lp = await api(srv, c, "GET", `/v1/vaults/${v}/changes?since=${c1}`);
    expect(lp.status).toBe(409);
    expect(lp.json.error.details).toMatchObject({ reason: "cursor-too-old", minSeq: c2 });
  });

  it("the cid cache is pruned after 7 days", async () => {
    const id = cid();
    const op = putOp(fileId(), null, pathKey());
    await ws.commit([op], { cid: id });
    time.advance(8 * DAY);
    const st = await srv.runMaintenance();
    expect(st.commitsPruned).toBeGreaterThan(0);
    const again = await ws.commit([op], { cid: id });
    expect(again.replayed).toBe(false);
    expect(again.results[0]).toMatchObject({ code: "CONFLICT" });
  });
});

describe("two-phase blob GC (S13)", () => {
  it("phase a dooms unreferenced blobs after 24 h; a commit then gets MISSING_BLOB; a re-PUT revives it", async () => {
    const id = blobId();
    expect((await putBlob(srv, c, vid, id, sealed(300))).status).toBe(201);
    time.advance(25 * HOUR);
    const st = await srv.runMaintenance();
    expect(st.blobsDoomed).toBeGreaterThanOrEqual(1);
    const m = await api(srv, c, "POST", `/v1/vaults/${vid}/blobs/missing`, { ids: [id] });
    expect(m.json.missing).toEqual([id]);
    const r = await ws.commit([putOp(fileId(), null, pathKey(), { blobs: [id] })]);
    expect(r.results[0]).toMatchObject({ code: "MISSING_BLOB", missing: [id] });
    expect((await putBlob(srv, c, vid, id, sealed(300))).status).toBe(200); // present: flips back to live
    time.advance(2 * HOUR);
    await srv.runMaintenance(); // phase b: the blob is live again, so it stays
    const ok = await ws.commit([putOp(fileId(), null, pathKey(), { blobs: [id] })]);
    expect(ok.results[0]!.ok).toBe(true);
    expect((await fetch(`${srv.url}/v1/vaults/${vid}/blobs/${id}`, { headers: c.auth })).status).toBe(200);
  });

  it("phase b deletes still-doomed rows and moves their files; referenced blobs are never doomed", async () => {
    const dead = blobId(), kept = blobId();
    await putBlob(srv, c, vid, dead, sealed(300));
    await putBlob(srv, c, vid, kept, sealed(300));
    await ws.commit([putOp(fileId(), null, pathKey(), { blobs: [kept] })]);
    time.advance(25 * HOUR);
    await srv.runMaintenance();
    time.advance(30 * 60_000);
    await srv.runMaintenance(); // < 1 h after phase a: nothing deleted yet
    expect((await fetch(`${srv.url}/v1/vaults/${vid}/blobs/${dead}`, { headers: c.auth })).status).toBe(200);
    time.advance(HOUR);
    const st = await srv.runMaintenance();
    expect(st.blobsDeleted).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${srv.url}/v1/vaults/${vid}/blobs/${dead}`, { headers: c.auth })).status).toBe(404);
    expect(existsSync(srv.core.blobs.blobPath(vid, dead))).toBe(false);
    expect((await fetch(`${srv.url}/v1/vaults/${vid}/blobs/${kept}`, { headers: c.auth })).status).toBe(200);
  });

  it("a PUT of a doomed blob racing phase b: the file is present after both finish", async () => {
    const id = blobId();
    const bytes = sealed(64 * 1024);
    await putBlob(srv, c, vid, id, bytes);
    time.advance(25 * HOUR);
    await srv.runMaintenance(); // doomed
    time.advance(2 * HOUR);
    // Start a slow PUT: the body streams while phase b runs.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    async function* body() {
      yield bytes.subarray(0, 1024);
      await gate;
      yield bytes.subarray(1024);
    }
    const pending = fetch(`${srv.url}/v1/vaults/${vid}/blobs/${id}`, {
      method: "PUT", body: Readable.toWeb(Readable.from(body())) as ReadableStream, duplex: "half",
      headers: { ...c.auth, "Content-Type": "application/octet-stream", "X-Shuttle-Sha256": sha256(bytes) },
    } as RequestInit);
    await sleep(100);
    const deleted = srv.maintenance.phaseB(vid);
    expect(deleted).toContain(id);
    expect(existsSync(srv.core.blobs.blobPath(vid, id))).toBe(false);
    release();
    const res = await pending;
    expect(res.status).toBe(201);
    expect(existsSync(srv.core.blobs.blobPath(vid, id))).toBe(true);
    const got = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/${id}`, { headers: c.auth });
    expect(sha256(new Uint8Array(await got.arrayBuffer()))).toBe(sha256(bytes));
    const ok = await ws.commit([putOp(fileId(), null, pathKey(), { blobs: [id] })]);
    expect(ok.results[0]!.ok).toBe(true);
  });

  it("orphan scan removes old files without a row and keeps young ones", async () => {
    const old = blobId(), young = blobId();
    for (const id of [old, young]) {
      const p = srv.core.blobs.blobPath(vid, id);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, sealed(100));
    }
    const past = new Date(Date.now() - 2 * DAY);
    await utimes(srv.core.blobs.blobPath(vid, old), past, past);
    expect(srv.maintenance.forceOrphanScan(vid)).toBe(1);
    expect(existsSync(srv.core.blobs.blobPath(vid, old))).toBe(false);
    expect(existsSync(srv.core.blobs.blobPath(vid, young))).toBe(true);
  });

  it("nightly backup: VACUUM INTO backups/shuttle-YYYYMMDD.db, once per day", async () => {
    const st = await srv.runMaintenance({ backup: true });
    expect(st.backup).toMatch(/backups[/\\]shuttle-\d{8}\.db$/);
    expect(existsSync(st.backup!)).toBe(true);
    const again = await srv.runMaintenance({ backup: true });
    expect(again.backup).toBeNull();
  });
});
