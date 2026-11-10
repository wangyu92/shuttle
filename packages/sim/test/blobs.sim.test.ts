// I5 blobs before meta (design §3.18, §7.2): no committed record references a blob the server does
// not hold. SimNet checks every successful op right after the commit; heavy network faults (lost
// responses, duplicates, 5xx) make the blob/commit ordering interesting.
import { describe, expect, it } from "vitest";
import { runSim } from "../src/index";
import { guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim(11, 12, 13);

describe("I5 blobs before meta", () => {
  it("binary-heavy runs under heavy network faults", async () => {
    let faults = 0;
    for (const seed of [11, 12, 13]) {
      const r = await runSim({
        seed, devices: 3, steps: 80, checkEvery: 40, editWhileDown: false, settleRestart: true, excludedFolders: false,
        weights: { writeBinary: 25, netFaults: 12, oversize: 2, crash: 1, commitCrash: 1, tornWrite: 0 },
      });
      expect(r.failures.filter((f) => f.inv === "I5")).toEqual([]);
      expect(r.failures).toEqual([]);
      faults += r.stats.netFaults;
    }
    expect(faults).toBeGreaterThan(0);
  }, 120_000);
});
