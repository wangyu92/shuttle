// Two-device convergence through FakeRemote (design §3.7-§3.10, invariants I7, I16, I17, I19, I31).
import { FakeScheduler } from "@shuttle/testkit";
import { describe, expect, it } from "vitest";
import { kindOf, scanLocal } from "../src/index";
import { Device, bigBytes, contentOf, makeWorld, recordsOf, serverMap, sortedEntries, type World } from "./harness";

async function pair(seed: string): Promise<{ w: World; a: Device; b: Device }> {
  const w = await makeWorld(seed);
  const a = new Device(w, { name: "alpha" });
  const b = new Device(w, { name: "beta" });
  await a.start();
  await b.start();
  return { w, a, b };
}

async function settle(...ds: Device[]): Promise<void> {
  for (let i = 0; i < 4; i++) for (const d of ds) await d.sync();
}

async function expectConverged(w: World, ...ds: Device[]): Promise<void> {
  const remote = sortedEntries(await serverMap(w));
  for (const d of ds) {
    expect(sortedEntries(await d.diskMap())).toEqual(remote);
    // design §3.3.5: nothing pending → the localStorage pendingOps mirror is empty.
    expect([...d.mirror.keys()]).toEqual([]);
  }
}

/** External edit with a later mtime (real filesystems change mtime; the fast path relies on it). */
function edit(w: World, d: Device, path: string, content: string | Uint8Array, mtimeOffset = 0): void {
  w.clock.tick(1000);
  d.fs.external.write(path, content, { mtime: w.clock.now() + mtimeOffset });
}

function fastScan(w: World, d: Device): ReturnType<typeof scanLocal> {
  return scanLocal({
    fs: d.fs, index: d.index, scheduler: new FakeScheduler(w.clock), scopeOf: d.scope, kindOf: (p) => kindOf(p, ".obsidian"),
    markDirty: () => undefined, includeConfigDir: true,
  }, "fast");
}

const commitsBy = (w: World, d: Device): number => w.server.calls.filter((c) => c.device === d.deviceId && c.method === "commit").length;

describe("two devices", () => {
  it("create, edit, move and delete reach the other device; the receiver never commits (I16)", async () => {
    const { w, a, b } = await pair("basic");
    edit(w, a, "notes/one.md", "hello\n");
    edit(w, a, "att/pic.bin", bigBytes("pic"));
    edit(w, a, "empty.md", "");
    await settle(a, b);
    await expectConverged(w, a, b);
    expect(recordsOf(w).length).toBe(3);
    expect(commitsBy(w, b)).toBe(0);
    expect(b.fs.readText("notes/one.md")).toBe("hello\n");

    edit(w, a, "notes/one.md", "hello\nworld\n");
    await settle(a, b);
    expect(b.fs.readText("notes/one.md")).toBe("hello\nworld\n");
    // I23 after applies: the receiver's next fast scan reads and hashes nothing.
    const reads = b.fs.stats.reads;
    const scan = await fastScan(w, b);
    expect(scan).toMatchObject({ fastPath: 3, dirty: 0 });
    expect(b.fs.stats.reads).toBe(reads);
    expect(b.index.byPath("notes/one.md")!.obs!.hash).toBe(b.index.remote.byFileId(b.index.byPath("notes/one.md")!.fileId)!.contentHash);

    const blobsBefore = w.server.inspect().blobIds.length;
    a.fs.external.rename("att/pic.bin", "moved/pic.bin");
    await a.renames.rename("att/pic.bin", "moved/pic.bin");
    await settle(a, b);
    await expectConverged(w, a, b);
    expect(b.fs.exists("moved/pic.bin")).toBe(true);
    expect(b.fs.exists("att/pic.bin")).toBe(false);
    expect(w.server.inspect().blobIds.length).toBe(blobsBefore);
    const moved = recordsOf(w).at(-1)!;
    expect(moved.kind).toBe("put");
    expect(moved.base).not.toBeNull();

    a.fs.external.remove("notes/one.md");
    await settle(a, b);
    await expectConverged(w, a, b);
    expect(b.fs.exists("notes/one.md")).toBe(false);
    expect(b.fs.trash.some((t) => t.path === "notes/one.md")).toBe(true);
    expect(commitsBy(w, b)).toBe(0);
  });

  it("concurrent edits of different lines merge on both devices (dmp3)", async () => {
    const { w, a, b } = await pair("merge");
    edit(w, a, "n.md", "l1\nl2\nl3\nl4\nl5\n");
    await settle(a, b);
    edit(w, a, "n.md", "L1\nl2\nl3\nl4\nl5\n");
    edit(w, b, "n.md", "l1\nl2\nl3\nl4\nL5\n");
    await a.sync();
    await b.sync();
    await settle(a, b);
    await expectConverged(w, a, b);
    expect(a.fs.readText("n.md")).toBe("L1\nl2\nl3\nl4\nL5\n");
  });

  it("overlapping edits keep both versions as a conflict copy (I10)", async () => {
    const { w, a, b } = await pair("copy");
    edit(w, a, "n.md", "same line\n");
    await settle(a, b);
    edit(w, a, "n.md", "alpha line\n");
    edit(w, b, "n.md", "beta line\n");
    await a.sync();
    await b.sync();
    await settle(a, b);
    await expectConverged(w, a, b);
    const texts = [...b.fs.files().entries()].map(([p, v]) => [p, new TextDecoder().decode(v)]);
    expect(texts.map((t) => t[1]).sort()).toEqual(["alpha line\n", "beta line\n"]);
    expect(texts.some(([p]) => p?.includes("Conflicted copy beta"))).toBe(true);
    expect(b.fs.readText("n.md")).toBe("alpha line\n");
    for (const d of [a, b]) expect((await fastScan(w, d)).dirty).toBe(0);
  });

  it("concurrent binary edits: LWW, the loser is archived (I31)", async () => {
    const { w, a, b } = await pair("lww");
    edit(w, a, "img.bin", bigBytes("v0"));
    await settle(a, b);
    edit(w, a, "img.bin", bigBytes("va"), 5000);
    edit(w, b, "img.bin", bigBytes("vb"), 1000);
    await a.sync();
    await b.sync();
    await settle(a, b);
    await expectConverged(w, a, b);
    const archives = recordsOf(w, (r) => r.kind === "archive");
    // a's version (newer mtime) reaches b first: remote wins on b, b archives its own bytes, then pulls.
    expect(archives.length).toBe(1);
    expect(archives[0]!.device).toBe(b.deviceId);
    expect(a.fs.files().get("img.bin")).toEqual(bigBytes("va"));
    expect(await contentOf(w, archives[0]!)).toEqual(bigBytes("vb"));
  });

  it("a swap of two paths applies atomically and converges", async () => {
    const { w, a, b } = await pair("swap");
    edit(w, a, "x.md", "content X\n");
    edit(w, a, "y.md", "content Y\n");
    await settle(a, b);
    a.fs.external.rename("x.md", "tmp.md");
    await a.renames.rename("x.md", "tmp.md");
    a.fs.external.rename("y.md", "x.md");
    await a.renames.rename("y.md", "x.md");
    a.fs.external.rename("tmp.md", "y.md");
    await a.renames.rename("tmp.md", "y.md");
    await settle(a, b);
    await expectConverged(w, a, b);
    expect(b.fs.readText("x.md")).toBe("content Y\n");
    expect(b.fs.readText("y.md")).toBe("content X\n");
  });

  it("edit beats delete: a remote delete of a locally edited file restores it (C4)", async () => {
    const { w, a, b } = await pair("resurrect");
    edit(w, a, "k.md", "v1\n");
    await settle(a, b);
    a.fs.external.remove("k.md");
    edit(w, b, "k.md", "v2 edited\n");
    await a.sync();
    await b.sync();
    await settle(a, b);
    await expectConverged(w, a, b);
    expect(a.fs.readText("k.md")).toBe("v2 edited\n");
  });

  it("the same new path created on both devices keeps both (N5, I11)", async () => {
    const { w, a, b } = await pair("n5");
    edit(w, a, "daily.md", "from alpha\n");
    edit(w, b, "daily.md", "from beta\n");
    await a.sync();
    await w.server.settle();
    // One reconcile pass on b: KEEP_BOTH renames b's note away and pulls a's into the original path.
    // The pull's observation (written file, remote hash) must survive the Reconciler's bookkeeping.
    await b.reconcileAll();
    const e = b.index.byPath("daily.md")!;
    expect(e.obs!.hash).toBe(b.index.remote.byFileId(e.fileId)!.contentHash);
    const st = (await b.fs.stat("daily.md"))!;
    expect([e.obs!.mtime, e.obs!.size]).toEqual([st.mtime, st.size]);
    await b.sync();
    await settle(a, b);
    await expectConverged(w, a, b);
    const vals = [...a.fs.files().values()].map((v) => new TextDecoder().decode(v)).sort();
    expect(vals).toEqual(["from alpha\n", "from beta\n"]);
    // The pull into the original path recorded its own observation: a fast scan reads nothing.
    for (const d of [a, b]) {
      const reads = d.fs.stats.reads;
      const scan = await fastScan(w, d);
      expect(scan.dirty).toBe(0);
      expect(d.fs.stats.reads).toBe(reads);
    }
  });

  it("I17: a folder move is N moves: N puts with unchanged blobs, no tombstones", async () => {
    const { w, a, b } = await pair("folder");
    edit(w, a, "dir/one.md", "one\n");
    edit(w, a, "dir/two.md", "two\n");
    edit(w, a, "dir/sub/big.bin", bigBytes("folderbig"));
    await settle(a, b);
    const before = recordsOf(w).length;
    const blobs = w.server.inspect().blobIds;
    a.fs.external.rename("dir", "moved");
    for (const p of ["one.md", "two.md", "sub/big.bin"]) await a.renames.rename(`dir/${p}`, `moved/${p}`);
    await settle(a, b);
    const after = recordsOf(w).slice(before);
    expect(after.map((r) => r.kind)).toEqual(["put", "put", "put"]);
    expect(w.server.inspect().blobIds).toEqual(blobs);
    await expectConverged(w, a, b);
    expect(b.fs.exists("dir")).toBe(false);
  });

  it("I19: a case-only rename keeps the fileId on a case-insensitive device", async () => {
    const w = await makeWorld("case");
    const a = new Device(w, { name: "alpha", caseInsensitive: true });
    const b = new Device(w, { name: "beta" });
    await a.start();
    await b.start();
    edit(w, a, "Readme.md", "hi\n");
    await settle(a, b);
    const id = a.index.byPath("Readme.md")!.fileId;
    a.fs.external.rename("Readme.md", "README.md");
    await a.renames.rename("Readme.md", "README.md");
    await settle(a, b);
    expect(a.index.byPath("README.md")?.fileId).toBe(id);
    expect(b.index.byPath("README.md")?.fileId).toBe(id);
    expect(recordsOf(w).map((r) => r.kind)).toEqual(["put", "put"]);
    await expectConverged(w, a, b);
  });
});
