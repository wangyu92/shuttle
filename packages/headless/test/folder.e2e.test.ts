// I17 folder expansion with real `mv` and `rm -r` (design §3.18 I17, §7.2): two headless daemons through
// the real server. A folder rename of N files is N put commits that keep fileIds and blobIds and leave
// no tombstones; a folder delete is N delete commits (guarded above the mass-delete threshold); no
// ghosts: nothing comes back at the old path on either device.
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RemoteHead } from "@shuttle/protocol";
import {
  converge, createTestVault, diskMap, exists, ownerAdapter, provisionNode, startNode, startWorld, stopNode, stopWorld, type HeadlessNode, type World,
} from "./e2eHarness";
import { ControlClient } from "../src/control/ControlClient";
import { sleep, waitFor } from "./tmp";

const T = 300_000;
let w: World;
const live: HeadlessNode[] = [];

beforeAll(async () => { w = await startWorld("folder"); }, T);
afterEach(async () => { for (const n of live.splice(0)) await stopNode(n).catch(() => undefined); });
afterAll(async () => { await stopWorld(w); }, T);

async function pair(name: string): Promise<{ a: HeadlessNode; b: HeadlessNode; vaultId: string }> {
  const v = await createTestVault(w, name);
  const a = await provisionNode(w, v, `${name}-a`);
  const b = await provisionNode(w, v, `${name}-b`);
  live.push(a, b);
  await startNode(a);
  await startNode(b);
  return { a, b, vaultId: v.vaultId };
}

const P = (n: HeadlessNode, rel: string) => path.join(n.dirs.vault, rel);

async function headSeq(vaultId: string): Promise<number> {
  const ad = ownerAdapter(w, vaultId);
  try {
    return (await ad.connect()).headSeq;
  } finally {
    await ad.close();
  }
}

function headsUnder(n: HeadlessNode, prefix: string): Map<string, RemoteHead> {
  const out = new Map<string, RemoteHead>();
  for (const h of n.daemon!.engine.index.remote.all()) if (h.path.startsWith(prefix)) out.set(h.fileId, h);
  return out;
}

/** Answer every pending mass-delete guard on both devices until `done` holds (deletes still arriving can raise one more). */
async function applyGuardsUntil(nodes: HeadlessNode[], done: () => Promise<boolean>, what: string): Promise<void> {
  await waitFor(async () => {
    for (const n of nodes) {
      const c = new ControlClient(n.daemon!.socketPath);
      for (const g of n.daemon!.listGuards()) {
        expect(["massDeleteLocal", "massDeleteRemote"]).toContain(g.kind);
        await c.post(`/guards/${g.id}`, { choice: "apply" });
      }
    }
    return done();
  }, 90_000, 250, what);
}

async function writeTree(n: HeadlessNode, root: string, files: number, sub: number): Promise<void> {
  await mkdir(P(n, `${root}/sub`), { recursive: true });
  for (let i = 0; i < files; i++) await writeFile(P(n, `${root}/n${i}.md`), `note ${i} of ${root}\n`);
  for (let i = 0; i < sub; i++) await writeFile(P(n, `${root}/sub/s${i}.md`), `sub ${i}\n`);
  // One multi-chunk binary: its blob list must survive the move unchanged.
  await writeFile(P(n, `${root}/sub/blob.bin`), Buffer.from(Array.from({ length: 60_000 }, (_, i) => (i * 7919) % 251)));
}

describe("folder operations with real mv and rm -r (I17)", () => {
  it("mv of a folder tree is one put per file: same fileIds, same blobIds, no tombstones, no ghosts; and back from the other side", async () => {
    const { a, b, vaultId } = await pair("mv");
    await writeTree(a, "proj", 12, 7);                       // N = 12 + 7 + 1 = 20
    await writeFile(P(a, "outside.md"), "stays\n");
    await converge([a, b], 120_000);
    const before = headsUnder(b, "proj/");
    expect(before.size).toBe(20);
    expect([...before.values()].find((h) => h.path === "proj/sub/blob.bin")!.blobs.length).toBeGreaterThan(1);
    const seq0 = await headSeq(vaultId);

    // A: real rename(2) into a new parent folder.
    await mkdir(P(a, "archive"));
    await rename(P(a, "proj"), P(a, "archive/proj2"));
    await converge([a, b], 120_000);
    const seq1 = await headSeq(vaultId);
    expect(seq1 - seq0).toBe(20);                            // exactly N put commits, no deletes
    const after = headsUnder(b, "archive/proj2/");
    expect(after.size).toBe(20);
    for (const [id, h0] of before) {
      const h1 = b.daemon!.engine.index.remote.byFileId(id)!;
      expect(h1.deleted).toBe(false);
      expect(h1.path).toBe(h0.path.replace(/^proj\//, "archive/proj2/"));
      expect(h1.blobs).toEqual(h0.blobs);
      expect(h1.contentHash).toBe(h0.contentHash);
      expect(a.daemon!.engine.index.byPath(h1.path)?.fileId).toBe(id);
    }
    expect(b.daemon!.engine.deletedFiles()).toEqual([]);
    expect(a.daemon!.engine.deletedFiles()).toEqual([]);
    expect(await exists(P(b, "proj"))).toBe(false);

    // B moves it back up under another name: the same rule from B's watcher.
    await rename(P(b, "archive/proj2"), P(b, "proj3"));
    await converge([a, b], 120_000);
    expect((await headSeq(vaultId)) - seq1).toBe(20);
    for (const id of before.keys()) {
      const h = a.daemon!.engine.index.remote.byFileId(id)!;
      expect(h.deleted).toBe(false);
      expect(h.path.startsWith("proj3/")).toBe(true);
    }
    expect(a.daemon!.engine.deletedFiles()).toEqual([]);
    expect(await exists(P(a, "archive/proj2"))).toBe(false);

    // No ghosts: a quiet period later nothing reappeared at an old path.
    await sleep(3000);
    for (const n of [a, b]) {
      const keys = [...(await diskMap(n.dirs.vault)).keys()];
      expect(keys).toHaveLength(21);
      expect(keys.filter((k) => k.startsWith("proj/") || k.startsWith("archive/"))).toEqual([]);
    }
  }, T);

  it("rm -r of a folder is one delete per file; above the threshold it waits for an answer; no ghosts", async () => {
    const { a, b, vaultId } = await pair("rmr");
    await writeTree(a, "small", 6, 3);                       // 10 files: below max(25, 10 %)
    await writeTree(a, "big", 22, 7);                        // 30 files: above
    for (let i = 0; i < 10; i++) await writeFile(P(a, `keep${i}.md`), `keep ${i}\n`);
    await converge([a, b], 180_000);
    const small = headsUnder(b, "small/");
    const big = headsUnder(b, "big/");
    expect([small.size, big.size]).toEqual([10, 30]);

    // Below the threshold: no guard, 10 tombstones.
    let seq = await headSeq(vaultId);
    await rm(P(b, "small"), { recursive: true });
    await converge([a, b], 120_000);
    expect(a.daemon!.listGuards()).toEqual([]);
    expect(b.daemon!.listGuards()).toEqual([]);
    expect((await headSeq(vaultId)) - seq).toBe(10);
    for (const id of small.keys()) expect(a.daemon!.engine.index.remote.byFileId(id)?.deleted).toBe(true);
    expect(await exists(P(a, "small/n0.md"))).toBe(false);

    // Above the threshold: nothing leaves B until the guard is answered.
    seq = await headSeq(vaultId);
    await rm(P(b, "big"), { recursive: true });
    await waitFor(() => b.daemon!.listGuards().length > 0, 30_000, 100, "mass-delete guard on B");
    await sleep(1000);
    expect(await headSeq(vaultId)).toBe(seq);
    expect((await diskMap(a.dirs.vault)).size).toBe(40);
    await applyGuardsUntil([a, b], async () => (await diskMap(a.dirs.vault)).size === 10, "big deleted on A");
    await converge([a, b], 120_000);
    expect((await headSeq(vaultId)) - seq).toBe(30);
    for (const id of big.keys()) expect(b.daemon!.engine.index.remote.byFileId(id)?.deleted).toBe(true);

    // No ghosts: the folders stay gone on both devices after a quiet period.
    await sleep(3000);
    for (const n of [a, b]) {
      const keys = [...(await diskMap(n.dirs.vault)).keys()].sort();
      expect(keys).toEqual(Array.from({ length: 10 }, (_, i) => `keep${i}.md`).sort());
      const top = (await readdir(n.dirs.vault)).filter((x) => !x.startsWith("."));
      expect(top.filter((x) => x === "big" || x === "small")).toEqual([]);
    }
  }, T);
});
