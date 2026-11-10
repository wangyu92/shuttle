// Lead decisions D8, D10, D11 (클로드 제안(미승인)): merge writes and pull applies never leave the target
// torn or missing (design §3.2 "temp file + rename", §3.8.4, §3.18 I6). Sim seeds 730 and 634 lost a
// user edit when a torn merge write destroyed the note and the state store (the only other copy) was
// then evicted. The tests run on every replace shape: 'rename' (D8, desktop), 'atomic' (D10, write()
// replaces atomically, headless) and 'swap' (D11, no rename over an existing file, Obsidian mobile).
import { describe, expect, it } from "vitest";
import { LocalFsError, MemLocalFs, MemStateStore, type FsOp, type MemReplaceMode } from "@shuttle/testkit";
import {
  BACKUP_DIR_PREFIX, FileIndex, REPLACE_TEMP_PREFIX, SwapPendingError, SwapRecovery, WriteIntents, backupTarget, isReplaceTemp,
  replaceFile, swapLeftovers,
} from "../src/index";
import { Crash } from "./harness";
import { Node, isCrashLike, makeWorld, syncAll } from "./engineHarness";

const te = new TextEncoder();
const td = new TextDecoder();
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of the note\n`);
const BASE = lines(12).join("");
const REMOTE_EDIT = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; return l.join(""); })();
const LOCAL_EDIT = (() => { const l = lines(12); l[9] = "line 9 tok-B ON BETA\n"; return l.join(""); })();
const MODES: MemReplaceMode[] = ["rename", "atomic", "swap"];
const MUTATING: ReadonlySet<FsOp> = new Set<FsOp>(["write", "rename", "remove", "mkdir", "rmdir"]);

async function listEverything(fs: MemLocalFs): Promise<string[]> {
  const out: string[] = [];
  for await (const b of fs.listAll({ includeConfigDir: true })) for (const s of b) out.push(s.path);
  return out;
}
const internal = (paths: string[]) => paths.filter((p) => p.split("/").some((s) => s.startsWith(".shuttle-")));
const texts = (n: Node) => [...n.fs.files().values()].map((x) => td.decode(x)).join("|");

/** alpha pushed REMOTE_EDIT; beta holds the unpushed LOCAL_EDIT and will merge on its next sync. */
async function mergeWorld(seed: string, mode: MemReplaceMode, emitOwnEvents = false) {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  const b = new Node(w, { name: "beta", replace: mode, emitOwnEvents });
  a.fs.seed({ "doc.md": BASE });
  await a.start(); await b.start();
  await syncAll([a, b]);
  w.clock.tick(1000);
  a.fs.external.write("doc.md", REMOTE_EDIT, { mtime: w.clock.now() });
  a.engine.requestScan();
  await a.sync();
  w.clock.tick(1000);
  b.fs.seed({ "doc.md": LOCAL_EDIT }, { mtime: w.clock.now() });
  return { w, a, b };
}

describe.each(MODES)("replace mode %s", (mode) => {
  it("torn merge write, process dies, state store evicted: both edits survive", async () => {
    const { a, b } = await mergeWorld(`d8-evict-${mode}`, mode);
    let tornPath = "";
    b.fs.tearNextWrite({
      path: "doc.md", fraction: 0.4,
      onTear: (p) => { tornPath = p; b.crashed = true; b.store.crash(); throw new Crash("torn write"); },
    });
    b.engine.requestScan();
    await syncAll([b]).catch((e: unknown) => { if (!isCrashLike(e)) throw e; });
    expect(b.fs.torn.length).toBe(1);
    // D10: the atomic write tears its own hidden temp; D8/D11: the engine's replace temp.
    if (mode === "atomic") expect(tornPath).toBe("doc.md");
    else expect(isReplaceTemp(tornPath)).toBe(true);
    // The note was never touched: it still holds the unpushed local edit.
    expect(b.fs.readText("doc.md")).toBe(LOCAL_EDIT);
    // iOS-style eviction: the state store (staged merge, intents, bases) is gone.
    await b.restart({ wipeState: true });
    await syncAll([a, b], 80);
    for (const n of [a, b]) {
      expect(texts(n), `${n.o.name} keeps beta's edit`).toContain("tok-B");
      expect(texts(n), `${n.o.name} keeps alpha's edit`).toContain("tok-A");
    }
    // The temp left by the tear is swept at startup.
    expect(internal(await listEverything(b.fs))).toEqual([]);
  });

  it("replaceFile never removes the target first; a failed step leaves it whole", async () => {
    const fs = new MemLocalFs({ replace: mode });
    await fs.write("n.md", te.encode("old\n"), { mtime: 1 });
    if (mode === "atomic") fs.failNext("write", "EIO");
    else fs.failNext("rename", "EIO");
    await expect(replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 2 })).rejects.toThrow();
    expect(fs.readText("n.md")).toBe("old\n");
    expect(await listEverything(fs)).toEqual(["n.md"]);
    const st = await replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 3 });
    expect(fs.readText("n.md")).toBe("new\n");
    expect(st.size).toBe(4);
    expect(await listEverything(fs)).toEqual(["n.md"]);
  });

  it("the pre-replace bytes are on disk at every fs operation", async () => {
    const fs = new MemLocalFs({ replace: mode });
    fs.seed({ "d/n.md": "old bytes\n" });
    const holders = (): string[] => [...fs.files().entries()].filter(([, v]) => td.decode(v) === "old bytes\n").map(([k]) => k);
    let ops = 0;
    let tempWrites = 0;
    const h = fs.before((op, p) => {
      ops++;
      if (op === "write" && isReplaceTemp(p)) tempWrites++;
      if (fs.readText("d/n.md") !== "new bytes\n") expect(holders().length, `op ${ops}`).toBeGreaterThan(0);
    });
    await replaceFile(fs, "d/n.md", te.encode("new bytes\n"), { mtime: 2 });
    h.dispose();
    expect(fs.readText("d/n.md")).toBe("new bytes\n");
    expect(await listEverything(fs)).toEqual(["d", "d/n.md"]);
    // D10: one write, no temp; the other shapes write a temp first.
    expect(tempWrites).toBe(mode === "atomic" ? 0 : 1);
  });
});

describe("D8 rename convention", () => {
  it("only a rename from a replace temp may overwrite an existing file", async () => {
    const fs = new MemLocalFs();
    await fs.write("a.md", te.encode("a\n"), { mtime: 1 });
    await fs.write("b.md", te.encode("b\n"), { mtime: 1 });
    await expect(fs.rename("a.md", "b.md")).rejects.toMatchObject({ code: "EEXIST" });
    await fs.write(`${REPLACE_TEMP_PREFIX}x`, te.encode("t\n"), { mtime: 1 });
    await fs.rename(`${REPLACE_TEMP_PREFIX}x`, "b.md");
    expect(fs.readText("b.md")).toBe("t\n");
  });

  it("swap mode refuses even a replace temp", async () => {
    const fs = new MemLocalFs({ replace: "swap" });
    await fs.write("b.md", te.encode("b\n"), { mtime: 1 });
    await fs.write(`${REPLACE_TEMP_PREFIX}x`, te.encode("t\n"), { mtime: 1 });
    await expect(fs.rename(`${REPLACE_TEMP_PREFIX}x`, "b.md")).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("D11 swap", () => {
  it("goes target → backup folder → temp into place → backup removed, never writing over the target", async () => {
    const fs = new MemLocalFs({ replace: "swap" });
    fs.seed({ "d/n.md": "old\n" });
    const log: string[] = [];
    fs.before((op, p) => { if (MUTATING.has(op)) log.push(`${op} ${p}`); });
    await replaceFile(fs, "d/n.md", te.encode("new\n"), { mtime: 2 });
    expect(log).toEqual([
      "mkdir d", `write d/${REPLACE_TEMP_PREFIX}1`, `mkdir d/${BACKUP_DIR_PREFIX}2`, "rename d/n.md",
      `rename d/${REPLACE_TEMP_PREFIX}1`, `remove d/${BACKUP_DIR_PREFIX}2/n.md`, `rmdir d/${BACKUP_DIR_PREFIX}2`,
    ]);
    expect(log.some((l) => l === "write d/n.md")).toBe(false);
    expect(fs.readText("d/n.md")).toBe("new\n");
  });

  it("a platform that does not declare the capability: EEXIST on the replace rename falls back to the swap", async () => {
    const fs = new MemLocalFs({ replace: "swap", declareReplace: false });
    expect(fs.renameReplaces).toBeUndefined();
    await fs.write("n.md", te.encode("old\n"), { mtime: 1 });
    const writes: string[] = [];
    fs.before((op, p) => { if (op === "write") writes.push(p); });
    await replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 2 });
    expect(writes).toEqual([`${REPLACE_TEMP_PREFIX}1`]);          // no in-place write of the target
    expect(fs.readText("n.md")).toBe("new\n");
    expect(await listEverything(fs)).toEqual(["n.md"]);
  });

  it("a failed temp → target rename puts the old file back", async () => {
    const fs = new MemLocalFs({ replace: "swap" });
    await fs.write("n.md", te.encode("old\n"), { mtime: 1 });
    fs.before((op, p) => { if (op === "rename" && isReplaceTemp(p)) throw new LocalFsError("EIO", p, "injected"); });
    await expect(replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 2 })).rejects.toThrow("injected");
    expect(fs.readText("n.md")).toBe("old\n");
    expect(await listEverything(fs)).toEqual(["n.md"]);
    expect(swapLeftovers(fs)).toEqual([]);
  });

  it("rollback fails too: the backup stays, the next replace resolves it first (restore, then replace)", async () => {
    const fs = new MemLocalFs({ replace: "swap" });
    await fs.write("n.md", te.encode("old\n"), { mtime: 1 });
    let fail = true;
    fs.before((op, p) => {
      if (fail && op === "rename" && (isReplaceTemp(p) || backupTarget(p) !== null)) throw new LocalFsError("EIO", p, "injected");
    });
    await expect(replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 2 })).rejects.toThrow("injected");
    expect(fs.readText("n.md")).toBe(null);
    const left = swapLeftovers(fs);
    expect(left.map((l) => l.state)).toEqual(["unresolved"]);
    expect(fs.readText(left[0]!.backup)).toBe("old\n");
    fail = false;
    // Without a resolver (no engine) the replace refuses rather than drop the backup.
    await expect(replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 3 })).rejects.toBeInstanceOf(SwapPendingError);
    const state = new MemStateStore();
    const intents = new WriteIntents({ state, fs });
    const rec = new SwapRecovery({
      fs, index: { byPath: () => null } as unknown as FileIndex, intents,
      conflictPath: async (p) => `${p}.copy`, markDirty: () => undefined,
    });
    rec.install();
    await replaceFile(fs, "n.md", te.encode("new\n"), { mtime: 3 });
    rec.uninstall();
    expect(fs.readText("n.md")).toBe("new\n");
    expect(await listEverything(fs)).toEqual(["n.md"]);
  });

  it("startup recovery: missing target restored, unaccounted backup kept as a copy, temps swept", async () => {
    const fs = new MemLocalFs({ replace: "swap" });
    fs.seed({
      [`a/${BACKUP_DIR_PREFIX}1/x.md`]: "x old\n", [`a/${REPLACE_TEMP_PREFIX}1`]: "x new\n",
      "b/y.md": "y new\n", [`b/${BACKUP_DIR_PREFIX}4/y.md`]: "y user edit\n",
      "c/z.md": "z same\n", [`c/${BACKUP_DIR_PREFIX}9/z.md`]: "z same\n",
    });
    fs.external.mkdir(`c/${BACKUP_DIR_PREFIX}3`);
    const state = new MemStateStore();
    const rec = new SwapRecovery({
      fs, index: { byPath: () => null } as unknown as FileIndex, intents: new WriteIntents({ state, fs }),
      conflictPath: async (p) => p.replace(/\.md$/, " (copy).md"), markDirty: () => undefined,
    });
    const out = await rec.startup();
    expect(out.map((o) => o.outcome).sort()).toEqual(["copied", "dropped", "restored"]);
    expect(Object.fromEntries([...fs.files()].map(([k, v]) => [k, td.decode(v)]))).toEqual({
      "a/x.md": "x old\n", "b/y (copy).md": "y user edit\n", "b/y.md": "y new\n", "c/z.md": "z same\n",
    });
    expect(internal(await listEverything(fs))).toEqual([]);
  });
});

describe("D11 crash enumeration (seed-730 style merge write on a swap platform)", () => {
  const isSwapOp = (op: FsOp, p: string) => MUTATING.has(op) && (p === "doc.md" || p.includes(".shuttle-"));

  /** Count the swap's fs mutations of one clean merge sync. */
  async function countOps(): Promise<number> {
    const { b } = await mergeWorld("d11-count", "swap");
    let n = 0;
    const h = b.fs.before((op, p) => { if (isSwapOp(op, p)) n++; });
    b.engine.requestScan();
    await syncAll([b]);
    h.dispose();
    return n;
  }

  it("crash before every step, with and without state eviction: no edit lost, no leftovers", async () => {
    const total = await countOps();
    expect(total).toBeGreaterThanOrEqual(6);
    const states = new Set<string>();
    for (const wipeState of [false, true]) {
      for (let k = 1; k <= total + 1; k++) {
        const label = `crash before swap op ${k}/${total} wipe=${wipeState}`;
        const { a, b } = await mergeWorld(`d11-${k}-${wipeState}`, "swap");
        let n = 0;
        let crashed = false;
        const h = b.fs.before((op, p) => {
          // The pre-merge bytes (tok-B) are somewhere on disk at every instant.
          expect(texts(b), `${label}: ${op} ${p}`).toContain("tok-B");
          if (crashed || !isSwapOp(op, p)) return;
          n++;
          if (n === k) {
            const bak = [...b.fs.files().keys()].some((x) => backupTarget(x) === "doc.md");
            states.add(`${b.fs.readText("doc.md") === null ? "target missing" : "target present"}${bak ? " + backup" : ""}`);
            crashed = true;
            b.crashed = true;
            b.store.crash();
            throw new Crash(label);
          }
        });
        b.engine.requestScan();
        await syncAll([b]).catch((e: unknown) => { if (!isCrashLike(e)) throw e; });
        h.dispose();
        expect(texts(b), label).toContain("tok-B");
        await b.restart({ wipeState });
        await syncAll([a, b], 80);
        for (const node of [a, b]) {
          expect(texts(node), `${label}: ${node.o.name} keeps beta's edit`).toContain("tok-B");
          expect(texts(node), `${label}: ${node.o.name} keeps alpha's edit`).toContain("tok-A");
        }
        expect(internal(await listEverything(b.fs)), label).toEqual([]);
        expect(b.fs.readText("doc.md"), label).not.toBe(null);
        // Without eviction every crash state resolves to restored or dropped, never to a copy.
        if (!wipeState) expect([...b.fs.files().keys()].filter((p) => p.includes("Conflicted copy")), label).toEqual([]);
      }
    }
    // Every intermediate state of the swap was hit by some crash.
    expect([...states].sort()).toEqual(["target missing + backup", "target present", "target present + backup"]);
  });

  it("pull apply over the synced base: crash before every swap step, with and without eviction", async () => {
    const isOp = (op: FsOp, p: string) => MUTATING.has(op) && (p === "doc.md" || p.includes(".shuttle-"));
    const NEXT = `${REMOTE_EDIT}tail from alpha\n`;
    async function world(seed: string) {
      const w = await makeWorld(seed);
      const a = new Node(w, { name: "alpha" });
      const b = new Node(w, { name: "beta", replace: "swap" });
      a.fs.seed({ "doc.md": BASE });
      await a.start(); await b.start();
      await syncAll([a, b]);
      w.clock.tick(1000);
      a.fs.external.write("doc.md", NEXT, { mtime: w.clock.now() });
      a.engine.requestScan();
      await a.sync();
      return { a, b };
    }
    const probe = await world("d11-pull-count");
    let total = 0;
    const hp = probe.b.fs.before((op, p) => { if (isOp(op, p)) total++; });
    await syncAll([probe.b]);
    hp.dispose();
    expect(probe.b.fs.readText("doc.md")).toBe(NEXT);
    expect(total).toBeGreaterThanOrEqual(6);
    for (const wipeState of [false, true]) {
      for (let k = 1; k <= total + 1; k++) {
        const label = `pull: crash before swap op ${k}/${total} wipe=${wipeState}`;
        const { a, b } = await world(`d11-pull-${k}-${wipeState}`);
        let n = 0;
        let crashed = false;
        const h = b.fs.before((op, p) => {
          // The base bytes or the new head are on disk at every instant.
          const all = texts(b);
          expect(all.includes(BASE) || all.includes(NEXT), `${label}: ${op} ${p}`).toBe(true);
          if (crashed || !isOp(op, p)) return;
          if (++n === k) {
            crashed = true;
            b.crashed = true;
            b.store.crash();
            throw new Crash(label);
          }
        });
        await syncAll([b]).catch((e: unknown) => { if (!isCrashLike(e)) throw e; });
        h.dispose();
        await b.restart({ wipeState });
        await syncAll([a, b], 80);
        expect(b.fs.readText("doc.md"), label).toBe(NEXT);
        expect(a.fs.readText("doc.md"), label).toBe(NEXT);
        expect(internal(await listEverything(b.fs)), label).toEqual([]);
        const copies = [...b.fs.files().keys()].filter((p) => p.includes("Conflicted copy"));
        // Without eviction the old base is provably on the remote: never a copy. After eviction the
        // engine cannot tell, so at most one copy of the old base may appear (D11 risk column).
        if (!wipeState) expect(copies, label).toEqual([]);
        else for (const c of copies) expect(b.fs.readText(c), label).toBe(BASE);
      }
    }
  });

  it("own fs events of the swap (target → backup) never turn into a pushed delete", async () => {
    const { w, a, b } = await mergeWorld("d11-events", "swap", true);
    b.engine.requestScan();
    await syncAll([a, b], 80);
    for (const node of [a, b]) {
      expect(node.fs.readText("doc.md"), node.o.name).toContain("tok-A");
      expect(node.fs.readText("doc.md"), node.o.name).toContain("tok-B");
    }
    // A plain pull over an existing file on the swap device, with events on.
    w.clock.tick(1000);
    a.fs.external.write("doc.md", `${REMOTE_EDIT}tail from alpha\n`, { mtime: w.clock.now() });
    a.engine.requestScan();
    await syncAll([a, b], 80);
    await b.flushEvents();
    await syncAll([a, b], 80);
    expect(b.fs.readText("doc.md")).toContain("tail from alpha");
    expect(a.fs.readText("doc.md")).toContain("tail from alpha");
    expect(internal(await listEverything(b.fs))).toEqual([]);
  });
});
