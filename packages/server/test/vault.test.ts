// Vault REST (design §2.8.5): create/list, vault-info etag CAS, rebuild (§2.11), delete, usage,
// snapshot paging, history, deleted list, pairing mailbox.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import {
  FakeTime, TestWs, addUser, api, blobId, createVault, delOp, fileId, fixture, login, makeInfo, pathKey, putBlob, putOp,
  removeDir, sealed, start, tempDir, vaultId, type Client, guardSuite,
} from "./helpers";

// design §7.2 H3: logs, admin output and console are scanned for the password and tokens.
guardSuite();

let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;
const time = new FakeTime();

beforeAll(async () => {
  dir = await tempDir("vault");
  srv = await start(dir, { now: time.now });
  ({ c, vid } = await fixture(srv, dir));
});

afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
});

describe("vaults", () => {
  it("create: VAULT_EXISTS, NAME_TAKEN; list; info round-trips unknown fields with a quoted ETag", async () => {
    expect((await api(srv, c, "POST", "/v1/vaults", { name: "other", info: makeInfo(vid) })).json.error.code).toBe("VAULT_EXISTS");
    const nv = vaultId();
    expect((await api(srv, c, "POST", "/v1/vaults", { name: "vault-alice", info: makeInfo(nv) })).json.error.code).toBe("NAME_TAKEN");
    const list = await api(srv, c, "GET", "/v1/vaults");
    expect(list.json.vaults).toEqual([expect.objectContaining({ vaultId: vid, name: "vault-alice", role: "owner", headSeq: 0 })]);
    const info = await api(srv, c, "GET", `/v1/vaults/${vid}/info`);
    expect(info.status).toBe(200);
    expect(info.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
    expect(info.json.unknownField).toEqual({ kept: true });
  });

  it("PUT info: 412 with the current etag on mismatch; INVALID on epoch change or non-increasing infoRev", async () => {
    const cur = await api(srv, c, "GET", `/v1/vaults/${vid}/info`);
    const etag = cur.headers.get("etag")!;
    const stale = await api(srv, c, "PUT", `/v1/vaults/${vid}/info`, makeInfo(vid, { infoRev: 2 }), { "If-Match": '"nope"' });
    expect(stale.status).toBe(412);
    expect(stale.json.error).toMatchObject({ code: "PRECONDITION_FAILED", details: { etag } });
    expect((await api(srv, c, "PUT", `/v1/vaults/${vid}/info`, makeInfo(vid, { infoRev: 2 }), { "If-Match": "*" })).status).toBe(412);
    expect((await api(srv, c, "PUT", `/v1/vaults/${vid}/info`, makeInfo(vid, { infoRev: 2, epoch: 2 }), { "If-Match": etag })).json.error.code).toBe("INVALID");
    expect((await api(srv, c, "PUT", `/v1/vaults/${vid}/info`, makeInfo(vid, { infoRev: 1 }), { "If-Match": etag })).json.error.code).toBe("INVALID");
    const ok = await api(srv, c, "PUT", `/v1/vaults/${vid}/info`, makeInfo(vid, { infoRev: 2, activeKv: 2 }), { "If-Match": etag });
    expect(ok.status).toBe(200);
    expect(ok.json.etag).not.toBe(etag);
    // activeKv changed → kv 1 is now KEY_VERSION
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    expect((await ws.commit([putOp(fileId(), null, pathKey(), { kv: 1 })])).results[0]).toMatchObject({ code: "KEY_VERSION" });
    expect((await ws.commit([putOp(fileId(), null, pathKey(), { kv: 2 })])).results[0]!.ok).toBe(true);
    ws.close();
  });

  it("snapshot pages by fileId; tombstones optional; history and deleted lists; getVersion", async () => {
    const v = await createVault(srv, c, "snap");
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, v);
    const ops = Array.from({ length: 25 }, () => putOp(fileId(), null, pathKey()));
    const r = await ws.commit(ops);
    const seqs = r.results.map((x) => (x as { seqs: number[] }).seqs[0]!);
    const d = await ws.commit([delOp(ops[0]!.fileId, seqs[0]!, ops[0]!.pathKey)]);
    const delSeq = (d.results[0] as { seqs: number[] }).seqs[0]!;
    let after: string | null = null;
    const got: string[] = [];
    let firstHead: number | null = null;
    do {
      const page: { status: number; json: any } = await api(srv, c, "GET", `/v1/vaults/${v}/snapshot?limit=10${after ? `&after=${after}` : ""}`);
      expect(page.status).toBe(200);
      firstHead ??= page.json.headSeq;
      got.push(...page.json.records.map((x: { fileId: string }) => x.fileId));
      after = page.json.next;
    } while (after);
    expect(firstHead).toBe(delSeq);
    expect(got).toHaveLength(24);
    expect([...got].sort()).toEqual(got);
    const withT = await api(srv, c, "GET", `/v1/vaults/${v}/snapshot?limit=5000&tombstones=1`);
    expect(withT.json.records).toHaveLength(25);
    const del = await api(srv, c, "GET", `/v1/vaults/${v}/deleted`);
    expect(del.json.records).toEqual([expect.objectContaining({ fileId: ops[0]!.fileId, kind: "del" })]);
    const hist = await api(srv, c, "GET", `/v1/vaults/${v}/files/${ops[0]!.fileId}/versions?limit=1`);
    expect(hist.json.records.map((x: { seq: number }) => x.seq)).toEqual([delSeq]);
    expect(hist.json.next).toBe(delSeq);
    const one = await api(srv, c, "GET", `/v1/vaults/${v}/files/${ops[0]!.fileId}/versions/${seqs[0]}`);
    expect(one.json).toMatchObject({ seq: seqs[0], kind: "put" });
    expect((await api(srv, c, "GET", `/v1/vaults/${v}/files/${ops[1]!.fileId}/versions/${seqs[0]}`)).status).toBe(404);
    ws.close();
  });

  it("usage", async () => {
    const v = await createVault(srv, c, "usage");
    const id = blobId();
    await putBlob(srv, c, v, id, sealed(5000));
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, v);
    await ws.commit([putOp(fileId(), null, pathKey(), { blobs: [id] })]);
    const u = await api(srv, c, "GET", `/v1/vaults/${v}/usage`);
    expect(u.json).toMatchObject({ liveBytes: 5000, historyBytes: 0, blobCount: 1, fileCount: 1, quotaBytes: null });
    expect(u.json.largest).toHaveLength(1);
    ws.close();
  });

  it("rebuild: epoch atomically equal to info.epoch, head_seq kept, only OTHER devices get snapshotRequired{epoch} (§2.11 step 5)", async () => {
    const v = await createVault(srv, c, "rebuild");
    const phone = await login(srv, "alice", "phone");
    const a = await TestWs.open(srv);
    await a.connect(c.token, v);
    await a.commit([putOp(fileId(), null, pathKey()), putOp(fileId(), null, pathKey())]);
    const b = await TestWs.open(srv);
    await b.connect(phone.token, v);
    expect((await api(srv, c, "POST", `/v1/vaults/${v}/rebuild`, { info: makeInfo(v, { epoch: 3, infoRev: 2 }) })).json.error.code).toBe("INVALID");
    a.frames = [];
    const r = await api(srv, c, "POST", `/v1/vaults/${v}/rebuild`, { info: makeInfo(v, { epoch: 2, infoRev: 2 }) });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ epoch: 2, headSeq: 2 });
    expect(await b.type("snapshotRequired")).toMatchObject({ reason: "epoch", epoch: 2, minSeq: 2 });
    const snap = await api(srv, c, "GET", `/v1/vaults/${v}/snapshot`);
    expect(snap.json).toMatchObject({ headSeq: 2, epoch: 2, records: [] });
    // The rebuilding device keeps its feed: no snapshotRequired, and step 4's creates go out on the same
    // socket at the new epoch. Seqs continue (ID-10) and its own commit comes back on the live feed.
    const up = await a.commit([putOp(fileId(), null, pathKey())]);
    expect((up.results[0] as { seqs: number[] }).seqs[0]).toBe(3);
    const echo = await a.take((f) => f.type === "changes" && (f.records as unknown[]).length > 0);
    expect(echo).toMatchObject({ to: 3, headSeq: 3 });
    expect(a.frames.some((f) => f.type === "snapshotRequired")).toBe(false);
    // The other device bootstraps the new epoch on the same socket and continues the seq too.
    const { welcome } = await b.connect(phone.token, v, { since: 3, epoch: 2 });
    expect(welcome.epoch).toBe(2);
    const res = await b.commit([putOp(fileId(), null, pathKey())]);
    expect((res.results[0] as { seqs: number[] }).seqs[0]).toBe(4);
    a.close(); b.close();
  });

  it("rebuild: the caller's socket that is still catching up is bridged over the dropped range, not parked", async () => {
    const v = await createVault(srv, c, "rebuild-catchup");
    const w = await TestWs.open(srv);
    await w.connect(c.token, v);
    for (let i = 0; i < 3; i++) await w.commit(Array.from({ length: 400 }, () => putOp(fileId(), null, pathKey())));
    w.close();
    // Same device, a socket stuck in catch-up: the first page (1000 of 1200 heads) exceeds its window.
    const a = await TestWs.open(srv);
    a.hello(c.token, v, { since: 0, window: { maxUnackedBytes: 1 } });
    const page = await a.take((f) => f.type === "changes");
    expect(page).toMatchObject({ from: 0, more: true });
    const stuckAt = page.to as number;
    expect(stuckAt).toBeLessThan(1200);
    expect((await api(srv, c, "POST", `/v1/vaults/${v}/rebuild`, { info: makeInfo(v, { epoch: 2, infoRev: 2 }) })).status).toBe(200);
    expect(await a.take((f) => f.type === "changes")).toMatchObject({ from: stuckAt, to: 1200, records: [], more: true, minSeq: 1200 });
    const up = await a.commit([putOp(fileId(), null, pathKey())]);
    expect((up.results[0] as { seqs: number[] }).seqs[0]).toBe(1201);
    a.send({ type: "ack", upTo: 1200 });
    expect(await a.take((f) => f.type === "changes" && f.from === 1200)).toMatchObject({ to: 1201 });
    expect(a.frames.some((f) => f.type === "snapshotRequired")).toBe(false);
    a.close();
  });

  it("rebuild: the caller's live socket behind the head is bridged to the new min_seq", async () => {
    // Dedicated server with a long live-coalescing window, so the caller's cursor lags the head when the
    // rebuild lands (a commit by another device is waiting in the live buffer).
    const ldir = await tempDir("vault-live");
    const ls = await start(ldir, { coalesceMs: 3000 });
    try {
      const { c: owner, vid: v } = await fixture(ls, ldir);
      const a = await TestWs.open(ls);
      await a.connect(owner.token, v);
      const phone = await login(ls, "alice", "phone-live");
      const p = await TestWs.open(ls);
      await p.connect(phone.token, v);
      await p.commit([putOp(fileId(), null, pathKey())]);
      a.frames = [];
      expect((await api(ls, owner, "POST", `/v1/vaults/${v}/rebuild`, { info: makeInfo(v, { epoch: 2, infoRev: 2 }) })).status).toBe(200);
      expect(await a.take((x) => x.type === "changes", 1500)).toMatchObject({ from: 0, to: 1, headSeq: 1, minSeq: 1, live: true, records: [] });
      expect(await p.type("snapshotRequired")).toMatchObject({ reason: "epoch", epoch: 2 });
      const up = await a.commit([putOp(fileId(), null, pathKey())]);
      expect((up.results[0] as { seqs: number[] }).seqs[0]).toBe(2);
      expect(a.frames.some((x) => x.type === "snapshotRequired")).toBe(false);
      a.close(); p.close();
    } finally {
      await ls.close();
      await removeDir(ldir);
    }
  });

  it("rebuild: a pre-rebuild cid is neither replayed nor re-run (SNAPSHOT_REQUIRED); cursors keep acked_seq", async () => {
    const v = await createVault(srv, c, "rebuild-cid");
    const phone = await login(srv, "alice", "phone-cid");
    const fid = fileId(), pk = pathKey();
    const op = putOp(fid, null, pk);
    const first = await api(srv, phone, "POST", `/v1/vaults/${v}/commit`, { cid: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", ops: [op] });
    expect(first.status).toBe(200);
    const b = await TestWs.open(srv);
    b.autoAck = true;
    await b.connect(phone.token, v, { since: 0 });
    for (let i = 0; i < 100 && !srv.core.s.get("SELECT 1 AS x FROM device_cursors WHERE vault_id = ?", v); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await api(srv, c, "POST", `/v1/vaults/${v}/rebuild`, { info: makeInfo(v, { epoch: 2, infoRev: 2 }) })).status).toBe(200);
    const again = await api(srv, phone, "POST", `/v1/vaults/${v}/commit`, { cid: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", ops: [op] });
    expect(again.json.error).toMatchObject({ code: "SNAPSHOT_REQUIRED", details: { reason: "epoch", epoch: 2, minSeq: 1, rollbackAt: null } });
    // Nothing was written by the refused resend.
    const snap = await api(srv, c, "GET", `/v1/vaults/${v}/snapshot`);
    expect(snap.json.records).toEqual([]);
    expect(srv.core.store.vault(v)!.head_seq).toBe(1);
    // A second rebuild keeps the original marker; a fresh cid with the same op is a normal create.
    expect((await api(srv, c, "POST", `/v1/vaults/${v}/rebuild`, { info: makeInfo(v, { epoch: 3, infoRev: 3 }) })).status).toBe(200);
    const row = srv.core.s.get<{ result_json: string }>("SELECT result_json FROM commits WHERE vault_id = ? AND cid = ?", v, "6f9619ff-8b86-4011-b42d-00cf4fc964ff");
    expect(JSON.parse(row!.result_json)).toEqual({ staleEpoch: 1 });
    const fresh = await api(srv, phone, "POST", `/v1/vaults/${v}/commit`, { cid: "7f9619ff-8b86-4011-b42d-00cf4fc964ff", ops: [op] });
    expect(fresh.json.results[0]).toMatchObject({ ok: true, seqs: [2] });
    const cur = srv.core.s.get<{ acked_seq: number; rollback_ack: number | null }>(
      "SELECT acked_seq, rollback_ack FROM device_cursors WHERE vault_id = ? AND device_id = ?", v, phone.deviceId);
    expect(cur).toMatchObject({ acked_seq: 1, rollback_ack: null });
    b.close();
  });

  it("delete needs owner and X-Shuttle-Confirm; sockets close 4404; member access is FORBIDDEN", async () => {
    const v = await createVault(srv, c, "doomed");
    await addUser(dir, "bob", false);
    const bob = await login(srv, "bob");
    expect((await api(srv, bob, "GET", `/v1/vaults/${v}/info`)).status).toBe(403);
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, v);
    expect((await api(srv, c, "DELETE", `/v1/vaults/${v}`, undefined, { "X-Shuttle-Confirm": "wrong" })).status).toBe(400);
    expect((await api(srv, c, "DELETE", `/v1/vaults/${v}`, undefined, { "X-Shuttle-Confirm": "doomed" })).status).toBe(202);
    expect((await ws.waitClose()).code).toBe(4404);
    expect((await api(srv, c, "GET", `/v1/vaults/${v}/info`)).status).toBe(404);
  });
});

describe("pairing mailbox", () => {
  it("single read, 409 while occupied, TTL 410, owner only", async () => {
    const pid = vaultId();
    const body = JSON.stringify({ hello: "x" });
    const put = await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${pid}`, { method: "PUT", body, headers: { ...c.auth, "Content-Type": "application/json" } });
    expect(put.status).toBe(201);
    const dup = await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${pid}`, { method: "PUT", body, headers: c.auth });
    expect(dup.status).toBe(409);
    const g1 = await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${pid}`, { headers: c.auth });
    expect(g1.status).toBe(200);
    expect(await g1.text()).toBe(body);
    expect((await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${pid}`, { headers: c.auth })).status).toBe(404);
    const pid2 = vaultId();
    await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${pid2}`, { method: "PUT", body, headers: c.auth });
    time.advance(16 * 60_000);
    expect((await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${pid2}`, { headers: c.auth })).status).toBe(410);
    const big = await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${vaultId()}`, { method: "PUT", body: JSON.stringify({ x: "y".repeat(5000) }), headers: c.auth });
    expect(big.status).toBe(413);
    const notJson = await fetch(`${srv.url}/v1/vaults/${vid}/pairing/${vaultId()}`, { method: "PUT", body: "{", headers: c.auth });
    expect(notJson.status).toBe(400);
  });
});
