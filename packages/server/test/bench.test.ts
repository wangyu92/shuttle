// Benchmarks (design §9 exit criteria: ≥ 200 single-op commits/s on the NAS; 10k-head snapshot < 2 s).
// Lead decision D3: the 200/s target is measured at 3 devices x 4 commits in flight.
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

  /** Single-op commits/s with `devices` sockets, each keeping `inFlight` commits unanswered (group commit). */
  async function commitRate(devices: number, inFlight: number, total: number): Promise<number> {
    const sockets: TestWs[] = [];
    for (let d = 0; d < devices; d++) {
      const dev = await login(srv, "alice", `bench-${devices}x${inFlight}-${d}`);
      const w = await TestWs.open(srv);
      await w.connect(dev.token, vid, { since: srv.core.store.vault(vid)!.head_seq });
      sockets.push(w);
    }
    // Instrumentation: groups (BEGIN IMMEDIATE count) and wall time inside COMMIT (the fsync).
    const db = srv.core.db as unknown as { exec: (sql: string) => void };
    const exec = db.exec;
    let groups = 0, commitMs = 0;
    db.exec = (sql: string) => {
      if (sql === "BEGIN IMMEDIATE") groups++;
      if (sql !== "COMMIT") return exec.call(srv.core.db, sql);
      const t = performance.now();
      try { return exec.call(srv.core.db, sql); } finally { commitMs += performance.now() - t; }
    };
    let left = total;
    const t0 = performance.now();
    await Promise.all(sockets.flatMap((w) => Array.from({ length: inFlight }, async () => {
      while (left > 0) {
        left--;
        const r = await w.commit([putOp(fileId(), null, pathKey())]);
        if (!r.results[0]!.ok) throw new Error("commit failed");
        w.frames = w.frames.filter((f) => f.type !== "changes"); // live fan-out is not under test
      }
    })));
    const rate = total / ((performance.now() - t0) / 1000);
    db.exec = exec;
    console.log(`bench: ${devices}x${inFlight}: ${rate.toFixed(1)}/s, ${groups} groups, ${(total / groups).toFixed(1)} commits/group, avg COMMIT ${(commitMs / groups).toFixed(1)} ms`);
    for (const w of sockets) w.close();
    return rate;
  }

  it("single-op commits per second: 1x1, 3x4 (target >= 200/s, D3) and 16x4", async () => {
    const r1 = await commitRate(1, 1, 100);
    const r3 = await commitRate(3, 4, 2000);
    const r16 = await commitRate(16, 4, 3000);
    console.log(`bench: single-op commits/s  1x1 ${r1.toFixed(1)}  3x4 ${r3.toFixed(0)}  16x4 ${r16.toFixed(0)}  (devices x in flight)`);
    expect(r3).toBeGreaterThanOrEqual(200);
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
