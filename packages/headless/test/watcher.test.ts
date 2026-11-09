// Watcher on real inotify (design §6.1.4): event mapping, pruning, new directories, poll fallback on a
// tiny budget, passive miss detection with delivery disabled.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalEvent, LocalStat } from "@shuttle/protocol";
import { NodeLocalFs } from "../src/NodeLocalFs";
import { Watcher } from "../src/watch/Watcher";
import { countWatchedDirs } from "../src/watch/inotifyBudget";
import { memoryLogger } from "../src/log";
import { removeDir, sleep, tempDir, waitFor } from "./tmp";

let base = "";
let vault = "";
let fs: NodeLocalFs;
let events: LocalEvent[];
let w: Watcher | null = null;

beforeEach(async () => {
  base = await tempDir("w");
  vault = path.join(base, "vault");
  await mkdir(path.join(base, "tmp"), { recursive: true });
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await mkdir(path.join(vault, ".git/objects"), { recursive: true });
  fs = new NodeLocalFs({ root: vault, tmpDir: path.join(base, "tmp") });
  events = [];
  fs.onEvent((e) => events.push(e));
});
afterEach(async () => {
  w?.stop();
  w = null;
  await removeDir(base);
});

const has = (pred: (e: LocalEvent) => boolean) => () => events.some(pred);
const bigBudget = { maxUserWatches: async () => 1_000_000, usedWatches: async () => 0 };

async function drain(fs2: NodeLocalFs): Promise<LocalStat[]> {
  const out: LocalStat[] = [];
  for await (const b of fs2.listAll({ includeConfigDir: false })) out.push(...b);
  return out;
}

describe("Watcher", () => {
  it("maps create, modify, delete; ignores dot dirs; watches new folders", async () => {
    w = new Watcher({ fs, mode: "hybrid", probe: bigBudget, missGraceMs: 0 });
    await w.start();
    expect(w.stats.dirs).toBe(2);                         // root + notes; .git is never watched
    await writeFile(path.join(vault, "notes/a.md"), "a");
    await waitFor(has((e) => (e.t === "create" || e.t === "modify") && e.path === "notes/a.md"), 10_000, 20, "create");
    await writeFile(path.join(vault, ".git/objects/x"), "x");
    await rm(path.join(vault, "notes/a.md"));
    await waitFor(has((e) => e.t === "delete" && e.path === "notes/a.md"), 10_000, 20, "delete");
    expect(events.some((e) => "path" in e && e.path.startsWith(".git"))).toBe(false);
    await mkdir(path.join(vault, "new/sub"), { recursive: true });
    await waitFor(() => (w?.stats.dirs ?? 0) >= 4, 10_000, 20, "new dirs watched");
    await writeFile(path.join(vault, "new/sub/b.md"), "b");
    await waitFor(has((e) => (e.t === "create" || e.t === "modify") && e.path === "new/sub/b.md"), 10_000, 20, "nested create");
    // Folder delete: one folder event; watchers for the subtree are dropped.
    await rm(path.join(vault, "new"), { recursive: true });
    await waitFor(has((e) => e.t === "delete" && e.path === "new"), 10_000, 20, "folder delete");
    await waitFor(() => w?.stats.dirs === 2, 10_000, 20, "unwatched");
  });

  it("a rename arrives as delete + create (paired by the engine)", async () => {
    await writeFile(path.join(vault, "notes/x.md"), "x");
    w = new Watcher({ fs, mode: "hybrid", probe: bigBudget });
    await w.start();
    await rename(path.join(vault, "notes/x.md"), path.join(vault, "y.md"));
    await waitFor(has((e) => e.t === "delete" && e.path === "notes/x.md"), 10_000, 20, "rename source");
    await waitFor(has((e) => e.t === "create" && e.path === "y.md"), 10_000, 20, "rename target");
  });

  it("falls back to polling on a tiny inotify budget", async () => {
    const log = memoryLogger();
    w = new Watcher({ fs, mode: "hybrid", log, probe: { maxUserWatches: async () => 100, usedWatches: async () => 0 } });
    await w.start();
    expect(w.stats.mode).toBe("poll");
    expect(w.stats.degraded).toBe(true);
    expect(w.stats.dirs).toBe(0);
    expect(log.lines.some((l) => l.includes("inotify budget exhausted"))).toBe(true);
    expect(await countWatchedDirs(fs, { includeConfigDir: false })).toBe(2);
  });

  it("counts changes the watcher never delivered and degrades after 3 scans with misses", async () => {
    w = new Watcher({ fs, mode: "hybrid", probe: bigBudget, missGraceMs: 0 });
    await w.start();
    await drain(fs);                                      // baseline listing
    w.deliver = false;
    // Delivery disabled: events still mark paths as reported, so drop that too by stopping the watch.
    (w as unknown as { reported: Map<string, number> }).reported.clear();
    for (let i = 0; i < 3; i++) {
      w.stop();
      await w.start();                                    // restart keeps counters; scan subscription renewed
      (w as unknown as { closeAll(): void }).closeAll();  // no watchers: nothing is reported
      await writeFile(path.join(vault, `notes/m${i}.md`), "m");
      await sleep(20);
      await drain(fs);
    }
    expect(w.stats.missedByWatcher).toBe(3);
    expect(w.stats.mode).toBe("poll");
    expect(w.stats.degradedReason).toMatch(/missed/);
  });

  it("an event for a vanished file never throws", async () => {
    w = new Watcher({ fs, mode: "hybrid", probe: bigBudget });
    await w.start();
    for (let i = 0; i < 50; i++) {
      const p = path.join(vault, `notes/t${i}.md`);
      await writeFile(p, "t");
      await rm(p);
    }
    await sleep(300);
    expect(w.stats.errors).toBe(0);
  });
});
