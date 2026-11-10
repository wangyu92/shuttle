// Seeds that failed at P1 part 3 (git fb42bfa, default configuration), pinned after the part-4 fixes.
// Each runs the full default CLI configuration (3 devices, 500 steps, every fault).
//  - 2, 659: a rename made under one filter, then the filter flipped back (rescope never ran after a
//    restart; a strayed entry handed to the Planner and never pulled) (design §3.11, D6)
//  - 597: a planned pull that failed on the network left no queue row (never retried; §3.7 liveness)
//  - 899: an out-of-scope entry whose head a rebuild dropped kept a base for a missing head (§3.4 S8/C5)
//  - 592: KEEP_BOTH crashed between the rename and the pull (row P1)
//  - 730, 634: torn merge write + state store eviction lost the pre-merge edit (lead decision D8)
//  - 151, 200: a delete right after re-including a folder was pulled back by the rescope (ghost, I12)
//  - 725: a holder waiting for its own commit retry was re-planned every iteration (liveness)
//  - 249, 408: an unpushed in-scope change pushed after the folder came back (oracle, design line 1425
//    and I12 line 2036)
//  - 35: a crash between an integrity error and its scheduled resync (base without a head after a
//    tombstone was purged while the folder was excluded); 99: a rebuild whose answer and vault-info
//    re-read were both lost (own rebuild never adopted)
//  - 721: a binary LWW lost to the remote while offline; the staged archive died with an evicted store
//    (now a conflict copy offline, I6); 525: row P1 ADOPT of a holder that had moved on re-keyed the
//    entry and left the local file untracked
//  - 192: a remote move into an excluded folder onto a path a scan placeholder held (unique-path
//    violation on every restart)
//  - 978: failed only after other seeds in the same process (cross-seed leakage, §7.4); 610, 652, 864,
//    960, 109: no longer fail after the fixes above
import { describe, expect, it } from "vitest";
import { replayCommand, runSim } from "../src/index";
import { guardSim } from "./helpers";

const SEEDS = [2, 659, 597, 899, 592, 730, 634, 151, 200, 725, 249, 408, 978, 610, 652, 864, 960, 109, 35, 99, 721, 525, 192];

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim(...SEEDS);

describe("sim part-4 seeds", () => {
  it(`${SEEDS.length} seeds that failed at part 3 pass in the default configuration`, async () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const r = await runSim({ seed, devices: 3, steps: 500, checkEvery: 100, faults: true, excludedFolders: true, editWhileDown: true, settleRestart: false });
      if (!r.ok) bad.push(`${seed}: ${r.failures.slice(0, 2).map((f) => `${f.inv}@${f.step}: ${f.detail}`).join(" | ")}\n  replay: ${replayCommand(r, "")}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it("a seed replays bit for bit after other seeds ran in the same process (design §7.4)", async () => {
    const o = { devices: 3, steps: 300, checkEvery: 100, faults: true, excludedFolders: true, editWhileDown: true, settleRestart: false };
    const alone = await runSim({ seed: 978, ...o });
    await runSim({ seed: 976, ...o });
    await runSim({ seed: 977, ...o });
    const after = await runSim({ seed: 978, ...o });
    expect(after.traceHash).toBe(alone.traceHash);
  }, 600_000);
});
