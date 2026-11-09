// I18 delete+create pairing on a real filesystem (design §3.18 I18, §6.1.4, §7.2): a rename(2) and an
// unlink followed by an add of the same bytes inside the delete hold window are one move (same fileId,
// one put, no tombstone); outside the window, or with other bytes, they are a delete and a create.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  converge, createTestVault, diskMap, exists, ownerAdapter, provisionNode, startNode, startWorld, stopNode, stopWorld, type HeadlessNode, type World,
} from "./e2eHarness";
import { sleep } from "./tmp";

const T = 300_000;
let w: World;
const live: HeadlessNode[] = [];

beforeAll(async () => { w = await startWorld("rename"); }, T);
afterEach(async () => { for (const n of live.splice(0)) await stopNode(n).catch(() => undefined); });
afterAll(async () => { await stopWorld(w); }, T);

const P = (n: HeadlessNode, rel: string) => path.join(n.dirs.vault, rel);
const idOf = (n: HeadlessNode, rel: string): string | undefined => n.daemon!.engine.index.byPath(rel)?.fileId;

async function headSeq(vaultId: string): Promise<number> {
  const ad = ownerAdapter(w, vaultId);
  try {
    return (await ad.connect()).headSeq;
  } finally {
    await ad.close();
  }
}

describe("rename and unlink+add pairing (I18)", () => {
  let a: HeadlessNode;
  let b: HeadlessNode;
  let vaultId: string;

  beforeAll(async () => {
    const v = await createTestVault(w, "pairing");
    vaultId = v.vaultId;
    a = await provisionNode(w, v, "pairing-a");
    b = await provisionNode(w, v, "pairing-b");
  }, T);

  /** One pair for the whole describe; the top-level afterEach stops it, the next case restarts it. */
  async function ensureStarted(): Promise<void> {
    // The production hold window (design §3.5: 500 ms), not the harness's shortened one: pairing is
    // what is under test, on a loaded host.
    const timings = { settleMs: 150, maxWaitMs: 1000, deleteHoldMs: 500, rawDebounceMs: 200 };
    if (!a.daemon) { await startNode(a, { timings }); live.push(a); }
    if (!b.daemon) { await startNode(b, { timings }); live.push(b); }
  }

  /** The move of `from` → `to` on the source device arrived as one put of the same fileId. */
  async function expectMove(src: HeadlessNode, dst: HeadlessNode, from: string, to: string, id: string, seq0: number, body: string): Promise<void> {
    await converge([a, b], 90_000);
    const commits = (await headSeq(vaultId)) - seq0;
    if (commits !== 1) throw new Error(`${from} -> ${to}: ${commits} commits\n${src.log.lines.slice(-40).join("\n")}`);
    expect(idOf(src, to)).toBe(id);
    expect(idOf(dst, to)).toBe(id);
    expect(src.daemon!.engine.index.byPath(from)).toBeNull();
    const h = dst.daemon!.engine.index.remote.byFileId(id)!;
    expect(h.deleted).toBe(false);
    expect(h.path).toBe(to);
    expect(dst.daemon!.engine.deletedFiles()).toEqual([]);
    expect(await readFile(P(dst, to), "utf8")).toBe(body);
    expect(await exists(P(dst, from))).toBe(false);
  }

  it("rename(2) inside a folder and across folders is one move", async () => {
    await ensureStarted();
    await mkdir(P(a, "inbox"), { recursive: true });
    await mkdir(P(a, "done"), { recursive: true });
    await writeFile(P(a, "inbox/task.md"), "task body\n");
    await converge([a, b], 90_000);
    const id = idOf(a, "inbox/task.md")!;
    expect(idOf(b, "inbox/task.md")).toBe(id);

    let seq = await headSeq(vaultId);
    await rename(P(a, "inbox/task.md"), P(a, "inbox/task renamed.md"));
    await expectMove(a, b, "inbox/task.md", "inbox/task renamed.md", id, seq, "task body\n");

    seq = await headSeq(vaultId);
    await mkdir(P(b, "done"), { recursive: true });                            // empty folders do not sync
    await rename(P(b, "inbox/task renamed.md"), P(b, "done/task.md"));        // from the other device
    await expectMove(b, a, "inbox/task renamed.md", "done/task.md", id, seq, "task body\n");
  }, T);

  it("unlink then add of the same bytes inside the hold window is one move", async () => {
    await ensureStarted();
    const body = "same bytes, new place\n".repeat(20);
    await writeFile(P(a, "orig.md"), body);
    await converge([a, b], 90_000);
    const id = idOf(a, "orig.md")!;
    const seq = await headSeq(vaultId);
    // What some editors and `mv` across filesystems do: delete, then write a copy elsewhere.
    await rm(P(a, "orig.md"));
    await mkdir(P(a, "moved"), { recursive: true });
    await writeFile(P(a, "moved/copy.md"), body);
    await expectMove(a, b, "orig.md", "moved/copy.md", id, seq, body);
  }, T);

  it("unlink then add of other bytes, or of the same bytes after the window, is a delete and a create", async () => {
    await ensureStarted();
    await writeFile(P(a, "x.md"), "x body\n");
    await writeFile(P(a, "y.md"), "y body\n");
    await converge([a, b], 90_000);
    const xId = idOf(a, "x.md")!;
    const yId = idOf(a, "y.md")!;

    // Other bytes: not a move.
    await rm(P(a, "x.md"));
    await writeFile(P(a, "x2.md"), "different body\n");
    await converge([a, b], 90_000);
    expect(idOf(b, "x2.md")).toBeDefined();
    expect(idOf(b, "x2.md")).not.toBe(xId);
    expect(b.daemon!.engine.index.remote.byFileId(xId)?.deleted).toBe(true);

    // Same bytes, but long after the hold window (the delete is committed first).
    await rm(P(a, "y.md"));
    await converge([a, b], 90_000);
    expect(b.daemon!.engine.index.remote.byFileId(yId)?.deleted).toBe(true);
    await sleep(1500);
    await writeFile(P(a, "y-again.md"), "y body\n");
    await converge([a, b], 90_000);
    expect(idOf(b, "y-again.md")).toBeDefined();
    expect(idOf(b, "y-again.md")).not.toBe(yId);
    const files = [...(await diskMap(b.dirs.vault)).keys()];
    expect(files).not.toContain("x.md");
    expect(files).not.toContain("y.md");
  }, T);
});
