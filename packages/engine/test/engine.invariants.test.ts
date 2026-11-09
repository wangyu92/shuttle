// Engine-level checks for the invariants §7.2 maps to packages/sim (I5, I6, I16, I17, I20, I21, I21b, I24,
// I28, I29), run through createEngine() against FakeRemote. The sim suite (random interleavings, many
// seeds) remains the normative home of these rows; these tests pin the engine side of each.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { GuardEvent, VaultInfo, VersionRecord } from "@shuttle/protocol";
import { Prng } from "@shuttle/testkit";
import { decodeRecord } from "../src/index";
import { contentOf } from "./harness";
import { sha256HexSync } from "./sha256";
import { Node, makeWorld, serverMap, sortedEntries, syncAll, type World } from "./engineHarness";

const commitsBy = (w: World, n: Node): number => w.server.calls.filter((c) => c.device === n.deviceId && c.method === "commit").length;
const recs = (w: World): VersionRecord[] => w.server.inspect().log as VersionRecord[];

async function pair(seed: string, o: { a?: ConstructorParameters<typeof Node>[1]; b?: ConstructorParameters<typeof Node>[1] } = {}) {
  const w = await makeWorld(seed);
  const a = new Node(w, o.a ?? { name: "alpha" });
  const b = new Node(w, o.b ?? { name: "beta" });
  await a.start();
  await b.start();
  // Both devices finish their first bootstrap (hello since = null, design §2.9.1) before the property
  // runs, so its first "sync" step is an ordinary incremental pass.
  await syncAll([a, b]);
  return { w, a, b };
}

function edit(w: World, n: Node, path: string, content: string | Uint8Array): void {
  w.clock.tick(1000);
  n.fs.external.write(path, content, { mtime: w.clock.now() });
  n.engine.requestScan();
}

async function converged(w: World, ...ns: Node[]): Promise<void> {
  const remote = sortedEntries(await serverMap(w));
  for (const n of ns) expect(sortedEntries(await n.diskMap())).toEqual(remote);
}

describe("I5 blobs before meta", () => {
  it("no committed record references a blob the remote does not have", async () => {
    const { w, a, b } = await pair("i5");
    edit(w, a, "big/one.bin", new Prng("one").bytes(60_000));
    edit(w, a, "big/two.bin", new Prng("two").bytes(45_000));
    edit(w, b, "n.md", "note\n");
    w.server.injectFault({ device: a.deviceId, method: "putBlob", when: "before", times: 2 });
    await syncAll([a, b]);
    for (const r of recs(w)) for (const id of r.blobs) expect(w.server.hasBlob(id), `blob of seq ${r.seq}`).toBe(true);
    expect(recs(w).some((r) => r.blobs.length > 0)).toBe(true);
    await converged(w, a, b);
  });
});

describe("I16 no echo uploads", () => {
  it("applying N remote changes produces 0 commits from the receiver", async () => {
    const { w, a, b } = await pair("i16");
    for (let i = 0; i < 12; i++) edit(w, a, `n/${i}.md`, `note ${i}\n`);
    edit(w, a, "pic.png", new Prng("p").bytes(30_000));
    await syncAll([a, b]);
    a.fs.external.rename("n/0.md", "moved/0.md");
    a.fs.external.remove("n/1.md");
    edit(w, a, "n/2.md", "note 2 edited\n");
    await syncAll([a, b]);
    b.engine.requestScan("full");
    await syncAll([a, b]);
    expect(commitsBy(w, b)).toBe(0);
    await converged(w, a, b);
  });

  it("config JSON reformatted by the app after an apply is not pushed back (canonical compare)", async () => {
    const { w, a, b } = await pair("i16-json");
    edit(w, a, ".obsidian/app.json", JSON.stringify({ spellcheck: true, tabSize: 2, zoom: 1.25 }));
    await syncAll([a, b]);
    expect(b.fs.exists(".obsidian/app.json")).toBe(true);
    // The app rewrites the file with its own formatting and key order: same settings.
    edit(w, b, ".obsidian/app.json", JSON.stringify({ zoom: 1.25, tabSize: 2, spellcheck: true }, null, 2) + "\n");
    b.engine.requestScan("full");
    await syncAll([a, b]);
    expect(commitsBy(w, b)).toBe(0);
    // A real change is still pushed.
    edit(w, b, ".obsidian/app.json", JSON.stringify({ zoom: 1.5, tabSize: 2, spellcheck: true }, null, 2) + "\n");
    await syncAll([a, b]);
    expect(commitsBy(w, b)).toBe(1);
    expect(JSON.parse(a.fs.readText(".obsidian/app.json")!)).toEqual({ zoom: 1.5, tabSize: 2, spellcheck: true });
  });
});

describe("I17 folder expansion", () => {
  it("a folder rename of N files: N puts with unchanged blobIds, no tombstones, no ghosts", async () => {
    const { w, a, b } = await pair("i17", { a: { name: "alpha" } });
    for (let i = 0; i < 6; i++) edit(w, a, `proj/f${i}.bin`, new Prng(`f${i}`).bytes(20_000));
    await syncAll([a, b]);
    const before = new Map(recs(w).map((r) => [r.fileId, r.blobs.join(",")]));
    const n0 = recs(w).length;
    a.fs.external.rename("proj", "archive/proj");
    await syncAll([a, b]);
    const after = recs(w).slice(n0);
    expect(after.length).toBe(6);
    expect(after.every((r) => r.kind === "put")).toBe(true);
    for (const r of after) expect(r.blobs.join(",")).toBe(before.get(r.fileId));
    expect([...b.fs.files().keys()].every((p) => p.startsWith("archive/proj/"))).toBe(true);
    expect(b.fs.exists("proj")).toBe(false);
    await converged(w, a, b);
  });

  it("a folder delete of N files yields N delete commits", async () => {
    const { w, a, b } = await pair("i17-del");
    for (let i = 0; i < 5; i++) edit(w, a, `tmp/f${i}.md`, `f${i}\n`);
    edit(w, a, "keep.md", "keep\n");
    await syncAll([a, b]);
    a.fs.external.remove("tmp");
    await syncAll([a, b]);
    expect(recs(w).filter((r) => r.kind === "del").length).toBe(5);
    expect([...b.fs.files().keys()]).toEqual(["keep.md"]);
  });
});

describe("I20 rebuild equivalence", () => {
  it("wiping the StateStore of a quiescent synced device: 0 uploads, 0 downloads, 0 conflict copies", async () => {
    const { w, a, b } = await pair("i20");
    for (let i = 0; i < 8; i++) edit(w, a, `n/${i}.md`, `note ${i}\n`);
    edit(w, a, "pic.bin", new Prng("pic").bytes(25_000));
    await syncAll([a, b]);
    const commits = commitsBy(w, b);
    const files = sortedEntries(await b.diskMap());
    b.fsOps.length = 0;
    await b.restart({ wipeState: true });
    await syncAll([a, b]);
    expect(commitsBy(w, b)).toBe(commits);
    expect(b.ops("write")).toEqual([]);
    expect(b.ops("rename")).toEqual([]);
    expect(sortedEntries(await b.diskMap())).toEqual(files);
    expect(b.engine.index.activeCount()).toBe(9);
    for (const e of b.engine.index.allActive()) expect(e.synced).not.toBeNull();
  });
});

describe("I21 / I21b cursor expired and purge safety", () => {
  it("an expired cursor resyncs from the snapshot and converges; purged tombstones delete via S8", async () => {
    const { w, a, b } = await pair("i21");
    edit(w, a, "keep.md", "keep\n");
    edit(w, a, "gone.md", "gone\n");
    await syncAll([a, b]);
    await b.engine.stop();
    a.fs.external.remove("gone.md");
    edit(w, a, "keep.md", "keep v2\n");
    edit(w, a, "new.md", "new\n");
    await syncAll([a]);
    w.server.expire(w.server.inspect().headSeq);
    await b.restart();
    await syncAll([a, b]);
    expect(b.fs.exists("gone.md")).toBe(false);
    expect(b.fs.trash.some((t) => t.path === "gone.md")).toBe(true);
    await converged(w, a, b);
  });

  it("incremental mode: a file with a base but no remote head never causes a delete (INTEGRITY_ERROR + resync)", async () => {
    const { w, a, b } = await pair("i21b");
    edit(w, a, "x.md", "x\n");
    await syncAll([a, b]);
    // Server bug model: b's mirror loses the head without a tombstone.
    const id = b.engine.index.byPath("x.md")!.fileId;
    await b.engine.index.write([], async (wr) => { await wr.deleteRemote(id); });
    b.engine.dirty.mark({ fileId: id, path: "x.md" }, "remote");
    await syncAll([a, b]);
    expect(b.fs.readText("x.md")).toBe("x\n");
    expect(a.fs.readText("x.md")).toBe("x\n");
    expect(recs(w).filter((r) => r.kind === "del")).toEqual([]);
  });
});

describe("I24 memory budget", () => {
  it("in-flight blob bytes stay within the budget except one admitted item ≤ maxFileBytes", async () => {
    const cap = 40_000;
    const { w, a, b } = await pair("i24", { a: { name: "alpha", opts: { budgets: { inFlightBytes: cap } } }, b: { name: "beta", opts: { budgets: { inFlightBytes: cap } } } });
    for (let i = 0; i < 6; i++) edit(w, a, `big${i}.bin`, new Prng(`b${i}`).bytes(50_000 + i * 3000));
    await syncAll([a, b]);
    for (const n of [a, b]) {
      const s = n.engine.budget.bytes.stats;
      expect(s.acquires).toBeGreaterThan(0);
      if (s.peak > cap) {
        expect(s.admittedAlone).toBeGreaterThan(0);
        expect(s.peak).toBe(s.largestAlone);
        expect(s.largestAlone).toBeLessThanOrEqual(n.engine.settings.maxFileBytes);
      }
      expect(n.engine.budget.bytes.inFlight).toBe(0);
    }
    await converged(w, a, b);
  });
});

describe("I28 epoch safety", () => {
  it("after a rebuild by another (filtered) device nobody deletes a local file absent from the new epoch", async () => {
    const { w, a, b } = await pair("i28", { a: { name: "alpha", settings: { excludedFolders: ["Private"] } } });
    edit(w, b, "Private/secret.md", "only on beta\n");
    edit(w, b, "shared.md", "shared\n");
    await syncAll([a, b]);
    // alpha rebuilds the remote from its own (filtered) view: the new epoch has no Private/ files.
    const info = w.server.inspect().info as VaultInfo;
    const next = { ...info, epoch: info.epoch + 1, infoRev: info.infoRev + 1 };
    const { infoMac: _m, ...unsigned } = next;
    next.infoMac = await w.ring.macVaultInfo(unsigned as Parameters<typeof w.ring.macVaultInfo>[0]);
    const raw = w.server.adapter("rebuilderdev000000000");
    await raw.connect();
    await raw.rebuild(next);
    await raw.close();
    const guards: GuardEvent[] = [];
    b.engine.on("guard", (g) => guards.push(g));
    await a.restart();
    await b.restart();
    await syncAll([a, b], 60);
    expect(b.fs.readText("Private/secret.md")).toBe("only on beta\n");
    expect(b.fs.readText("shared.md")).toBe("shared\n");
    expect(a.fs.readText("shared.md")).toBe("shared\n");
    expect(b.fs.trash).toEqual([]);
    expect(a.fs.trash).toEqual([]);
    expect(recs(w).filter((r) => r.kind === "del")).toEqual([]);
    expect(sortedEntries(await serverMap(w)).map(([p]) => p).sort()).toEqual(["Private/secret.md", "shared.md"]);
  });
});

describe("I29 rollback recovery (engine side)", () => {
  it("welcome.headSeq behind seen.maxSeq pauses; accept re-pushes edits held by this device", async () => {
    const { w, a, b } = await pair("i29");
    edit(w, a, "doc.md", "v1\n");
    await syncAll([a, b]);
    await b.engine.stop();
    edit(w, b, "doc.md", "v2 made on beta after the backup\n");
    // Model a server restore: the server is behind what beta has seen.
    b.ls.seen = { ...b.ls.seen!, maxSeq: w.server.inspect().headSeq + 5 };
    const guards: GuardEvent[] = [];
    await b.restart();
    b.engine.on("guard", (g) => guards.push(g));
    await syncAll([b]);
    expect(b.engine.status()).toMatchObject({ status: "paused", reason: "rollback" });
    const g = b.engine.guards.list().find((x) => x.kind === "rollback")!;
    expect(g).toBeDefined();
    b.engine.answerGuard(g.id, "accept");
    await b.engine.whenConnected();
    await syncAll([a, b]);
    expect(a.fs.readText("doc.md")).toBe("v2 made on beta after the backup\n");
    await converged(w, a, b);
  });
});

describe("I6 no silent loss (small ledger)", () => {
  it("every content hash ever on disk or in a remote head survives somewhere", async () => {
    let seed = 0;
    const op = fc.record({ dev: fc.nat(1), f: fc.nat(2), v: fc.nat(20), kind: fc.constantFrom("edit", "edit", "delete", "sync") });
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 2, maxLength: 10 }), async (ops) => {
      const { w, a, b } = await pair(`i6-${seed++}`);
      const nodes = [a, b];
      const paths = ["x.md", "y.bin", "z.json"];
      const ledger = new Set<string>();
      const body = (p: string, v: number, d: number): Uint8Array =>
        p.endsWith(".bin") ? new Prng(`${p}${v}${d}`).bytes(5000) : new TextEncoder().encode(p.endsWith(".json") ? JSON.stringify({ v, d }) : `${p} ${v} ${d}\n`);
      // Before an engine action of `who`: its disk and every remote head (other devices' unsynced disk
      // content can still be overwritten by their users; that is not the engine's loss).
      const snapshotLedger = async (who: readonly Node[] = nodes): Promise<void> => {
        for (const n of who) for (const [, v] of n.fs.files({ includeConfigDir: true })) ledger.add(sha256HexSync(v));
        for (const r of w.server.inspect().heads as VersionRecord[]) {
          if (r.kind !== "put") continue;
          const h = (await decodeRecord(w.ring, r)).head?.contentHash;
          if (h) ledger.add(h);
        }
      };
      for (const o of ops) {
        const n = nodes[o.dev]!;
        const p = paths[o.f]!;
        if (o.kind === "edit") {
          // Content the user overwrites before any sync never existed "before an action": the ledger
          // records what is on disk and in remote heads at each sync instead.
          edit(w, n, p, body(p, o.v, o.dev));
        } else if (o.kind === "delete") {
          if (n.fs.exists(p)) n.fs.external.remove(p);
          n.engine.requestScan();
        } else {
          await snapshotLedger([n]);
          await n.flushEvents();
          await n.engine.runOnce();
          await w.server.settle();
        }
      }
      await snapshotLedger();
      await syncAll([a, b]);
      await syncAll([b, a]);
      const have = new Set<string>();
      for (const n of nodes) {
        for (const [, v] of n.fs.files({ includeConfigDir: true })) have.add(sha256HexSync(v));
        for (const t of n.fs.trash) if (t.bytes) have.add(sha256HexSync(t.bytes));
      }
      for (const r of recs(w)) {
        if (r.kind === "del") continue;
        const dec = await decodeRecord(w.ring, r);
        const h = (dec.meta as { hash?: string }).hash;
        if (h) have.add(h);
        else have.add(sha256HexSync(await contentOf(w, r)));
      }
      for (const h of ledger) expect(have.has(h), `content ${h.slice(0, 8)} lost`).toBe(true);
      await converged(w, a, b);
    }), { numRuns: 15, seed: 66 });
  }, 180_000);
});
