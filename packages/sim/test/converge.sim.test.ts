// I7 convergence (design §3.18, §7.2): after quiescence every device's active path→hash map is
// identical and equals the in-scope remote heads. No-fault seeds, plus a check that the oracle sees
// a device that never syncs.
import { describe, expect, it } from "vitest";
import { runSim } from "../src/index";
import { by, scripted, guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

describe("I7 convergence", () => {
  it("no-fault random runs on 2 to 4 devices converge at every checkpoint", async () => {
    for (const [seed, devices] of [[21, 2], [22, 3], [23, 4]] as const) {
      const r = await runSim({ seed, devices, steps: 90, checkEvery: 30, faults: false, excludedFolders: false });
      expect(r.failures).toEqual([]);
    }
  }, 120_000);

  it("the oracle reports a device that stopped syncing", async () => {
    const sim = await scripted(902, 2);
    const a = by(sim, "alpha");
    a.engine.pause();
    await sim.userWrite(a, "only-here.md", sim.noteOf(1));
    sim.step++;
    await sim.checkpoint();
    expect(sim.failures.some((f) => f.inv === "I7" || f.inv === "liveness")).toBe(true);
  }, 60_000);
});
