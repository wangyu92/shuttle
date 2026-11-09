// Local event handling (design §3.5, I18) and echo suppression (§3.6.2).
import type { LocalEvent } from "@shuttle/protocol";
import { FakeClock, FakeScheduler, MemLocalFs, MemStateStore } from "@shuttle/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEBOUNCE_MAX_WAIT_MS, DEBOUNCE_SETTLE_MS, DELETE_HOLD_MS, EchoSuppressor, ECHO_TTL_MS, FileIndex, LocalEventQueue, RAW_DEBOUNCE_MS,
  readAndHash, type DirtyKey,
} from "../src/index";

const F = "a".repeat(32);
const G = "b".repeat(32);

interface Rec { dirty: Array<{ key: DirtyKey; reason: string; at: number }>; renames: Array<{ from: string; to: string; groupId?: string }>; scans: string[]; errors: unknown[] }

let clock: FakeClock;
let sched: FakeScheduler;
let fs: MemLocalFs;
let ix: FileIndex;
let rec: Rec;
let q: LocalEventQueue;

beforeEach(async () => {
  clock = new FakeClock();
  sched = new FakeScheduler(clock);
  fs = new MemLocalFs({ clock, emitOwnEvents: false });
  ix = await FileIndex.load(new MemStateStore(), () => clock.now());
  rec = { dirty: [], renames: [], scans: [], errors: [] };
  let g = 0;
  q = new LocalEventQueue({
    clock, scheduler: sched, configDir: ".obsidian", index: ix,
    sink: {
      markDirty: (key, reason) => rec.dirty.push({ key, reason, at: clock.monotonic() }),
      rename: (from, to, groupId) => { rec.renames.push({ from, to, ...(groupId ? { groupId } : {}) }); },
      scheduleScan: (m) => rec.scans.push(m),
      onError: (e) => rec.errors.push(e),
    },
    stat: (p) => fs.stat(p),
    hashNow: async (p) => (await readAndHash(fs, p)).hash,
    newGroupId: () => `g${++g}`,
  });
});

afterEach(() => {
  expect(sched.errors).toEqual([]);
  expect(rec.errors).toEqual([]);
});

const ev = (e: LocalEvent) => q.handle(e);

async function track(path: string, content: string, fileId = F): Promise<void> {
  fs.seed({ [path]: content });
  const h = await readAndHash(fs, path);
  await ix.createEntry({ fileId, path, scope: "active", kind: "note", obs: { mtime: clock.now(), size: h.size, hash: h.hash } });
}

describe("debounce (design §3.5)", () => {
  it("settles 1500 ms after the last event", async () => {
    ev({ t: "modify", path: "a.md" });
    await sched.advance(1000);
    ev({ t: "modify", path: "a.md" });
    await sched.advance(1000);
    ev({ t: "modify", path: "a.md" });
    await sched.advance(DEBOUNCE_SETTLE_MS - 1);
    expect(rec.dirty).toEqual([]);
    await sched.advance(1);
    expect(rec.dirty).toEqual([{ key: { path: "a.md" }, reason: "event", at: 3500 }]);
  });

  it("flushes at the 10 s max wait under a continuous stream", async () => {
    for (let t = 0; t < 15_000; t += 1000) {
      ev({ t: "modify", path: "busy.md" });
      await sched.advance(1000);
    }
    expect(rec.dirty[0]?.at).toBe(DEBOUNCE_MAX_WAIT_MS);
  });

  it("NFD event paths are normalized; known paths carry the fileId", async () => {
    await track("한글.md", "x");
    ev({ t: "modify", path: "한글.md".normalize("NFD") });
    await sched.advance(DEBOUNCE_SETTLE_MS);
    expect(rec.dirty[0]?.key).toEqual({ fileId: F, path: "한글.md" });
  });

  it("raw events: only under configDir, 2 s debounce", async () => {
    ev({ t: "raw", path: "elsewhere/x" });
    ev({ t: "raw", path: ".obsidian/app.json" });
    await sched.advance(RAW_DEBOUNCE_MS - 1);
    expect(rec.dirty).toEqual([]);
    await sched.advance(1);
    expect(rec.dirty.map((d) => d.key.path)).toEqual([".obsidian/app.json"]);
  });

  it("rescan-hint schedules a fast scan; flushAll empties everything", async () => {
    ev({ t: "rescan-hint" });
    ev({ t: "modify", path: "a.md" });
    q.flushAll();
    expect(rec.scans).toEqual(["fast"]);
    expect(rec.dirty.length).toBe(1);
    expect(q.pendingPaths).toBe(0);
  });
});

describe("delete + create pairing (I18)", () => {
  it("unlink + add with equal content inside the window is one move", async () => {
    await track("old/a.md", "hello");
    fs.external.remove("old/a.md");
    ev({ t: "delete", path: "old/a.md", kind: "file" });
    await sched.advance(100);
    fs.external.write("new/a.md", "hello");
    ev({ t: "create", path: "new/a.md" });
    await q.idle();
    expect(rec.renames).toEqual([{ from: "old/a.md", to: "new/a.md" }]);
    await sched.advance(DELETE_HOLD_MS + DEBOUNCE_SETTLE_MS);
    expect(rec.dirty).toEqual([]);
  });

  it("a delete with no matching create becomes missing after 500 ms", async () => {
    await track("a.md", "hello");
    ev({ t: "delete", path: "a.md" });
    await sched.advance(DELETE_HOLD_MS - 1);
    expect(rec.dirty).toEqual([]);
    await sched.advance(1);
    expect(rec.dirty).toEqual([{ key: { fileId: F, path: "a.md" }, reason: "missing", at: DELETE_HOLD_MS }]);
  });

  it("same size, different content: no pairing", async () => {
    await track("a.md", "hello");
    ev({ t: "delete", path: "a.md" });
    fs.external.write("b.md", "jello");
    ev({ t: "create", path: "b.md" });
    await q.idle();
    await sched.advance(DEBOUNCE_SETTLE_MS);
    expect(rec.renames).toEqual([]);
    expect(rec.dirty.map((d) => `${d.reason}:${d.key.path}`).sort()).toEqual(["event:b.md", "missing:a.md"]);
  });

  it("an untracked delete is missing immediately", () => {
    ev({ t: "delete", path: "ghost.md" });
    expect(rec.dirty).toEqual([{ key: { path: "ghost.md" }, reason: "missing", at: 0 }]);
  });
});

describe("folders and renames (design §3.5, pain 13-14)", () => {
  it("a folder delete expands to every entry under it", async () => {
    await track("d/a.md", "1", F);
    await track("d/s/b.md", "2", G);
    ev({ t: "delete", path: "d" });
    expect(rec.dirty.map((d) => `${d.reason}:${d.key.fileId}`).sort()).toEqual([`missing:${F}`, `missing:${G}`]);
  });

  it("a folder rename expands with one shared groupId", async () => {
    await track("d/a.md", "1", F);
    await track("d/s/b.md", "2", G);
    ev({ t: "rename", from: "d", to: "e/d", kind: "folder" });
    await q.idle();
    expect(rec.renames.sort((x, y) => x.from.localeCompare(y.from))).toEqual([
      { from: "d/a.md", to: "e/d/a.md", groupId: "g1" },
      { from: "d/s/b.md", to: "e/d/s/b.md", groupId: "g1" },
    ]);
  });

  it("a pending modify follows its file through a rename", async () => {
    await track("a.md", "1");
    ev({ t: "modify", path: "a.md" });
    ev({ t: "rename", from: "a.md", to: "b.md", kind: "file" });
    await q.idle();
    await sched.advance(DEBOUNCE_SETTLE_MS);
    expect(rec.renames).toEqual([{ from: "a.md", to: "b.md" }]);
    expect(rec.dirty.map((d) => d.key.path)).toEqual(["b.md"]);
  });

  it("stop() cancels timers", async () => {
    ev({ t: "modify", path: "a.md" });
    q.stop();
    await sched.advance(20_000);
    expect(rec.dirty).toEqual([]);
    expect(sched.pending).toBe(0);
  });
});

describe("EchoSuppressor (design §3.6.2)", () => {
  it("matches hash and size only, once, within the TTL", () => {
    const c = new FakeClock();
    const e = new EchoSuppressor(c);
    e.expect("a.md", { hash: "h", size: 3 });
    expect(e.consume("a.md", { hash: "h", size: 4 })).toBe(false);
    expect(e.consume("a.md", { hash: "h", size: 3 })).toBe(true);
    expect(e.consume("a.md", { hash: "h", size: 3 })).toBe(false);
    e.expect("b.md", "deleted");
    e.expect("c.md", { renamedFrom: "x.md" });
    expect(e.consume("c.md", { renamedFrom: "y.md" })).toBe(false);
    expect(e.consume("c.md", { renamedFrom: "x.md" })).toBe(true);
    c.tick(ECHO_TTL_MS);
    expect(e.consume("b.md", "deleted")).toBe(false);
    expect(e.pending("b.md")).toBe(false);
  });
});
