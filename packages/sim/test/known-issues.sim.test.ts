// Open engine findings from the simulator, pinned as scripted scenarios. Each test asserts the
// CURRENT wrong outcome (the oracle that fires), so it fails once the engine is fixed: then flip it to
// expect no failures and widen the random CI set in sim.ci.test.ts (editWhileDown / excludedFolders).
import { describe, expect, it } from "vitest";
import { noteBytes, noteLines } from "../src/index";
import { by, checkpoint, scripted, text } from "./helpers";
import type { Sim } from "../src/index";

/** Quiesce and run the oracles without failing the test; the invariant ids that fired. */
async function oracles(sim: Sim): Promise<string[]> {
  sim.step++;
  await sim.checkpoint();
  return [...new Set(sim.failures.map((f) => f.inv))];
}

describe("open findings", () => {
  // Finding A (I6 via I30 recovery, design §3.8.4): a pull is torn by a crash; before the engine
  // re-applies it, the user edits the file (another editor while the app is down, or right after
  // launch while catch-up runs). WriteIntents.check() calls any hash other than pre/target "torn",
  // so the re-apply overwrites the user's edit with the remote head and nothing keeps the edit.
  it("A (open): a user edit made after a torn pull is overwritten by the torn re-apply", async () => {
    const sim = await scripted(1001, 2);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(a, "n.md", sim.noteOf(4));
    await checkpoint(sim);
    await sim.userWrite(a, "n.md", sim.noteOf(40));
    await a.iterate();
    b.armTornWrite(0.5);
    await b.iterate();
    expect(b.dead).toBe(true);
    const torn = b.fs.files().get("n.md")!;
    const lines = noteLines(torn);
    const mine = sim.ledger.token();
    lines.push(mine);
    await sim.userWrite(b, "n.md", noteBytes(lines));
    await sim.restartDev(b);
    expect(await oracles(sim)).toEqual(["I6"]);
    // The re-apply wrote the remote head over the user's file; the edit is nowhere.
    expect(b.fs.readText("n.md")).toBe(a.fs.readText("n.md"));
    expect(b.fs.readText("n.md")).not.toContain(mine);
  }, 60_000);

  // Finding B (I7, design §3.4 C7 / §3.11 scope gate): a remote move into a folder the receiver
  // excludes leaves the receiver with the old path forever: it neither renames the file into the
  // excluded folder nor treats it as gone, so its active map keeps a path no remote head has. The
  // design states the sender side (§3.6 "into an excluded folder") but not the receiver; any rule
  // must keep the receiver's local edits (I6).
  it("B (open): a remote move into a folder this device excludes never converges", async () => {
    const sim = await scripted(1002, 2, {}, [{ settings: { excludedFolders: ["private"] } }]);
    const [, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(b, "a.md", text("moving\n"));
    await checkpoint(sim);
    sim.userRename(b, "a.md", "private/a.md");
    expect(await oracles(sim)).toEqual(["I7"]);
    expect(by(sim, "alpha").fs.exists("a.md")).toBe(true);
  }, 60_000);
});
