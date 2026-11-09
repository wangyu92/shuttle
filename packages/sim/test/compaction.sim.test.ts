// I21 / I21b (design §3.18, §7.2): a cursor below minSeq gets CursorExpired (SNAPSHOT_REQUIRED) and
// the snapshot resync converges per I7; purged tombstones go through S8/C5 and never delete a file.
import { describe, expect, it } from "vitest";
import { by, checkpoint, scripted, text } from "./helpers";

describe("I21 compaction", () => {
  it("an offline device past minSeq resyncs from a snapshot and converges", async () => {
    const sim = await scripted(401);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    for (let i = 0; i < 4; i++) await sim.userWrite(a, `n${i}.md`, sim.noteOf(2));
    await checkpoint(sim);
    b.setOnline(false);
    await sim.userWrite(a, "n0.md", sim.noteOf(3));
    await sim.userRemove(a, "n1.md");
    await sim.userWrite(a, "fresh.md", sim.noteOf(2));
    sim.userRename(a, "n2.md", "dir/n2.md");
    await sim.userWrite(b, "n3.md", sim.noteOf(2));
    for (let i = 0; i < 3; i++) await a.iterate();
    for (let i = 0; i < 3; i++) await by(sim, "gamma").iterate();
    const srv = sim.w.server;
    const { purgedFiles } = await sim.compact(srv.headSeq);
    expect(purgedFiles).toBe(1);
    expect(srv.minSeq).toBeGreaterThan(0);
    await checkpoint(sim);
    expect(b.fs.readText("fresh.md")).toBe(a.fs.readText("fresh.md"));
    expect(b.fs.exists("dir/n2.md")).toBe(true);
  }, 60_000);

  it("a purged tombstone reaches an offline device through the snapshot: row S8 trashes the file", async () => {
    const sim = await scripted(402, 2);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(a, "keep.md", text("precious\n"));
    await checkpoint(sim);
    b.setOnline(false);
    await sim.userRemove(a, "keep.md");
    for (let i = 0; i < 3; i++) await a.iterate();
    await sim.compact(sim.w.server.headSeq);
    // beta was offline for the delete and the tombstone is gone. snapshotResync row S8 (L = B,
    // R purged): LOCAL_DELETE to the trash, never a remote delete; the content stays in the trash.
    const before = sim.commits.length;
    await checkpoint(sim);
    expect(b.fs.exists("keep.md")).toBe(false);
    expect(b.fs.trash.some((t) => t.path === "keep.md" && t.bytes && new TextDecoder().decode(t.bytes) === "precious\n")).toBe(true);
    expect(sim.commits.slice(before).filter((c) => c.device === "beta")).toEqual([]);
  });

  it("C5: an offline edit of a file whose tombstone was purged is uploaded again", async () => {
    const sim = await scripted(403, 2);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    await sim.userWrite(a, "keep.md", text("v1\n"));
    await checkpoint(sim);
    b.setOnline(false);
    await sim.userRemove(a, "keep.md");
    for (let i = 0; i < 3; i++) await a.iterate();
    await sim.compact(sim.w.server.headSeq);
    await sim.userWrite(b, "keep.md", sim.noteOf(2));
    await checkpoint(sim);
    expect(a.fs.readText("keep.md")).toBe(b.fs.readText("keep.md"));
  }, 60_000);
});
