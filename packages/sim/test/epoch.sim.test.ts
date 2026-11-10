// I28 epoch safety (S4; design §3.18, §2.11, §7.2): after a rebuild from a filtered device, no other
// device deletes a local file because it is absent from the new epoch.
import { describe, expect, it } from "vitest";
import { by, checkpoint, scripted, guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

describe("I28 rebuild from a filtered device", () => {
  it("files outside the rebuilder's scope survive and come back to the remote", async () => {
    const sim = await scripted(601, 3, {}, [{ settings: { excludedFolders: ["private"] } }]);
    const [a, b, c] = [by(sim, "alpha"), by(sim, "beta"), by(sim, "gamma")];
    await sim.userWrite(b, "private/secret.md", sim.noteOf(3));
    await sim.userWrite(b, "notes/shared.md", sim.noteOf(3));
    await sim.userWrite(c, "att/pic.png", sim.prng.bytes(20_000));
    await checkpoint(sim);
    expect(a.fs.exists("private/secret.md")).toBe(false);
    const before = sim.commits.length;
    await sim.evidence.capture(sim.w.server);
    await a.engine.rebuildRemote({ confirmFiltered: true });
    await checkpoint(sim);
    expect(sim.w.server.inspect().epoch).toBe(2);
    for (const d of [b, c]) expect(d.fs.exists("private/secret.md")).toBe(true);
    expect(sim.commits.slice(before).some((x) => x.kinds.includes("del"))).toBe(false);
  }, 60_000);
});
