// Bounded concurrent pull applies (budget applyConcurrency, part 5; 클로드 제안(미승인)). Ingest persists
// the cursor with the heads and queue rows (design §3.8.1, invariant 9), so only the BatchOrderer's
// order (§3.8.2: frees before needs) and the per-file locks have to hold while applies overlap.
import { describe, expect, it } from "vitest";
import type { MemReplaceMode } from "@shuttle/testkit";
import { Node, makeWorld, syncAll } from "./engineHarness";

const td = new TextDecoder();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function pair(seed: string, width: number, replace: MemReplaceMode = "atomic") {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  const b = new Node(w, { name: "beta", platform: "node", replace, opts: { budgets: { applyConcurrency: width } } });
  await a.start(); await b.start();
  await syncAll([a, b]);
  return { w, a, b };
}

/** Peak number of writes waiting at once on `n` (each write yields one macrotask first). */
function measureOverlap(n: Node): { peak: () => number } {
  let active = 0;
  let peak = 0;
  n.fs.before(async (op) => {
    if (op !== "write") return;
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
  });
  return { peak: () => peak };
}

const files = (n: Node) => Object.fromEntries([...n.fs.files()].map(([k, v]) => [k, td.decode(v)]));

describe("apply concurrency", () => {
  it("the node budget is 4, desktop and mobile stay sequential", async () => {
    const { PLATFORM_BUDGETS } = await import("../src/index");
    expect(PLATFORM_BUDGETS.node.applyConcurrency).toBe(4);
    expect(PLATFORM_BUDGETS.desktop.applyConcurrency).toBe(1);
    expect(PLATFORM_BUDGETS.mobile.applyConcurrency).toBe(1);
  });

  for (const width of [1, 4]) {
    it(`width ${width}: 40 new files arrive, at most ${width} writes overlap, cursor and state converge`, async () => {
      const { w, a, b } = await pair(`conc-new-${width}`, width);
      const o = measureOverlap(b);
      for (let i = 0; i < 40; i++) a.fs.external.write(`n/${i % 5}/f${i}.md`, `note ${i}\n`, { mtime: w.clock.now() });
      a.engine.requestScan();
      await syncAll([a, b], 80);
      expect(files(b)).toEqual(files(a));
      expect(Object.keys(files(b)).length).toBe(40);
      if (width === 1) expect(o.peak()).toBe(1);
      else {
        expect(o.peak()).toBeGreaterThan(1);
        expect(o.peak()).toBeLessThanOrEqual(width);
      }
      expect(b.engine.status().pendingDown).toBe(0);
      // Every file is synced at its head and the queue is empty: nothing left for a restart to redo.
      await b.restart();
      await syncAll([a, b], 40);
      expect(files(b)).toEqual(files(a));
    });
  }

  for (const replace of ["atomic", "swap", "rename"] as const) {
    it(`frees before needs under concurrency (${replace}): move away + create in the freed path, delete the last file of a folder + create there`, async () => {
      const { w, a, b } = await pair(`conc-order-${replace}`, 4, replace);
      for (let i = 0; i < 12; i++) a.fs.external.write(`x/f${i}.md`, `x ${i}\n`, { mtime: w.clock.now() });
      a.fs.external.write("p.md", "moving file\n", { mtime: w.clock.now() });
      a.fs.external.write("gone/last.md", "last\n", { mtime: w.clock.now() });
      a.engine.requestScan();
      await syncAll([a, b], 80);
      expect(files(b)).toEqual(files(a));
      w.clock.tick(1000);
      // Alpha pushes the move first and the new file in the freed path second; beta gets both at once.
      a.fs.external.rename("p.md", "q.md");
      a.engine.requestScan();
      await syncAll([a], 40);
      w.clock.tick(1000);
      a.fs.external.write("p.md", "new file in the freed path\n", { mtime: w.clock.now() });
      a.fs.external.remove("gone/last.md");
      a.fs.external.write("gone/fresh.md", "fresh\n", { mtime: w.clock.now() });
      for (let i = 0; i < 12; i++) a.fs.external.write(`x/f${i}.md`, `x ${i} edited\n`, { mtime: w.clock.now() });
      a.engine.requestScan();
      await syncAll([a], 40);
      const o = measureOverlap(b);
      await syncAll([a, b], 80);
      expect(files(b)).toEqual(files(a));
      expect(files(b)["q.md"], JSON.stringify(files(b))).toBe("moving file\n");
      expect(files(b)["p.md"]).toBe("new file in the freed path\n");
      expect(files(b)["gone/fresh.md"]).toBe("fresh\n");
      expect(o.peak()).toBeGreaterThan(1);
      // No conflict copies: the ordering held (a needs-item never saw the path still occupied).
      expect(Object.keys(files(b)).some((p) => p.includes("Conflicted copy"))).toBe(false);
    });
  }

  it("a failing apply in the window does not stop the others; it stays queued and succeeds later", async () => {
    const { w, a, b } = await pair("conc-fail", 4);
    for (let i = 0; i < 10; i++) a.fs.external.write(`f${i}.md`, `v ${i}\n`, { mtime: w.clock.now() });
    a.engine.requestScan();
    await syncAll([a], 40);
    b.fs.failNext("write", "ENOSPC", { path: "f3.md" });
    await syncAll([a, b], 80);
    expect(files(b)).toEqual(files(a));
  });
});
