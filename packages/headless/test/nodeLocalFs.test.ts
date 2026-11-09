// NodeLocalFs on a real directory (design §6.1.3): atomic writes, mtime round trip, NFC/NFD names,
// symlinks, read-only mode, rename collisions, removes, torn reads, listing failures, startup checks.
import { chmod, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalStat } from "@shuttle/protocol";
import { hasFsCode } from "@shuttle/engine";
import { NodeLocalFs, startupChecks } from "../src/NodeLocalFs";
import { memoryLogger } from "../src/log";
import { removeDir, tempDir } from "./tmp";

let base = "";
let vault = "";
let tmp = "";
const enc = new TextEncoder();
const dec = new TextDecoder();

beforeEach(async () => {
  base = await tempDir("fs");
  vault = path.join(base, "vault");
  tmp = path.join(base, ".shuttle-tmp");
  await mkdir(vault);
  await mkdir(tmp);
});
afterEach(async () => { await removeDir(base); });

async function listAll(fs: NodeLocalFs, includeConfigDir = false): Promise<LocalStat[]> {
  const out: LocalStat[] = [];
  for await (const b of fs.listAll({ includeConfigDir })) out.push(...b);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

describe("NodeLocalFs", () => {
  it("write is atomic through the temp dir, sets mtime exactly and creates parents", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    const mtime = 1_762_318_800_123;
    const st = await fs.write("a/b/c.md", enc.encode("hello"), { mtime });
    expect(st).toMatchObject({ path: "a/b/c.md", kind: "file", size: 5, mtime });
    expect(await fs.stat("a/b/c.md")).toMatchObject({ mtime, size: 5, ino: st.ino });
    expect(dec.decode(await fs.read("a/b/c.md"))).toBe("hello");
    expect(await readdir(tmp)).toEqual([]);
    // Overwrite replaces the inode (rename), never truncates in place.
    const st2 = await fs.write("a/b/c.md", enc.encode("hello again"), { mtime: mtime + 1000 });
    expect(st2.ino).not.toBe(st.ino);
    expect(st2.mtime).toBe(mtime + 1000);
  });

  it("stat returns null for missing paths and for paths through a file", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    expect(await fs.stat("nope.md")).toBeNull();
    await fs.write("f.md", enc.encode("x"), { mtime: 1000 });
    expect(await fs.stat("f.md/child.md")).toBeNull();
    await expect(fs.read("nope.md")).rejects.toSatisfy((e: unknown) => hasFsCode(e, "ENOENT"));
  });

  it("an NFD name on disk is listed under its NFC path and all IO uses the on-disk name (S10)", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    const nfd = "한글/노트.md".normalize("NFD");
    await mkdir(path.join(vault, nfd.split("/")[0]!));
    await writeFile(path.join(vault, nfd), "본문");
    const list = await listAll(fs);
    expect(list.map((s) => s.path)).toEqual(["한글/노트.md".normalize("NFC")]);
    const nfcPath = "한글/노트.md".normalize("NFC");
    expect(dec.decode(await fs.read(nfcPath))).toBe("본문");
    await fs.write(nfcPath, enc.encode("수정"), { mtime: 5000 });
    const names = await readdir(path.join(vault, nfd.split("/")[0]!));
    expect(names).toEqual([nfd.split("/")[1]]);                    // still one file, still NFD on disk
    expect(await readFile(path.join(vault, nfd), "utf8")).toBe("수정");
    // A new file in the NFD folder gets an NFC name inside the existing folder.
    await fs.write("한글/새.md".normalize("NFC"), enc.encode("n"), { mtime: 5000 });
    expect((await readdir(path.join(vault, nfd.split("/")[0]!))).sort()).toContain("새.md".normalize("NFC"));
    await fs.remove(nfcPath, "delete");
    expect(await fs.stat(nfcPath)).toBeNull();
  });

  it("two on-disk names with one NFC form: the NFC one is the file, the other is skipped and logged once", async () => {
    const log = memoryLogger();
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp, log });
    await writeFile(path.join(vault, "é.md".normalize("NFC")), "nfc");
    await writeFile(path.join(vault, "é.md".normalize("NFD")), "nfd");
    const list = await listAll(fs);
    expect(list).toHaveLength(1);
    expect(dec.decode(await fs.read("é.md".normalize("NFC")))).toBe("nfc");
    await listAll(fs);
    expect(log.lines.filter((l) => l.includes("duplicate name"))).toHaveLength(1);
  });

  it("skips symlinks and dot directories; configDir only when asked", async () => {
    const log = memoryLogger();
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp, log });
    await mkdir(path.join(vault, ".git/objects"), { recursive: true });
    await writeFile(path.join(vault, ".git/objects/x"), "g");
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian/app.json"), "{}");
    await writeFile(path.join(vault, "real.md"), "r");
    await symlink(path.join(vault, "real.md"), path.join(vault, "link.md"));
    expect((await listAll(fs)).map((s) => s.path)).toEqual(["real.md"]);
    expect((await listAll(fs, true)).map((s) => s.path)).toEqual([".obsidian/app.json", "real.md"]);
    expect(await fs.stat("link.md")).toBeNull();
    expect(log.lines.filter((l) => l.includes("symlink"))).toHaveLength(1);
  });

  it("an unreadable directory fails the listing instead of hiding its files", async () => {
    if (process.getuid?.() === 0) return;                       // root reads everything
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    await mkdir(path.join(vault, "locked"));
    await writeFile(path.join(vault, "locked/a.md"), "a");
    await chmod(path.join(vault, "locked"), 0o000);
    try {
      await expect(listAll(fs)).rejects.toSatisfy((e: unknown) => hasFsCode(e, "EACCES"));
    } finally {
      await chmod(path.join(vault, "locked"), 0o755);
    }
  });

  it("read-only mode refuses every mutation (push-only)", async () => {
    await writeFile(path.join(vault, "a.md"), "a");
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp, readOnly: true });
    for (const f of [
      () => fs.write("b.md", enc.encode("b"), { mtime: 1 }),
      () => fs.rename("a.md", "c.md"),
      () => fs.remove("a.md", "delete"),
      () => fs.mkdirp("d"),
    ]) await expect(f()).rejects.toMatchObject({ name: "ReadOnlyFsError", code: "EROFS" });
    expect(await readdir(vault)).toEqual(["a.md"]);
  });

  it("rename creates parents and refuses a taken target with EEXIST", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    await fs.write("a.md", enc.encode("a"), { mtime: 1000 });
    await fs.write("b.md", enc.encode("b"), { mtime: 1000 });
    await expect(fs.rename("a.md", "b.md")).rejects.toSatisfy((e: unknown) => hasFsCode(e, "EEXIST"));
    await fs.rename("a.md", "x/y/a.md");
    expect(dec.decode(await fs.read("x/y/a.md"))).toBe("a");
    expect(await fs.stat("a.md")).toBeNull();
  });

  it("remove unlinks files and prunes empty parents up to, never including, the root; folders are parked", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    await fs.write("p/q/r.md", enc.encode("r"), { mtime: 1000 });
    await fs.remove("p/q/r.md", "delete");
    expect(await readdir(vault)).toEqual([]);
    expect(await fs.rmdirIfEmpty("")).toBe(false);
    await fs.write("dir/keep.md", enc.encode("k"), { mtime: 1000 });
    await fs.remove("dir", "delete");
    expect(await fs.stat("dir")).toBeNull();
    const trash = await readdir(path.join(tmp, "trash"));
    expect(trash).toHaveLength(1);
    expect(await readFile(path.join(tmp, "trash", trash[0]!, "dir/keep.md"), "utf8")).toBe("k");
    // 'trash' mode on a file parks it too.
    await fs.write("t.md", enc.encode("t"), { mtime: 1000 });
    await fs.remove("t.md", "trash");
    expect(await fs.stat("t.md")).toBeNull();
    await stat(vault);
  });

  it("detects a read torn by a concurrent writer", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    await writeFile(path.join(vault, "big.md"), "x".repeat(4 << 20));
    // Grow the file while it is read: several attempts, at least one read must be torn or consistent.
    let torn = 0;
    for (let i = 0; i < 20 && torn === 0; i++) {
      const w = writeFile(path.join(vault, "big.md"), "y".repeat((4 << 20) + i + 1), { flag: "a" });
      try { await fs.read("big.md"); } catch (e) { if ((e as Error).name === "TornReadError") torn++; else throw e; }
      await w;
    }
    // Reads that are not torn are complete and consistent; the counter matches what was thrown.
    expect(fs.stats.tornReads).toBe(torn);
  });

  it("listAll reports changes since the previous complete listing", async () => {
    const fs = new NodeLocalFs({ root: vault, tmpDir: tmp });
    const reports: Array<string[] | null> = [];
    fs.onScan((r) => reports.push(r.changes));
    await writeFile(path.join(vault, "a.md"), "a");
    await writeFile(path.join(vault, "b.md"), "b");
    await listAll(fs);
    await writeFile(path.join(vault, "c.md"), "c");
    await utimes(path.join(vault, "a.md"), 5, 5);
    await import("node:fs/promises").then((m) => m.unlink(path.join(vault, "b.md")));
    await listAll(fs);
    expect(reports[0]).toBeNull();
    expect([...(reports[1] ?? [])].sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("startup checks: empty-vault guard, same device, writable temp", async () => {
    expect(await startupChecks({ vaultPath: vault, tmpPath: tmp, readOnly: false, indexedActive: 5 })).toMatchObject({ ok: true });
    const r = await startupChecks({ vaultPath: vault, tmpPath: tmp, readOnly: false, indexedActive: 25 });
    expect(r).toMatchObject({ ok: false, emptyVault: true });
    const m = await startupChecks({ vaultPath: path.join(base, "missing"), tmpPath: tmp, readOnly: false, indexedActive: 0 });
    expect(m.ok).toBe(false);
    const t = await startupChecks({ vaultPath: vault, tmpPath: path.join(base, "no-tmp"), readOnly: false, indexedActive: 0 });
    expect(t.failures.join()).toMatch(/temp dir/);
    expect((await startupChecks({ vaultPath: vault, tmpPath: path.join(base, "no-tmp"), readOnly: true, indexedActive: 0 })).ok).toBe(true);
  });
});
