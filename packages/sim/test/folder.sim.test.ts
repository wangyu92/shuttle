// I17 folder expansion (design §3.18, §7.2): a folder rename of N files is N puts with unchanged
// blobs and no tombstones; a folder delete is N deletes; no ghosts.
import { describe, expect, it } from "vitest";
import { by, checkpoint, scripted } from "./helpers";

describe("I17 folder moves", () => {
  it("move then delete a folder of N files", async () => {
    const sim = await scripted(201);
    const a = by(sim, "alpha");
    const names = ["one.md", "two.md", "sub/three.md", "sub/big.png", "sub/deeper/four.md"];
    for (const n of names) await sim.userWrite(a, `dir/${n}`, n.endsWith(".png") ? sim.prng.bytes(40_000) : sim.noteOf(2));
    await checkpoint(sim);
    const srv = sim.w.server;
    const blobs = srv.inspect().blobIds;
    const ids = new Map(srv.inspect().heads.map((r) => [r.fileId, r.seq]));
    const from = srv.inspect().log.length;

    sim.userRename(a, "dir", "moved");
    await checkpoint(sim);
    const moved = srv.inspect().log.slice(from);
    expect(moved.map((r) => r.kind)).toEqual(names.map(() => "put"));
    for (const r of moved) {
      expect(ids.has(r.fileId)).toBe(true);
      expect(r.base).toBe(ids.get(r.fileId));
    }
    expect(srv.inspect().blobIds).toEqual(blobs);
    for (const d of sim.devices) for (const n of names) {
      expect(d.fs.exists(`moved/${n}`)).toBe(true);
      expect(d.fs.exists(`dir/${n}`)).toBe(false);
    }

    const before = srv.inspect().log.length;
    await sim.userRemove(a, "moved");
    await checkpoint(sim);
    const dels = srv.inspect().log.slice(before);
    expect(dels.map((r) => r.kind)).toEqual(names.map(() => "del"));
    for (const d of sim.devices) expect([...d.fs.files().keys()]).toEqual([]);
  }, 60_000);

  it("concurrent folder moves on two devices converge without ghosts", async () => {
    const sim = await scripted(202);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    for (let i = 0; i < 5; i++) await sim.userWrite(a, `x/f${i}.md`, sim.noteOf(2));
    await checkpoint(sim);
    b.setOnline(false);
    sim.userRename(a, "x", "y");
    sim.userRename(b, "x", "z");
    await checkpoint(sim);
  }, 60_000);
});
