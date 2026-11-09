// Seeds the P1 sim gate (1000 seeds, default configuration) found failing, pinned after their fixes.
// Each runs the full default CLI configuration (3 devices, 500 steps, every fault).
//  A  torn D1 merge write: staged merge op replaced, cancelled or dropped on CONFLICT (I6)
//  B  delete on a device that had not caught up with a remote rebuild (oracle, design §2.11 step 5)
//  C  torn pull write followed by a crash; the completed write taken for a local edit (ghost)
//  E  rebuild whose response was lost after the server switched epochs (I7, I1)
//  I  character-level 3-way merge splicing two edits of one line (I6)
//  plus D, F, G, H seeds that no longer fail after the fixes above.
import { describe, expect, it } from "vitest";
import { replayCommand, runSim } from "../src/index";

const SEEDS = [
  127, 186, 328, 373, 467, 503, 574, 611, 624, 683, 691, 717, 726, 859, 993, // A
  95, 215, 220, 330, 499, 697, 735, 778, 812, 822, 979, 984,                  // B
  298, 301, 736,                                                                // C
  153, 310, 123, 930,                                                           // D
  983,                                                                          // E
  565, 794,                                                                     // F
  368,                                                                          // G
  893, 854,                                                                     // H
  163,                                                                          // I
  1004, 1093,                                                                   // fresh-seed ghosts (eviction catch-up)
];

describe("sim gate seeds (P1 part 4)", () => {
  it(`${SEEDS.length} former failing seeds pass in the default configuration`, async () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const r = await runSim({ seed, devices: 3, steps: 500, checkEvery: 100, faults: true, excludedFolders: true, editWhileDown: true, settleRestart: false });
      if (!r.ok) bad.push(`${seed}: ${r.failures.slice(0, 2).map((f) => `${f.inv}@${f.step}: ${f.detail}`).join(" | ")}\n  replay: ${replayCommand(r, "")}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
