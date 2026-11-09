// Reconnect idempotency by cid (design §2.9.5, X2): same cid + digest → cached result, also across a
// restart; same cid + different digest → PROTOCOL; MISSING_BLOB results are re-evaluated on resend.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import { TestWs, blobId, cid, fileId, fixture, login, meta, pathKey, putBlob, putOp, removeDir, sealed, start, tempDir, type Client } from "./helpers";

let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;

beforeAll(async () => {
  dir = await tempDir("idem");
  srv = await start(dir);
  ({ c, vid } = await fixture(srv, dir));
});

afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
});

describe("idempotency", () => {
  it("same cid and digest replays the cached result; re-sealed meta keeps the digest", async () => {
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    const id = cid();
    const op = putOp(fileId(), null, pathKey());
    const first = await ws.commit([op], { cid: id });
    expect(first.replayed).toBe(false);
    const again = await ws.commit([{ ...op, meta: meta() }], { cid: id }); // fresh nonce, same header
    expect(again.replayed).toBe(true);
    expect(again.results).toEqual(first.results);
    ws.close();
  });

  it("same cid with a different digest → PROTOCOL and close 4400", async () => {
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    const id = cid();
    const fid = fileId();
    await ws.commit([putOp(fid, null, pathKey())], { cid: id });
    const rid = ws.nextRid();
    ws.send({ type: "commit", rid, cid: id, ops: [putOp(fid, null, pathKey())] });
    expect(await ws.take((f) => f.rid === rid)).toMatchObject({ type: "error", code: "PROTOCOL", fatal: true });
    expect((await ws.waitClose()).code).toBe(4400);
  });

  it("cid cache is per device: another device may reuse the cid", async () => {
    const other = await login(srv, "alice", "phone");
    const id = cid();
    const a = await TestWs.open(srv);
    await a.connect(c.token, vid);
    const b = await TestWs.open(srv);
    await b.connect(other.token, vid);
    expect((await a.commit([putOp(fileId(), null, pathKey())], { cid: id })).replayed).toBe(false);
    expect((await b.commit([putOp(fileId(), null, pathKey())], { cid: id })).replayed).toBe(false);
    a.close(); b.close();
  });

  it("MISSING_BLOB is re-evaluated on a same-cid resend after the upload", async () => {
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    const id = cid();
    const bid = blobId();
    const op = putOp(fileId(), null, pathKey(), { blobs: [bid] });
    const r1 = await ws.commit([op], { cid: id });
    expect(r1.results[0]).toMatchObject({ ok: false, code: "MISSING_BLOB", missing: [bid] });
    expect((await putBlob(srv, c, vid, bid, sealed(200))).status).toBe(201);
    const r2 = await ws.commit([op], { cid: id });
    expect(r2.replayed).toBe(true);
    expect(r2.results[0]).toMatchObject({ ok: true });
    const r3 = await ws.commit([op], { cid: id });
    expect(r3.results).toEqual(r2.results);
    ws.close();
  });

  it("the cache survives a restart", async () => {
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    const id = cid();
    const op = putOp(fileId(), null, pathKey());
    const first = await ws.commit([op], { cid: id });
    ws.close();
    await srv.close();
    srv = await start(dir);
    const ws2 = await TestWs.open(srv);
    await ws2.connect(c.token, vid);
    const again = await ws2.commit([op], { cid: id });
    expect(again.replayed).toBe(true);
    expect(again.results).toEqual(first.results);
    ws2.close();
  });
});
