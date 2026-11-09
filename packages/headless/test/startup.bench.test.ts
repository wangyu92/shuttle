// Daemon startup time on a populated vault (part 3 measurement; run with SHUTTLE_BENCH=1). A restart
// with 300 folders / 900 notes and 40 notes edited while stopped, state DB at synchronous=FULL, the
// watcher in inotify mode. Before the watcher moved ahead of the engine, its tree walk was starved by
// the engine's fsync'd startup commits and "started" came after ~30 s on the NAS; now ~1 s.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { converge, createTestVault, provisionNode, startNode, startWorld, stopNode, stopWorld } from "./e2eHarness";

const DIRS = Number(process.env["SHUTTLE_BENCH_DIRS"] ?? 300);

it.skipIf(process.env["SHUTTLE_BENCH"] !== "1")("restart of a populated vault reaches 'started' quickly", async () => {
  const w = await startWorld("bench");
  try {
    const v = await createTestVault(w, "bench");
    const a = await provisionNode(w, v, "bench-a", "bidirectional", { stateSynchronous: "normal" });
    await startNode(a);
    for (let i = 0; i < DIRS * 3; i++) {
      await mkdir(path.join(a.dirs.vault, `d${i % DIRS}`), { recursive: true });
      await writeFile(path.join(a.dirs.vault, `d${i % DIRS}/n${i}.md`), `n ${i}\n`);
    }
    await converge([a], 600_000);
    await stopNode(a);
    for (let i = 0; i < 40; i++) await writeFile(path.join(a.dirs.vault, `d${i % DIRS}/n${i}.md`), `changed ${i}\n`);
    a.config.stateSynchronous = "full";
    const t0 = performance.now();
    const d = await startNode(a, { inotifyProbe: { maxUserWatches: async () => 1_000_000, usedWatches: async () => 0 } });
    const ms = performance.now() - t0;
    const report = `startup ${Math.round(ms)} ms, phases ${JSON.stringify(d.startupPhases)}, watcher ${d.watcher.stats.mode}`;
    expect(d.watcher.stats.mode, report).toBe("hybrid");
    expect(ms, report).toBeLessThan(5000);
    await converge([a], 300_000);
    await stopNode(a);
  } finally {
    await stopWorld(w);
  }
}, 1_200_000);
