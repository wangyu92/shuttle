// CLI end to end (design §6.1.12, §4.12.2, §7.7): setup with an enroll code, pair-init through the real
// mailbox (the test plays the plugin), a substituted envelope, one-pass sync, verify, manifest, the
// continuous daemon with status/guard/pause/resume/rescan/debug over the control socket, secrets
// permissions, config, unlink, prodGuard. In-process against the real server on 127.0.0.1.
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secretScan } from "@shuttle/testkit";
import { runCli, type CliIo } from "../src/cli";
import { memoryLogger } from "../src/log";
import type { Daemon } from "../src/main";
import { parsePairingLink, sealPairingEnvelope } from "../src/pair";
import { readSecrets, secretsPath } from "../src/secrets";
import { createTestVault, ownerAdapter, startWorld, stopWorld, type TestVault, type World } from "./e2eHarness";
import { sleep, waitFor } from "./tmp";

const T = 300_000;
let w: World;
let v: TestVault;

beforeAll(async () => {
  w = await startWorld("cli");
  v = await createTestVault(w, "cli-vault");
}, T);
afterAll(async () => { await stopWorld(w); }, T);

interface Cap { io: CliIo; out: string[]; err: string[]; daemon: Daemon | null; exits: number[] }

function capture(extra: Partial<CliIo> = {}): Cap {
  const c: Cap = { out: [], err: [], daemon: null, exits: [], io: undefined as unknown as CliIo };
  c.io = {
    out: (l) => c.out.push(l), err: (l) => c.err.push(l),
    env: { HOME: path.join(w.dir, "home"), SHUTTLE_PAIR_POLL_MS: "100" },
    logger: memoryLogger(), exit: (code) => { c.exits.push(code); }, installProcessHandlers: false,
    onDaemon: (d) => { c.daemon = d; },
    ...extra,
  };
  return c;
}

async function enrollCode(): Promise<string> {
  const ad = ownerAdapter(w, v.vaultId);
  await ad.connect();
  const r = await ad.createEnrollCode(600);
  await ad.close();
  return r.code;
}

async function setupNode(name: string, mode = "bidirectional"): Promise<{ state: string; vault: string; code: number; cap: Cap }> {
  const root = path.join(w.dir, name);
  const vault = path.join(root, "data/vault");
  await mkdir(vault, { recursive: true });
  await mkdir(path.join(root, "data/.shuttle-tmp"), { recursive: true });
  const state = path.join(root, "st");
  const cap = capture();
  const code = await runCli(["setup", "--server", w.srv.url, "--enroll", await enrollCode(), "--vault", "cli-vault", "--path", vault,
    "--mode", mode, "--device-name", name, "--state", state], cap.io);
  return { state, vault, code, cap };
}

/** Answer a pair-init link the way the plugin does (design §4.12.2 step 3). */
async function answerPairing(out: string[], keys: Record<string, string>): Promise<void> {
  await waitFor(() => out.some((l) => l.includes("obsidian://shuttle-pair")), 20_000, 50, "pairing link");
  const link = out.join("\n").split("\n").find((l) => l.startsWith("obsidian://")) as string;
  const p = parsePairingLink(link);
  expect(p.vaultId).toBe(v.vaultId);
  const body = await sealPairingEnvelope(p, { vaultId: v.vaultId, keys, infoRev: v.info.infoRev });
  const ad = ownerAdapter(w, v.vaultId);
  await ad.connect();
  await ad.pairingPut(p.pairId, body);
  await ad.close();
}

const realKeys = (): Record<string, string> => Object.fromEntries(Object.entries(v.cache.kvs).map(([k, x]) => [String(k), x]));

describe("shuttle-headless CLI", () => {
  it("setup → pair-init → sync → verify → manifest → daemon control → unlink", async () => {
    const n = await setupNode("mirror");
    expect(n.cap.err).toEqual([]);
    expect(n.code).toBe(0);
    const sfile = secretsPath(n.state, {});
    expect((await stat(sfile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(sfile))).mode & 0o777).toBe(0o700);
    expect(readSecrets(sfile).keys).toEqual({});
    const cfg = JSON.parse(await readFile(path.join(n.state, "headless.json"), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(cfg)).not.toMatch(/sxd_/);

    // pair-init: the link carries only a public key; the answer goes through the mailbox.
    const pc = capture();
    const pairing = runCli(["pair-init", "--state", n.state, "--timeout", "30s"], pc.io);
    await answerPairing(pc.out, realKeys());
    expect(await pairing).toBe(0);
    const s = readSecrets(sfile);
    expect(s.keys).toEqual(realKeys());
    expect(s.seen?.epoch).toBe(v.info.epoch);

    // One pass of sync uploads a local file.
    await writeFile(path.join(n.vault, "hello.md"), "hello from the mirror\n");
    const sc = capture();
    expect(await runCli(["sync", "--state", n.state], sc.io)).toBe(0);
    const vc = capture();
    expect(await runCli(["verify", "--state", n.state], vc.io)).toBe(0);
    expect(vc.out.join("\n")).toContain("equal: 1 files");
    expect(await runCli(["verify", "--state", n.state, "--remote"], capture().io)).toBe(0);
    await writeFile(path.join(n.vault, "local-only.md"), "x\n");
    const vd = capture();
    expect(await runCli(["verify", "--state", n.state, "--remote"], vd.io)).toBe(5);
    expect(vd.out).toContain("only-local\tlocal-only.md");

    const mf = path.join(w.dir, "manifest.tsv");
    expect(await runCli(["manifest", "--state", n.state, "--out", mf], capture().io)).toBe(0);
    const rows = (await readFile(mf, "utf8")).trim().split("\n");
    expect(rows.map((r) => r.split("\t")[0])).toEqual(["hello.md", "local-only.md"]);
    expect(rows[0]).toMatch(/^hello\.md\t22\t[0-9a-f]{64}$/);

    // status without a daemon: unreachable.
    expect(await runCli(["status", "--state", n.state, "--quiet"], capture().io)).toBe(2);

    // The continuous daemon, driven over the control socket.
    const dc = capture();
    const daemonRun = runCli(["sync", "--continuous", "--state", n.state], dc.io);
    await waitFor(() => dc.daemon?.health?.status === "ok", 60_000, 100, "daemon healthy");
    const st = capture();
    expect(await runCli(["status", "--state", n.state, "--json"], st.io)).toBe(0);
    expect(JSON.parse(st.out[0] as string)).toMatchObject({ status: "ok", mode: "bidirectional" });
    const gl = capture();
    expect(await runCli(["guard", "list", "--state", n.state], gl.io)).toBe(0);
    expect(gl.out).toEqual(["no pending guards"]);
    expect(await runCli(["pause", "--state", n.state], capture().io)).toBe(0);
    await waitFor(async () => (await runCli(["status", "--state", n.state, "--quiet"], capture().io)) === 4, 20_000, 200, "paused = down");
    expect(await runCli(["resume", "--state", n.state], capture().io)).toBe(0);
    expect(await runCli(["rescan", "--state", n.state], capture().io)).toBe(0);
    await waitFor(async () => (await runCli(["status", "--state", n.state, "--quiet"], capture().io)) === 0, 30_000, 200, "healthy again");
    const dbg = capture();
    expect(await runCli(["debug", "--state", n.state], dbg.io)).toBe(0);
    expect(dbg.out.join("\n")).toContain("engineVersion");

    // H3: nothing secret in any output of any command, the daemon log, health.json or headless.json.
    const texts = [...pc.out, ...pc.err, ...sc.out, ...dc.out, ...st.out, ...dbg.out,
      ...(dc.io.logger as ReturnType<typeof memoryLogger>).lines, ...(sc.io.logger as ReturnType<typeof memoryLogger>).lines,
      await readFile(path.join(n.state, "health.json"), "utf8"), await readFile(path.join(n.state, "headless.json"), "utf8")].join("\n");
    expect(secretScan(texts, [{ name: "token", value: s.token }, ...Object.values(s.keys).map((k, i) => ({ name: `vmk${i}`, value: k }))])).toEqual([]);

    await dc.daemon!.supervisor!.terminate("test");
    expect(await daemonRun).toBe(0);
    expect(dc.exits).toEqual([0]);

    // config edits headless.json; mode changes need a restart.
    expect(await runCli(["config", "--state", n.state, "--mode", "pull-only", "--exclude", "Private", "--selective", "videos=off"], capture().io)).toBe(0);
    const cfg2 = JSON.parse(await readFile(path.join(n.state, "headless.json"), "utf8")) as { mode: string; excludedFolders: string[]; selective: { videos: boolean } };
    expect(cfg2).toMatchObject({ mode: "pull-only", excludedFolders: ["Private"], selective: { videos: false } });

    // secrets.json readable by others: refuse to start (exit 3).
    await chmod(sfile, 0o644);
    const bad = capture();
    expect(await runCli(["sync", "--state", n.state], bad.io)).toBe(3);
    expect(bad.err.join("\n")).toMatch(/permissions too open \(0644\)/);
    await chmod(sfile, 0o600);

    // unlink: token revoked, secrets and state gone, vault files untouched.
    expect(await runCli(["unlink", "--state", n.state], capture().io)).toBe(0);
    expect(existsSync(sfile)).toBe(false);
    expect(existsSync(path.join(n.state, "state.db"))).toBe(false);
    expect(existsSync(path.join(n.vault, "hello.md"))).toBe(true);
    const ad = ownerAdapter(w, v.vaultId);
    await ad.connect();
    const dev = (await ad.listDevices()).find((d) => d.deviceId === s.deviceId);
    await ad.close();
    expect(dev?.revoked).toBe(true);
  }, T);

  it("a substituted pairing envelope is rejected and nothing is written (exit 14)", async () => {
    const n = await setupNode("mirror-sub");
    expect(n.code).toBe(0);
    const pc = capture();
    const pairing = runCli(["pair-init", "--state", n.state, "--timeout", "30s"], pc.io);
    const wrong = { "1": Buffer.from(new Uint8Array(32).fill(9)).toString("base64url") };
    await answerPairing(pc.out, wrong);
    expect(await pairing).toBe(14);
    expect(readSecrets(secretsPath(n.state, {})).keys).toEqual({});
    // A pair-init nobody answers times out (exit 13).
    expect(await runCli(["pair-init", "--state", n.state, "--timeout", "1s"], capture().io)).toBe(13);
  }, T);

  it("setup refuses a bad enroll code (10), an unknown vault (12) and a production path (9)", async () => {
    const root = path.join(w.dir, "neg");
    const vault = path.join(root, "vault");
    await mkdir(vault, { recursive: true });
    const base = ["--server", w.srv.url, "--path", vault, "--mode", "push-only", "--device-name", "neg", "--state", path.join(root, "st")];
    expect(await runCli(["setup", "--enroll", "SXE-not-a-code", "--vault", "cli-vault", ...base], capture().io)).toBe(10);
    expect(await runCli(["setup", "--enroll", await enrollCode(), "--vault", "no-such-vault", ...base], capture().io)).toBe(12);
    const prodVault = path.join(w.dir, "home", "Obsidian", "vault");   // $HOME/Obsidian of the fake HOME
    const pg = capture();
    expect(await runCli(["setup", "--enroll", "SXE-x", "--vault", "cli-vault", "--server", w.srv.url, "--path", prodVault,
      "--mode", "push-only", "--device-name", "neg", "--state", path.join(root, "st2")], pg.io)).toBe(9);
    expect(existsSync(prodVault)).toBe(false);
    expect(await runCli(["nope"], capture().io)).toBe(1);
    await sleep(10);
  }, T);
});
