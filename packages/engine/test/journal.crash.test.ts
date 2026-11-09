// Crash at every crash point and at every store commit of the op runner and the apply path
// (design §3.7.4, §3.8.4, §7.2: I1, I2, I3, I4, I16, I30).
import type { FileEntry, Op, RemoteHead, VersionRecord, WriteIntent } from "@shuttle/protocol";
import { MemStateStore } from "@shuttle/testkit";
import { describe, expect, it } from "vitest";
import { decodeRecord } from "../src/index";
import { sha256HexSync } from "./sha256";
import { Device, bigBytes, contentOf, makeWorld, recordsOf, serverMap, sortedEntries, type World } from "./harness";

/** `act` changes the disk (external, survives crashes); `notify` tells the engine (re-run after a restart). */
type Step = { name: string; act(d: Device, w: World): void; notify?(d: Device): Promise<void> };

/** Every content a test wrote, by hash (the "local side" of I1). */
const userWritten = new Set<string>();

function edit(w: World, d: Device, path: string, content: string | Uint8Array): void {
  w.clock.tick(1000);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  userWritten.add(hashSync(bytes));
  d.fs.external.write(path, bytes, { mtime: w.clock.now() });
}

function hashSync(b: Uint8Array): string {
  return sha256HexSync(b);
}

const PUSH_STEPS: Step[] = [
  { name: "create", act: (d, w) => { edit(w, d, "notes/a.md", "alpha\n"); edit(w, d, "att/pic.bin", bigBytes("pic")); } },
  {
    name: "edit+move",
    act: (d, w) => {
      edit(w, d, "notes/a.md", "alpha\nbeta\n");
      d.fs.external.rename("att/pic.bin", "moved/pic.bin");
    },
    notify: async (d) => {
      if (d.index.byPath("att/pic.bin")) await d.renames.rename("att/pic.bin", "moved/pic.bin");
    },
  },
  { name: "delete", act: (d) => { d.fs.external.remove("notes/a.md"); } },
];

interface Dumped { files: FileEntry[]; remote: RemoteHead[]; journal: Op[]; intents: WriteIntent[]; meta: Array<{ k: string; v: unknown }>; integrity: unknown[]; bases: Array<{ fileId: string; version: number; hash: string }> }

function dump(store: MemStateStore): Dumped {
  return store.dump() as unknown as Dumped;
}

/**
 * I1: every synced version exists on the server with that hash, the hash is content this device had
 * (a user write or an engine write), and the disk holds it unless a newer local edit or an engine
 * write covered by a write intent is pending.
 */
async function checkI1(w: World, d: Device, final = false): Promise<void> {
  const st = dump(d.store);
  const log = new Map<number, VersionRecord>(recordsOf(w).map((r) => [r.seq, r]));
  const disk = await d.diskMap();
  for (const e of st.files ?? []) {
    if (!e.synced) continue;
    const rec = log.get(e.synced.version);
    expect(rec, `server record ${e.synced.version} for ${e.path}`).toBeDefined();
    expect(rec!.fileId).toBe(e.fileId);
    const h = (await decodeRecord(w.ring, rec!)).head!;
    expect(h.contentHash).toBe(e.synced.hash);
    const onDisk = disk.get(e.path);
    const intentTarget = (st.intents ?? []).some((i) => i.targetHash === onDisk);
    const newerUserEdit = onDisk === undefined || userWritten.has(onDisk);
    if (final) expect(onDisk, `final disk content of ${e.path}`).toBe(e.synced.hash);
    else if (onDisk !== e.synced.hash) expect(intentTarget || newerUserEdit, `disk content of ${e.path}`).toBe(true);
    if (e.synced.hasBase) {
      const b = (st.bases ?? []).find((x) => x.fileId === e.fileId);
      expect(b?.version).toBe(e.synced.version);
    }
  }
}

/** I4: at most one non-terminal put/delete op per fileId. */
function checkI4(d: Device): void {
  const seen = new Set<string>();
  for (const op of dump(d.store).journal ?? []) {
    if (op.kind === "archive") continue;
    expect(seen.has(op.fileId), `two ops for ${op.fileId}`).toBe(false);
    seen.add(op.fileId);
  }
}

/** I2: the cursor never runs ahead of the heads it covers. */
function checkI2(w: World, d: Device): void {
  const st = dump(d.store);
  const cursor = (st.meta ?? []).find((m) => m.k === "cursor")?.v as number | undefined;
  if (cursor === undefined) return;
  const mirror = new Map((st.remote ?? []).map((h) => [h.fileId, h.seq] as const));
  const quarantined = new Set((st.integrity as Array<{ seq: number }> ?? []).map((q) => q.seq));
  const latest = new Map<string, number>();
  for (const r of recordsOf(w)) if (r.seq <= cursor && r.kind !== "archive") latest.set(r.fileId, r.seq);
  for (const [fileId, seq] of latest) {
    if (quarantined.has(seq)) continue;
    expect(mirror.get(fileId) ?? -1, `remote mirror of ${fileId} at cursor ${cursor}`).toBeGreaterThanOrEqual(seq);
  }
}

async function runSteps(w: World, d: Device, steps: Step[], after: (d: Device) => Promise<void>): Promise<number> {
  let crashes = 0;
  for (const s of steps) {
    s.act(d, w);
    for (let attempt = 0; ; attempt++) {
      try {
        await s.notify?.(d);
        await d.sync();
        break;
      } catch (err) {
        if (!d.crashed) throw err;
        crashes++;
        await after(d);
        await d.restart();
        if (attempt > 5) throw new Error("too many crashes");
      }
    }
  }
  return crashes;
}

/** Enumerate crash N = 1, 2, … until a run completes without reaching N. */
async function enumerate(kind: "point" | "commit", steps: Step[], check: (w: World, d: Device, crashed: boolean) => Promise<void>): Promise<number> {
  let runs = 0;
  for (let n = 1; n < 400; n++) {
    const w = await makeWorld(`crash-${kind}-${n}`);
    const d = new Device(w, { name: "alpha" });
    await d.start();
    if (kind === "point") d.crashAt = d.points.length + n;
    else d.commitCrashAt = d.commits + n;
    const crashes = await runSteps(w, d, steps, async (dd) => {
      checkI4(dd);
      await checkI1(w, dd);
    });
    await d.sync();
    try {
      await check(w, d, crashes > 0);
    } catch (err) {
      throw new Error(`${kind} crash #${n}: ${String(err)}\n${JSON.stringify(dump(d.store).files)}\n${JSON.stringify(recordsOf(w).map((r) => [r.seq, r.kind, r.fileId.slice(0, 6), r.base]))}\n${JSON.stringify(dump(d.store).journal)}`);
    }
    runs++;
    if (crashes === 0) return runs;
  }
  throw new Error("crash enumeration did not terminate");
}

async function pushOracle(w: World, d: Device): Promise<void> {
  expect(sortedEntries(await d.diskMap())).toEqual(sortedEntries(await serverMap(w)));
  // I3: exactly one record per logical change, whatever was resent.
  const kinds = recordsOf(w).map((r) => r.kind);
  expect(kinds).toEqual(["put", "put", "put", "put", "del"].slice(0, kinds.length));
  expect(kinds.length).toBe(5);
  expect(w.server.stats.blobRewriteMismatches).toBe(0);
  checkI4(d);
  await checkI1(w, d, true);
  expect((await d.journal.ops()).length).toBe(0);
  expect(dump(d.store).intents ?? []).toEqual([]);
  // The localStorage pendingOps mirror survives crashes; resume prunes what was already acked.
  expect([...d.mirror.keys()]).toEqual([]);
}

describe("op runner crash safety", () => {
  it("I1/I3/I4: crash at every crash point while pushing", async () => {
    const runs = await enumerate("point", PUSH_STEPS, async (w, d) => pushOracle(w, d));
    expect(runs).toBeGreaterThan(10);
  }, 240_000);

  it("I1/I3/I4: crash during every store commit while pushing", async () => {
    const runs = await enumerate("commit", PUSH_STEPS, async (w, d) => pushOracle(w, d));
    expect(runs).toBeGreaterThan(10);
  }, 240_000);
});

describe("apply path crash safety", () => {
  async function receiverRuns(kind: "point" | "commit"): Promise<number> {
    let runs = 0;
    for (let n = 1; n < 400; n++) {
      const w = await makeWorld(`apply-${kind}-${n}`);
      const a = new Device(w, { name: "alpha" });
      const b = new Device(w, { name: "beta" });
      await a.start();
      await b.start();
      if (kind === "point") b.crashAt = b.points.length + n;
      else b.commitCrashAt = b.commits + n;
      let crashes = 0;
      for (const s of PUSH_STEPS) {
        s.act(a, w);
        await s.notify?.(a);
        await a.sync();
        for (let attempt = 0; ; attempt++) {
          try {
            await w.server.settle();
            if (b.crashed) throw new Error("crashed in feed");
            await b.sync();
            if (b.crashed) throw new Error("crashed in feed");
            break;
          } catch (err) {
            if (!b.crashed) throw err;
            crashes++;
            checkI2(w, b);
            await checkI1(w, b);
            await b.restart();
            if (attempt > 5) throw new Error("too many crashes");
          }
        }
      }
      await b.sync();
      expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(await serverMap(w)));
      // I16: the receiver never commits.
      expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "commit").length).toBe(0);
      expect(dump(b.store).intents ?? []).toEqual([]);
      checkI2(w, b);
      await checkI1(w, b, true);
      runs++;
      if (crashes === 0) return runs;
    }
    throw new Error("crash enumeration did not terminate");
  }

  it("I1/I2/I16: crash at every crash point while applying", async () => {
    expect(await receiverRuns("point")).toBeGreaterThan(5);
  }, 240_000);

  it("I1/I2/I16: crash during every store commit while applying", async () => {
    expect(await receiverRuns("commit")).toBeGreaterThan(5);
  }, 240_000);
});

describe("conflict path crash safety (I6, I10, I31)", () => {
  async function ledger(w: World, ...ds: Device[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const d of ds) {
      for (const v of d.fs.files().values()) out.add(sha256HexSync(v));
      for (const t of d.fs.trash) if (t.bytes) out.add(sha256HexSync(t.bytes));
    }
    for (const r of recordsOf(w)) if (r.kind !== "del") out.add(sha256HexSync(await contentOf(w, r)));
    return out;
  }

  it.each(["point", "commit"] as const)("crash at every %s while B resolves concurrent edits: nothing is lost, both converge", async (kind) => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    const contents = {
      noteA: enc("alpha wrote this\n"), noteB: enc("beta wrote that\n"), binA: bigBytes("binA"), binB: bigBytes("binB"),
    };
    let runs = 0;
    for (let n = 1; n < 400; n++) {
      const w = await makeWorld(`conflict-${kind}-${n}`);
      const a = new Device(w, { name: "alpha" });
      const b = new Device(w, { name: "beta" });
      await a.start();
      await b.start();
      edit(w, a, "n.md", "shared start\n");
      edit(w, a, "img.bin", bigBytes("bin0"));
      await a.sync();
      await b.sync();
      w.clock.tick(1000);
      a.fs.external.write("n.md", contents.noteA, { mtime: w.clock.now() });
      a.fs.external.write("img.bin", contents.binA, { mtime: w.clock.now() + 60_000 });
      w.clock.tick(1000);
      b.fs.external.write("n.md", contents.noteB, { mtime: w.clock.now() });
      b.fs.external.write("img.bin", contents.binB, { mtime: w.clock.now() });
      await a.sync();
      if (kind === "point") b.crashAt = b.points.length + n;
      else b.commitCrashAt = b.commits + n;
      let crashes = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          await w.server.settle();
          if (b.crashed) throw new Error("crashed in feed");
          await b.sync();
          if (b.crashed) throw new Error("crashed in feed");
          break;
        } catch (err) {
          if (!b.crashed) throw err;
          crashes++;
          checkI4(b);
          checkI2(w, b);
          await b.restart();
          if (attempt > 5) throw new Error("too many crashes");
        }
      }
      for (let i = 0; i < 3; i++) { await a.sync(); await b.sync(); }
      const remote = sortedEntries(await serverMap(w));
      expect(sortedEntries(await a.diskMap()), `run ${n}`).toEqual(remote);
      expect(sortedEntries(await b.diskMap()), `run ${n}`).toEqual(remote);
      const seen = await ledger(w, a, b);
      for (const [k, v] of Object.entries(contents)) expect(seen.has(sha256HexSync(v)), `run ${n}: ${k} survives`).toBe(true);
      // I10: the conflict copy holds the detecting device's (b's) note, the original the remote one.
      const copy = [...b.fs.files().keys()].find((p) => p.includes("Conflicted copy beta"));
      expect(copy, `run ${n}: conflict copy`).toBeDefined();
      expect(b.fs.readText(copy!)).toBe("beta wrote that\n");
      expect(b.fs.readText("n.md")).toBe("alpha wrote this\n");
      expect(w.server.stats.blobRewriteMismatches).toBe(0);
      expect([...a.mirror.keys(), ...b.mirror.keys()]).toEqual([]);
      runs++;
      if (crashes === 0) break;
    }
    expect(runs).toBeGreaterThan(5);
  }, 240_000);
});
