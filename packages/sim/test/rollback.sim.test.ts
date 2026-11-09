// I29 rollback recovery (S1; design §3.18, §2.6.1, §4.9.2, §7.2): after a server DB restore and
// "accept", every edit made after the backup and held by any device ends up as a remote head or a
// conflict copy.
import { describe, expect, it } from "vitest";
import { backupServer, restoreServer, tokensOf } from "../src/index";
import { by, checkpoint, scripted } from "./helpers";

describe("I29 server restore", () => {
  it("edits after the backup survive restore + accept", async () => {
    const sim = await scripted(701);
    const [a, b, c] = [by(sim, "alpha"), by(sim, "beta"), by(sim, "gamma")];
    for (let i = 0; i < 3; i++) await sim.userWrite(a, `n${i}.md`, sim.noteOf(2));
    await sim.userWrite(b, "pic.png", sim.prng.bytes(20_000));
    await checkpoint(sim);
    const backup = backupServer(sim.w.server);

    // After the backup: synced edits, a new file, a rename, and an edit held only by gamma (offline).
    const after: Uint8Array[] = [];
    const put = async (d: typeof a, p: string, bytes: Uint8Array): Promise<void> => { after.push(bytes); await sim.userWrite(d, p, bytes); };
    await put(a, "n0.md", sim.noteOf(3));
    await put(b, "late.md", sim.noteOf(2));
    sim.userRename(a, "n1.md", "moved/n1.md");
    await checkpoint(sim);
    c.setOnline(false);
    await put(c, "n2.md", sim.noteOf(4));
    for (const d of sim.devices) d.rollbackAnswer = "accept";
    await sim.evidence.capture(sim.w.server);
    restoreServer(sim.w, backup, sim.devices, sim.prng);
    for (const d of sim.devices) await d.restart();
    await checkpoint(sim);

    expect(sim.guards.filter((g) => g.kind === "rollback").map((g) => g.answer)).toContain("accept");
    // Every token written after the backup is in the content of a live head.
    const heads = new Set<string>();
    for (const [, bytes] of a.fs.files()) for (const t of tokensOf(bytes)) heads.add(t);
    const want = after.flatMap((bytes) => [...tokensOf(bytes)]);
    expect(want.filter((t) => !heads.has(t))).toEqual([]);
    expect(a.fs.exists("moved/n1.md")).toBe(true);
    expect(a.fs.readText("late.md")).not.toBeNull();
  }, 60_000);
});
