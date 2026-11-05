// Integration test for the P0 dev server stub: health, 4 MiB blob PUT/GET with hash check, WS hello → welcome.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_LIMITS, WS_PATH, WS_SUBPROTOCOL } from "@shuttle/protocol";
import type { WelcomeMsg } from "@shuttle/protocol";
import { startServer, type RunningServer } from "../src/server";

// Never os.tmpdir(): the system temp dir is RAM on the NAS (design §8.2).
const TEST_ROOT = process.env.SHUTTLE_TEST_TMP ?? path.join(os.homedir(), "tmp/claude/shuttle-test");
const VAULT_ID = randomBytes(16).toString("base64url");

let server: RunningServer;
let dataDir: string;

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  dataDir = await mkdtemp(path.join(TEST_ROOT, "server-"));
  server = await startServer({ host: "127.0.0.1", port: 0, dataDir, sourceUrl: "https://example.invalid/shuttle" });
});

afterAll(async () => {
  await server?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const blobUrl = (id: string) => `${server.url}/v1/vaults/${VAULT_ID}/blobs/${id}`;
function sealedLike(size: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set(randomBytes(size));
  b.set([0x53, 0x58, 0x42, 0x31, 1, 0]); // "SXB1", kv 1, flags 0
  return b;
}
const put = (id: string, body: Uint8Array<ArrayBuffer>, hash = sha256(body)) =>
  fetch(blobUrl(id), { method: "PUT", body, headers: { "Content-Type": "application/octet-stream", "X-Shuttle-Sha256": hash } });

describe("dev server stub", () => {
  it("GET /v1/health", async () => {
    const res = await fetch(`${server.url}/v1/health`, { headers: { "X-Shuttle-Request-Id": "r-1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-shuttle-server")).toBeTruthy();
    expect(res.headers.get("x-shuttle-request-id")).toBe("r-1");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, protocols: [1], source: "https://example.invalid/shuttle" });
    expect(typeof body.time).toBe("number");
  });

  it("PUT then GET a 4 MiB blob, hash preserved", async () => {
    const blob = sealedLike(4 * 1024 * 1024);
    const id = randomBytes(32).toString("hex");
    const r1 = await put(id, blob);
    expect(r1.status).toBe(201);
    const r2 = await put(id, blob);
    expect(r2.status).toBe(200);
    const head = await fetch(blobUrl(id), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(blob.length));
    const got = await fetch(blobUrl(id));
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe(`"${id}"`);
    expect(got.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(bytes.length).toBe(blob.length);
    expect(sha256(bytes)).toBe(sha256(blob));
    // Stored at vaults/<vid>/blobs/<aa>/<bb>/<blobId> (§2.8.2).
    const st = await stat(path.join(dataDir, "vaults", VAULT_ID, "blobs", id.slice(0, 2), id.slice(2, 4), id));
    expect(st.size).toBe(blob.length);
  });

  it("rejects bad hash, bad magic, bad id, oversize; 404 for a missing blob", async () => {
    const id = randomBytes(32).toString("hex");
    const blob = sealedLike(1000);
    const bad = await put(id, blob, "0".repeat(64));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("HASH_MISMATCH");
    const plain = new Uint8Array(1000);
    plain.set(randomBytes(1000));
    plain[0] = 0;
    const magic = await put(id, plain);
    expect(magic.status).toBe(422);
    expect((await magic.json()).error.code).toBe("BAD_BLOB");
    const badId = await put("ABC", blob);
    expect(badId.status).toBe(400);
    expect((await badId.json()).error.code).toBe("BAD_ID");
    const traversal = await fetch(`${server.url}/v1/vaults/${VAULT_ID}/blobs/..%2F..%2Fx`, { method: "GET" });
    expect(traversal.status).toBe(400);
    const badEscape = await fetch(`http://127.0.0.1:${server.port}/v1/vaults/%E0%A4%A/blobs/x`);
    expect(badEscape.status).toBe(400);
    expect((await badEscape.json()).error.code).toBe("BAD_ID");
    const big = await put(id, sealedLike(DEFAULT_LIMITS.maxBlobSize + 1));
    expect(big.status).toBe(413);
    const missing = await fetch(blobUrl(id));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });

  it("WebSocket hello → welcome, ping → pong, bye → 1000", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`, [WS_SUBPROTOCOL]);
    const frames: Record<string, unknown>[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => { frames.push(JSON.parse(String(d))); for (const w of waiters) w(); });
    const waitFor = (type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
      const check = () => {
        const f = frames.find((x) => x.type === type);
        if (f) { clearTimeout(t); resolve(f); }
      };
      waiters.push(check);
      check();
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    expect(ws.protocol).toBe(WS_SUBPROTOCOL);
    ws.send(JSON.stringify({
      type: "hello", rid: 1, proto: 1, token: "sxd_test", vaultId: VAULT_ID, since: null, epoch: 1,
      seenMaxSeq: null, rollbackAck: null, client: { name: "test", platform: "linux", version: "0.0.0", role: "headless" },
      window: { maxUnackedBytes: 8388608 },
    }));
    const welcome = (await waitFor("welcome")) as unknown as WelcomeMsg;
    expect(welcome).toMatchObject({ type: "welcome", rid: 1, proto: 1, epoch: 1, headSeq: 0, minSeq: 0 });
    expect(welcome.limits).toEqual(DEFAULT_LIMITS);
    ws.send(JSON.stringify({ type: "ping", ts: 5 }));
    expect(await waitFor("error")).toMatchObject({ code: "PROTOCOL", fatal: false });
    ws.send(JSON.stringify({ type: "ping", rid: 2, ts: 123 }));
    expect(await waitFor("pong")).toMatchObject({ rid: 2, ts: 123 });
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send(JSON.stringify({ type: "bye" }));
    expect(await closed).toBe(1000);
  });

  it("WebSocket without the subprotocol is closed 4400", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
    const code = await new Promise<number>((r, j) => { ws.once("close", (c) => r(c)); ws.once("error", j); });
    expect(code).toBe(4400);
  });
});
