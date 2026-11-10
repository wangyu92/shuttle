// Per-apply cost of the headless mirror (part 5 measurement; run with SHUTTLE_BENCH=1). Lead decision
// D10: NodeLocalFs.write() is already temp + fsync + rename + directory fsync, so the engine's own D8
// temp hop (a second rename and directory fsync) is skipped when `atomicReplace` is declared. Budget
// applyConcurrency (node 4) overlaps applies of distinct files.
//  (1) replaceFile over 50 existing files, D8 path vs D10 path;
//  (2) a fresh headless device joining and pulling 50 notes: D8 sequential, D10 sequential, D10 x4.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceFile } from "@shuttle/engine";
import { NodeLocalFs } from "../src/NodeLocalFs";
import { converge, createTestVault, provisionNode, startNode, startWorld, stopNode, stopWorld } from "./e2eHarness";
import { TEST_ROOT, removeDir, tempDir } from "./tmp";

/** Results also go to a file: vitest may not show console output of passing tests. */
const report = (line: string) => appendFile(path.join(TEST_ROOT, "apply-bench.txt"), `${new Date().toISOString()} ${line}\n`);

const N = Number(process.env["SHUTTLE_BENCH_FILES"] ?? 50);
const bench = process.env["SHUTTLE_BENCH"] !== "1";
const te = new TextEncoder();
const body = (i: number, v: string) => te.encode(`# note ${i}\n\n${v} `.padEnd(2048, "x") + "\n");

it.skipIf(bench)("replaceFile per-op cost: D8 temp hop vs D10 atomic write", async () => {
  const dir = await tempDir("bench-replace");
  try {
    const out: string[] = [];
    for (const atomicReplace of [false, true]) {
      const root = path.join(dir, `vault-${atomicReplace}`);
      const tmp = path.join(dir, `tmp-${atomicReplace}`);
      await mkdir(root, { recursive: true });
      await mkdir(tmp, { recursive: true });
      for (let i = 0; i < N; i++) await writeFile(path.join(root, `n${i}.md`), body(i, "old"));
      const fs = new NodeLocalFs({ root, tmpDir: tmp, atomicReplace });
      const t0 = performance.now();
      for (let i = 0; i < N; i++) await replaceFile(fs, `n${i}.md`, body(i, "new"), { mtime: Date.now() });
      const per = (performance.now() - t0) / N;
      out.push(`${atomicReplace ? "D10 atomic write" : "D8 temp + rename"}: ${per.toFixed(1)} ms/op`);
    }
    await report(`replaceFile x${N}: ${out.join("; ")}`);
    expect(out.length).toBe(2);
  } finally {
    await removeDir(dir);
  }
}, 600_000);

it.skipIf(bench)("headless join pulling 50 notes: D8, D10, D10 + applyConcurrency 4", async () => {
  const w = await startWorld("bench-apply");
  try {
    const v = await createTestVault(w, "bench-apply");
    const a = await provisionNode(w, v, "bench-src", "bidirectional", { stateSynchronous: "normal" });
    await startNode(a);
    for (let i = 0; i < N; i++) await writeFile(path.join(a.dirs.vault, `n${i}.md`), body(i, "v1"));
    await converge([a], 600_000);
    const out: string[] = [];
    const runs = [
      { name: "D8 sequential", atomicReplace: false, applyConcurrency: 1 },
      { name: "D10 sequential", atomicReplace: true, applyConcurrency: 1 },
      { name: "D10 x4", atomicReplace: true, applyConcurrency: 4 },
    ];
    for (const [k, r] of runs.entries()) {
      const b = await provisionNode(w, v, `bench-dst${k}`, "bidirectional", { stateSynchronous: "normal" });
      const t0 = performance.now();
      await startNode(b, { atomicReplace: r.atomicReplace, budgets: { applyConcurrency: r.applyConcurrency } });
      await converge([a, b], 600_000);
      const ms = performance.now() - t0;
      out.push(`${r.name}: ${Math.round(ms)} ms total, ${(ms / N).toFixed(0)} ms/file`);
      await stopNode(b);
    }
    await stopNode(a);
    await report(`join + pull ${N} notes: ${out.join("; ")}`);
    expect(out.length).toBe(3);
  } finally {
    await stopWorld(w);
  }
}, 1_800_000);
