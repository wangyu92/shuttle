// I23 fast path (design §3.18, §7.2): a startup scan of 10k unchanged files performs 0 reads and 0
// hashes, and yields to the UI between batches so no synchronous slice runs long (FakeScheduler).

import { describe, expect, it } from "vitest";
import type { FileEntry } from "@shuttle/protocol";
import { foldKey } from "../src/index";
import { Node, makeWorld } from "./engineHarness";

const N = 10_000;

describe("I23 fast path", () => {
  it("10k unchanged files: 0 reads, 0 hashes, bounded slices", async () => {
    const w = await makeWorld("perf");
    const a = new Node(w, { name: "alpha" });
    const mtime = 1_700_000_000_000;
    const files: Record<string, string> = {};
    for (let i = 0; i < N; i++) files[`d${i % 50}/f${i}.md`] = `n${i}`;
    a.fs.seed(files, { mtime });
    // Index rows of a device that synced these files before. Written straight into the fake's storage:
    // MemStateStore checks unique indexes by scanning, which is quadratic at 10k puts (testkit note).
    const rows = a.store.data.stores.get("files")!;
    let i = 0;
    for (const [path, body] of Object.entries(files)) {
      const fileId = (i++).toString(16).padStart(32, "0");
      const h = "h".repeat(64);
      const e: FileEntry = {
        fileId, path, foldKey: foldKey(path), scope: "active", kind: "note",
        obs: { mtime, size: body.length, hash: h }, synced: { version: i, path, hash: h, size: body.length, mtime, hasBase: false },
        updatedAt: mtime,
      };
      rows.set(`s:${fileId}`, { key: fileId, value: e as unknown as Record<string, unknown> });
    }
    let hashes = 0;
    const slices: number[] = [];
    let last = 0;
    const realYield = a.scheduler.yieldToUi.bind(a.scheduler);
    a.scheduler.yieldToUi = async () => {
      const t = performance.now();
      if (last > 0) slices.push(t - last);
      await realYield();
      last = performance.now();
    };
    await a.start();
    const origAcquire = a.engine.budget.acquireHash.bind(a.engine.budget);
    a.engine.budget.acquireHash = async (n: number) => { hashes++; return origAcquire(n); };
    a.fsOps.length = 0;
    a.engine.requestScan("fast");
    last = performance.now();
    await a.engine.runOnce();
    expect(a.ops("read")).toEqual([]);
    expect(hashes).toBe(0);
    expect(a.engine.dirty.size).toBe(0);
    expect(a.scheduler.stats.yields).toBeGreaterThanOrEqual(N / 500);
    // The first slice includes MemLocalFs building and sorting its 10k-entry listing (platform cost:
    // Obsidian lists from its in-memory vault tree); every engine slice after it stays under 50 ms.
    const worst = Math.max(...slices.slice(1));
    expect(worst).toBeLessThan(50);
  }, 60_000);
});
