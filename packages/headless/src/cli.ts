// shuttle-headless CLI (design §6.1.12). Every command accepts `--state <dir>` (default /state) and
// `--json`. Exit codes: 0 ok; 1 error; 2 daemon unreachable; 3 startup check failed; 4 a person is
// needed; 5 differences (verify); 9 prodGuard; 10 bad enroll code; 11 wrong passphrase; 12 no vault;
// 13 pairing timeout; 14 pairing validation failed.
//
// Secrets never come from argv or env values: the passphrase is read from a 0600 file (deleted after
// use) or a TTY prompt without echo; the token and keys live in secret/secrets.json.

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createVault, isCryptoError, unlock as cryptoUnlock, type VaultInfo as CryptoVaultInfo } from "@shuttle/crypto";
import type { GuardChoice, HttpClient, Keyring, RemoteHead, SyncMode, VaultInfo, VaultsResponse, WsFactory } from "@shuttle/protocol";
import { isRemoteError } from "@shuttle/protocol";
import { ServerAdapter, RestClient, DEFAULT_REST_TIMEOUTS, fetchHttpClient, realScheduler as adapterScheduler, serverEnroll } from "@shuttle/adapter-server";
import { DEFAULT_PLUGIN_ID, PathFilter, decodeRecord, nameRulesFor } from "@shuttle/engine";
import { ConfigError, defaultConfig, deviceSettingsOf, loadConfig, validateConfig, type HeadlessConfig } from "./config";
import { NodeLocalFs, prepareTmpDir } from "./NodeLocalFs";
import { SqliteStateStore } from "./state/SqliteStateStore";
import {
  SECRETS_FORMAT, SecretsError, readSecrets, secretDir, secretsPath, writeFileAtomicSync, writeSecrets, type HeadlessSecrets,
} from "./secrets";
import { ProdGuardError, checkPaths, checkServerUrls } from "./prodGuard";
import { PairingError, startPairing, validatePairedKeys, waitForEnvelope } from "./pair";
import { ControlClient, ControlUnreachable } from "./control/ControlClient";
import { createLogger, type LogFormat, type Logger } from "./log";
import { Daemon, EXIT, HEADLESS_VERSION, StartupError, buildKeyring, nodeWs } from "./main";
import type { HealthJson } from "./health";

export const EXIT_CODES = { ...EXIT, badCode: 10, wrongPassphrase: 11, noVault: 12, pairTimeout: 13, pairInvalid: 14 } as const;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  /** Passphrase prompt without echo (TTY only); null when no TTY is available. */
  readPassword?(prompt: string): Promise<string | null>;
  /** Network clients (tests inject nothing; production uses fetch and ws). */
  http?: HttpClient;
  ws?: WsFactory;
  /** Logger for `sync` (default: JSON lines on stdout). */
  logger?: Logger;
  /** Process exit used by the daemon's supervisor (default process.exit). */
  exit?: (code: number) => void;
  /** Install process signal handlers in `sync --continuous` (default true). */
  installProcessHandlers?: boolean;
  /** Called with the running daemon (tests). */
  onDaemon?(d: Daemon): void;
}

const USAGE = `usage: shuttle-headless <command> [--state <dir>] [--json]
  setup --server <url>... --enroll <code> (--vault <name> | --create-vault <name>) --path <dir> --mode <m> --device-name <n> [--tmp <dir>] [--password-file <f>]
  pair-init [--timeout 15m]
  unlock
  sync [--continuous] [--config <file>]
  status [--json] [--quiet]
  verify [--remote] [--paths-only]
  manifest --out <file>
  guard list | guard answer <id> apply|pause|accept|rebuild
  pause | resume | rescan
  config [--mode <m>] [--exclude <folder>]... [--include <folder>]... [--selective <class>=on|off]... [--config-categories <cat>=on|off]...
  debug
  unlink`;

const MODES: readonly SyncMode[] = ["bidirectional", "push-only", "pull-only", "mirror-remote"];

class CliError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "CliError";
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      state: { type: "string" }, json: { type: "boolean" }, quiet: { type: "boolean" }, config: { type: "string" },
      server: { type: "string", multiple: true }, enroll: { type: "string" }, vault: { type: "string" },
      "create-vault": { type: "string" }, path: { type: "string" }, tmp: { type: "string" }, mode: { type: "string" },
      "device-name": { type: "string" }, "password-file": { type: "string" }, "allow-http": { type: "boolean" },
      timeout: { type: "string" }, continuous: { type: "boolean" }, remote: { type: "boolean" }, "paths-only": { type: "boolean" },
      out: { type: "string" }, exclude: { type: "string", multiple: true }, include: { type: "string", multiple: true },
      selective: { type: "string", multiple: true }, "config-categories": { type: "string", multiple: true },
      "log-format": { type: "string" }, help: { type: "boolean" },
    },
  });
}
type Args = ReturnType<typeof parse>;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let a: Args;
  try {
    a = parse(argv);
  } catch (e) {
    io.err(String((e as Error).message));
    io.err(USAGE);
    return EXIT.error;
  }
  const [cmd, ...rest] = a.positionals;
  if (!cmd || a.values.help) {
    io.out(USAGE);
    return a.values.help ? EXIT.ok : EXIT.error;
  }
  const stateDir = path.resolve(a.values.state ?? "/state");
  const ctx: Ctx = { a, io, stateDir, configFile: path.resolve(a.values.config ?? path.join(stateDir, "headless.json")), rest };
  try {
    switch (cmd) {
      case "setup": return await setup(ctx);
      case "pair-init": return await pairInit(ctx);
      case "unlock": return await unlockCmd(ctx);
      case "sync": return await sync(ctx);
      case "status": return await status(ctx);
      case "verify": return await verify(ctx);
      case "manifest": return await manifest(ctx);
      case "guard": return await guard(ctx);
      case "pause": case "resume": case "rescan": return await simple(ctx, cmd);
      case "config": return await configCmd(ctx);
      case "debug": return await debugCmd(ctx);
      case "unlink": return await unlinkCmd(ctx);
      default:
        io.err(`unknown command: ${cmd}`);
        io.err(USAGE);
        return EXIT.error;
    }
  } catch (e) {
    return failure(io, e);
  }
}

function failure(io: CliIo, e: unknown): number {
  if (e instanceof CliError) { io.err(e.message); return e.code; }
  if (e instanceof ProdGuardError) { io.err(e.message); return EXIT.prodGuard; }
  if (e instanceof SecretsError) { io.err(e.message); return EXIT.startup; }
  if (e instanceof StartupError) { io.err(e.message); return e.exitCode; }
  if (e instanceof ConfigError) { io.err(e.message); return EXIT.startup; }
  if (e instanceof PairingError) { io.err(e.message); return e.reason === "timeout" ? EXIT_CODES.pairTimeout : EXIT_CODES.pairInvalid; }
  if (e instanceof ControlUnreachable) { io.err(e.message); return EXIT.unreachable; }
  if (isRemoteError(e)) { io.err(`server: ${e.code}: ${e.message}`); return EXIT.error; }
  io.err(`error: ${(e as Error)?.message ?? String(e)}`);
  return EXIT.error;
}

interface Ctx { a: Args; io: CliIo; stateDir: string; configFile: string; rest: string[] }

function print(ctx: Ctx, human: string, data: unknown): void {
  if (ctx.a.values.quiet) return;
  ctx.io.out(ctx.a.values.json ? JSON.stringify(data) : human);
}

function isLoopback(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || h.startsWith("127.");
  } catch {
    return false;
  }
}

function needHttp(urls: readonly string[]): boolean {
  return urls.some((u) => u.startsWith("http://") && !isLoopback(u));
}

function rest(io: CliIo, urls: string[], token: string | null, allowHttp: boolean): RestClient {
  return new RestClient({
    urls, http: io.http ?? fetchHttpClient(), token: () => token, scheduler: adapterScheduler(), allowHttp, timeouts: { ...DEFAULT_REST_TIMEOUTS },
  });
}

function adapterFor(io: CliIo, c: HeadlessConfig, s: HeadlessSecrets, vaultName?: string): ServerAdapter {
  return new ServerAdapter({
    config: { urls: c.remote.urls, vaultId: c.remote.vaultId, ...(s.deviceId ? { deviceId: s.deviceId } : {}) },
    token: () => s.token, http: io.http ?? fetchHttpClient(), ws: io.ws ?? nodeWs,
    client: { name: c.device.name, platform: "linux", version: HEADLESS_VERSION, role: "headless" },
    allowHttp: c.remote.allowHttp ?? false, ...(vaultName ? { vaultName } : {}),
  });
}

/** The passphrase from a 0600 file, deleted after use (design §6.1.12), never argv or env. */
function readPasswordFile(f: string): string {
  let st: import("node:fs").Stats;
  try {
    st = statSync(f);
  } catch {
    throw new CliError("password file not found", EXIT.error);
  }
  if ((st.mode & 0o077) !== 0) throw new CliError(`password file permissions too open (0${(st.mode & 0o777).toString(8)}); expected 0600`, EXIT.error);
  const pass = readFileSync(f, "utf8").replace(/\r?\n$/, "");
  try { writeFileSync(f, ""); } catch { /* best effort before unlinking */ }
  rmSync(f, { force: true });
  return pass;
}

function loadAll(ctx: Ctx): { c: HeadlessConfig; s: HeadlessSecrets; sfile: string } {
  const c = loadConfig(ctx.configFile, ctx.io.env);
  const sfile = secretsPath(ctx.stateDir, ctx.io.env);
  const s = readSecrets(sfile);
  return { c, s, sfile };
}

// ---------------- setup ----------------

async function setup(ctx: Ctx): Promise<number> {
  const v = ctx.a.values;
  const urls = v.server ?? [];
  if (urls.length === 0 || !v.enroll || !v.path || !v.mode || !v["device-name"] || (!v.vault && !v["create-vault"])) {
    throw new CliError(`setup needs --server, --enroll, --vault (or --create-vault), --path, --mode and --device-name\n${USAGE}`, EXIT.error);
  }
  if (!MODES.includes(v.mode as SyncMode)) throw new CliError(`--mode must be one of ${MODES.join(", ")}`, EXIT.error);
  const vaultPath = path.resolve(v.path);
  const tmpPath = path.resolve(v.tmp ?? path.join(path.dirname(vaultPath), ".shuttle-tmp"));
  checkPaths([vaultPath, tmpPath, ctx.stateDir], ctx.io.env);
  checkServerUrls(urls, ctx.io.env);
  if (v["create-vault"] && ctx.io.env["SHUTTLE_PROD"] === "1") throw new CliError("--create-vault is for sandboxes only (refused with SHUTTLE_PROD=1)", EXIT.error);
  // The temp dir before the enroll code is spent (single use): a daemon refuses to start without it
  // (design §6.1.3). push-only never writes into the vault and needs none.
  if (v.mode !== "push-only") {
    try {
      prepareTmpDir(vaultPath, tmpPath);
    } catch (e) {
      throw new CliError(`setup: ${(e as Error).message}`, EXIT.startup);
    }
  }
  const allowHttp = v["allow-http"] === true || needHttp(urls);
  const pass = v["password-file"] ? readPasswordFile(v["password-file"]) : null;
  if (v["create-vault"] && pass === null) throw new CliError("--create-vault needs --password-file", EXIT.error);

  const device = { name: v["device-name"], platform: "linux", clientVersion: HEADLESS_VERSION };
  let auth: { token: string; deviceId: string };
  try {
    auth = await serverEnroll({ urls, http: ctx.io.http ?? fetchHttpClient(), allowHttp }, v.enroll, device);
  } catch (e) {
    if (isRemoteError(e) && e.code !== "NETWORK" && e.code !== "TIMEOUT" && e.code !== "UNAVAILABLE") {
      throw new CliError(`enroll code rejected (${e.code})`, EXIT_CODES.badCode);
    }
    throw e;
  }
  let vaultId: string;
  let info: VaultInfo | null = null;
  let cache: { kvs: Record<number, string> } | null = null;
  if (v["create-vault"]) {
    const created = await createVault(pass as string);
    const ad = new ServerAdapter({
      config: { urls, vaultId: created.info.vaultId }, token: auth.token, http: ctx.io.http ?? fetchHttpClient(), ws: ctx.io.ws ?? nodeWs,
      client: { name: device.name, platform: "linux", version: HEADLESS_VERSION, role: "headless" }, allowHttp, vaultName: v["create-vault"],
    });
    await ad.connect();
    await ad.createVaultInfo(created.info as unknown as VaultInfo);
    await ad.close();
    vaultId = created.info.vaultId;
    info = created.info as unknown as VaultInfo;
    cache = created.cache;
  } else {
    const { data } = await rest(ctx.io, urls, auth.token, allowHttp).json("GET", "/vaults", "vaults");
    const list = (data as VaultsResponse | null)?.vaults ?? [];
    const hit = list.find((x) => x.name === v.vault) ?? list.find((x) => x.vaultId === v.vault);
    if (!hit) throw new CliError(`vault not found: ${v.vault}`, EXIT_CODES.noVault);
    vaultId = hit.vaultId;
  }
  const config = defaultConfig({ vaultPath, tmpPath, urls, vaultId, deviceName: v["device-name"], mode: v.mode as SyncMode, allowHttp });
  mkdirSync(path.dirname(ctx.configFile), { recursive: true });
  writeFileAtomicSync(ctx.configFile, JSON.stringify(config, null, 2) + "\n", 0o644);
  const secrets: HeadlessSecrets = {
    format: SECRETS_FORMAT, v: 1, vaultId, deviceId: auth.deviceId, serverUrls: urls, token: auth.token, keys: {}, seen: null,
  };
  const sfile = secretsPath(ctx.stateDir, ctx.io.env);
  writeSecrets(sfile, secrets);
  if (pass !== null) {
    if (!info) {
      const ad = adapterFor(ctx.io, config, secrets);
      await ad.connect();
      info = (await ad.getVaultInfo())?.info ?? null;
      await ad.close();
    }
    if (!info) throw new CliError("vault has no vault-info yet", EXIT_CODES.noVault);
    await storeUnlocked(sfile, secrets, pass, info, cache);
  }
  print(ctx, `setup done: vault ${vaultId}, device ${auth.deviceId}, mode ${config.mode}${pass === null ? "; run pair-init next" : ""}`,
    { vaultId, deviceId: auth.deviceId, mode: config.mode, unlocked: pass !== null });
  return EXIT.ok;
}

async function storeUnlocked(sfile: string, s: HeadlessSecrets, pass: string, info: VaultInfo, known: { kvs: Record<number, string> } | null): Promise<void> {
  let kvs = known?.kvs ?? null;
  if (!kvs) {
    try {
      kvs = (await cryptoUnlock(pass, info as unknown as CryptoVaultInfo, s.seen)).cache.kvs;
    } catch (e) {
      if (isCryptoError(e) && e.code === "WrongPassphrase") throw new CliError("wrong passphrase", EXIT_CODES.wrongPassphrase);
      throw e;
    }
  }
  s.keys = Object.fromEntries(Object.entries(kvs).map(([k, x]) => [String(k), x]));
  s.seen = { epoch: info.epoch, infoRev: info.infoRev, activeKv: info.activeKv, maxSeq: s.seen?.maxSeq ?? 0, maxEntryKey: s.seen?.maxEntryKey ?? null };
  s.ring = { activeKv: info.activeKv, metaPadBucket: info.params.metaPadBucket };
  writeSecrets(sfile, s);
}

// ---------------- pair-init / unlock ----------------

function parseDuration(s: string | undefined, def: number): number {
  if (!s) return def;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new CliError(`bad duration: ${s}`, EXIT.error);
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? "s") as "ms" | "s" | "m" | "h"];
}

async function pairInit(ctx: Ctx): Promise<number> {
  const { c, s, sfile } = loadAll(ctx);
  checkPaths([c.vaultPath, c.tmpPath, ctx.stateDir], ctx.io.env);
  const timeoutMs = parseDuration(ctx.a.values.timeout, 15 * 60_000);
  const ad = adapterFor(ctx.io, c, s);
  try {
    await ad.connect();
    const session = await startPairing(c.remote.vaultId);
    try {
      ctx.io.out(ctx.a.values.json ? JSON.stringify({ link: session.link, pairId: session.pairId }) : `Open this link on an unlocked device:\n${session.link}`);
      const body = await waitForEnvelope(ad, session.pairId, { timeoutMs, intervalMs: Number(ctx.io.env["SHUTTLE_PAIR_POLL_MS"] ?? 2000) });
      const payload = await session.open(body);
      const got = await ad.getVaultInfo();
      if (!got) throw new PairingError("validation", "vault has no vault-info");
      const v = await validatePairedKeys(payload, got.info, s.seen);
      s.keys = payload.keys;
      s.seen = v.seen;
      s.ring = { activeKv: got.info.activeKv, metaPadBucket: got.info.params.metaPadBucket };
      writeSecrets(sfile, s);
    } finally {
      session.dispose();
    }
  } finally {
    await ad.close().catch(() => undefined);
  }
  print(ctx, "paired: keys stored; restart the daemon if it is running", { paired: true });
  return EXIT.ok;
}

async function unlockCmd(ctx: Ctx): Promise<number> {
  const { c, s, sfile } = loadAll(ctx);
  const pass = ctx.io.readPassword ? await ctx.io.readPassword("Vault passphrase: ") : null;
  if (pass === null) throw new CliError("unlock needs a TTY (docker exec -it ... shuttle-headless unlock)", EXIT_CODES.wrongPassphrase);
  const ad = adapterFor(ctx.io, c, s);
  try {
    await ad.connect();
    const got = await ad.getVaultInfo();
    if (!got) throw new CliError("vault has no vault-info", EXIT_CODES.noVault);
    await storeUnlocked(sfile, s, pass, got.info, null);
  } finally {
    await ad.close().catch(() => undefined);
  }
  print(ctx, "unlocked: keys stored; restart the daemon if it is running", { unlocked: true });
  return EXIT.ok;
}

// ---------------- sync ----------------

async function sync(ctx: Ctx): Promise<number> {
  const config = loadConfig(ctx.configFile, ctx.io.env);
  const format = (ctx.a.values["log-format"] ?? "json") as LogFormat;
  const log = ctx.io.logger ?? createLogger({ format: format === "text" ? "text" : "json" });
  const continuous = ctx.a.values.continuous === true;
  let done!: (code: number) => void;
  const finished = new Promise<number>((r) => { done = r; });
  const exit = (code: number): void => {
    done(code);
    (ctx.io.exit ?? ((c2: number) => process.exit(c2)))(code);
  };
  const d = new Daemon({
    stateDir: ctx.stateDir, config, log, env: ctx.io.env, exit,
    installProcessHandlers: continuous ? (ctx.io.installProcessHandlers ?? true) : false,
    ...(ctx.io.http ? { http: ctx.io.http } : {}), ...(ctx.io.ws ? { ws: ctx.io.ws } : {}),
    ...(continuous ? {} : { manual: true, control: false }),
  });
  try {
    await d.start();
  } catch (e) {
    await d.stop().catch(() => undefined);
    throw e;
  }
  ctx.io.onDaemon?.(d);
  if (continuous) {
    // A ref'd timer keeps the process alive: watchers, sockets and timers are unref'd on purpose.
    const keepalive = setInterval(() => undefined, 1 << 30);
    try {
      return await finished;
    } finally {
      clearInterval(keepalive);
    }
  }
  // One pass: drive the loop until quiet (the feed arrives asynchronously).
  const e = d.engine;
  const deadline = Date.now() + 30 * 60_000;
  let quiet = 0;
  try {
    await e.whenConnected();
    while (Date.now() < deadline && quiet < 3) {
      const r = await e.runOnce();
      const s = e.status();
      quiet = r.work === 0 && e.dirty.size === 0 && s.pendingUp === 0 && s.pendingDown === 0 ? quiet + 1 : 0;
      if (s.status === "error" || s.status === "paused") break;
      await new Promise((res) => setTimeout(res, 300));
    }
    await d.tick();
    const s = e.status();
    const ok = (s.status === "synced" || (s.status === "syncing" && quiet >= 3)) && s.failed === 0;
    print(ctx, `sync: ${s.status}${s.reason ? ` (${s.reason})` : ""}, up ${s.pendingUp}, down ${s.pendingDown}, failed ${s.failed}`, { status: s, health: d.health });
    return ok ? EXIT.ok : EXIT.error;
  } finally {
    await d.stop();
  }
}

// ---------------- status / guard / control ----------------

function control(ctx: Ctx): ControlClient {
  return new ControlClient(path.join(ctx.stateDir, "control.sock"));
}

async function status(ctx: Ctx): Promise<number> {
  let h: HealthJson;
  try {
    const r = await control(ctx).get("/health");
    h = r.data as HealthJson;
    if (!h || typeof h !== "object" || !("status" in h)) throw new ControlUnreachable("daemon has no health yet");
  } catch (e) {
    if (!ctx.a.values.quiet) ctx.io.err(`daemon unreachable: ${(e as Error).message}`);
    return EXIT.unreachable;
  }
  if (!ctx.a.values.quiet) {
    if (ctx.a.values.json) ctx.io.out(JSON.stringify(h));
    else {
      ctx.io.out(`${h.status} (engine ${h.engine}, mode ${h.mode}, lag ${h.lagSeq}, up ${h.pending.up}, down ${h.pending.down}, failed ${h.pending.failed})`);
      for (const r of h.reasons) ctx.io.out(`  - ${r}`);
    }
  }
  return h.exitCode;
}

async function guard(ctx: Ctx): Promise<number> {
  const [sub, id, choice] = ctx.rest;
  const c = control(ctx);
  if (sub === "list" || sub === undefined) {
    const r = await c.get("/guards");
    const list = (r.data as Array<{ id: string; kind: string; n: number; sample: string[] }>) ?? [];
    if (ctx.a.values.json) ctx.io.out(JSON.stringify(list));
    else if (list.length === 0) ctx.io.out("no pending guards");
    else for (const g of list) ctx.io.out(`${g.id}\t${g.kind}\t${g.n}\t${g.sample.slice(0, 5).join(", ")}`);
    return EXIT.ok;
  }
  if (sub === "answer") {
    if (!id || !["apply", "pause", "accept", "rebuild"].includes(choice ?? "")) throw new CliError("usage: guard answer <id> apply|pause|accept|rebuild", EXIT.error);
    const r = await c.post(`/guards/${encodeURIComponent(id)}`, { choice: choice as GuardChoice });
    if (r.status !== 200) throw new CliError(`guard ${id}: ${JSON.stringify(r.data)}`, EXIT.error);
    print(ctx, `guard ${id}: ${choice}`, { id, choice });
    return EXIT.ok;
  }
  throw new CliError("usage: guard list | guard answer <id> <choice>", EXIT.error);
}

async function simple(ctx: Ctx, cmd: "pause" | "resume" | "rescan"): Promise<number> {
  const r = await control(ctx).post(`/${cmd}`);
  if (r.status !== 200) throw new CliError(`${cmd} failed`, EXIT.error);
  print(ctx, `${cmd}: ok`, { ok: true });
  return EXIT.ok;
}

// ---------------- verify / manifest ----------------

function filterOf(c: HeadlessConfig | null): PathFilter {
  const s = c ? { ...deviceSettingsOf(c) } : {};
  return new PathFilter({
    configDir: c?.configDir ?? ".obsidian", pluginId: DEFAULT_PLUGIN_ID, platform: "node", nameRules: nameRulesFor("node", { os: "linux" }),
    caseInsensitive: false, excludedFolders: s.excludedFolders ?? [], selective: s.selective ?? { images: true, audio: true, videos: true, pdfs: true, other: true },
    configCategories: s.configCategories ?? {} as never, maxFileBytes: s.maxFileBytes ?? 209_715_200,
  });
}

async function localHashes(root: string, tmp: string, filter: PathFilter, configDir: string): Promise<Map<string, { size: number; hash: string }>> {
  const fs = new NodeLocalFs({ root, tmpDir: tmp, readOnly: true, configDir });
  const out = new Map<string, { size: number; hash: string }>();
  for await (const batch of fs.listAll({ includeConfigDir: true })) {
    for (const st of batch) {
      if (st.kind !== "file" || filter.scope(st.path, st.size) !== "active") continue;
      const bytes = await fs.read(st.path).catch(() => null);
      if (!bytes) continue;
      out.set(st.path, { size: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return out;
}

async function verify(ctx: Ctx): Promise<number> {
  const { c, s } = loadAll(ctx);
  const filter = filterOf(c);
  const local = await localHashes(c.vaultPath, c.tmpPath, filter, c.configDir ?? ".obsidian");
  const remote = new Map<string, string | null>();
  if (ctx.a.values.remote) {
    // Fresh heads from the server (REST snapshot), decrypted here; nothing is written.
    const ad = adapterFor(ctx.io, c, s);
    try {
      await ad.connect();
      const k = await buildKeyring(s, async () => (await ad.getVaultInfo())?.info ?? null, createLogger({ write: () => undefined }));
      if (!k.ring) throw new CliError("vault is locked on this device (no keys)", EXIT.person);
      let token: string | null = null;
      do {
        const page = await ad.snapshot({ pageToken: token, tombstones: false });
        for (const rec of page.records) {
          const d = await decodeRecord(k.ring as Keyring, rec);
          if (d.head && !d.head.deleted) remote.set(d.head.path, d.head.contentHash);
        }
        token = page.next;
      } while (token);
    } finally {
      await ad.close().catch(() => undefined);
    }
  } else {
    const dbFile = path.join(ctx.stateDir, "state.db");
    if (!existsSync(dbFile)) throw new CliError("no state.db yet: run sync first, or use verify --remote", EXIT.error);
    const st = SqliteStateStore.open(dbFile);
    try {
      const heads = await st.tx(["remote"], (tx) => tx.remote.getAll({ index: "deleted", only: false }), "readonly");
      for (const h of heads as RemoteHead[]) remote.set(h.path, h.contentHash);
    } finally {
      await st.close();
    }
  }
  const lines: string[] = [];
  const out = { onlyLocal: [] as string[], onlyRemote: [] as string[], differ: [] as string[] };
  for (const [p, l] of local) {
    if (!remote.has(p)) out.onlyLocal.push(p);
    else if (!ctx.a.values["paths-only"] && remote.get(p) !== l.hash) out.differ.push(p);
  }
  for (const p of remote.keys()) if (!local.has(p) && filter.scope(p) === "active") out.onlyRemote.push(p);
  for (const k of ["onlyLocal", "onlyRemote", "differ"] as const) out[k].sort();
  for (const p of out.onlyLocal) lines.push(`only-local\t${p}`);
  for (const p of out.onlyRemote) lines.push(`only-remote\t${p}`);
  for (const p of out.differ) lines.push(`differ\t${p}`);
  const n = lines.length;
  if (ctx.a.values.json) ctx.io.out(JSON.stringify({ ...out, local: local.size, remote: remote.size }));
  else if (!ctx.a.values.quiet) {
    for (const l of lines) ctx.io.out(l);
    ctx.io.out(n === 0 ? `equal: ${local.size} files` : `${n} differences`);
  }
  return n === 0 ? EXIT.ok : EXIT.differences;
}

async function manifest(ctx: Ctx): Promise<number> {
  const outFile = ctx.a.values.out;
  if (!outFile) throw new CliError("manifest needs --out <file>", EXIT.error);
  let c: HeadlessConfig | null = null;
  try { c = loadConfig(ctx.configFile, ctx.io.env); } catch { c = null; }
  const root = path.resolve(ctx.a.values.path ?? c?.vaultPath ?? "");
  if (!root || !existsSync(root)) throw new CliError("manifest needs a vault: --path <dir> or a headless.json", EXIT.error);
  const filter = filterOf(c);
  const local = await localHashes(root, c?.tmpPath ?? root, filter, c?.configDir ?? ".obsidian");
  const rows = [...local.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([p, v]) => `${p}\t${v.size}\t${v.hash}`);
  writeFileAtomicSync(path.resolve(outFile), rows.join("\n") + (rows.length ? "\n" : ""), 0o644);
  print(ctx, `manifest: ${rows.length} files`, { files: rows.length });
  return EXIT.ok;
}

// ---------------- config / debug / unlink ----------------

function toggles(list: string[] | undefined, what: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const item of list ?? []) {
    const m = /^([^=]+)=(on|off|true|false)$/.exec(item);
    if (!m) throw new CliError(`${what}: expected <name>=on|off, got ${item}`, EXIT.error);
    out[m[1] as string] = m[2] === "on" || m[2] === "true";
  }
  return out;
}

async function configCmd(ctx: Ctx): Promise<number> {
  const v = ctx.a.values;
  const raw = JSON.parse(readFileSync(ctx.configFile, "utf8")) as HeadlessConfig;
  const next: HeadlessConfig = { ...raw };
  if (v.mode) {
    if (!MODES.includes(v.mode as SyncMode)) throw new CliError(`--mode must be one of ${MODES.join(", ")}`, EXIT.error);
    next.mode = v.mode as SyncMode;
  }
  const ex = new Set(raw.excludedFolders);
  for (const f of v.exclude ?? []) ex.add(f);
  for (const f of v.include ?? []) ex.delete(f);
  next.excludedFolders = [...ex];
  next.selective = { ...raw.selective, ...toggles(v.selective, "--selective") } as HeadlessConfig["selective"];
  next.configCategories = { ...raw.configCategories, ...toggles(v["config-categories"], "--config-categories") };
  const valid = validateConfig(next, ctx.io.env);
  writeFileAtomicSync(ctx.configFile, JSON.stringify(valid, null, 2) + "\n", 0o644);
  print(ctx, `config saved${v.mode ? "; --mode takes effect on restart" : ""}`, valid);
  return EXIT.ok;
}

async function debugCmd(ctx: Ctx): Promise<number> {
  try {
    const r = await control(ctx).get("/debug");
    ctx.io.out(JSON.stringify(r.data, null, ctx.a.values.json ? 0 : 2));
    return EXIT.ok;
  } catch {
    // Daemon not running: offline facts only, never secrets.
    let c: HeadlessConfig | null = null;
    try { c = loadConfig(ctx.configFile, ctx.io.env); } catch { c = null; }
    const info = {
      version: HEADLESS_VERSION, daemon: "unreachable", config: c ? { ...c, remote: { ...c.remote } } : null,
      secrets: existsSync(secretsPath(ctx.stateDir, ctx.io.env)) ? "present" : "missing",
      stateDb: existsSync(path.join(ctx.stateDir, "state.db")) ? "present" : "missing",
    };
    ctx.io.out(JSON.stringify(info, null, ctx.a.values.json ? 0 : 2));
    return EXIT.ok;
  }
}

async function unlinkCmd(ctx: Ctx): Promise<number> {
  const sfile = secretsPath(ctx.stateDir, ctx.io.env);
  let revoked = false;
  try {
    const s = readSecrets(sfile, { checkPermissions: false });
    let allowHttp = needHttp(s.serverUrls);
    try { allowHttp = loadConfig(ctx.configFile, ctx.io.env).remote.allowHttp ?? allowHttp; } catch { /* config optional here */ }
    await rest(ctx.io, s.serverUrls, s.token, allowHttp).call("POST", "/auth/logout", "logout");
    revoked = true;
  } catch (e) {
    ctx.io.err(`logout failed (${(e as Error).message}); deleting local secrets anyway`);
  }
  rmSync(sfile, { force: true });
  rmSync(secretDir(ctx.stateDir), { recursive: true, force: true });
  for (const f of ["state.db", "state.db-wal", "state.db-shm", "local.json", "health.json"]) rmSync(path.join(ctx.stateDir, f), { force: true });
  print(ctx, `unlinked${revoked ? " (token revoked)" : ""}; vault files untouched`, { revoked });
  return EXIT.ok;
}

/** TTY passphrase prompt without echo; null when stdin is not a TTY. */
export function ttyPassword(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let s = "";
    const onData = (ch: string): void => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(s);
          return;
        }
        if (c === "\u0003") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stderr.write("\n"); resolve(null); return; }
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on("data", onData);
  });
}

export function processIo(): CliIo {
  return {
    out: (l) => { process.stdout.write(l + "\n"); },
    err: (l) => { process.stderr.write(l + "\n"); },
    env: process.env,
    readPassword: ttyPassword,
  };
}
