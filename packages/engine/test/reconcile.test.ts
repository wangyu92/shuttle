// Reconciler, Scanner, LocalRenames and helpers against the testkit fakes (design §3.4, §3.6.1, I19, I23).
import type { FileEntry, RemoteHead, Scope } from "@shuttle/protocol";
import { FakeClock, FakeScheduler, MemLocalFs, MemStateStore } from "@shuttle/testkit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DirtySet, EchoSuppressor, FileIndex, KeyedMutex, LocalRenames, Reconciler, isConfigJson, kindOf, newFileId, observationOf, readAndHash,
  scanLocal, type Action, type ActionExecutor, type ExecContext, type ReconcileSettings, type PlanCtx,
} from "../src/index";

const CFG = ".obsidian";
const scopeOf = (p: string, size?: number): Scope => {
  if (p.split("/").some((s, i) => s.startsWith(".") && !(i === 0 && s === CFG))) return "ignored";
  if (p.startsWith("excluded/")) return "excluded";
  if (size !== undefined && size > 1000) return "oversize";
  return "active";
};

class RecordingExecutor implements ActionExecutor {
  readonly calls: Array<{ action: Action; c: ExecContext }> = [];
  constructor(private readonly ix: FileIndex, private readonly now: () => number) {}
  async execute(action: Action, c: ExecContext): Promise<void> {
    this.calls.push({ action, c });
    // design §3.4.4: PUSH_CREATE creates the FileEntry (fresh fileId, synced null, obs L) before enqueueing.
    if (action.type === "PUSH_CREATE" && action.fileId === null && c.L && c.stat) {
      await this.ix.createEntry({ fileId: newFileId(), path: c.L.path, scope: "active", kind: c.kind, obs: observationOf(c.stat, c.L.hash) });
    }
  }
}

let clock: FakeClock;
let sched: FakeScheduler;
let fs: MemLocalFs;
let store: MemStateStore;
let ix: FileIndex;
let dirty: DirtySet;
let echo: EchoSuppressor;
let exec: RecordingExecutor;
let settings: ReconcileSettings;
let ctx: PlanCtx;
let locked: boolean;
let rec: Reconciler;

function makeReconciler(platformFs = fs): Reconciler {
  return new Reconciler({
    fs: platformFs, index: ix, locks: new KeyedMutex(), echo, scopeOf,
    kindOf: (p) => kindOf(p, CFG), isConfigJson: (p) => isConfigJson(p, CFG),
    hashFile: async (p) => { const h = await readAndHash(platformFs, p); return { hash: h.hash, size: h.size }; },
    settings: () => settings, ctx: () => ctx, executor: exec, markDirty: (k, r) => dirty.mark(k, r), isLocked: () => locked,
  });
}

beforeEach(async () => {
  clock = new FakeClock();
  sched = new FakeScheduler(clock);
  fs = new MemLocalFs({ clock, emitOwnEvents: false });
  store = new MemStateStore();
  ix = await FileIndex.load(store, () => clock.now());
  dirty = new DirtySet();
  echo = new EchoSuppressor(clock);
  exec = new RecordingExecutor(ix, () => clock.now());
  settings = { conflictMode: "merge", mode: "bidirectional" };
  ctx = { mode: "incremental" };
  locked = false;
  rec = makeReconciler();
});

async function synced(path: string, content: string, version = 5): Promise<FileEntry> {
  fs.seed({ [path]: content });
  const st = (await fs.stat(path))!;
  const h = await readAndHash(fs, path);
  const fileId = newFileId();
  await ix.createEntry({ fileId, path, scope: "active", kind: kindOf(path, CFG), obs: observationOf(st, h.hash) });
  await ix.update(fileId, (e) => { e.synced = { version, path, hash: h.hash, size: h.size, mtime: st.mtime, hasBase: false }; });
  await ix.upsertRemote(remoteHead(fileId, version, path, h.hash, h.size));
  return ix.byFileId(fileId)!;
}

function remoteHead(fileId: string, seq: number, path: string, hash: string | null, size = 1, deleted = false): RemoteHead {
  return { fileId, seq, base: null, pathKey: "pk:" + path.toLowerCase(), path, deleted, size, mtime: 1, contentHash: hash, chunkSizes: [], blobs: [], kv: 1, deviceId: "dev", ts: 1 };
}

const lastAction = (): Action => exec.calls[exec.calls.length - 1]!.action;

describe("Reconciler.reconcile (design §3.4.4)", () => {
  it("a new local file → N1 PUSH_CREATE and an entry with a fresh fileId", async () => {
    fs.seed({ "n.md": "hello" });
    const out = await rec.reconcile({ path: "n.md" });
    expect(out).toMatchObject({ t: "planned", action: { type: "PUSH_CREATE", row: "N1", fileId: null } });
    const e = ix.byPath("n.md")!;
    expect(e.synced).toBeNull();
    expect(e.obs?.hash).toBe((await readAndHash(fs, "n.md")).hash);
  });

  it("unchanged file: fast path, no read, S1", async () => {
    const e = await synced("a.md", "x");
    const reads = fs.stats.reads;
    await rec.reconcile({ fileId: e.fileId, path: e.path });
    expect(fs.stats.reads).toBe(reads);
    expect(lastAction()).toMatchObject({ row: "S1", type: "NOOP" });
  });

  it("edited file: hashes and pushes S2 with base = B.version, then records obs", async () => {
    const e = await synced("a.md", "x");
    clock.tick(5000);
    fs.external.write("a.md", "xy");
    await rec.reconcile({ fileId: e.fileId, path: e.path });
    expect(lastAction()).toMatchObject({ row: "S2", type: "PUSH_PUT", base: 5 });
    expect(ix.byFileId(e.fileId)!.obs?.size).toBe(2);
  });

  it("remote changed, local unchanged → PULL; pull-only does not block pulls; pull-only blocks pushes", async () => {
    const e = await synced("a.md", "x");
    await ix.upsertRemote(remoteHead(e.fileId, 9, "a.md", "other"));
    await rec.reconcile({ fileId: e.fileId, path: e.path });
    expect(lastAction()).toMatchObject({ row: "S6", type: "PULL", seq: 9 });
    const f = await synced("b.md", "y");
    clock.tick(1000);
    fs.external.write("b.md", "yy");
    settings = { ...settings, mode: "pull-only" };
    await rec.reconcile({ fileId: f.fileId, path: f.path });
    expect(lastAction()).toMatchObject({ type: "NOOP", why: "pull-only" });
  });

  it("deleted locally → S5 PUSH_DELETE", async () => {
    const e = await synced("a.md", "x");
    fs.external.remove("a.md");
    await rec.reconcile({ fileId: e.fileId, path: e.path });
    expect(lastAction()).toMatchObject({ row: "S5", type: "PUSH_DELETE", base: 5 });
  });

  it("incremental mode with a base but no remote head → INTEGRITY_ERROR (I21b)", async () => {
    const e = await synced("a.md", "x");
    await ix.write([], (w) => w.deleteRemote(e.fileId));
    fs.external.remove("a.md");
    await rec.reconcile({ fileId: e.fileId, path: e.path });
    expect(lastAction()).toMatchObject({ type: "INTEGRITY_ERROR" });
  });

  it("no base, remote holds equal content at the same foldKey → N3 ADOPT", async () => {
    fs.seed({ "Same.md": "content" });
    const h = await readAndHash(fs, "Same.md");
    const other = newFileId();
    await ix.upsertRemote(remoteHead(other, 3, "same.md", h.hash, h.size));
    await rec.reconcile({ path: "Same.md" });
    expect(lastAction()).toMatchObject({ row: "N3", type: "ADOPT", fileId: other, preRename: { from: "Same.md", to: "same.md" } });
  });

  it("PATH_TAKEN holder in the dirty key → P1", async () => {
    fs.seed({ "p.md": "mine" });
    const holder = remoteHead(newFileId(), 4, "p.md", "theirs");
    await rec.reconcile({ path: "p.md", pathTaken: holder });
    expect(lastAction()).toMatchObject({ row: "P1", type: "KEEP_BOTH" });
  });

  it("echo of our own write (content is the synced base): obs updated, nothing planned", async () => {
    const e = await synced("a.md", "x");
    clock.tick(1000);
    // The apply transaction already recorded the new base; the write's event arrives afterwards.
    fs.external.write("a.md", "x");
    const h = await readAndHash(fs, "a.md");
    echo.expect("a.md", { hash: h.hash, size: h.size });
    expect(await rec.reconcile({ fileId: e.fileId, path: e.path })).toEqual({ t: "echo" });
    expect(exec.calls).toEqual([]);
    expect(ix.byFileId(e.fileId)!.obs?.hash).toBe(h.hash);
  });

  it("an echo match never hides content that differs from the base (design §3.6.2)", async () => {
    // A user edit that equals bytes the engine wrote earlier (a stale expectation) is still planned.
    const e = await synced("a.md", "x");
    clock.tick(1000);
    fs.external.write("a.md", "written by engine earlier, now typed by the user");
    const h = await readAndHash(fs, "a.md");
    echo.expect("a.md", { hash: h.hash, size: h.size });
    expect(await rec.reconcile({ fileId: e.fileId, path: e.path })).toMatchObject({ t: "planned" });
    expect(lastAction()).toMatchObject({ type: "PUSH_PUT", row: "S2", fileId: e.fileId });
    expect(ix.byFileId(e.fileId)!.obs?.hash).toBe(h.hash);
  });

  it("Locked: no hashing, the key goes back to the dirty set", async () => {
    fs.seed({ "n.md": "x" });
    locked = true;
    expect(await rec.reconcile({ path: "n.md" })).toEqual({ t: "locked" });
    expect(dirty.has({ path: "n.md" })).toBe(true);
    expect(fs.stats.reads).toBe(0);
  });

  it("file vanishing between stat and read is a missing re-check, not an exception", async () => {
    fs.seed({ "v.md": "x" });
    fs.vanishBeforeRead("v.md");
    expect(await rec.reconcile({ path: "v.md" })).toEqual({ t: "vanished" });
    expect(dirty.peek()[0]).toMatchObject({ reason: "missing" });
  });

  it("scope gate: out-of-scope paths are tracked with their flag and never planned (I13, I14)", async () => {
    fs.seed({ "excluded/x.md": "x", ".git/config": "y", "big.md": "z".repeat(2000) });
    expect(await rec.reconcile({ path: "excluded/x.md" })).toEqual({ t: "scope" });
    expect(await rec.reconcile({ path: ".git/config" })).toEqual({ t: "scope" });
    expect(await rec.reconcile({ path: "big.md" })).toEqual({ t: "scope" });
    expect(ix.byPath("excluded/x.md")?.scope).toBe("excluded");
    expect(ix.byPath("big.md")?.scope).toBe("oversize");
    expect(ix.byPath(".git/config")).toBeNull();
    expect(exec.calls).toEqual([]);
    expect(fs.stats.reads).toBe(0); // I25: oversize files are never read
  });

  it("an entry whose scope changed is re-flagged; synced state is kept (I12)", async () => {
    const e = await synced("a.md", "x");
    fs.external.write("a.md", "z".repeat(2000));
    await rec.reconcile({ fileId: e.fileId, path: e.path });
    const after = ix.byFileId(e.fileId)!;
    expect(after.scope).toBe("oversize");
    expect(after.synced).not.toBeNull();
  });

  it("integrity hold → nothing", async () => {
    const e = await synced("a.md", "x");
    await ix.update(e.fileId, (x) => { x.integrityHold = true; });
    fs.external.write("a.md", "changed");
    expect(await rec.reconcile({ fileId: e.fileId, path: e.path })).toEqual({ t: "hold" });
  });

  it("torn-write hook takes over before planning", async () => {
    fs.seed({ "t.md": "partial" });
    const reapplied: string[] = [];
    const r = new Reconciler({
      ...(rec as unknown as { d: ConstructorParameters<typeof Reconciler>[0] }).d,
      hooks: { isTorn: async () => true, reapply: async (p) => { reapplied.push(p); } },
    });
    expect(await r.reconcile({ path: "t.md" })).toEqual({ t: "torn" });
    expect(reapplied).toEqual(["t.md"]);
  });
});

describe("scanLocal (design §3.4.1, I23)", () => {
  async function seedSynced(n: number): Promise<void> {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`f/${i}.md`] = `c${i}`;
    fs.seed(files);
    await ix.write([], async (w) => {
      for await (const batch of fs.listAll({ includeConfigDir: false })) {
        for (const st of batch) {
          if (st.kind !== "file") continue;
          await w.putEntry({ fileId: newFileId(), path: st.path, foldKey: st.path, scope: "active", kind: "note", obs: observationOf(st, "h"), synced: null, updatedAt: 0 });
        }
      }
    });
  }

  it("unchanged files take the fast path: zero reads, yields per batch", async () => {
    await seedSynced(1200);
    const r = await scanLocal({
      fs, index: ix, scheduler: sched, scopeOf, kindOf: (p) => kindOf(p, CFG), markDirty: (k, why) => dirty.mark(k, why), includeConfigDir: false,
    }, "fast");
    expect(r).toMatchObject({ seen: 1200, fastPath: 1200, dirty: 0 });
    expect(fs.stats.reads).toBe(0);
    expect(sched.stats.yields).toBeGreaterThanOrEqual(3);
  });

  it("new, changed, missing, out-of-scope; full mode marks everything", async () => {
    await seedSynced(3);
    clock.tick(10);
    fs.external.write("f/0.md", "changed!");
    fs.external.remove("f/1.md");
    fs.seed({ "new.md": "n", "excluded/e.md": "e", ".trash/t.md": "t" });
    const checks: Array<{ seen: number; indexedActive: number }> = [];
    const d = { fs, index: ix, scheduler: sched, scopeOf, kindOf: (p: string) => kindOf(p, CFG), markDirty: (k: never, why: never) => dirty.mark(k, why), includeConfigDir: false, emptyVaultCheck: (o: { seen: number; indexedActive: number }) => checks.push(o) };
    const r = await scanLocal(d as never, "fast");
    expect(r).toMatchObject({ dirty: 3, tracked: 1, missing: 1, fastPath: 1 });
    expect(dirty.peek().map((x) => `${x.reason}:${x.key.path}`).sort()).toEqual(["missing:f/1.md", "new:new.md", "stat-changed:f/0.md"]);
    expect(ix.byPath("excluded/e.md")?.scope).toBe("excluded");
    expect(ix.byPath(".trash/t.md")).toBeNull();
    expect(checks).toEqual([{ seen: 5, indexedActive: 3 }]);
    dirty.clear();
    const full = await scanLocal(d as never, "full");
    expect(full.fastPath).toBe(0);
  });
});

describe("LocalRenames (design §3.6.1, I19)", () => {
  function renames(): LocalRenames {
    return new LocalRenames({ index: ix, scopeOf, markDirty: (k, r) => dirty.mark(k, r) });
  }

  it("to a free path: the entry moves immediately and keeps its fileId", async () => {
    const e = await synced("a.md", "x");
    await renames().rename("a.md", "d/b.md", "g1");
    expect(ix.byFileId(e.fileId)?.path).toBe("d/b.md");
    expect(dirty.peek()).toEqual([{ key: { fileId: e.fileId, path: "d/b.md" }, reason: "rename" }]);
  });

  it("case-only rename keeps the fileId on case-insensitive and case-sensitive fakes", async () => {
    for (const ci of [true, false]) {
      fs = new MemLocalFs({ clock, caseInsensitive: ci, emitOwnEvents: false });
      ix = await FileIndex.load(new MemStateStore(), () => 0);
      const e = await synced("Note.md", "x");
      fs.external.rename("Note.md", "note.md");
      await renames().rename("Note.md", "note.md");
      expect(ix.byPath("note.md")?.fileId).toBe(e.fileId);
      expect(ix.byFoldKey("note.md").length).toBe(1);
    }
  });

  it("into an excluded folder: old entry missing (→ S5), new path untracked", async () => {
    const e = await synced("a.md", "x");
    await renames().rename("a.md", "excluded/a.md");
    expect(ix.byFileId(e.fileId)?.path).toBe("a.md");
    expect(dirty.peek().map((x) => `${x.reason}:${x.key.path}`).sort()).toEqual(["missing:a.md", "new:excluded/a.md"]);
  });

  it("unknown source → create(to)", async () => {
    await renames().rename("nope.md", "b.md");
    expect(dirty.peek()).toEqual([{ key: { path: "b.md" }, reason: "new" }]);
  });

  it("while a rename is pending: the mover is deferred and the stale holder sees its path as absent", async () => {
    const a = await synced("a.md", "moved content");
    const b = await synced("b.md", "stale");
    const r = renames();
    fs.external.remove("b.md");
    fs.external.rename("a.md", "b.md");
    await r.rename("a.md", "b.md");
    const guarded = new Reconciler({ ...(rec as unknown as { d: ConstructorParameters<typeof Reconciler>[0] }).d, hooks: { renames: r } });
    // A scan sees a.md missing: the mover must not plan S5 PUSH_DELETE.
    expect(await guarded.reconcile({ fileId: a.fileId, path: "a.md" })).toEqual({ t: "deferred" });
    // The holder must not take the mover's bytes as its own S2 edit: its path counts as absent → S5.
    await guarded.reconcile({ fileId: b.fileId, path: "b.md" });
    expect(lastAction()).toMatchObject({ type: "PUSH_DELETE", fileId: b.fileId, row: "S5" });
    expect(exec.calls.every((c) => c.action.type !== "PUSH_PUT")).toBe(true);
    // Delete acked → entry gone → retry applies the move → the mover plans S3 at b.md.
    await ix.forget(b.fileId);
    await r.retry();
    await guarded.reconcile({ fileId: a.fileId, path: "b.md" });
    expect(lastAction()).toMatchObject({ type: "PUSH_PUT", row: "S3", fileId: a.fileId, path: "b.md", base: 5 });
  });

  it("target held by a stale entry: pending until it resolves", async () => {
    const a = await synced("a.md", "x");
    const b = await synced("b.md", "y");
    const r = renames();
    await r.rename("a.md", "b.md");
    expect(ix.byFileId(a.fileId)?.path).toBe("a.md");
    expect(r.pendingCount).toBe(1);
    expect(dirty.has({ fileId: b.fileId, path: "b.md" })).toBe(true);
    await ix.forget(b.fileId);
    await r.retry();
    expect(ix.byFileId(a.fileId)?.path).toBe("b.md");
    expect(r.pendingCount).toBe(0);
  });
});

describe("KeyedMutex and DirtySet", () => {
  it("serializes per key and takes multiple keys in a fixed order", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const u1 = await m.acquire("b", "a");
    const p2 = m.acquire("a", "b").then((u) => { order.push("second"); u(); });
    const p3 = m.acquire("c").then((u) => { order.push("other key"); u(); });
    await p3;
    order.push("release first");
    u1();
    await p2;
    expect(order).toEqual(["other key", "release first", "second"]);
    expect(m.isLocked("a")).toBe(false);
  });

  it("a fileId mark replaces the path mark and keeps extra planner input", () => {
    const d = new DirtySet();
    let kicks = 0;
    d.onMark(() => kicks++);
    d.mark({ path: "a.md" }, "new");
    d.mark({ fileId: "f", path: "a.md", pathTaken: { seq: 1 } as never }, "pathTaken");
    d.mark({ fileId: "f", path: "b.md" }, "rename");
    expect(d.size).toBe(1);
    expect(d.peek()[0]).toMatchObject({ key: { fileId: "f", path: "b.md", pathTaken: { seq: 1 } }, reason: "rename" });
    expect(d.take(5).length).toBe(1);
    expect(d.size).toBe(0);
    expect(kicks).toBe(3);
  });
});
