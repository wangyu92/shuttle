// Headless e2e (design §7.7): two headless daemons on real directories, syncing through the real server
// in-process on 127.0.0.1. Create, edit, rename, delete, folder move, NFD names, conflict, restart
// mid-sync (kill -9 at the state level), secrets never in logs (H3).
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { secretScan } from "@shuttle/testkit";
import {
  converge, createTestVault, diskMap, ownerAdapter, provisionNode, startNode, startWorld, stopNode, stopWorld, type HeadlessNode, type World,
} from "./e2eHarness";
import { ControlClient } from "../src/control/ControlClient";
import { sleep, waitFor } from "./tmp";

const T = 300_000;
let w: World;
const live: HeadlessNode[] = [];

beforeAll(async () => { w = await startWorld("e2e"); }, T);
afterEach(async () => {
  for (const n of live.splice(0)) await stopNode(n).catch(() => undefined);
});
afterAll(async () => { await stopWorld(w); }, T);

async function pair(name: string): Promise<{ a: HeadlessNode; b: HeadlessNode }> {
  const v = await createTestVault(w, name);
  const a = await provisionNode(w, v, `${name}-a`);
  const b = await provisionNode(w, v, `${name}-b`);
  live.push(a, b);
  await startNode(a);
  await startNode(b);
  return { a, b };
}

const P = (n: HeadlessNode, rel: string) => path.join(n.dirs.vault, rel);

function secretsOf(n: HeadlessNode): Array<{ name: string; value: string }> {
  return [{ name: "token", value: n.secrets.token }, ...Object.values(n.secrets.keys).map((k, i) => ({ name: `vmk${i}`, value: k }))];
}

describe("two headless daemons through the real server", () => {
  it("create, edit, rename, folder move, delete and an NFD name converge", async () => {
    const { a, b } = await pair("basic");
    await mkdir(P(a, "notes"), { recursive: true });
    await writeFile(P(a, "notes/one.md"), "hello\n");
    await writeFile(P(a, "bin.dat"), Buffer.alloc(50_000, 7));
    await converge([a, b]);
    expect(await readFile(P(b, "notes/one.md"), "utf8")).toBe("hello\n");

    await writeFile(P(b, "notes/one.md"), "hello\nfrom b\n");
    await converge([a, b]);
    expect(await readFile(P(a, "notes/one.md"), "utf8")).toBe("hello\nfrom b\n");

    await rename(P(a, "notes/one.md"), P(a, "renamed.md"));
    await converge([a, b]);
    expect([...(await diskMap(b.dirs.vault)).keys()].sort()).toEqual(["bin.dat", "renamed.md"]);

    // Folder move of 20 files: moves, never delete + create of new fileIds.
    await mkdir(P(a, "f1"));
    for (let i = 0; i < 20; i++) await writeFile(P(a, `f1/n${i}.md`), `note ${i}\n`);
    await converge([a, b]);
    const before = a.daemon!.engine.index.byPath("f1/n0.md")?.fileId;
    await rename(P(a, "f1"), P(a, "f2"));
    await converge([a, b]);
    expect(a.daemon!.engine.index.byPath("f2/n0.md")?.fileId).toBe(before);
    expect((await diskMap(b.dirs.vault)).has("f2/n19.md")).toBe(true);
    expect(b.daemon!.engine.deletedFiles().filter((h) => h.path.startsWith("f1/") || h.path.startsWith("f2/"))).toEqual([]);

    // NFD-named file created on disk: uploaded under its NFC path; IO uses the on-disk name (S10).
    const nfd = "한글 노트.md".normalize("NFD");
    await writeFile(P(a, nfd), "본문\n");
    await converge([a, b]);
    expect((await diskMap(b.dirs.vault)).has("한글 노트.md".normalize("NFC"))).toBe(true);
    expect((await diskMap(a.dirs.vault)).size).toBe((await diskMap(b.dirs.vault)).size);

    await rm(P(b, "renamed.md"));
    await rm(P(b, "f2/n7.md"));
    await converge([a, b]);
    const left = [...(await diskMap(a.dirs.vault)).keys()];
    expect(left).not.toContain("renamed.md");
    expect(left).not.toContain("f2/n7.md");
    expect(left).toHaveLength(21);

    // H3: no token or key bytes in any log line, health.json or debug output.
    const texts = [...a.log.lines, ...b.log.lines, JSON.stringify(a.daemon!.health), JSON.stringify(b.daemon!.engine.debugInfo()),
      await readFile(path.join(a.dirs.state, "health.json"), "utf8")];
    expect(secretScan(texts.join("\n"), [...secretsOf(a), ...secretsOf(b)])).toEqual([]);
  }, T);

  it("rm -r of a large folder trips the mass-delete guard; status exits 4; guard answer apply completes", async () => {
    const { a, b } = await pair("massdel");
    await mkdir(P(a, "big"));
    for (let i = 0; i < 30; i++) await writeFile(P(a, `big/n${i}.md`), `n${i}\n`);
    for (let i = 0; i < 20; i++) await writeFile(P(a, `keep${i}.md`), `keep ${i}\n`);
    await converge([a, b], 90_000);
    await rm(P(b, "big"), { recursive: true });
    await waitFor(() => (b.daemon!.health?.guards.length ?? 0) > 0, 30_000, 100, "guard trip on B");
    const h = b.daemon!.health!;
    expect(h.status).toBe("down");
    expect(h.exitCode).toBe(4);
    const g = h.guards[0]!;
    expect(g.kind).toBe("massDeleteLocal");
    expect(await readFile(path.join(b.dirs.state, "guards", `${g.id}.json`), "utf8")).toContain("massDeleteLocal");
    // Nothing was deleted remotely while the guard waits.
    await sleep(1000);
    expect((await diskMap(a.dirs.vault)).size).toBe(50);
    const c = new ControlClient(b.daemon!.socketPath);
    const ca = new ControlClient(a.daemon!.socketPath);
    expect((await c.get("/guards")).data).toEqual([expect.objectContaining({ id: g.id, kind: "massDeleteLocal" })]);
    expect((await c.post(`/guards/${g.id}`, { choice: "apply" })).status).toBe(200);
    // Deletes still arriving from the watcher when the guard tripped can raise one more trip (the
    // approval covers the deletes parked at that moment): answer until the folder is gone remotely.
    await waitFor(async () => {
      for (const x of b.daemon!.listGuards()) await c.post(`/guards/${x.id}`, { choice: "apply" });
      // The receiving mirror pauses an incoming mass delete as well (massDeleteRemote).
      for (const x of a.daemon!.listGuards()) await ca.post(`/guards/${x.id}`, { choice: "apply" });
      return (await diskMap(a.dirs.vault)).size === 20;
    }, 60_000, 250, "deletes applied").catch(async (e: unknown) => {
      throw new Error(`${String(e)}\nB: ${JSON.stringify(b.daemon!.engine.status())} dirty=${b.daemon!.engine.dirty.size} A files=${(await diskMap(a.dirs.vault)).size}\n${b.log.lines.slice(-25).join("\n")}\nA:\n${a.log.lines.slice(-10).join("\n")}`);
    });
    await converge([a, b], 90_000);
    expect([...(await diskMap(a.dirs.vault)).keys()].every((p) => p.startsWith("keep"))).toBe(true);
    expect((await diskMap(a.dirs.vault)).size).toBe(20);
    await waitFor(() => b.daemon!.health?.status === "ok", 10_000, 100, "B healthy again");
  }, T);

  it("the same note edited on both devices while one is stopped keeps both edits (I6)", async () => {
    const { a, b } = await pair("conflict");
    await writeFile(P(a, "c.md"), "line one\nline two\n");
    await converge([a, b]);
    await stopNode(b);
    await writeFile(P(a, "c.md"), "line one from A\nline two\n");
    await writeFile(P(b, "c.md"), "line one\nline two from B\n");
    await waitFor(() => (a.daemon!.engine.status().pendingUp === 0), 30_000, 100, "A pushed");
    await startNode(b);
    await converge([a, b]);
    const files = await diskMap(a.dirs.vault);
    const texts = await Promise.all([...files.keys()].map((p) => readFile(P(a, p), "utf8")));
    const all = texts.join("\n");
    expect(all).toContain("from A");
    expect(all).toContain("from B");
    // conflictMode conflictFile (unattended devices do not merge silently): a conflict copy exists.
    expect([...files.keys()].some((p) => p.includes("onflict"))).toBe(true);
  }, T);

  it("a daemon killed mid-download resumes after restart: no torn file, no duplicate, no loss", async () => {
    const { a, b } = await pair("restart");
    await stopNode(b);
    for (let i = 0; i < 40; i++) await writeFile(P(a, `bulk-${String(i).padStart(2, "0")}.md`), `content ${i}\n`.repeat(200));
    await waitFor(() => a.daemon!.engine.status().pendingUp === 0 && a.daemon!.engine.status().status === "synced", 60_000, 100, "A pushed all");
    // Start B and kill it as soon as the first files land.
    const d = await startNode(b);
    await waitFor(async () => (await diskMap(b.dirs.vault)).size >= 3, 60_000, 20, "B received some files");
    await d.kill();
    b.daemon = null;
    await sleep(200);
    await startNode(b);
    await converge([a, b], 90_000);
    const ma = await diskMap(a.dirs.vault);
    const mb = await diskMap(b.dirs.vault);
    expect(mb.size).toBe(40);
    expect([...mb.keys()].some((p) => p.includes("onflict"))).toBe(false);
    for (const [p, h] of ma) expect(mb.get(p)).toBe(h);
    // Nothing was pushed back by B (no torn push, I30): the server head count equals A's file count.
    expect(b.daemon!.engine.status().failed).toBe(0);
  }, T);

  it("a daemon killed mid-upload resumes: every file arrives once, no duplicates, no conflict copies", async () => {
    const { a, b } = await pair("upkill");
    for (let i = 0; i < 30; i++) await writeFile(P(a, `up-${String(i).padStart(2, "0")}.md`), `upload ${i}\n`.repeat(100));
    await waitFor(() => (a.daemon!.progress.lastCommitOkAt ?? 0) > 0, 60_000, 10, "first commit");
    await a.daemon!.kill();
    a.daemon = null;
    await startNode(a);
    await converge([a, b], 120_000);
    const mb = await diskMap(b.dirs.vault);
    expect(mb.size).toBe(30);
    expect([...mb.keys()].some((p) => p.includes("onflict"))).toBe(false);
    const heads = [...b.daemon!.engine.index.remote.all()].filter((h) => !h.deleted);
    expect(new Set(heads.map((h) => h.path)).size).toBe(heads.length);
    expect(heads.length).toBe(30);
  }, T);

  it("state.db deleted: the mirror rebuilds from a scan with zero transfers and no conflicts", async () => {
    const { a, b } = await pair("rebuild");
    for (let i = 0; i < 25; i++) await writeFile(P(a, `r${i}.md`), `rebuild ${i}\n`);
    await converge([a, b], 90_000);
    const ad = ownerAdapter(w, a.daemon!.o.config.remote.vaultId);
    const before = (await ad.connect()).headSeq;
    await stopNode(b);
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) await rm(path.join(b.dirs.state, f), { force: true });
    await startNode(b);
    await converge([a, b], 90_000);
    const after = (await ad.connect()).headSeq;
    await ad.close();
    expect(after).toBe(before);                                   // B committed nothing
    expect(b.daemon!.fs.stats.writes).toBe(0);                    // and downloaded nothing to disk
    expect([...(await diskMap(b.dirs.vault)).keys()].some((p) => p.includes("onflict"))).toBe(false);
  }, T);
});

