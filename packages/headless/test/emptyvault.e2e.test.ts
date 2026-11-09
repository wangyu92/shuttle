// I22 empty or unmounted vault root (design §3.18 I22, §3.13, §6.1.3, §7.2): an emptied root, a root
// replaced by an empty directory while the daemon runs, and a root that is empty or missing at startup
// never produce remote deletes. The daemon reports down with exit code 4 (a person is needed) until
// the root is back; after that, a restart syncs normally and every file is still everywhere.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  converge, createTestVault, diskMap, ownerAdapter, provisionNode, startNode, startWorld, stopNode, stopWorld, type HeadlessNode, type World,
} from "./e2eHarness";
import { StartupError } from "../src/main";
import { sleep, waitFor } from "./tmp";

const T = 300_000;
const FILES = 30;
let w: World;
const live: HeadlessNode[] = [];

beforeAll(async () => { w = await startWorld("empty"); }, T);
afterEach(async () => { for (const n of live.splice(0)) await stopNode(n).catch(() => undefined); });
afterAll(async () => { await stopWorld(w); }, T);

const P = (n: HeadlessNode, rel: string) => path.join(n.dirs.vault, rel);

async function headSeq(vaultId: string): Promise<number> {
  const ad = ownerAdapter(w, vaultId);
  try {
    return (await ad.connect()).headSeq;
  } finally {
    await ad.close();
  }
}

/** A synced pair with FILES notes in two folders; returns the server head after convergence. */
async function syncedPair(name: string): Promise<{ a: HeadlessNode; b: HeadlessNode; vaultId: string; seq: number }> {
  const v = await createTestVault(w, name);
  const a = await provisionNode(w, v, `${name}-a`);
  const b = await provisionNode(w, v, `${name}-b`);
  live.push(a, b);
  await startNode(a);
  await startNode(b);
  await mkdir(P(a, "notes"), { recursive: true });
  for (let i = 0; i < FILES; i++) await writeFile(P(a, i % 2 ? `notes/n${i}.md` : `n${i}.md`), `note ${i}\n`);
  await converge([a, b], 120_000);
  return { a, b, vaultId: v.vaultId, seq: await headSeq(v.vaultId) };
}

/** No remote delete happened and B still has every file, over a quiet period of several scans. */
async function expectNothingDeleted(vaultId: string, seq: number, b: HeadlessNode): Promise<void> {
  await sleep(3000);
  expect(await headSeq(vaultId)).toBe(seq);
  expect((await diskMap(b.dirs.vault)).size).toBe(FILES);
  expect(b.daemon!.engine.deletedFiles()).toEqual([]);
}

async function downForPerson(n: HeadlessNode): Promise<void> {
  await waitFor(() => n.daemon?.health?.status === "down" && n.daemon.health.exitCode === 4, 30_000, 100, `${n.name} down (exit 4)`);
}

describe("empty or unmounted vault root (I22)", () => {
  it("every file removed from the root while running: guarded, no remote deletes", async () => {
    const { a, b, vaultId, seq } = await syncedPair("emptied");
    await rm(P(a, "notes"), { recursive: true });
    for (let i = 0; i < FILES; i += 2) await rm(P(a, `n${i}.md`));
    await downForPerson(a);
    expect(a.daemon!.listGuards().map((g) => g.kind)).toEqual(expect.arrayContaining([expect.stringMatching(/^(emptyVault|massDeleteLocal)$/)]));
    await expectNothingDeleted(vaultId, seq, b);
  }, T);

  it("the vault dir replaced by an empty dir while running (unmount): no remote deletes; restored + restart: all back", async () => {
    const { a, b, vaultId, seq } = await syncedPair("swapped");
    const vault = a.dirs.vault;
    const aside = `${vault}.aside`;
    // What an unmount looks like from inside: the path now names another, empty directory.
    await rename(vault, aside);
    await mkdir(vault);
    await downForPerson(a);
    await expectNothingDeleted(vaultId, seq, b);
    // A change on B while A is guarded does not get lost either.
    await writeFile(P(b, "n0.md"), "edited on B while A was unmounted\n");
    await waitFor(async () => (await headSeq(vaultId)) === seq + 1, 30_000, 100, "B's edit committed");
    expect(await readFile(path.join(aside, "n0.md"), "utf8")).toBe("note 0\n");

    // The operator brings the volume back and restarts the daemon.
    await stopNode(a);
    await rm(vault, { recursive: true });
    await rename(aside, vault);
    await startNode(a);
    await converge([a, b], 120_000);
    expect(a.daemon!.listGuards()).toEqual([]);
    expect((await diskMap(a.dirs.vault)).size).toBe(FILES);
    expect(await readFile(P(a, "n0.md"), "utf8")).toBe("edited on B while A was unmounted\n");
    expect(await headSeq(vaultId)).toBe(seq + 1);
    expect(a.daemon!.engine.deletedFiles()).toEqual([]);
  }, T);

  it("an empty or missing root at startup: startup check fails, health down with exit 4, nothing deleted", async () => {
    const { a, b, vaultId, seq } = await syncedPair("startup");
    await stopNode(a);
    const aside = `${a.dirs.vault}.aside`;
    await rename(a.dirs.vault, aside);

    // Missing root (volume not mounted at all).
    await expect(startNode(a)).rejects.toBeInstanceOf(StartupError);
    let h = JSON.parse(await readFile(path.join(a.dirs.state, "health.json"), "utf8")) as { status: string; exitCode: number; reasons: string[] };
    expect(h).toMatchObject({ status: "down", exitCode: 4 });
    expect(h.reasons.join(" ")).toMatch(/missing/);

    // Empty root (mount point without the volume).
    await mkdir(a.dirs.vault);
    await expect(startNode(a)).rejects.toThrow(/vault is empty/);
    h = JSON.parse(await readFile(path.join(a.dirs.state, "health.json"), "utf8")) as typeof h;
    expect(h).toMatchObject({ status: "down", exitCode: 4 });
    await expectNothingDeleted(vaultId, seq, b);

    await rm(a.dirs.vault, { recursive: true });
    await rename(aside, a.dirs.vault);
    await startNode(a);
    await converge([a, b], 120_000);
    expect(await headSeq(vaultId)).toBe(seq);
    expect((await diskMap(a.dirs.vault)).size).toBe(FILES);
  }, T);
});
