// The random simulation in the vitest set (design §7.4 "Runs"; CI runs more seeds through the CLI).
// Configuration --ci: faults on, user edits only on running devices, restarts finish catch-up first,
// no excluded folders. Those three switches keep two open engine findings out of the random set;
// both are pinned by scripted tests in known-issues.sim.test.ts.
import { describe, expect, it } from "vitest";
import { replayCommand, runSim, type SimOptions } from "../src/index";

const CI: Omit<SimOptions, 'seed'> = { devices: 3, steps: 100, checkEvery: 50, editWhileDown: false, settleRestart: true, excludedFolders: false };

describe("random multi-device simulation", () => {
  it("20 seeds x 3 devices x 100 steps: every oracle holds", async () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const r = await runSim({ seed, ...CI });
      if (!r.ok) bad.push(`${r.failures.map((f) => `${f.inv}@${f.step}: ${f.detail}`).join(" | ")}\n  replay: ${replayCommand(r, " --ci --check-every 50")}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it("a seed replays bit for bit (same trace, commits and server log)", async () => {
    const a = await runSim({ seed: 7, ...CI, devices: 2, steps: 60 });
    const b = await runSim({ seed: 7, ...CI, devices: 2, steps: 60 });
    const c = await runSim({ seed: 8, ...CI, devices: 2, steps: 60 });
    expect(a.stats.commits).toBeGreaterThan(0);
    expect(b.traceHash).toBe(a.traceHash);
    expect(b.stats).toEqual(a.stats);
    expect(c.traceHash).not.toBe(a.traceHash);
  }, 120_000);

  it("full fault set incl. excluded folders runs without harness errors (findings are reported, not thrown)", async () => {
    const r = await runSim({ seed: 3, devices: 3, steps: 60, checkEvery: 30 });
    expect(r.failures.filter((f) => f.inv === "crash" || f.inv === "unhandled")).toEqual([]);
  }, 120_000);
});
