// The headless daemon (design §6.1): config → prodGuard → secrets → state DB → startup checks →
// NodeLocalFs + Watcher → ServerAdapter (wrapped for mode enforcement and progress) → createEngine →
// guards, health, control socket, supervision.

import { readFileSync, readdirSync, renameSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type {
  DebugInfo, GuardChoice, GuardEvent, HttpClient, Keyring, LogEntry, StateStore, VaultInfo, WsFactory, WsLike,
} from "@shuttle/protocol";
import { adapterStateStoreOver, isStateStoreError } from "@shuttle/protocol";
import { SxKeyring, fromB64u, fromCache, isCryptoError, type CachedSecrets, type Seen, type VaultInfo as CryptoVaultInfo } from "@shuttle/crypto";
import {
  ENGINE_VERSION, createEngine, readMeta, type EventTimings, type LocalRecordStore, type SeenStore, type ShuttleEngine,
} from "@shuttle/engine";
import type { LocalRecord } from "@shuttle/engine";
import { ServerAdapter, fetchHttpClient } from "@shuttle/adapter-server";
import { deviceSettingsOf, scanIntervalMs, watchModeOf, type HeadlessConfig } from "./config";
import { NodeLocalFs, startupChecks } from "./NodeLocalFs";
import { SqliteStateStore } from "./state/SqliteStateStore";
import { Watcher } from "./watch/Watcher";
import type { InotifyProbe } from "./watch/inotifyBudget";
import { readSecrets, secretsPath, writeSecrets, writeFileAtomicSync, type HeadlessSecrets } from "./secrets";
import { checkPaths, checkServerUrls } from "./prodGuard";
import { wrapRemote, type RemoteProgress } from "./remote";
import { HealthClock, computeHealth, writeHealthFile, type HealthJson } from "./health";
import { ControlServer } from "./control/ControlServer";
import { Supervisor } from "./supervisor";
import type { Logger } from "./log";

export const HEADLESS_VERSION = ENGINE_VERSION;
export const EXIT = { ok: 0, error: 1, unreachable: 2, startup: 3, person: 4, differences: 5, prodGuard: 9 } as const;
const TRASH_KEEP_MS = 30 * 24 * 3600 * 1000;

export class StartupError extends Error {
  constructor(message: string, readonly exitCode: number = EXIT.startup) {
    super(message);
    this.name = "StartupError";
  }
}

export const nodeWs: WsFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as WsLike;

export interface DaemonOptions {
  stateDir: string;
  config: HeadlessConfig;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  http?: HttpClient;
  ws?: WsFactory;
  /** health.json cadence (design §6.1.9: 15 s). */
  healthEveryMs?: number;
  /** Process-level handlers and process.exit (false in tests that run several daemons in one process). */
  installProcessHandlers?: boolean;
  exit?: (code: number) => void;
  /** `sync` without --continuous: the caller drives runOnce(). */
  manual?: boolean;
  /** Watcher test hooks. */
  watcherDeliver?: boolean;
  inotifyProbe?: InotifyProbe;
  /** Engine local event timings (tests shorten the settle time). */
  timings?: Partial<EventTimings>;
  /** Control socket (default on). */
  control?: boolean;
  /** Missing-event grace of the watcher (ms). */
  missGraceMs?: number;
  /** Uptime before the first nightly backup may run (VACUUM INTO blocks the loop; default 10 min). */
  backupDelayMs?: number;
}

/**
 * LocalRecordStore (design §3.3.5) as `<state>/local.json`, written synchronously via temp + rename.
 * The record changes with every journaled op (pending-op mirror), so only a change of deviceId or
 * dbEpoch is fsynced; an fsync costs ~100 ms on the NAS volume and node blocks meanwhile. The state DB
 * stays the source of truth; the mirror only matters if state.db is lost.
 */
export class FileLocalRecordStore implements LocalRecordStore {
  private last: LocalRecord | null = null;
  constructor(readonly file: string) {}
  load(): LocalRecord | null {
    try {
      this.last = JSON.parse(readFileSync(this.file, "utf8")) as LocalRecord;
      return structuredClone(this.last);
    } catch {
      return null;
    }
  }
  save(r: LocalRecord): void {
    const durable = !this.last || this.last.deviceId !== r.deviceId || this.last.dbEpoch !== r.dbEpoch || this.last.everSynced !== r.everSynced;
    const text = JSON.stringify(r) + "\n";
    if (durable) writeFileAtomicSync(this.file, text, 0o644);
    else {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode: 0o644 });
      renameSync(tmp, this.file);
    }
    this.last = structuredClone(r);
  }
}

/**
 * SeenStore kept in secrets.json (design §4.12.1 `seen`). A change of epoch, infoRev or activeKv is
 * written at once (synchronous, fsynced). A change of maxSeq alone is coalesced to one write per
 * `coalesceMs`: every write fsyncs (~100 ms on the NAS, blocking the loop), and a slightly stale maxSeq
 * only makes rollback detection less sensitive, never raises a false alarm.
 */
export class SecretsSeenStore implements SeenStore {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly file: string, private readonly s: HeadlessSecrets, private readonly coalesceMs = 5000) {}
  load(): Seen | null {
    return this.s.seen ? { ...this.s.seen } : null;
  }
  save(seen: Seen): void {
    const cur = this.s.seen;
    if (cur && cur.epoch === seen.epoch && cur.infoRev === seen.infoRev && cur.activeKv === seen.activeKv && cur.maxSeq === seen.maxSeq
      && (cur.maxEntryKey ?? null) === (seen.maxEntryKey ?? null)) return;
    const keyChange = !cur || cur.epoch !== seen.epoch || cur.infoRev !== seen.infoRev || cur.activeKv !== seen.activeKv;
    this.s.seen = { ...seen };
    if (keyChange) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    this.timer.unref();
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeSecrets(this.file, this.s);
  }
}

function vmksOf(s: HeadlessSecrets): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  for (const [k, v] of Object.entries(s.keys)) m.set(Number(k), fromB64u(v));
  return m;
}

/**
 * Keyring from the cached keys (design §4.12.3). With the server reachable, design §4.5.3 "from cache"
 * checks 6-9 run against the live vault-info; a missing active kv means Locked (null). Unreachable:
 * the keyring is built from the last validated parameters; the engine validates on connect.
 */
export async function buildKeyring(s: HeadlessSecrets, getInfo: () => Promise<VaultInfo | null>, log: Logger): Promise<{ ring: Keyring | null; info: VaultInfo | null; pullOnly: boolean }> {
  if (Object.keys(s.keys).length === 0) return { ring: null, info: null, pullOnly: false };
  let info: VaultInfo | null = null;
  try {
    info = await getInfo();
  } catch (e) {
    log.warn("network", "vault-info unreachable at startup; using cached keyring parameters", { err: (e as Error).name });
  }
  if (info) {
    try {
      const cache: CachedSecrets = { vaultId: s.vaultId, kvs: Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [Number(k), v])) };
      const r = await fromCache(cache, info as unknown as CryptoVaultInfo, s.seen);
      return { ring: r.ring as unknown as Keyring, info, pullOnly: r.pullOnly };
    } catch (e) {
      if (isCryptoError(e) && e.code === "Locked") {
        log.error("account", "vault keys are out of date (key rotated); re-pair this device");
        return { ring: null, info, pullOnly: false };
      }
      // Tampered or rolled back: hand the engine a keyring anyway; it marks the vault tampered on
      // connect (design §4.5.3) and stops, with the reason in status.
      log.error("account", "vault-info failed validation at startup", { err: isCryptoError(e) ? e.code : (e as Error).name });
    }
  }
  const vmks = vmksOf(s);
  const activeKv = s.ring?.activeKv ?? Math.max(...vmks.keys());
  if (!vmks.has(activeKv)) return { ring: null, info, pullOnly: false };
  const ring = await SxKeyring.fromVmks(s.vaultId, vmks, activeKv, s.ring ? { metaPadBucket: s.ring.metaPadBucket } : {});
  return { ring: ring as unknown as Keyring, info, pullOnly: false };
}

export class Daemon {
  readonly o: DaemonOptions;
  readonly env: NodeJS.ProcessEnv;
  engine!: ShuttleEngine;
  fs!: NodeLocalFs;
  state!: SqliteStateStore;
  watcher!: Watcher;
  adapter!: ServerAdapter;
  progress!: RemoteProgress;
  secrets!: HeadlessSecrets;
  control: ControlServer | null = null;
  supervisor: Supervisor | null = null;
  health: HealthJson | null = null;
  private healthClock!: HealthClock;
  private healthTimer: NodeJS.Timeout | null = null;
  private heartbeatAt = Date.now();
  private iterationStartedAt: number | null = null;
  private startedAt = Date.now();
  private startupFailure: { emptyVault: boolean; text: string } | null = null;
  private lastBackupDay = "";
  private stopped = false;
  private ticking: Promise<void> | null = null;
  private seenStore: SecretsSeenStore | null = null;

  constructor(o: DaemonOptions) {
    this.o = o;
    this.env = o.env ?? process.env;
  }

  get stateFile(): string { return path.join(this.o.stateDir, "state.db"); }
  get healthFile(): string { return path.join(this.o.stateDir, "health.json"); }
  get guardsDir(): string { return path.join(this.o.stateDir, "guards"); }
  get socketPath(): string { return path.join(this.o.stateDir, "control.sock"); }

  /** Start everything; on any failure, whatever was opened is closed again before the error propagates. */
  async start(): Promise<void> {
    try {
      await this.startInner();
    } catch (e) {
      await this.stop().catch(() => undefined);
      throw e;
    }
  }

  private async startInner(): Promise<void> {
    const c = this.o.config;
    const log = this.o.log;
    this.startedAt = Date.now();
    this.healthClock = new HealthClock(this.startedAt);
    // (4) prodGuard: vault, temp and state paths; dev URLs in production.
    checkPaths([c.vaultPath, c.tmpPath, this.o.stateDir], this.env);
    checkServerUrls(c.remote.urls, this.env);
    // (5) secrets permissions (exit 3).
    log.debug("startup", "checking secrets");
    const sfile = secretsPath(this.o.stateDir, this.env);
    this.secrets = readSecrets(sfile);
    if (this.secrets.vaultId !== c.remote.vaultId) throw new StartupError("secrets.json belongs to another vault than headless.json");
    // State DB: a newer schema needs a newer shuttle-headless (exit 4).
    try {
      this.state = SqliteStateStore.open(this.stateFile, { synchronous: c.stateSynchronous ?? "full" });
    } catch (e) {
      if (isStateStoreError(e, "NEWER_SCHEMA")) throw new StartupError((e as Error).message, EXIT.person);
      throw e;
    }
    log.debug("startup", "state db open");
    const indexedActive = await this.state.tx(["files"], async (tx) => {
      let n = 0;
      for (const e of await tx.files.getAll({ index: "scope", only: "active" })) if (e.obs !== null) n++;
      return n;
    }, "readonly");
    // (1)-(3) vault exists and is not suspiciously empty, temp on the same device, temp writable.
    const readOnly = c.mode === "push-only";
    const chk = await startupChecks({ vaultPath: c.vaultPath, tmpPath: c.tmpPath, readOnly, indexedActive });
    if (!chk.ok) {
      this.startupFailure = { emptyVault: chk.emptyVault, text: chk.failures.join("; ") };
      for (const f of chk.failures) log.error("startup", `startup check failed: ${f}`);
      await this.writeFailedHealth();
      await this.state.close();
      throw new StartupError(`startup checks failed: ${chk.failures.join("; ")}`);
    }

    // mirror-remote keeps every reverted local edit and removal under <state>/reverted (design §6.1.1).
    const mirror = c.mode === "mirror-remote";
    this.fs = new NodeLocalFs({
      root: c.vaultPath, tmpDir: c.tmpPath, readOnly, log, ...(c.configDir ? { configDir: c.configDir } : {}),
      ...(mirror ? { parkDir: path.join(this.o.stateDir, "reverted"), keepOverwritten: true } : {}),
    });
    this.adapter = new ServerAdapter({
      config: { urls: c.remote.urls, vaultId: c.remote.vaultId, ...(this.secrets.deviceId ? { deviceId: this.secrets.deviceId } : {}) },
      token: () => this.secrets.token,
      http: this.o.http ?? fetchHttpClient(),
      ws: this.o.ws ?? nodeWs,
      client: { name: c.device.name, platform: "linux", version: HEADLESS_VERSION, role: "headless" },
      state: adapterStateStoreOver(this.state),
      allowHttp: c.remote.allowHttp ?? false,
    });
    const wrapped = wrapRemote(this.adapter, { mode: c.mode });
    this.progress = wrapped.progress;

    log.debug("startup", "building keyring");
    const k = await buildKeyring(this.secrets, async () => {
      await this.adapter.connect();
      return (await this.adapter.getVaultInfo())?.info ?? null;
    }, log);
    if (k.info) this.rememberRing(k.info);

    const sfileForSeen = sfile;
    this.engine = createEngine({
      fs: this.fs, state: this.state as StateStore, remote: wrapped.remote, keyring: k.ring,
      clock: { now: () => Date.now(), monotonic: () => performance.now() },
      scheduler: realScheduler(),
      adapterState: adapterStateStoreOver(this.state),
    }, {
      settings: deviceSettingsOf(c),
      os: "linux",
      local: new FileLocalRecordStore(path.join(this.o.stateDir, "local.json")),
      seen: this.seenStore = new SecretsSeenStore(sfileForSeen, this.secrets),
      onKeysUnlocked: (cache) => {
        const cs = cache as CachedSecrets;
        this.secrets.keys = Object.fromEntries(Object.entries(cs.kvs).map(([kv, v]) => [String(kv), v]));
        writeSecrets(sfileForSeen, this.secrets);
      },
      host: safeHost(c.remote.urls[0]),
      logSink: (e: LogEntry) => log.engine(e),
      headless: true,
      periodicScanMs: scanIntervalMs(c),
      ...(this.o.manual ? { manual: true } : {}),
      ...(this.o.timings ? { timings: this.o.timings } : {}),
    });
    // Loop heartbeat (design §6.1.7): every loop iteration goes through runOnce(); an iteration that
    // has been running for longer than stallSec is a stall, an idle loop is alive.
    const runOnce = this.engine.runOnce.bind(this.engine);
    this.engine.runOnce = async (o) => {
      this.iterationStartedAt = Date.now();
      this.heartbeatAt = this.iterationStartedAt;
      try {
        return await runOnce(o);
      } finally {
        this.iterationStartedAt = null;
        this.heartbeatAt = Date.now();
      }
    };
    this.engine.on("guard", (g) => this.onGuard(g));

    this.watcher = new Watcher({
      fs: this.fs, mode: watchModeOf(c), log,
      includeConfigDir: () => Object.values(this.engine.settings.configCategories).some(Boolean),
      prune: (rel) => this.engine.filter.scope(rel + "/x.md") === "excluded" && !this.isConfigRel(rel),
      ...(this.o.inotifyProbe ? { probe: this.o.inotifyProbe } : {}),
      ...(this.o.watcherDeliver === false ? { deliver: false } : {}),
      ...(this.o.missGraceMs !== undefined ? { missGraceMs: this.o.missGraceMs } : {}),
    });

    log.debug("startup", "starting engine");
    await this.engine.start();
    log.debug("startup", "starting watcher");
    await this.watcher.start();
    mkdirSync(this.guardsDir, { recursive: true });
    if (this.o.control !== false) {
      this.control = new ControlServer(this.socketPath, {
        status: () => ({ health: this.health, engine: this.engine.status(), watcher: this.watcher.stats }),
        health: () => this.refreshHealthSync(),
        guards: () => this.listGuards(),
        debug: () => this.debug(),
        answerGuard: (id, choice) => this.answerGuard(id, choice),
        pause: () => this.engine.pause(),
        resume: () => this.engine.resume(),
        kick: () => this.engine.kick("control"),
        rescan: () => this.engine.requestScan("full"),
      });
      await this.control.start();
    }
    if (!this.o.manual) {
      this.supervisor = new Supervisor({
        log, stallSec: c.watchdog.stallSec, heartbeat: () => (this.iterationStartedAt === null ? Date.now() : this.heartbeatAt),
        paused: () => { const s = this.engine.status(); return s.status === "paused" || s.locked || this.engine.guards.list().length > 0; },
        shutdown: () => this.stop(),
        installProcessHandlers: this.o.installProcessHandlers ?? true,
        ...(this.o.exit ? { exit: this.o.exit } : {}),
      });
      this.supervisor.start();
    }
    const every = this.o.healthEveryMs ?? 15_000;
    this.healthTimer = setInterval(() => { void this.tick(); }, every);
    this.healthTimer.unref();
    await this.tick();
    log.info("general", "shuttle-headless started", { mode: c.mode, watch: this.watcher.stats.mode });
  }

  private isConfigRel(rel: string): boolean {
    const cfg = this.fs.configDir;
    return rel === cfg || rel.startsWith(cfg + "/") || cfg.startsWith(rel + "/");
  }

  private rememberRing(info: VaultInfo): void {
    const ring = { activeKv: info.activeKv, metaPadBucket: info.params.metaPadBucket };
    if (this.secrets.ring?.activeKv === ring.activeKv && this.secrets.ring.metaPadBucket === ring.metaPadBucket) return;
    this.secrets.ring = ring;
    writeSecrets(secretsPath(this.o.stateDir, this.env), this.secrets);
  }

  // ---------- guards (design §6.1.8) ----------

  private onGuard(g: GuardEvent): void {
    const file = path.join(this.guardsDir, `${safeName(g.id)}.json`);
    try {
      mkdirSync(this.guardsDir, { recursive: true });
      writeFileAtomicSync(file, JSON.stringify({ ...g, sample: g.sample.slice(0, 50), raisedAt: Date.now() }) + "\n", 0o644);
    } catch (e) {
      this.o.log.error("guard", "cannot write guard file", { err: String(e) });
    }
    this.o.log.warn("guard", `guard ${g.kind} tripped`, { n: g.n, id: g.id, sample: g.sample.slice(0, 50) });
    if (this.o.config.guards.onTrip === "apply" && this.env["SHUTTLE_PROD"] !== "1") {
      setImmediate(() => {
        this.o.log.warn("guard", `guard ${g.kind} answered automatically: apply (guards.onTrip=apply)`, { id: g.id });
        void this.answerGuard(g.id, "apply");
      });
    }
    void this.tick();
  }

  listGuards(): Array<GuardEvent & { raisedAt: number }> {
    return this.engine.guards.list().map((g) => ({ id: g.id, kind: g.kind, n: g.n, sample: [...g.sample], raisedAt: g.raisedAt }));
  }

  answerGuard(id: string, choice: GuardChoice): boolean {
    const open = this.engine.guards.list().some((g) => g.id === id);
    if (!open) return false;
    this.engine.answerGuard(id, choice);
    this.o.log.info("guard", `guard answered: ${choice}`, { id });
    this.syncGuardFiles();
    void this.tick();
    return true;
  }

  private syncGuardFiles(): void {
    const open = new Set(this.engine.guards.list().map((g) => `${safeName(g.id)}.json`));
    try {
      for (const f of readdirSync(this.guardsDir)) if (f.endsWith(".json") && !open.has(f)) rmSync(path.join(this.guardsDir, f), { force: true });
    } catch { /* guards dir missing */ }
  }

  // ---------- health (design §6.1.9) ----------

  private debug(): DebugInfo & { headless: unknown } {
    return {
      ...this.engine.debugInfo(),
      headless: { version: HEADLESS_VERSION, mode: this.o.config.mode, watcher: this.watcher.stats, fs: this.fs.stats, progress: this.progress },
    };
  }

  private refreshHealthSync(): HealthJson | null {
    void this.tick();
    return this.health;
  }

  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        if (this.stopped) return;
        const now = Date.now();
        const st = this.engine.status();
        if (this.iterationStartedAt === null) this.heartbeatAt = now;
        const cursor = (await readMeta(this.state, "cursor").catch(() => undefined)) ?? null;
        const cursorAt = (await readMeta(this.state, "cursorAt").catch(() => undefined)) ?? null;
        const { deferred, failedErrors } = await this.state.tx(["deferred", "journal"], async (tx) => ({
          deferred: await tx.deferred.count(),
          failedErrors: (await tx.journal.getAll({ index: "state", only: "failed" })).map((o) => o.lastError ?? ""),
        }), "readonly").catch(() => ({ deferred: 0, failedErrors: [] as string[] }));
        const connected = this.engine.isConnected();
        const lagSeq = this.progress.serverHeadSeq !== null && cursor !== null ? Math.max(0, this.progress.serverHeadSeq - cursor) : 0;
        const { deferredHourAgo } = this.healthClock.observe(now, { connected, lagSeq, pendingUp: st.pendingUp, deferred });
        const dbg = this.engine.debugInfo();
        const w = this.watcher.stats;
        this.health = computeHealth({
          now, engine: st, mode: this.o.config.mode, version: HEADLESS_VERSION, connected,
          connectedSince: this.progress.connectedSince, disconnectedSince: this.healthClock.disconnectedSince,
          serverHeadSeq: this.progress.serverHeadSeq, serverHeadSeqAt: this.progress.serverHeadSeqAt, cursor, cursorAt,
          lagSince: this.healthClock.lagSince, lastPullOkAt: this.progress.lastPullOkAt, lastCommitOkAt: this.progress.lastCommitOkAt,
          pendingUpSince: this.healthClock.pendingUpSince, deferred, deferredHourAgo, quarantined: dbg.quarantined, failedErrors,
          watcher: { mode: w.mode, degraded: w.degraded, missedByWatcher: w.missedByWatcher, lastScanAt: w.lastScanAt || null, lastScanMs: w.lastScanAt ? w.lastScanMs : null },
          pollIntervalSec: scanIntervalMs(this.o.config) / 1000, startedAt: this.startedAt,
          guards: this.listGuards(), loopHeartbeatAt: this.heartbeatAt, startupFailure: this.startupFailure,
        });
        await writeHealthFile(this.healthFile, this.health);
        this.syncGuardFiles();
        await this.nightly(new Date(now));
      } catch (e) {
        this.o.log.error("health", "health update failed", { err: String(e) });
      }
    })();
    try {
      await this.ticking;
    } finally {
      this.ticking = null;
    }
  }

  private async writeFailedHealth(): Promise<void> {
    const now = Date.now();
    const h = computeHealth({
      now, engine: { status: "error", pendingUp: 0, pendingDown: 0, failed: 0, locked: false, readOnly: false, reason: "startup" },
      mode: this.o.config.mode, version: HEADLESS_VERSION, connected: false, connectedSince: null, disconnectedSince: null,
      serverHeadSeq: null, serverHeadSeqAt: null, cursor: null, cursorAt: null, lagSince: null, lastPullOkAt: null, lastCommitOkAt: null,
      pendingUpSince: null, deferred: 0, deferredHourAgo: null, quarantined: 0, failedErrors: [],
      watcher: { mode: "none", degraded: false, missedByWatcher: 0, lastScanAt: now, lastScanMs: null },
      pollIntervalSec: this.o.config.watch.pollIntervalSec, startedAt: now, guards: [], loopHeartbeatAt: now, startupFailure: this.startupFailure,
    });
    this.health = h;
    await writeHealthFile(this.healthFile, h).catch(() => undefined);   // state dir unwritable: nothing more to do
  }

  /** Nightly VACUUM INTO backup (keep 3) and pruning of parked removals older than 30 days. */
  private async nightly(d: Date): Promise<void> {
    const day = d.toISOString().slice(0, 10);
    if (day === this.lastBackupDay) return;
    if (d.getTime() - this.startedAt < (this.o.backupDelayMs ?? 10 * 60 * 1000)) return;
    this.lastBackupDay = day;
    try {
      const f = await this.state.backup(path.join(this.o.stateDir, "backup"), d);
      if (f) this.o.log.info("maintenance", "state backup written", { file: path.basename(f) });
    } catch (e) {
      this.o.log.error("maintenance", "state backup failed", { err: String(e) });
    }
    // Parked removals (tmp/trash) are pruned after 30 days. mirror-remote's <state>/reverted is
    // kept: design §6.1.1 states no retention for reverted content (the operator prunes it).
    if (this.o.config.mode === "mirror-remote") return;
    try {
      const trash = this.fs.parkDir;
      for (const name of readdirSync(trash)) {
        const p = path.join(trash, name);
        if (d.getTime() - statSync(p).mtimeMs > TRASH_KEEP_MS) rmSync(p, { recursive: true, force: true });
      }
    } catch { /* no trash yet */ }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.supervisor?.stop();
    this.watcher?.stop();
    await this.control?.stop().catch(() => undefined);
    await this.engine?.stop().catch((e: unknown) => this.o.log.error("general", "engine stop failed", { err: String(e) }));
    await this.adapter?.close().catch(() => undefined);
    await this.ticking?.catch(() => undefined);
    try { this.seenStore?.flush(); } catch (e) { this.o.log.error("general", "cannot save seen", { err: String(e) }); }
    await this.state?.close().catch(() => undefined);
  }

  /**
   * Test hook: process death (kill -9). Timers stop, the state DB connection closes without
   * committing, the engine is abandoned without `stop()`.
   */
  async kill(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.supervisor?.stop();
    this.watcher?.stop();
    this.state.abandon();
    await this.control?.stop().catch(() => undefined);
    await this.adapter?.close().catch(() => undefined);
    await this.engine.stop().catch(() => undefined);
  }
}

export function realScheduler(): import("@shuttle/protocol").Scheduler {
  const timers = new Map<number, NodeJS.Timeout>();
  let next = 1;
  return {
    setTimer(ms, fn) {
      const id = next++;
      const t = setTimeout(() => { timers.delete(id); fn(); }, Math.max(0, ms));
      timers.set(id, t);
      return id;
    },
    clearTimer(h) {
      const t = timers.get(h);
      if (t) clearTimeout(t);
      timers.delete(h);
    },
    yieldToUi: () => new Promise<void>((r) => setImmediate(r)),
    idle: (timeoutMs) => new Promise<void>((r) => setTimeout(r, Math.min(timeoutMs ?? 0, 50))),
  };
}

function safeHost(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
