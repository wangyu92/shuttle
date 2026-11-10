// CAS table (design §2.5), commit processing (§2.9.7), op error codes (§2.9.3).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import {
  TestWs, archiveOp, blobId, delOp, fileId, fixture, meta, pathKey, putBlob, putOp, removeDir, sealed, start, tempDir, type Client, guardSuite,
} from "./helpers";

// design §7.2 H3: logs, admin output and console are scanned for the password and tokens.
guardSuite();

let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;
let ws: TestWs;

beforeAll(async () => {
  dir = await tempDir("cas");
  srv = await start(dir);
  ({ c, vid } = await fixture(srv, dir));
  ws = await TestWs.open(srv);
  await ws.connect(c.token, vid);
});

afterAll(async () => {
  ws?.close();
  await srv?.close();
  await removeDir(dir);
});

async function one(op: Parameters<typeof ws.commit>[0][0]) {
  const r = await ws.commit([op]);
  return r.results[0]!;
}

describe("CAS table", () => {
  it("create, stale base, edit, PATH_TAKEN, delete frees the pathKey, resurrect", async () => {
    const a = fileId(), b = fileId(), pk = pathKey(), pk2 = pathKey();
    const r1 = await one(putOp(a, null, pk));
    expect(r1).toMatchObject({ i: 0, ok: true });
    const s1 = (r1 as { seqs: number[] }).seqs[0]!;
    // put base:null over an existing head → CONFLICT with current = H
    const r2 = await one(putOp(a, null, pk));
    expect(r2).toMatchObject({ ok: false, code: "CONFLICT", current: { seq: s1, fileId: a } });
    // stale base
    const r3 = await one(putOp(a, s1 - 1 > 0 ? s1 - 1 : 999999, pk));
    expect(r3).toMatchObject({ ok: false, code: "CONFLICT" });
    // edit with the right base
    const r4 = await one(putOp(a, s1, pk));
    expect(r4.ok).toBe(true);
    const s4 = (r4 as { seqs: number[] }).seqs[0]!;
    expect(s4).toBe(s1 + 1);
    // another file creating at the same pathKey → PATH_TAKEN with current = P
    const r5 = await one(putOp(b, null, pk));
    expect(r5).toMatchObject({ ok: false, code: "PATH_TAKEN", current: { fileId: a, seq: s4 } });
    // move b elsewhere works
    const r6 = await one(putOp(b, null, pk2));
    expect(r6.ok).toBe(true);
    // delete a with a stale base → CONFLICT
    expect(await one(delOp(a, s1, pk))).toMatchObject({ ok: false, code: "CONFLICT" });
    const r7 = await one(delOp(a, s4, pk));
    expect(r7.ok).toBe(true);
    const s7 = (r7 as { seqs: number[] }).seqs[0]!;
    // del over a tombstone → CONFLICT, current is the tombstone
    expect(await one(delOp(a, s7, pk))).toMatchObject({ ok: false, code: "CONFLICT", current: { kind: "del", seq: s7 } });
    // base:null over a tombstone → CONFLICT
    expect(await one(putOp(a, null, pk))).toMatchObject({ ok: false, code: "CONFLICT", current: { seq: s7 } });
    // pathKey freed: b can move into pk
    const r8 = await one(putOp(b, (r6 as { seqs: number[] }).seqs[0]!, pk));
    expect(r8.ok).toBe(true);
    // resurrect a at its old path → PATH_TAKEN (b holds it); at a new path → OK
    expect(await one(putOp(a, s7, pk))).toMatchObject({ ok: false, code: "PATH_TAKEN", current: { fileId: b } });
    expect((await one(putOp(a, s7, pathKey()))).ok).toBe(true);
  });

  it("archive never moves the head; archive without head is INVALID; base above head INVALID", async () => {
    const a = fileId(), pk = pathKey();
    const s1 = ((await one(putOp(a, null, pk))) as { seqs: number[] }).seqs[0]!;
    const s2 = ((await one(putOp(a, s1, pk))) as { seqs: number[] }).seqs[0]!;
    const ar = await one(archiveOp(a, s1, pk));
    expect(ar.ok).toBe(true);
    // head is still s2: an edit with base s2 succeeds
    expect((await one(putOp(a, s2, pk))).ok).toBe(true);
    expect(await one(archiveOp(fileId(), 1, pathKey()))).toMatchObject({ ok: false, code: "INVALID" });
    expect(await one(archiveOp(a, 10_000_000, pk))).toMatchObject({ ok: false, code: "INVALID" });
    // history shows the archive record
    const h = await fetch(`${srv.url}/v1/vaults/${vid}/files/${a}/versions`, { headers: c.auth }).then((r) => r.json());
    expect(h.records.map((r: { kind: string }) => r.kind)).toEqual(["put", "archive", "put", "put"]);
  });

  it("non-atomic commits evaluate ops in order; atomic swap passes; atomic failure aborts all", async () => {
    const a = fileId(), b = fileId(), pa = pathKey(), pb = pathKey();
    const r = await ws.commit([putOp(a, null, pa), putOp(b, null, pb)]);
    const [sa, sb] = r.results.map((x) => (x as { seqs: number[] }).seqs[0]!);
    // non-atomic swap fails on the first op (pb is held by b)
    const nonAtomic = await ws.commit([putOp(a, sa!, pb), putOp(b, sb!, pa)]);
    expect(nonAtomic.results[0]).toMatchObject({ ok: false, code: "PATH_TAKEN" });
    expect(nonAtomic.results[1]).toMatchObject({ ok: false, code: "PATH_TAKEN" });
    // atomic swap: pathKey uniqueness on the final state
    const sw = await ws.commit([putOp(a, sa!, pb), putOp(b, sb!, pa)], { atomic: true });
    expect(sw.results.every((x) => x.ok)).toBe(true);
    const [sa2, sb2] = sw.results.map((x) => (x as { seqs: number[] }).seqs[0]!);
    // atomic with one bad op: others ABORTED, nothing applied
    const head = sw.headSeq;
    const bad = await ws.commit([putOp(a, sa2!, pathKey()), putOp(b, 1, pb)], { atomic: true });
    expect(bad.results[0]).toMatchObject({ ok: false, code: "ABORTED" });
    expect(bad.results[1]).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(bad.headSeq).toBe(head);
    // the swap is visible: a is at pb
    const snap = await fetch(`${srv.url}/v1/vaults/${vid}/snapshot?limit=5000`, { headers: c.auth }).then((x) => x.json());
    const recA = snap.records.find((x: { fileId: string }) => x.fileId === a);
    expect(recA).toMatchObject({ pathKey: pb, seq: sa2 });
    expect(snap.records.find((x: { fileId: string }) => x.fileId === b)).toMatchObject({ pathKey: pa, seq: sb2 });
  });

  it("atomic: two files claiming one pathKey → PATH_TAKEN", async () => {
    const pk = pathKey();
    const r = await ws.commit([putOp(fileId(), null, pk), putOp(fileId(), null, pk)], { atomic: true });
    expect(r.results.every((x) => !x.ok)).toBe(true);
    expect(r.results.some((x) => !x.ok && x.code === "PATH_TAKEN")).toBe(true);
  });

  it("KEY_VERSION, INVALID sizes, MISSING_BLOB, encSize recomputed", async () => {
    expect(await one(putOp(fileId(), null, pathKey(), { kv: 2 }))).toMatchObject({ ok: false, code: "KEY_VERSION" });
    const big = { ...putOp(fileId(), null, pathKey()), meta: meta(17 * 1024) };
    expect(await one(big)).toMatchObject({ ok: false, code: "INVALID", message: "meta too large" });
    const bigInline = putOp(fileId(), null, pathKey(), { inline: meta(7 * 1024) });
    expect(await one(bigInline)).toMatchObject({ ok: false, code: "INVALID" });
    const id1 = blobId(), id2 = blobId();
    const missing = await one(putOp(fileId(), null, pathKey(), { blobs: [id1, id2, id1] }));
    expect(missing).toMatchObject({ ok: false, code: "MISSING_BLOB", missing: [id1, id2] });
    expect((await putBlob(srv, c, vid, id1, sealed(1000))).status).toBe(201);
    expect((await putBlob(srv, c, vid, id2, sealed(500))).status).toBe(201);
    const fid = fileId();
    const ok = await one({ ...putOp(fid, null, pathKey(), { blobs: [id1, id2] }) });
    expect(ok.ok).toBe(true);
    const rec = await fetch(`${srv.url}/v1/vaults/${vid}/files/${fid}/versions`, { headers: c.auth }).then((r) => r.json());
    expect(rec.records[0]).toMatchObject({ encSize: 1500, blobs: [id1, id2] });
    expect(rec.records[0].inline).toBeUndefined();
  });

  it("message-level errors: too many ops → TOO_LARGE (non-fatal); malformed op → INVALID", async () => {
    const ops = Array.from({ length: 501 }, () => putOp(fileId(), null, pathKey()));
    const rid = ws.nextRid();
    ws.send({ type: "commit", rid, cid: crypto.randomUUID(), ops });
    expect(await ws.take((f) => f.rid === rid)).toMatchObject({ type: "error", code: "TOO_LARGE", fatal: false });
    const rid2 = ws.nextRid();
    ws.send({ type: "commit", rid: rid2, cid: crypto.randomUUID(), ops: [{ op: "put", fileId: "nope" }] });
    expect(await ws.take((f) => f.rid === rid2)).toMatchObject({ type: "error", code: "INVALID", fatal: false });
    // still usable
    expect((await one(putOp(fileId(), null, pathKey()))).ok).toBe(true);
  });

  it("quota: commit with inline over the limit → QUOTA; blob PUT over → 507", async () => {
    const { runAdmin } = await import("../src/adminCli");
    const { silentIo } = await import("./helpers");
    const { io } = silentIo(dir);
    expect(await runAdmin(["vault", "quota", "vault-alice", "1"], io)).toBe(0);
    expect(await one(putOp(fileId(), null, pathKey()))).toMatchObject({ ok: false, code: "QUOTA" });
    const r = await putBlob(srv, c, vid, blobId(), sealed(100));
    expect(r.status).toBe(507);
    expect(await runAdmin(["vault", "quota", "vault-alice", "none"], io)).toBe(0);
    expect((await one(putOp(fileId(), null, pathKey()))).ok).toBe(true);
  });

  it("REST commit gives the same result shape", async () => {
    const fid = fileId();
    const r = await fetch(`${srv.url}/v1/vaults/${vid}/commit`, {
      method: "POST", headers: { ...c.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ cid: crypto.randomUUID(), ops: [putOp(fid, null, pathKey())] }),
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ replayed: false, results: [{ i: 0, ok: true }] });
    expect(typeof b.headSeq).toBe("number");
  });
});
