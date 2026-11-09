// Each mode (design §6.1.1, §7.7 "Each mode | H1"): a bidirectional headless A and a headless B in
// push-only, pull-only or mirror-remote, through the real server.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HeadlessConfig } from "../src/config";
import {
  converge, createTestVault, diskMap, provisionNode, startNode, startWorld, stopNode, stopWorld, type HeadlessNode, type World,
} from "./e2eHarness";
import { sleep, waitFor } from "./tmp";

const T = 300_000;
let w: World;
const live: HeadlessNode[] = [];

beforeAll(async () => { w = await startWorld("modes"); }, T);
afterEach(async () => { for (const n of live.splice(0)) await stopNode(n).catch(() => undefined); });
afterAll(async () => { await stopWorld(w); }, T);

async function pair(name: string, mode: HeadlessConfig["mode"]): Promise<{ a: HeadlessNode; b: HeadlessNode }> {
  const v = await createTestVault(w, name);
  const a = await provisionNode(w, v, `${name}-a`);
  const b = await provisionNode(w, v, `${name}-b`, mode);
  live.push(a, b);
  await startNode(a);
  await startNode(b);
  return { a, b };
}

const P = (n: HeadlessNode, rel: string) => path.join(n.dirs.vault, rel);
/** push-only never applies remote heads, so its apply queue stays non-empty by design. */
const pushIdle = (n: HeadlessNode) => {
  const s = n.daemon!.engine.status();
  return s.pendingUp === 0 && n.daemon!.engine.dirty.size === 0 && s.status !== "error";
};
const idle = (n: HeadlessNode) => {
  const s = n.daemon!.engine.status();
  return s.status === "synced" && s.pendingUp === 0 && s.pendingDown === 0 && n.daemon!.engine.dirty.size === 0;
};

describe("headless modes", () => {
  it("push-only uploads local files and never writes the disk", async () => {
    const { a, b } = await pair("push", "push-only");
    await writeFile(P(b, "seed.md"), "from the seeding mirror\n");
    await waitFor(async () => (await diskMap(a.dirs.vault)).has("seed.md"), 60_000, 100, "seed reaches A");
    await writeFile(P(a, "remote-only.md"), "written on A\n");
    await writeFile(P(a, "seed.md"), "edited on A\n");
    await waitFor(() => idle(a) && pushIdle(b), 60_000, 100, "both idle");
    await waitFor(() => [...b.daemon!.engine.index.remote.all()].some((h) => h.path === "remote-only.md"), 30_000, 100, "B recorded A's file");
    await sleep(1500);
    expect(b.daemon!.health?.status).toBe("ok");
    const mb = await diskMap(b.dirs.vault);
    expect([...mb.keys()]).toEqual(["seed.md"]);
    expect(await readFile(P(b, "seed.md"), "utf8")).toBe("from the seeding mirror\n");
    expect(b.daemon!.fs.stats.writes).toBe(0);
  }, T);

  it("pull-only applies remote changes and never pushes local edits", async () => {
    const { a, b } = await pair("pull", "pull-only");
    await writeFile(P(a, "n.md"), "v1\n");
    await converge([a, b]);
    await writeFile(P(b, "n.md"), "local edit on the verifier\n");
    await writeFile(P(b, "local.md"), "never leaves B\n");
    await sleep(3000);
    await waitFor(() => idle(a), 30_000, 100, "A idle");
    expect(await readFile(P(a, "n.md"), "utf8")).toBe("v1\n");
    expect((await diskMap(a.dirs.vault)).has("local.md")).toBe(false);
    expect(await readFile(P(b, "n.md"), "utf8")).toBe("local edit on the verifier\n");   // left alone
    await writeFile(P(a, "new.md"), "from A\n");
    await waitFor(async () => (await diskMap(b.dirs.vault)).has("new.md"), 60_000, 100, "A's file reaches B");
  }, T);

  it("mirror-remote reverts local edits to the remote head and keeps the reverted content", async () => {
    const { a, b } = await pair("mirror", "mirror-remote");
    await writeFile(P(a, "m.md"), "remote truth\n");
    await converge([a, b]);
    await writeFile(P(b, "m.md"), "unwanted local edit\n");
    await waitFor(async () => (await readFile(P(b, "m.md"), "utf8")) === "remote truth\n", 60_000, 100, "revert on B");
    expect(await readFile(P(a, "m.md"), "utf8")).toBe("remote truth\n");
    const reverted = path.join(b.dirs.state, "reverted");
    const kept: string[] = [];
    for (const stamp of await readdir(reverted)) {
      const f = path.join(reverted, stamp, "m.md");
      kept.push(await readFile(f, "utf8").catch(() => ""));
    }
    expect(kept).toContain("unwanted local edit\n");
  }, T);
});
