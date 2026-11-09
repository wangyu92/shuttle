// MemLocalFs: LocalFs contract (design §3.2) and the faults of ops-spec §3.
import { describe, expect, it } from "vitest";
import type { LocalEvent, LocalStat } from "@shuttle/protocol";
import { FakeClock, MemLocalFs, drainMicrotasks, isLocalFsError, mergeEvents } from "../src/index";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function listAll(fs: MemLocalFs, includeConfigDir = false): Promise<LocalStat[]> {
  const out: LocalStat[] = [];
  for await (const batch of fs.listAll({ includeConfigDir })) out.push(...batch);
  return out;
}

function collect(fs: MemLocalFs): LocalEvent[] {
  const evs: LocalEvent[] = [];
  fs.onEvent((e) => evs.push(e));
  return evs;
}

describe("MemLocalFs basics", () => {
  it("writes, stats, reads and lists in batches with NFC paths", async () => {
    const clock = new FakeClock();
    const fs = new MemLocalFs({ clock, listBatch: 2 });
    await fs.mkdirp("notes/sub");
    const st = await fs.write("notes/sub/a.md", enc("hello"), { mtime: 1000, ctime: 900 });
    expect(st).toMatchObject({ path: "notes/sub/a.md", kind: "file", size: 5, mtime: 1000, ctime: 900 });
    expect(dec(await fs.read("notes/sub/a.md"))).toBe("hello");
    fs.external.write("Café.md", "nfd");
    expect(fs.exists("Café.md")).toBe(true);
    const all = await listAll(fs);
    expect(all.map((s) => s.path)).toEqual(["Café.md", "notes", "notes/sub", "notes/sub/a.md"]);
    let batches = 0;
    for await (const b of fs.listAll({ includeConfigDir: false })) { batches++; expect(b.length).toBeLessThanOrEqual(2); }
    expect(batches).toBe(2);
  });

  it("write needs the parent folder unless configured otherwise; rename creates parents", async () => {
    const fs = new MemLocalFs();
    await expect(fs.write("a/b.md", enc("x"), { mtime: 1 })).rejects.toSatisfy((e: unknown) => isLocalFsError(e, "ENOENT"));
    await fs.write("b.md", enc("x"), { mtime: 1 });
    await fs.rename("b.md", "deep/er/b.md");
    expect(fs.exists("deep/er")).toBe(true);
    expect(fs.readText("deep/er/b.md")).toBe("x");
    const loose = new MemLocalFs({ writeCreatesParents: true });
    await loose.write("a/b.md", enc("x"), { mtime: 1 });
    expect(loose.exists("a")).toBe(true);
  });

  it("rename keeps ino and refuses an existing target", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "a.md": "A", "b.md": "B" });
    const ino = (await fs.stat("a.md"))?.ino;
    await expect(fs.rename("a.md", "b.md")).rejects.toSatisfy((e: unknown) => isLocalFsError(e, "EEXIST"));
    await fs.rename("a.md", "c.md");
    expect((await fs.stat("c.md"))?.ino).toBe(ino);
    expect(await fs.stat("a.md")).toBeNull();
  });

  it("folder rename moves children and emits one folder event by default", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "f/x.md": "1", "f/g/y.md": "2" });
    const evs = collect(fs);
    await fs.rename("f", "h");
    await drainMicrotasks();
    expect([...fs.files().keys()]).toEqual(["h/g/y.md", "h/x.md"]);
    expect(evs).toEqual([{ t: "rename", from: "f", to: "h", kind: "folder" }]);
    const fs2 = new MemLocalFs({ expandFolderEvents: true });
    fs2.seed({ "f/x.md": "1" });
    const evs2 = collect(fs2);
    await fs2.rename("f", "h");
    await drainMicrotasks();
    expect(evs2.map((e) => e.t + ":" + ("to" in e ? e.to : ""))).toEqual(["rename:h", "rename:h/x.md"]);
  });

  it("case-insensitive mode: same file under different case, case-only rename allowed", async () => {
    const fs = new MemLocalFs({ caseInsensitive: true });
    fs.seed({ "Note.md": "a" });
    expect(fs.exists("note.md")).toBe(true);
    await fs.write("NOTE.md", enc("b"), { mtime: 2 });
    expect([...fs.files().keys()]).toEqual(["Note.md"]);
    await fs.rename("Note.md", "note.md");
    expect([...fs.files().keys()]).toEqual(["note.md"]);
    const cs = new MemLocalFs();
    cs.seed({ "Note.md": "a", "note.md": "b" });
    expect(cs.files().size).toBe(2);
  });

  it("remove: trash keeps the bytes; folders go recursively; rmdirIfEmpty", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "a.md": "A", "d/e.md": "E" });
    await fs.remove("a.md", "trash");
    expect(fs.trash.map((t) => [t.path, t.bytes && dec(t.bytes)])).toEqual([["a.md", "A"]]);
    expect(await fs.rmdirIfEmpty("d")).toBe(false);
    await fs.remove("d/e.md", "delete");
    expect(await fs.rmdirIfEmpty("d")).toBe(true);
    expect(fs.exists("d")).toBe(false);
  });

  it("processText applies or aborts", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "a.md": "one" });
    expect(await fs.processText("a.md", (s) => s + " two")).toBe(true);
    expect(fs.readText("a.md")).toBe("one two");
    expect(await fs.processText("a.md", () => null)).toBe(false);
    expect(fs.readText("a.md")).toBe("one two");
  });

  it("config dir: excluded from listAll unless asked, changes emit raw events", async () => {
    const fs = new MemLocalFs();
    fs.seed({ ".obsidian/app.json": "{}", "a.md": "x" });
    expect((await listAll(fs)).map((s) => s.path)).toEqual(["a.md"]);
    expect((await listAll(fs, true)).map((s) => s.path)).toContain(".obsidian/app.json");
    const evs = collect(fs);
    fs.external.write(".obsidian/app.json", "{\"a\":1}");
    await drainMicrotasks();
    expect(evs).toEqual([{ t: "raw", path: ".obsidian/app.json" }]);
  });
});

describe("MemLocalFs events", () => {
  it("emits create/modify/delete/rename for engine and external changes, asynchronously", async () => {
    const fs = new MemLocalFs();
    const evs = collect(fs);
    const p = fs.write("a.md", enc("1"), { mtime: 1 });
    expect(evs).toEqual([]);   // never synchronously inside the call
    await p;
    await drainMicrotasks();
    fs.external.write("a.md", "2");
    fs.external.rename("a.md", "b.md");
    fs.external.remove("b.md");
    await drainMicrotasks();
    expect(evs.map((e) => e.t)).toEqual(["create", "modify", "rename", "delete"]);
    fs.emitOwnEvents = false;
    await fs.write("c.md", enc("1"), { mtime: 1 });
    await drainMicrotasks();
    expect(evs).toHaveLength(4);
  });

  it("drops, holds and merges events", async () => {
    const fs = new MemLocalFs();
    const evs = collect(fs);
    fs.dropEvents(1);
    fs.external.write("a.md", "1");
    fs.external.write("b.md", "1");
    await drainMicrotasks();
    expect(evs.map((e) => ("path" in e ? e.path : ""))).toEqual(["b.md"]);
    fs.pauseEvents();
    fs.external.write("c.md", "1");
    fs.external.write("c.md", "2");
    fs.external.write("c.md", "3");
    await drainMicrotasks();
    expect(evs).toHaveLength(1);
    fs.resumeEvents({ merge: true });
    await drainMicrotasks();
    expect(evs.slice(1).map((e) => e.t)).toEqual(["create"]);
    expect(mergeEvents([{ t: "modify", path: "x" }, { t: "delete", path: "x" }]).length).toBe(2);
  });

  it("dispose stops delivery", async () => {
    const fs = new MemLocalFs();
    const evs: LocalEvent[] = [];
    const d = fs.onEvent((e) => evs.push(e));
    d.dispose();
    fs.external.write("a.md", "1");
    await drainMicrotasks();
    expect(evs).toEqual([]);
  });
});

describe("MemLocalFs faults", () => {
  it("failNext injects an error once, optionally per path and after skips", async () => {
    const fs = new MemLocalFs();
    fs.failNext("write", "ENOSPC", { skip: 1 });
    await fs.write("a.md", enc("1"), { mtime: 1 });
    await expect(fs.write("b.md", enc("1"), { mtime: 1 })).rejects.toSatisfy((e: unknown) => isLocalFsError(e, "ENOSPC"));
    expect(fs.exists("b.md")).toBe(false);   // a failed write leaves nothing behind
    await fs.write("b.md", enc("1"), { mtime: 1 });
    fs.failNext("read", "EIO", { path: "b.md" });
    expect(dec(await fs.read("a.md"))).toBe("1");
    await expect(fs.read("b.md")).rejects.toSatisfy((e: unknown) => isLocalFsError(e, "EIO"));
  });

  it("torn read: the file changes between stat and read", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "a.md": "old" });
    const st = await fs.stat("a.md");
    fs.tornReadOnce("a.md", "newer content");
    const bytes = await fs.read("a.md");
    expect(dec(bytes)).toBe("newer content");
    expect(bytes.length).not.toBe(st?.size);
  });

  it("ENOENT between list and read", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "a.md": "x" });
    const listed = await listAll(fs);
    expect(listed).toHaveLength(1);
    fs.vanishBeforeRead("a.md");
    await expect(fs.read("a.md")).rejects.toSatisfy((e: unknown) => isLocalFsError(e, "ENOENT"));
  });

  it("returned bytes are copies", async () => {
    const fs = new MemLocalFs();
    const data = enc("abc");
    await fs.write("a.md", data, { mtime: 1 });
    data[0] = 0;
    const r = await fs.read("a.md");
    r[1] = 0;
    expect(fs.readText("a.md")).toBe("abc");
  });
});

describe("MemLocalFs torn writes", () => {
  it("tearNextWrite leaves a prefix without an event and throws; later writes are whole", async () => {
    const fs = new MemLocalFs();
    fs.seed({ "a.md": "old content" });
    const events: unknown[] = [];
    fs.onEvent((e) => events.push(e));
    let killed = "";
    fs.tearNextWrite({ path: "a.md", keep: 4, onTear: (p) => { killed = p; } });
    expect(fs.pendingTears).toBe(1);
    await expect(fs.write("a.md", new TextEncoder().encode("new content"), { mtime: 5 })).rejects.toMatchObject({ code: "EIO" });
    expect(killed).toBe("a.md");
    expect(fs.readText("a.md")).toBe("new ");
    expect(fs.torn).toEqual([{ path: "a.md", kept: 4, of: 11 }]);
    await Promise.resolve();
    expect(events).toEqual([]);
    await fs.write("a.md", new TextEncoder().encode("whole"), { mtime: 6 });
    expect(fs.readText("a.md")).toBe("whole");
    expect(fs.pendingTears).toBe(0);
  });

  it("skip, fraction and an onTear that throws (process death) are honored", async () => {
    const fs = new MemLocalFs();
    fs.tearNextWrite({ fraction: 0.5, skip: 1, onTear: () => { throw new Error("killed"); } });
    await fs.write("x.bin", new Uint8Array(10), { mtime: 1 });
    await expect(fs.write("y.bin", new Uint8Array(10).fill(7), { mtime: 1 })).rejects.toThrow("killed");
    expect(fs.files().get("y.bin")).toEqual(new Uint8Array(5).fill(7));
  });
});
