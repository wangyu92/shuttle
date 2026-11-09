// Process death of the bundled CLI daemon (design §6.1, §7.7 "restart mid-sync", §3.18 durability):
// the esbuild bundle is built inside the test (same options as scripts/build.mjs, output under
// ~/tmp/claude/shuttle-p1, never dist/), run as a child process `sync --continuous`, killed with SIGKILL
// while downloads and local uploads are in flight, restarted, and checked for loss: every file on both
// devices with equal bytes, no duplicates, no conflict copies, and `verify --remote` exits 0.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control/ControlClient";
import {
  createTestVault, diskMap, provisionNode, same, startNode, startWorld, stopNode, stopWorld, trackOutput, type HeadlessNode, type World,
} from "./e2eHarness";
import { sleep, waitFor } from "./tmp";

const T = 600_000;
const A_FILES = 60;
const TOTAL = A_FILES + 20;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BUNDLE_DIR = path.join(os.homedir(), "tmp/claude/shuttle-p1", `bundle-${process.pid}`);
const BUNDLE = path.join(BUNDLE_DIR, "shuttle-headless.mjs");

let w: World;
const nodes: HeadlessNode[] = [];
const children: ChildProcess[] = [];

/** The headless bundle exactly as scripts/build.mjs makes it (esm, node22, ws bundled behind a require shim). */
async function buildBundle(): Promise<void> {
  await mkdir(BUNDLE_DIR, { recursive: true });
  await build({
    entryPoints: [{ in: path.join(ROOT, "packages/headless/src/index.ts"), out: "shuttle-headless" }],
    outdir: BUNDLE_DIR, outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "node", target: "node22",
    banner: { js: 'import { createRequire as __shuttleCreateRequire } from "node:module"; const require = __shuttleCreateRequire(import.meta.url);' },
    define: { __SHUTTLE_TEST_HOOKS__: "false" }, logLevel: "warning",
  });
}

function childEnv(): NodeJS.ProcessEnv {
  return { HOME: os.homedir(), PATH: process.env["PATH"] ?? "", TMPDIR: path.join(os.homedir(), "tmp/claude/shuttle-p1") };
}

/** Run the bundle to completion; stdout+stderr lines are kept for the H3 scan. */
function runBundle(args: string[]): Promise<{ code: number | null; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BUNDLE, ...args], { env: childEnv(), cwd: BUNDLE_DIR });
    const lines: string[] = [];
    trackOutput(`bundle ${args[0]}#${children.length}`, () => lines);
    p.stdout.on("data", (d: Buffer) => lines.push(...d.toString("utf8").split("\n")));
    p.stderr.on("data", (d: Buffer) => lines.push(...d.toString("utf8").split("\n")));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, lines }));
  });
}

interface Running { p: ChildProcess; exited: Promise<number | null>; log: string }

/** `sync --continuous` as a child process, its JSON log lines appended to a file. */
async function startChild(n: HeadlessNode, tag: string): Promise<Running> {
  const log = path.join(n.dirs.root, `daemon-${tag}.log`);
  const out = createWriteStream(log, { flags: "a" });
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BUNDLE, "sync", "--continuous", "--state", n.dirs.state],
    { env: childEnv(), cwd: BUNDLE_DIR, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  const exited = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
  let text = "";
  trackOutput(`daemon-${tag}`, () => [text]);
  const ctl = new ControlClient(path.join(n.dirs.state, "control.sock"));
  await waitFor(async () => {
    text = await readFile(log, "utf8").catch(() => "");
    if (p.exitCode !== null) throw new Error(`daemon exited ${p.exitCode}:\n${text.slice(-3000)}`);
    try { return (await ctl.get("/status")).status === 200; } catch { return false; }
  }, 120_000, 200, `child daemon ${tag} up`);
  const refresh = setInterval(() => { void readFile(log, "utf8").then((t) => { text = t; }, () => undefined); }, 500);
  void exited.then(async () => { clearInterval(refresh); text = await readFile(log, "utf8").catch(() => text); });
  return { p, exited, log };
}

interface ChildStatus { engine: { status: string; pendingUp: number; pendingDown: number; failed: number } }

async function childStatus(n: HeadlessNode): Promise<ChildStatus | null> {
  try {
    const r = await new ControlClient(path.join(n.dirs.state, "control.sock")).get("/status");
    return r.status === 200 ? (r.data as ChildStatus) : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  await buildBundle();
  w = await startWorld("kill9");
}, T);

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const n of nodes) await stopNode(n).catch(() => undefined);
  await rm(BUNDLE_DIR, { recursive: true, force: true });
  await stopWorld(w);
}, T);

describe("kill -9 of the bundled daemon", () => {
  it("the bundle runs standalone", async () => {
    const r = await runBundle(["--help"]);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("usage: shuttle-headless");
  }, T);

  it("SIGKILL during downloads and uploads, restart: nothing lost, nothing doubled", async () => {
    const v = await createTestVault(w, "kill9");
    const a = await provisionNode(w, v, "k9-a");
    const b = await provisionNode(w, v, "k9-b");
    nodes.push(a, b);
    // B is the child: production durability (synchronous FULL), its own headless.json.
    const { stateSynchronous: _drop, ...cfg } = b.config;
    void _drop;
    await writeFile(path.join(b.dirs.state, "headless.json"), JSON.stringify(cfg, null, 2) + "\n");
    await startNode(a);
    let child = await startChild(b, "1");

    // Work in flight in both directions: 20 local notes on B, then 60 notes (some multi-chunk) from A.
    // Every apply and every ack is an fsync'd commit on B (synchronous=FULL), so on this volume the
    // work takes tens of seconds and the kill lands in the middle of it.
    for (let i = 0; i < 20; i++) await writeFile(path.join(b.dirs.vault, `b-${String(i).padStart(2, "0")}.md`), `from B ${i}\n`.repeat(40));
    for (let i = 0; i < A_FILES; i++) {
      const body = i % 6 === 0 ? Buffer.from(Array.from({ length: 50_000 }, (_, j) => (i * 31 + j * 7) % 251)) : `from A ${i}\n`.repeat(50);
      await writeFile(path.join(a.dirs.vault, `a-${String(i).padStart(3, "0")}.md`), body);
    }
    const count = async (dir: string, prefix: string): Promise<number> => [...(await diskMap(dir)).keys()].filter((k) => k.startsWith(prefix)).length;
    await waitFor(async () => (await count(b.dirs.vault, "a-")) >= 3, 120_000, 20, "B received some of A's files");
    const aOnB = await count(b.dirs.vault, "a-");
    const bOnA = await count(a.dirs.vault, "b-");
    child.p.kill("SIGKILL");
    expect(await child.exited).toBeNull();                       // killed by the signal, no exit code
    // The kill really interrupted the work.
    expect(aOnB < A_FILES || bOnA < 20, `at the kill: ${aOnB}/${A_FILES} downloaded, ${bOnA}/20 uploaded`).toBe(true);

    // Restart on the same state; everything converges.
    await sleep(300);
    child = await startChild(b, "2");
    let streak = 0;
    await waitFor(async () => {
      const [ma, mb, st] = await Promise.all([diskMap(a.dirs.vault), diskMap(b.dirs.vault), childStatus(b)]);
      const ok = ma.size === TOTAL && same(ma, mb) && st?.engine.status === "synced" && st.engine.pendingUp === 0 && st.engine.pendingDown === 0
        && a.daemon!.engine.status().status === "synced" && a.daemon!.engine.status().pendingUp === 0;
      streak = ok ? streak + 1 : 0;
      return streak >= 3;
    }, 240_000, 250, "convergence after the restart").catch(async (e: unknown) => {
      const log = await readFile(child.log, "utf8").catch(() => "");
      throw new Error(`${String(e)}\nA=${(await diskMap(a.dirs.vault)).size} B=${(await diskMap(b.dirs.vault)).size} ${JSON.stringify(await childStatus(b))}\n${log.slice(-4000)}`);
    });
    const ma = await diskMap(a.dirs.vault);
    expect([...ma.keys()].some((k) => k.includes("onflict"))).toBe(false);
    expect((await childStatus(b))!.engine.failed).toBe(0);
    // One live head per file on the server: no duplicate created by a replayed upload.
    const heads = [...a.daemon!.engine.index.remote.all()].filter((h) => !h.deleted);
    expect(heads).toHaveLength(TOTAL);
    expect(new Set(heads.map((h) => h.path)).size).toBe(TOTAL);
    expect(a.daemon!.engine.deletedFiles()).toEqual([]);

    // Graceful stop (SIGTERM), then the bundle's own verify against the server.
    child.p.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const ver = await runBundle(["verify", "--state", b.dirs.state, "--remote"]);
    expect(ver.lines.join("\n")).toContain(`equal: ${TOTAL} files`);
    expect(ver.code).toBe(0);
  }, T);
});
