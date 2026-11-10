// ObsidianLocalFs over the FakeVault: Vault vs DataAdapter routing, events, NFC, errors (design §3.2).
import { describe, expect, it } from "vitest";
import type { LocalEvent, LocalFs, LocalStat } from "@shuttle/protocol";
import { hasFsCode, replaceFile } from "@shuttle/engine";
import { ObsidianLocalFs, fsCodeOf } from "../src/platform/ObsidianLocalFs";
import { FakeVault } from "./fakeVault";

const te = new TextEncoder();
const td = new TextDecoder();

function setup(): { v: FakeVault; fs: ObsidianLocalFs; events: LocalEvent[]; dispose: () => void } {
  const v = new FakeVault();
  const fs = new ObsidianLocalFs({ vault: v, fileManager: v.fileManager, platform: "desktop", caseInsensitive: true, listBatch: 2 });
  const events: LocalEvent[] = [];
  const d = fs.onEvent((e) => events.push(e));
  return { v, fs, events, dispose: () => d.dispose() };
}

async function listAll(fs: ObsidianLocalFs, includeConfigDir: boolean): Promise<LocalStat[][]> {
  const out: LocalStat[][] = [];
  for await (const b of fs.listAll({ includeConfigDir })) out.push(b);
  return out;
}

describe("ObsidianLocalFs", () => {
  it("writes indexed notes through Vault (create, then modify) and creates parent folders", async () => {
    const { v, fs } = setup();
    const st = await fs.write("a/b/n.md", te.encode("one"), { mtime: 1234 });
    expect(st).toMatchObject({ path: "a/b/n.md", kind: "file", size: 3, mtime: 1234 });
    await fs.write("a/b/n.md", te.encode("two!"), { mtime: 5678 });
    expect(v.calls.filter((c) => !c.startsWith("trash"))).toEqual(["createFolder:a", "createFolder:a/b", "createBinary:a/b/n.md", "modifyBinary:a/b/n.md"]);
    expect(td.decode(await fs.read("a/b/n.md"))).toBe("two!");
    expect((await fs.stat("a/b/n.md"))?.mtime).toBe(5678);
  });

  it("writes the configuration folder through the DataAdapter", async () => {
    const { v, fs } = setup();
    await fs.write(".obsidian/snippets/x.css", te.encode("a{}"), { mtime: 1 });
    expect(v.calls).toContain("adapter.writeBinary:.obsidian/snippets/x.css");
    expect(v.calls.some((c) => c.startsWith("createBinary"))).toBe(false);
  });

  it("lists vault files in batches and the configuration folder only when asked", async () => {
    const { v, fs } = setup();
    v.userWrite("a.md", "a");
    v.userWrite("f/b.md", "b");
    v.userWrite("c.png", "c");
    v.userWrite(".obsidian/app.json", "{}");
    v.userWrite(".hidden/x.md", "x");
    const without = (await listAll(fs, false)).flat().map((s) => s.path).sort();
    expect(without).toEqual(["a.md", "c.png", "f/b.md"]);
    const batches = await listAll(fs, true);
    expect(batches.every((b) => b.length <= 2)).toBe(true);
    expect(batches.flat().map((s) => s.path).sort()).toEqual([".obsidian/app.json", "a.md", "c.png", "f/b.md"]);
  });

  it("maps Vault events to LocalEvents and forwards raw only under the configuration folder", async () => {
    const { v, fs, events } = setup();
    v.userWrite("n.md", "x");
    v.userWrite("n.md", "y");
    v.userWrite(".obsidian/hotkeys.json", "{}");
    await fs.rename("n.md", "d/m.md");
    await fs.remove("d/m.md", "delete");
    const kinds = events.map((e) => (e.t === "rename" ? `rename:${e.from}->${e.to}` : `${e.t}:${"path" in e ? e.path : ""}`));
    expect(kinds).toEqual(["create:n.md", "modify:n.md", "raw:.obsidian/hotkeys.json", "rename:n.md->d/m.md", "delete:d/m.md"]);
    const c = events[0] as { stat?: LocalStat };
    expect(c.stat).toMatchObject({ kind: "file", size: 1 });
  });

  it("dispose() unregisters every handler", () => {
    const { v, dispose } = setup();
    expect(v.listenerCount()).toBe(5);
    dispose();
    dispose();
    expect(v.listenerCount()).toBe(0);
  });

  it("presents NFD names on disk as NFC and still reaches the real file", async () => {
    const { v, fs, events } = setup();
    const nfd = "café.md";
    const nfc = "café.md";
    v.userWrite(nfd, "x");
    expect(events.at(-1)).toMatchObject({ t: "create", path: nfc });
    const listed = (await listAll(fs, false)).flat().map((s) => s.path);
    expect(listed).toEqual([nfc]);
    expect(td.decode(await fs.read(nfc))).toBe("x");
    await fs.write(nfc, te.encode("y"), { mtime: 9 });
    expect(v.text(nfd)).toBe("y");
    expect(v.nodes.has(nfc)).toBe(false);
  });

  it("removes to the trash through FileManager, configuration files through the adapter", async () => {
    const { v, fs } = setup();
    v.userWrite("t.md", "x");
    v.userWrite(".obsidian/a.json", "{}");
    await fs.remove("t.md", "trash");
    await fs.remove(".obsidian/a.json", "trash");
    expect(v.calls).toContain("trashFile:t.md");
    expect(v.calls).toContain("trashLocal:.obsidian/a.json");
    expect(await fs.stat("t.md")).toBeNull();
    expect(v.nodes.has(".trash/t.md")).toBe(true);
  });

  it("reports missing files with LocalFs error codes", async () => {
    const { fs } = setup();
    expect(await fs.stat("nope.md")).toBeNull();
    const e = await fs.read("nope.md").catch((x: unknown) => x);
    expect(hasFsCode(e, "ENOENT")).toBe(true);
    const r = await fs.remove("nope.md", "delete").catch((x: unknown) => x);
    expect(hasFsCode(r, "ENOENT")).toBe(true);
    expect(fsCodeOf(new Error("File already exists."))).toBe("EEXIST");
    expect(fsCodeOf(Object.assign(new Error("x"), { code: "EPERM" }))).toBe("EACCES");
    expect(fsCodeOf(new Error("disk quota exceeded"))).toBe("ENOSPC");
  });

  it("rmdirIfEmpty removes only empty folders; mkdirp refuses a file in the way", async () => {
    const { v, fs } = setup();
    await fs.mkdirp("x/y");
    v.userWrite("x/y/f.md", "1");
    expect(await fs.rmdirIfEmpty("x/y")).toBe(false);
    await fs.remove("x/y/f.md", "delete");
    expect(await fs.rmdirIfEmpty("x/y")).toBe(true);
    expect(await fs.rmdirIfEmpty("missing")).toBe(false);
    v.userWrite("file.md", "1");
    const e = await fs.mkdirp("file.md/sub").catch((x: unknown) => x);
    expect(hasFsCode(e, "ENOTDIR")).toBe(true);
  });

  it("processText applies or aborts through Vault.process", async () => {
    const { v, fs } = setup();
    v.userWrite("p.md", "abc");
    expect(await fs.processText("p.md", (cur) => cur + "d")).toBe(true);
    expect(v.text("p.md")).toBe("abcd");
    expect(await fs.processText("p.md", () => null)).toBe(false);
    expect(v.text("p.md")).toBe("abcd");
    expect(await fs.processText("absent.md", () => "x")).toBe(false);
  });

  it("D11: mobile refuses a replace rename over an existing note (EEXIST) and never writes the temp's bytes there", async () => {
    const { v, fs } = setup();
    expect(fs.renameReplaces).toBe(false);
    expect((fs as LocalFs).atomicReplace).toBeUndefined();
    await fs.write("n.md", te.encode("old"), { mtime: 1 });
    await fs.write(".shuttle-replace-1", te.encode("new!"), { mtime: 2 });
    v.calls.length = 0;
    await expect(fs.rename(".shuttle-replace-1", "n.md")).rejects.toMatchObject({ code: "EEXIST" });
    expect(v.text("n.md")).toBe("old");
    expect(v.calls.filter((c) => c.includes("n.md"))).toEqual([]);
  });

  it("D11: replaceFile on mobile swaps through a backup folder, then removes it", async () => {
    const { v, fs } = setup();
    await fs.write("d/n.md", te.encode("old"), { mtime: 1 });
    v.calls.length = 0;
    await replaceFile(fs, "d/n.md", te.encode("new!"), { mtime: 2 });
    expect(v.text("d/n.md")).toBe("new!");
    expect(v.calls.some((c) => c === "modifyBinary:d/n.md" || c === "adapter.writeBinary:d/n.md")).toBe(false);
    const left: string[] = [];
    for await (const b of fs.listInternal()) for (const s of b) left.push(s.path);
    expect(left).toEqual([]);
  });

  it("D11: listInternal finds swap leftovers Vault does not index (also under the configuration folder)", async () => {
    const { fs } = setup();
    await fs.write("d/n.md", te.encode("new"), { mtime: 1 });
    await fs.mkdirp("d/.shuttle-bak-3");
    await fs.write("d/.shuttle-bak-3/n.md", te.encode("old"), { mtime: 1 });
    await fs.write("d/.shuttle-replace-7", te.encode("tmp"), { mtime: 1 });
    await fs.write(".obsidian/.shuttle-replace-2", te.encode("cfg"), { mtime: 1 });
    await fs.write(".git/.shuttle-replace-9", te.encode("not ours"), { mtime: 1 }).catch(() => undefined);
    const found: string[] = [];
    for await (const b of fs.listInternal()) for (const s of b) found.push(`${s.kind}:${s.path}`);
    expect(found.sort()).toEqual([
      "file:.obsidian/.shuttle-replace-2", "file:d/.shuttle-bak-3/n.md", "file:d/.shuttle-replace-7", "folder:d/.shuttle-bak-3",
    ]);
    // Vault's own listing never shows them.
    const listed = (await listAll(fs, false)).flat().map((s) => s.path);
    expect(listed).toEqual(["d/n.md"]);
  });

  it("D8: desktop renames the temp over the note through the adapter's node fs", async () => {
    const { v, fs } = setup();
    await fs.write("n.md", te.encode("old"), { mtime: 1 });
    await fs.write(".shuttle-replace-2", te.encode("new!"), { mtime: 2 });
    const calls: string[] = [];
    const a = v.adapter as unknown as { getFullPath(p: string): string; fsPromises: { rename(x: string, y: string): Promise<void> } };
    a.getFullPath = (p) => `/vault/${p}`;
    a.fsPromises = { rename: async (x, y) => { calls.push(`${x}->${y}`); } };
    await fs.rename(".shuttle-replace-2", "n.md");
    expect(calls).toEqual(["/vault/.shuttle-replace-2->/vault/n.md"]);
  });

  it("a plain rename onto an existing file still refuses", async () => {
    const { fs } = setup();
    await fs.write("a.md", te.encode("a"), { mtime: 1 });
    await fs.write("b.md", te.encode("b"), { mtime: 1 });
    await expect(fs.rename("a.md", "b.md")).rejects.toThrow();
  });
});
