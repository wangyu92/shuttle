// Benchmarks (design §9 exit criteria: ≥ 200 single-op commits/s on the NAS; 10k-head snapshot < 2 s).
// Skipped unless SHUTTLE_BENCH=1:  SHUTTLE_BENCH=1 npx vitest run --project @shuttle/server bench
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server";
import { TestWs, api, fileId, fixture, login, pathKey, putOp, removeDir, start, tempDir, type Client } from "./helpers";

const ENABLED = process.env.SHUTTLE_BENCH === "1";

describe.runIf(ENABLED)("bench", () => {
  let srv: RunningServer;
  let dir: string;
  let c: Client;
  let vid: string;

  beforeAll(async () => {
    dir = await tempDir("bench");
    srv = await start(dir);
    ({ c, vid } = await fixture(srv, dir));
  });

  afterAll(async () => {
    await srv?.close();
    await removeDir(dir);
  });

  it("single-op commits per second: 16 devices x 4 in flight (group commit), and one sequential client", async () => {
    const devices = 16, inFlight = 4, total = 3000;
    const sockets: TestWs[] = [];
    for (let d = 0; d < devices; d++) {
      const dev = await login(srv, "alice", `bench-${d}`);
      const w = await TestWs.open(srv);
      await w.connect(dev.token, vid);
      sockets.push(w);
    }
    let left = total;
    const t0 = performance.now();
    await Promise.all(sockets.flatMap((w) => Array.from({ length: inFlight }, async () => {
      while (left > 0) {
        left--;
        const r = await w.commit([putOp(fileId(), null, pathKey())]);
        if (!r.results[0]!.ok) throw new Error("commit failed");
      }
    })));
    const rate = total / ((performance.now() - t0) / 1000);
    for (const w of sockets) w.close();
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    const n = 50;
    const t1 = performance.now();
    for (let i = 0; i < n; i++) await ws.commit([putOp(fileId(), null, pathKey())]);
    const seq = n / ((performance.now() - t1) / 1000);
    ws.close();
    console.log(`bench: ${rate.toFixed(0)} single-op commits/s (${devices} devices x ${inFlight} in flight); sequential ${seq.toFixed(1)}/s (one fsync each)`);
    expect(rate).toBeGreaterThanOrEqual(200);
  }, 300_000);

  it("snapshot of 10k heads", async () => {
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    for (let i = 0; i < 20; i++) await ws.commit(Array.from({ length: 500 }, () => putOp(fileId(), null, pathKey())));
    ws.close();
    const t0 = performance.now();
    let after: string | null = null;
    let count = 0;
    do {
      const page: { json: { records: unknown[]; next: string | null } } = await api(srv, c, "GET", `/v1/vaults/${vid}/snapshot?limit=5000${after ? `&after=${after}` : ""}`);
      count += page.json.records.length;
      after = page.json.next;
    } while (after);
    const ms = performance.now() - t0;
    console.log(`bench: snapshot of ${count} heads in ${ms.toFixed(0)} ms`);
    expect(count).toBeGreaterThanOrEqual(10_000);
    expect(ms).toBeLessThan(2000);
  }, 120_000);
});

describe.skipIf(ENABLED)("bench (disabled)", () => {
  it.skip("set SHUTTLE_BENCH=1 to run the server benchmarks", () => {});
});
