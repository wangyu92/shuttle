// Benchmarks (design §9 exit criteria, 10k-head snapshot < 2 s). The commit criterion is restated by
// lead decision D7 (durability wins: acks stay after fsync, so the disk's fsync time is the ceiling):
//   (a) steady state, single-op commits, 3 devices x 4 in flight: >= 40 commits/s on the NAS;
//   (b) initial seed of 10k files from one device with multi-op commits (engine batch sizes, 4 in flight,
//       default per-device rate limit): commit phase < 60 s (blob upload excluded: inline ops);
//   (c) 16 devices x 4 in flight: reported only.
// Skipped unless SHUTTLE_BENCH=1:  SHUTTLE_BENCH=1 npx vitest run --project @shuttle/server bench
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommitOp, CommitResultMsg } from "@shuttle/protocol";
import { DEFAULT_RATES } from "../src/config";
import type { RunningServer } from "../src/server";
import { TestWs, api, cid, fileId, fixture, login, pathKey, putOp, removeDir, start, tempDir, type Client } from "./helpers";

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

  it("D7 (a) 3x4 single-op commits >= 40/s; (c) 16x4 reported", async () => {
    const r1 = await commitRate(1, 1, 100);
    const r3 = await commitRate(3, 4, 2000);
    const r16 = await commitRate(16, 4, 3000);
    console.log(`bench: single-op commits/s  1x1 ${r1.toFixed(1)}  (a) 3x4 ${r3.toFixed(0)}  (c) 16x4 ${r16.toFixed(0)}  (devices x in flight)`);
    expect(r3).toBeGreaterThanOrEqual(40);
  }, 300_000);

  /**
   * One device seeds `files` creates in commits of `batch` ops with `inFlight` unanswered, against a
   * server with the default per-device rate limit (RATE_LIMITED is retried after retryAfterMs, as the
   * engine does). Returns the wall time of the commit phase in ms.
   */
  async function seed(files: number, batch: number, inFlight: number): Promise<number> {
    const sdir = await tempDir("bench-seed");
    const s = await start(sdir, { rates: { ...DEFAULT_RATES } });
    try {
      const { c: owner, vid: v } = await fixture(s, sdir);
      const w = await TestWs.open(s);
      await w.connect(owner.token, v);
      const batches: CommitOp[][] = [];
      for (let i = 0; i < files; i += batch) {
        batches.push(Array.from({ length: Math.min(batch, files - i) }, () => putOp(fileId(), null, pathKey())));
      }
      let next = 0, limited = 0;
      const t0 = performance.now();
      await Promise.all(Array.from({ length: inFlight }, async () => {
        while (next < batches.length) {
          const ops = batches[next++]!;
          const id = cid();
          for (;;) {
            const rid = w.nextRid();
            w.send({ type: "commit", rid, cid: id, ops });
            const f = await w.take((x) => x.rid === rid, 60_000);
            w.frames = w.frames.filter((x) => x.type !== "changes");
            if (f.type === "commitResult") {
              if (!(f as unknown as CommitResultMsg).results.every((r) => r.ok)) throw new Error("seed commit failed");
              break;
            }
            if (f.type === "error" && f.code === "RATE_LIMITED") {
              limited++;
              await new Promise((r) => setTimeout(r, Number(f.retryAfterMs ?? 50)));
              continue;
            }
            throw new Error(`seed commit answered with ${JSON.stringify(f)}`);
          }
        }
      }));
      const ms = performance.now() - t0;
      expect(s.core.store.vault(v)!.head_seq).toBe(files);
      console.log(`bench: seed ${files} files, ${batch} ops/commit x ${inFlight} in flight: ${(ms / 1000).toFixed(1)} s `
        + `(${batches.length} commits, ${(files / (ms / 1000)).toFixed(0)} files/s, ${limited} RATE_LIMITED retries)`);
      w.close();
      return ms;
    } finally {
      await s.close();
      await removeDir(sdir);
    }
  }

  it("D7 (b) initial seed of 10k files from one device: commit phase < 60 s", async () => {
    const desktop = await seed(10_000, 50, 4); // engine desktop budget: commitBatchOps 50
    const mobile = await seed(10_000, 20, 4);  // engine mobile budget: commitBatchOps 20 (reported)
    console.log(`bench: (b) seed 10k  desktop ${(desktop / 1000).toFixed(1)} s  mobile ${(mobile / 1000).toFixed(1)} s`);
    expect(desktop).toBeLessThan(60_000);
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
