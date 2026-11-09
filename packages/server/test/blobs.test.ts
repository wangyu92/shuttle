// Blob routes (design §2.8.5): PUT/GET/HEAD with hash and magic checks, missing, pack-get, pack-put.
import { stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, decodePack, encodePack } from "@shuttle/protocol";
import type { RunningServer } from "../src/server";
import { api, blobId, fixture, putBlob, removeDir, sealed, sha256, start, tempDir, type Client } from "./helpers";

let srv: RunningServer;
let dir: string;
let c: Client;
let vid: string;

beforeAll(async () => {
  dir = await tempDir("blobs");
  srv = await start(dir);
  ({ c, vid } = await fixture(srv, dir));
});

afterAll(async () => {
  await srv?.close();
  await removeDir(dir);
});

const blobUrl = (id: string) => `${srv.url}/v1/vaults/${vid}/blobs/${id}`;

describe("health", () => {
  it("GET /v1/health without auth, request id echoed", async () => {
    const res = await fetch(`${srv.url}/v1/health`, { headers: { "X-Shuttle-Request-Id": "r-1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-shuttle-server")).toBeTruthy();
    expect(res.headers.get("x-shuttle-request-id")).toBe("r-1");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, protocols: [1], source: "https://example.invalid/shuttle" });
    expect(typeof body.time).toBe("number");
    // Limits are published before subscribe, on health and on /v1/me, equal to welcome.limits.
    expect(body.limits).toEqual(srv.core.cfg.limits);
    expect(body.limits.maxInFlightCommits).toBe(DEFAULT_LIMITS.maxInFlightCommits);
    expect((await api(srv, c, "GET", "/v1/me")).json.limits).toEqual(srv.core.cfg.limits);
  });
});

describe("blobs", () => {
  it("require auth", async () => {
    const r = await fetch(blobUrl(blobId()));
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("PUT then GET a 4 MiB blob, hash preserved, re-PUT → 200, stored under aa/bb", async () => {
    const blob = sealed(4 * 1024 * 1024);
    const id = blobId();
    expect((await putBlob(srv, c, vid, id, blob)).status).toBe(201);
    const again = await putBlob(srv, c, vid, id, blob);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ blobId: id, created: false });
    const head = await fetch(blobUrl(id), { method: "HEAD", headers: c.auth });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(blob.length));
    const got = await fetch(blobUrl(id), { headers: c.auth });
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe(`"${id}"`);
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(sha256(new Uint8Array(await got.arrayBuffer()))).toBe(sha256(blob));
    const st = await stat(path.join(dir, "vaults", vid, "blobs", id.slice(0, 2), id.slice(2, 4), id));
    expect(st.size).toBe(blob.length);
    expect(srv.core.tmpEntries()).toEqual([]);
  });

  it("rejects bad hash (422), bad magic (422), bad id (400), oversize (413); 404 for a missing blob", async () => {
    const id = blobId();
    const blob = sealed(1000);
    const bad = await putBlob(srv, c, vid, id, blob, "0".repeat(64));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("HASH_MISMATCH");
    const plain = sealed(1000);
    plain[0] = 0;
    const magic = await putBlob(srv, c, vid, id, plain);
    expect(magic.status).toBe(422);
    expect((await magic.json()).error.code).toBe("BAD_BLOB");
    const badId = await putBlob(srv, c, vid, "ABC", blob);
    expect(badId.status).toBe(400);
    expect((await badId.json()).error.code).toBe("BAD_ID");
    const traversal = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/..%2F..%2Fx`, { headers: c.auth });
    expect(traversal.status).toBe(400);
    const badEscape = await fetch(`http://127.0.0.1:${srv.port}/v1/vaults/%E0%A4%A/blobs/x`, { headers: c.auth });
    expect(badEscape.status).toBe(400);
    expect((await badEscape.json()).error.code).toBe("BAD_ID");
    const big = await putBlob(srv, c, vid, id, sealed(DEFAULT_LIMITS.maxBlobSize + 1));
    expect(big.status).toBe(413);
    const missing = await fetch(blobUrl(id), { headers: c.auth });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
    expect(srv.core.tmpEntries()).toEqual([]);
  });

  it("POST missing lists absent ids", async () => {
    const have = blobId();
    await putBlob(srv, c, vid, have, sealed(100));
    const gone = blobId();
    const r = await api(srv, c, "POST", `/v1/vaults/${vid}/blobs/missing`, { ids: [have, gone, gone] });
    expect(r.status).toBe(200);
    expect(r.json.missing).toEqual([gone]);
  });

  it("pack-put stores and dedupes; pack-get returns request order, missing markers, maxBytes cut", async () => {
    const items = [sealed(1000), sealed(2000), sealed(3000)].map((bytes) => ({ id: blobId(), bytes }));
    const pack = encodePack(items);
    const put = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/pack-put`, {
      method: "POST", body: pack as Uint8Array<ArrayBuffer>, headers: { ...c.auth, "Content-Type": "application/x-shuttle-pack" },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ stored: 3, present: 0 });
    const put2 = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/pack-put`, { method: "POST", body: pack as Uint8Array<ArrayBuffer>, headers: c.auth });
    expect(await put2.json()).toEqual({ stored: 0, present: 3 });
    const absent = blobId();
    const get = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/pack-get`, {
      method: "POST", headers: { ...c.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [items[2]!.id, absent, items[0]!.id], maxBytes: 8 * 1024 * 1024 }),
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/x-shuttle-pack");
    const entries = decodePack(new Uint8Array(await get.arrayBuffer()), { allowMissing: true });
    expect(entries.map((e) => e.id)).toEqual([items[2]!.id, absent, items[0]!.id]);
    expect(sha256(entries[0]!.bytes!)).toBe(sha256(items[2]!.bytes));
    expect(entries[1]!.bytes).toBeNull();
    // maxBytes smaller than the first blob still returns it (at least one entry), then stops
    const cut = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/pack-get`, {
      method: "POST", headers: { ...c.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [items[1]!.id, items[0]!.id], maxBytes: 100 }),
    });
    const cutEntries = decodePack(new Uint8Array(await cut.arrayBuffer()), { allowMissing: true });
    expect(cutEntries.map((e) => e.id)).toEqual([items[1]!.id]);
  });

  it("pack-put with a truncated entry fails as a whole (422) and stores nothing", async () => {
    const items = [sealed(500), sealed(500)].map((bytes) => ({ id: blobId(), bytes }));
    const pack = encodePack(items);
    const bad = pack.slice(0, pack.length - 10);
    const r = await fetch(`${srv.url}/v1/vaults/${vid}/blobs/pack-put`, { method: "POST", body: bad as Uint8Array<ArrayBuffer>, headers: c.auth });
    expect(r.status).toBe(422);
    const m = await api(srv, c, "POST", `/v1/vaults/${vid}/blobs/missing`, { ids: items.map((i) => i.id) });
    expect(m.json.missing).toHaveLength(2);
    expect(srv.core.tmpEntries()).toEqual([]);
  });

  it("blobs are scoped per vault", async () => {
    const id = blobId();
    await putBlob(srv, c, vid, id, sealed(100));
    const { createVault } = await import("./helpers");
    const v2 = await createVault(srv, c, "second");
    const r = await fetch(`${srv.url}/v1/vaults/${v2}/blobs/${id}`, { headers: c.auth });
    expect(r.status).toBe(404);
  });
});
