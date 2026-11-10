// I16 no echo uploads (design §3.18, §7.2): applying N remote changes produces 0 commits on receivers.
import { describe, expect, it } from "vitest";
import { by, checkpoint, commitsOf, scripted, text, guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

describe("I16 echo", () => {
  it("receivers of creates, edits, moves and deletes commit nothing", async () => {
    const sim = await scripted(101);
    const [a, b, c] = [by(sim, "alpha"), by(sim, "beta"), by(sim, "gamma")];
    for (let i = 0; i < 6; i++) await sim.userWrite(a, `notes/n${i}.md`, sim.noteOf(3));
    await sim.userWrite(a, "img/p.png", sim.prng.bytes(30_000));
    await sim.userWrite(a, "empty.md", new Uint8Array(0));
    await checkpoint(sim);
    await sim.userWrite(a, "notes/n0.md", sim.noteOf(4));
    sim.userRename(a, "notes/n1.md", "moved/n1.md");
    await sim.userRemove(a, "notes/n2.md");
    sim.userRename(a, "img", "pics");
    await checkpoint(sim);
    expect(commitsOf(sim, a)).toBeGreaterThan(0);
    expect(commitsOf(sim, b)).toBe(0);
    expect(commitsOf(sim, c)).toBe(0);
    expect(b.fs.exists("pics/p.png") && !b.fs.exists("img/p.png")).toBe(true);
  }, 60_000);

  it("a restart of a receiver does not upload what it received", async () => {
    const sim = await scripted(102, 2);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    for (let i = 0; i < 4; i++) await sim.userWrite(a, `n${i}.md`, text(`line ${i}\n`));
    await checkpoint(sim);
    const before = sim.commits.length;
    await sim.restartDev(b);
    await checkpoint(sim);
    expect(commitsOf(sim, b, before)).toBe(0);
  }, 60_000);
});
