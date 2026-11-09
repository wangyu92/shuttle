// Cached stored-bytes counter (quota input): after commits, blob PUTs, a rolled-back commit, retention,
// blob GC and a rebuild, the cached value equals the SQL SUM it replaces.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import {
  FakeTime, TestWs, api, blobId, cid, delOp, fileId, fixture, makeInfo, pathKey, putBlob, putOp, removeDir, sealed, start,
  tempDir, type Client,
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
  dir = await tempDir("usage");
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

function expectInSync(): number {
  const st = srv.core.store;
  const cached = st.storedBytes(vid);
  expect(cached).toBe(st.stored.sum(vid));
  return cached;
}

describe("stored-bytes cache", () => {
  it("tracks commits, blob PUTs, rollbacks, GC and rebuild", async () => {
    const st = srv.core.store;
    expect(expectInSync()).toBe(0);

    // Inline commits add their bodies.
    const A = fileId(), pa = pathKey();
    const a1 = seqOf(await ws.commit([putOp(A, null, pa), putOp(fileId(), null, pathKey())]));
    expect(expectInSync()).toBeGreaterThan(0);

    // A blob PUT adds its size; a second PUT of the same blob adds nothing.
    const before = st.storedBytes(vid);
    const body = sealed(5000);
    const b = blobId();
    expect((await putBlob(srv, c, vid, b, body)).status).toBe(201);
    expect(expectInSync()).toBe(before + 5000);
    expect((await putBlob(srv, c, vid, b, body)).status).toBe(200);
    expect(expectInSync()).toBe(before + 5000);
    const D = fileId(), pd = pathKey();
    await ws.commit([putOp(D, null, pd, { blobs: [b], rc: "attachment" })]);
    expectInSync();

    // A commit that fails inside its savepoint leaves no delta behind.
    const bad = cid();
    const orig = st.commitInTx.bind(st);
    st.commitInTx = (v, d, r, e) => {
      const out = orig(v, d, r, e);
      if (r.cid === bad) throw new Error("injected");
      return out;
    };
    try {
      const rid = ws.nextRid();
      ws.send({ type: "commit", rid, cid: bad, ops: [putOp(fileId(), null, pathKey())] });
      expect(await ws.take((f) => f.rid === rid)).toMatchObject({ type: "error", code: "SERVER" });
    } finally {
      st.commitInTx = orig;
    }
    expectInSync();

    // Retention deletes old inline versions; tombstone purge and blob GC delete rows.
    let s = a1;
    for (let i = 0; i < 3; i++) { time.advance(2 * HOUR); s = seqOf(await ws.commit([putOp(A, s, pa)])); }
    const dHead = st.headRow(vid, D)!.head_seq;
    await ws.commit([delOp(D, dHead, pd)]);
    expectInSync();
    time.advance(100 * DAY);
    await srv.runMaintenance();
    expectInSync();
    time.advance(2 * HOUR);
    await srv.runMaintenance();
    const after = expectInSync();
    expect(after).toBeLessThan(before + 5000);

    // Rebuild drops every row of the vault.
    const r = await api(srv, c, "POST", `/v1/vaults/${vid}/rebuild`, { info: makeInfo(vid, { epoch: 2, infoRev: 2 }) });
    expect(r.status).toBe(200);
    expect(expectInSync()).toBe(0);
  });

  it("quota is enforced against the cached value", async () => {
    srv.core.s.run("UPDATE vaults SET quota_bytes = ? WHERE vault_id = ?", srv.core.store.storedBytes(vid) + 10, vid);
    // After the rebuild: a fresh socket on epoch 2 with since = head (what a client sends after its bootstrap).
    const w2 = await TestWs.open(srv);
    await w2.connect(c.token, vid, { epoch: 2, since: srv.core.store.vault(vid)!.head_seq });
    const big = await w2.commit([putOp(fileId(), null, pathKey(), { inline: Buffer.alloc(600, 1).toString("base64url") })]);
    expect(big.results[0]).toMatchObject({ ok: false, code: "QUOTA" });
    expectInSync();
    w2.close();
    srv.core.s.run("UPDATE vaults SET quota_bytes = NULL WHERE vault_id = ?", vid);
  });
});
