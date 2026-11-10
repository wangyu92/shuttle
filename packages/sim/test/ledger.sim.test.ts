// I6 content ledger (design §3.18, §7.4): every user-produced content survives somewhere. Also checks
// that the oracle itself catches a loss.
import { describe, expect, it } from "vitest";
import { noteBytes, noteLines } from "../src/index";
import { by, checkpoint, scripted, guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

describe("I6 ledger", () => {
  it("concurrent edits on three devices keep every token (merge or conflict copy)", async () => {
    const sim = await scripted(801);
    const [a, b, c] = [by(sim, "alpha"), by(sim, "beta"), by(sim, "gamma")];
    await sim.userWrite(a, "n.md", sim.noteOf(6));
    await sim.userWrite(a, "bin.png", sim.prng.bytes(9000));
    await checkpoint(sim);
    for (const d of [a, b, c]) {
      const lines = noteLines(d.fs.files().get("n.md")!);
      lines.splice(sim.prng.int(lines.length + 1), 0, sim.ledger.token());
      await sim.userWrite(d, "n.md", noteBytes(lines));
      await sim.userWrite(d, "bin.png", sim.prng.bytes(9000));
    }
    await checkpoint(sim);
    expect(sim.ledger.live().length).toBeGreaterThan(9);
  }, 60_000);

  it("the oracle reports a token destroyed behind its back", async () => {
    const sim = await scripted(802, 2);
    const a = by(sim, "alpha");
    await sim.userWrite(a, "n.md", sim.noteOf(2));
    await checkpoint(sim);
    await sim.userWrite(a, "n.md", sim.noteOf(2));
    // Simulated engine bug: the file is reverted without the ledger knowing, before any sync.
    a.fs.external.write("n.md", new TextEncoder().encode("reverted\n"));
    sim.step++;
    await sim.checkpoint();
    expect(sim.failures.map((f) => f.inv)).toContain("I6");
  }, 60_000);
});
