// Headless e2e harness (design §7.7): the real @shuttle/server in-process on 127.0.0.1, real files in
// ~/tmp/claude/shuttle-p1/hl, headless daemons with real timers and inotify. Fixtures only: user
// "alice", no real hosts. The vault is created with @shuttle/crypto (real key checks and infoMac).
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PBKDF2_MIN_ITER, createVault, type CachedSecrets } from "@shuttle/crypto";
import type { VaultInfo } from "@shuttle/protocol";
import { ServerAdapter, fetchHttpClient } from "@shuttle/adapter-server";
import { startServer, type RunningServer } from "../../server/src/server";
import { addUser, login, testOptions, type Client } from "../../server/test/helpers";
import { defaultConfig, type HeadlessConfig } from "../src/config";
import { memoryLogger, type Logger } from "../src/log";
import { Daemon, nodeWs } from "../src/main";
import { SECRETS_FORMAT, secretsPath, writeSecrets, type HeadlessSecrets } from "../src/secrets";
import { removeDir, tempDir, waitFor } from "./tmp";

export const PASSPHRASE = "correct horse battery staple";
export const SMALL_CHUNKER = { alg: "fastcdc-k1" as const, min: 2048, avg: 4096, max: 16384 };

export interface World {
  dir: string;
  srv: RunningServer;
  owner: Client;
}

export async function startWorld(prefix: string): Promise<World> {
  const dir = await tempDir(prefix);
  const srv = await startServer(testOptions(path.join(dir, "server"), { coalesceMs: 5, log: () => undefined }));
  await addUser(path.join(dir, "server"), "alice");
  const owner = await login(srv, "alice", "owner-laptop");
  return { dir, srv, owner };
}

export async function stopWorld(w: World | undefined): Promise<void> {
  if (!w) return;
  await w.srv.close().catch(() => undefined);
  await removeDir(w.dir);
}

export interface TestVault { vaultId: string; info: VaultInfo; cache: CachedSecrets; name: string }

/** A vault on the real server, created the way the plugin does (createVault + POST /v1/vaults). */
export async function createTestVault(w: World, name: string): Promise<TestVault> {
  const { info, cache } = await createVault(PASSPHRASE, { kdf: { iter: PBKDF2_MIN_ITER }, params: { chunker: SMALL_CHUNKER } });
  const boot = ownerAdapter(w, info.vaultId, name);
  await boot.connect();
  await boot.createVaultInfo(info as unknown as VaultInfo);
  await boot.close();
  return { vaultId: info.vaultId, info: info as unknown as VaultInfo, cache, name };
}

export function ownerAdapter(w: World, vaultId: string, vaultName?: string): ServerAdapter {
  return new ServerAdapter({
    config: { urls: [w.srv.url], vaultId }, token: w.owner.token, http: fetchHttpClient(), ws: nodeWs,
    client: { name: "owner", platform: "linux", version: "0.1.0", role: "plugin" }, random: () => 0,
    ...(vaultName ? { vaultName } : {}),
  });
}

export interface NodeDirs { root: string; vault: string; tmp: string; state: string }

export async function nodeDirs(w: World, name: string): Promise<NodeDirs> {
  const root = path.join(w.dir, name);
  const d = { root, vault: path.join(root, "data/vault"), tmp: path.join(root, "data/.shuttle-tmp"), state: path.join(root, "st") };
  await mkdir(d.vault, { recursive: true });
  await mkdir(d.tmp, { recursive: true });
  await mkdir(path.join(d.state, "secret"), { recursive: true });
  await chmod(path.join(d.state, "secret"), 0o700);
  return d;
}

export interface HeadlessNode {
  name: string;
  dirs: NodeDirs;
  config: HeadlessConfig;
  log: Logger & { lines: string[] };
  daemon: Daemon | null;
  secrets: HeadlessSecrets;
}

/** Provision secrets.json directly (the CLI tests cover setup and pair-init). */
export async function provisionNode(w: World, v: TestVault, name: string, mode: HeadlessConfig["mode"] = "bidirectional", patch: Partial<HeadlessConfig> = {}): Promise<HeadlessNode> {
  const dirs = await nodeDirs(w, name);
  const client = await login(w.srv, "alice", name);
  const secrets: HeadlessSecrets = {
    format: SECRETS_FORMAT, v: 1, vaultId: v.vaultId, deviceId: client.deviceId, serverUrls: [w.srv.url], token: client.token,
    keys: Object.fromEntries(Object.entries(v.cache.kvs).map(([k, x]) => [String(k), x])), seen: null,
  };
  writeSecrets(secretsPath(dirs.state, {}), secrets);
  const config = { ...defaultConfig({ vaultPath: dirs.vault, tmpPath: dirs.tmp, urls: [w.srv.url], vaultId: v.vaultId, deviceName: name, mode }), ...patch };
  config.watch = { mode: "hybrid", pollIntervalSec: 2, ...(patch.watch ?? {}) };
  // FULL fsyncs every commit (~100 ms on the NAS) and node:sqlite blocks the loop: two daemons in one
  // test process would starve each other. NORMAL is equally durable across process death (WAL).
  config.stateSynchronous = patch.stateSynchronous ?? "normal";
  return { name, dirs, config, log: memoryLogger(), daemon: null, secrets };
}

export async function startNode(n: HeadlessNode, extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {}): Promise<Daemon> {
  const d = new Daemon({
    stateDir: n.dirs.state, config: n.config, log: n.log, env: { HOME: process.env["HOME"] ?? "" },
    installProcessHandlers: false, healthEveryMs: 250, exit: () => undefined, missGraceMs: 300,
    timings: { settleMs: 150, maxWaitMs: 1000, deleteHoldMs: 300, rawDebounceMs: 200 },
    ...extra,
  });
  await d.start();
  n.daemon = d;
  return d;
}

export async function stopNode(n: HeadlessNode): Promise<void> {
  const d = n.daemon;
  n.daemon = null;
  await d?.stop();
}

/** sha256 of every synced (non-dot, non-conflict-copy unless asked) file under the vault. */
export async function diskMap(vault: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        const bytes = await readFile(path.join(dir, e.name)).catch(() => null);   // raced with a move or delete
        if (bytes) out.set(r.normalize("NFC"), createHash("sha256").update(bytes).digest("hex"));
      }
    }
  };
  await walk(vault, "");
  return out;
}

export function same(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function idle(n: HeadlessNode): boolean {
  const e = n.daemon?.engine;
  if (!e) return false;
  const s = e.status();
  return s.status === "synced" && s.pendingUp === 0 && s.pendingDown === 0 && e.dirty.size === 0;
}

/** Wait until every node is idle and all vaults hold the same files (checked three times in a row). */
export async function converge(nodes: readonly HeadlessNode[], timeoutMs = 60_000): Promise<void> {
  let streak = 0;
  try {
    await waitFor(async () => {
      const maps = await Promise.all(nodes.map((n) => diskMap(n.dirs.vault)));
      const ok = nodes.every(idle) && maps.every((m) => same(m, maps[0]!));
      streak = ok ? streak + 1 : 0;
      return streak >= 3;
    }, timeoutMs, 150, `convergence of ${nodes.map((n) => n.name).join(", ")}`);
  } catch (e) {
    const parts: string[] = [];
    for (const n of nodes) {
      const m = await diskMap(n.dirs.vault);
      const e2 = n.daemon?.engine;
      parts.push(`${n.name}: ${JSON.stringify(e2?.status())} dirty=${e2?.dirty.size} files=${[...m.keys()].sort().join(",")}`);
      parts.push(n.log.lines.slice(-15).join("\n"));
    }
    throw new Error(`${(e as Error).message}\n${parts.join("\n")}`);
  }
}

export async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
