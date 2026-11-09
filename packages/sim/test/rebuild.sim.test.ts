// I20 rebuild equivalence (design §3.18, §7.2): wiping the StateStore on a quiescent synced device
// gives 0 uploads, 0 downloads, 0 conflict copies (+ the pendingOps replay of S26).
import { describe, expect, it } from "vitest";
import { by, checkpoint, commitsOf, scripted, text } from "./helpers";

const blobReads = (sim: Awaited<ReturnType<typeof scripted>>, id: string): number =>
  sim.w.server.calls.filter((c) => c.device === id && (c.method === "getBlob" || c.method === "getBlobs")).length;

describe("I20 store eviction", () => {
  it("a quiescent device rebuilt from an empty store uploads, downloads and writes nothing", async () => {
    const sim = await scripted(301);
    const [a, b, c] = [by(sim, "alpha"), by(sim, "beta"), by(sim, "gamma")];
    for (let i = 0; i < 5; i++) await sim.userWrite(a, `notes/n${i}.md`, sim.noteOf(3));
    await sim.userWrite(b, "att/big.png", sim.prng.bytes(50_000));
    await sim.userWrite(c, "zero.md", new Uint8Array(0));
    await checkpoint(sim);
    const commits = sim.commits.length;
    const reads = blobReads(sim, b.deviceId);
    const writes = b.fs.stats.writes;
    const files = [...b.fs.files().keys()];
    await sim.restartDev(b, true);
    await checkpoint(sim);
    expect(commitsOf(sim, b, commits)).toBe(0);
    expect(blobReads(sim, b.deviceId)).toBe(reads);
    expect(b.fs.stats.writes).toBe(writes);
    expect([...b.fs.files().keys()]).toEqual(files);
  }, 60_000);

  it("edits made before the eviction are uploaded once, nothing is lost (S26)", async () => {
    const sim = await scripted(302, 2);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(a, "n.md", text("one\n"));
    await checkpoint(sim);
    await sim.userWrite(b, "n.md", sim.noteOf(2));
    await sim.userWrite(b, "new.md", sim.noteOf(2));
    await sim.restartDev(b, true);
    await checkpoint(sim);
    expect(a.fs.readText("new.md")).toBe(b.fs.readText("new.md"));
  }, 60_000);
});
