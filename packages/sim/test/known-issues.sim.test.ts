// Former engine findings from the simulator, kept as scripted regression scenarios. Each test asserts
// the CORRECT outcome now that the engine is fixed (lead decisions D5 and D6, 클로드 제안(미승인)).
import { describe, expect, it } from "vitest";
import { noteBytes, noteLines } from "../src/index";
import { by, checkpoint, scripted, text, guardSim } from "./helpers";
import type { Sim } from "../src/index";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

/** Quiesce and run the oracles without failing the test; the invariant ids that fired. */
async function oracles(sim: Sim): Promise<string[]> {
  sim.step++;
  await sim.checkpoint();
  return [...new Set(sim.failures.map((f) => f.inv))];
}

describe("fixed findings (regression)", () => {
  // Finding A (I6 via I30 recovery, design §3.8.4, D5): a pull is torn by a crash; before the engine
  // re-applies it, the user edits the file (another editor while the app is down, or right after
  // launch while catch-up runs). Content that is not a strict prefix of the target is the user's edit
  // against the base: it is planned as a local change (merge or conflict copy), never overwritten.
  it("A: a user edit made after a torn pull survives the restart (merge or conflict copy)", async () => {
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
    expect(await oracles(sim)).toEqual([]);
    // The edit reached the remote (merged into n.md or kept in a conflict copy) and every device.
    const holders = [...a.fs.files().entries()].filter(([, bytes]) => noteLines(bytes).includes(mine)).map(([p]) => p);
    expect(holders.length).toBeGreaterThan(0);
    expect(b.fs.readText("n.md")).toBe(a.fs.readText("n.md"));
  }, 60_000);

  // A torn pull with no user edit after it is still rewritten from the remote head (I30 unchanged).
  it("A': a torn pull without a user edit is repaired from the remote head, never pushed", async () => {
    const sim = await scripted(1003, 2);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(a, "n.md", sim.noteOf(4));
    await checkpoint(sim);
    await sim.userWrite(a, "n.md", sim.noteOf(40));
    await a.iterate();
    const commitsBefore = sim.commits.filter((c) => c.device === "beta").length;
    b.armTornWrite(0.5);
    await b.iterate();
    expect(b.dead).toBe(true);
    await sim.restartDev(b);
    expect(await oracles(sim)).toEqual([]);
    expect(b.fs.readText("n.md")).toBe(a.fs.readText("n.md"));
    expect(sim.commits.filter((c) => c.device === "beta").length).toBe(commitsBefore);
  }, 60_000);

  // Finding B (I7, design §3.4 C7 / §3.11 scope gate, D6): a remote move into a folder the receiver
  // excludes. The receiver treats the file as gone from its scope: it removes its unchanged copy, and
  // re-including the folder pulls the file back (no delete is ever pushed, I12).
  it("B: a remote move into a folder this device excludes converges; re-including pulls it back", async () => {
    const sim = await scripted(1002, 2, {}, [{ settings: { excludedFolders: ["private"] } }]);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(b, "a.md", text("moving\n"));
    await checkpoint(sim);
    sim.userRename(b, "a.md", "private/a.md");
    expect(await oracles(sim)).toEqual([]);
    expect(a.fs.exists("a.md")).toBe(false);
    expect(a.fs.exists("private/a.md")).toBe(false);
    a.settings = { ...a.settings, excludedFolders: [] };
    await a.engine.updateSettings({ excludedFolders: [] });
    expect(await oracles(sim)).toEqual([]);
    expect(a.fs.readText("private/a.md")).toBe("moving\n");
    expect(sim.commits.some((c) => c.device === "alpha" && c.kinds.includes("del"))).toBe(false);
  }, 60_000);

  // D6 with a local edit on the receiver: the edited copy stays at the old path as a new file.
  it("B': a receiver's local edit survives a remote move into its excluded folder", async () => {
    const sim = await scripted(1004, 2, {}, [{ settings: { excludedFolders: ["private"] } }]);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(b, "a.md", sim.noteOf(3));
    await checkpoint(sim);
    const lines = noteLines(a.fs.files().get("a.md")!);
    const mine = sim.ledger.token();
    await sim.userWrite(a, "a.md", noteBytes([...lines, mine]));
    sim.userRename(b, "a.md", "private/a.md");
    await b.iterate();
    expect(await oracles(sim)).toEqual([]);
    const holders = [...b.fs.files().entries()].filter(([, bytes]) => noteLines(bytes).includes(mine)).map(([p]) => p);
    expect(holders.length).toBeGreaterThan(0);
  }, 60_000);
});
