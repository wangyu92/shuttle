// createEngine (design §3.17, engine-spec §14): the single entry the plugin and the headless client use.
// It assembles parts 1 and 2 (index, reconciler, journal, op runner, ingest, applier, executor) with the
// policy layer of part 3: PathFilter (§3.11), ConfigSync (§3.12), guards and the Locked state (§3.13),
// triggers and the single-flight sync loop (§3.14), budgets (§3.15), activity log and debug info (§3.16).
//
// Loop iteration (engine-spec §3.2): stop if stopped/paused/locked/tampered → snapshot resync if the feed
// asked for one → scan when due (empty-vault guard) → outgoing mass-delete pre-count → drain the dirty
// set through reconcile() → OpRunner.run() → RemoteApplier.drain() → configApplied → counters/status.

import type {
  ChangeSink, ConfigCategory, ConnectInfo, DebugInfo, DeviceSettings, Disposable, EngineDeps, EngineEventMap, EngineEventName,
  EngineStatus, FileId, GuardChoice, GuardEvent, GuardKind, Keyring, LocalEvent, LogEntry, RemoteError, RemoteHead, Scope, Seq,
  SnapshotRequiredInfo, Subscription, SyncMode, TimerHandle, VaultInfo, VersionRecord, Engine,
} from "@shuttle/protocol";
import { STATE_SCHEMA_VERSION, isRemoteError } from "@shuttle/protocol";
import { unlock as cryptoUnlock, selfTest as cryptoSelfTest, type Seen } from "@shuttle/crypto";

import { FileIndex } from "./index/FileIndex";
import { Journal } from "./journal/Journal";
import { OpRunner, type RunStats } from "./journal/OpRunner";
import { backoffDelay } from "./journal/backoff";
import { BlobPipeline, type ContentParams } from "./content/BlobPipeline";
import { ChunkCache } from "./content/ChunkCache";
import { readAndHash } from "./content/hash";
import { WriteIntents } from "./apply/WriteIntents";
import { RemoteApplier, type DrainStats } from "./apply/RemoteApplier";
import { Ingest, type ResyncMode } from "./remote/ingest";
import { withRequestTimeouts } from "./remote/timeouts";
import { Executor } from "./reconcile/Executor";
import { Reconciler, type ActionExecutor, type ExecContext, type ReconcileSettings } from "./reconcile/Reconciler";
import type { Action, PlanCtx } from "./reconcile/Planner";
import { DirtySet } from "./reconcile/DirtySet";
import { LocalRenames } from "./reconcile/LocalRenames";
import { markPendingLocalChanges, scanLocal } from "./reconcile/Scanner";
import { EchoSuppressor } from "./events/EchoSuppressor";
import { LocalEventQueue } from "./events/LocalEventQueue";
import type { EventTimings } from "./events/timing";
import { KeyedMutex } from "./util/KeyedMutex";
import { uuidV4 } from "./util/uuid";
import { readMeta, writeMeta } from "./state/StateStore";
import { prepareState } from "./state/migrations";
import { classifyStartup, mirrorPendingOp, unmirrorPendingOp, type LocalRecord, type PendingOpMirror, type StartupClass } from "./state/epoch";
import { isConfigJson, kindOf, retentionClassOf } from "./merge/MergePolicy";
import { canonOfBytes } from "./merge/jsonMerge";
import { DEFAULT_MERGE_OPTIONS, type MergeOptions } from "./merge/dmp3";
import { ConflictLoopTracker } from "./merge/Oscillation";
import { isIllegal, nameRulesFor } from "./path/illegal";
import { PathFilter, defaultMaxFileBytes, type FilterSettings } from "./filter/PathFilter";
import { DEFAULT_CONFIG_CATEGORIES, DEFAULT_PLUGIN_ID, isMobile } from "./filter/configCategories";
import { DEFAULT_SELECTIVE } from "./filter/fileTypes";
import { ConfigSync } from "./config/ConfigSync";
import { Budget, budgetsFor, type PlatformBudgets } from "./sched/Budget";
import { EPOCH_INFO_MIN, GuardBoard, MASS_CONFLICT_MAX, PAUSING_GUARDS, looksEmpty, massDeleteThreshold } from "./safety/Guards";
import { ActivityLog, LOG_KEYS, type LogInput } from "./log/ActivityLog";
import { LockedError, isEngineError } from "./errors";
import type { DirtyKey, DirtyReason } from "./types";

export const ENGINE_VERSION = "0.1.0";

const MiB = 1024 * 1024;
/** Base storage (design §3.3.4): notes ≤ 2 MiB desktop/node, 1 MiB mobile. Config JSON ≤ 1 MiB (canonical echo check). */
const CONFIG_BASE_MAX = 1 * MiB;
/** Remote batches kick the loop coalesced (design §3.14). */
export const REMOTE_KICK_COALESCE_MS = 200;
/** Close the socket at the latest this long after going hidden (ID-12). */
export const HIDDEN_CLOSE_MS = 5000;
/** Periodic fast scan (design §3.14): desktop/node 10 min; headless 30 s (§6.1.4). */
export const PERIODIC_SCAN_MS = 10 * 60 * 1000;
export const HEADLESS_SCAN_MS = 30 * 1000;
/** configDir scan (design §3.12): desktop 60 s, mobile 5 min in foreground. */
export const CONFIG_SCAN_DESKTOP_MS = 60 * 1000;
export const CONFIG_SCAN_MOBILE_MS = 5 * 60 * 1000;
/** Longest wait for the feed's catch-up before reconciling anyway. */
export const CATCH_UP_WAIT_MS = 30_000;
/** Consecutive productive iterations run back to back before the loop yields to a timer. */
const MAX_BACK_TO_BACK = 25;
/** Reconcile passes over the dirty set inside one iteration. */
const MAX_DIRTY_PASSES = 50;

/** Vault-scoped localStorage record (design §3.3.5). The host persists it synchronously. */
export interface LocalRecordStore {
  load(): LocalRecord | null;
  save(r: LocalRecord): void;
}

/** `seen = {infoRev, epoch, activeKv, maxSeq}` (design §4.5.3 step 10, §4.9.2). Host-persisted. */
export interface SeenStore {
  load(): Seen | null;
  save(s: Seen): void;
}

export interface UnlockResult { ring: Keyring; pullOnly?: boolean }

/** design §2.11 step 1 precheck counts. */
export interface RebuildPrecheck { files: number; excluded: number; oversize: number; illegal: number; remoteOnly: number }

export interface EngineOptions {
  settings?: Partial<DeviceSettings>;
  /** OS hint for desktop filename rules (path/illegal.ts nameRulesFor). */
  os?: 'windows' | 'macos' | 'linux';
  /** SHUTTLE's own plugin id (its folder under `<configDir>/plugins/` is never synced). */
  pluginId?: string;
  local?: LocalRecordStore;
  seen?: SeenStore;
  /**
   * Passphrase → keyring (design §4.5.3). Default: @shuttle/crypto unlock(); the host persists the
   * cached VMKs through `onKeysUnlocked`. Never logged.
   */
  unlock?(passphrase: string, info: VaultInfo, seen: Seen | null): Promise<UnlockResult>;
  onKeysUnlocked?(cache: unknown): void | Promise<void>;
  /** lock(): the host deletes its cached VMKs (design §4.11.7). */
  onKeysDropped?(): void | Promise<void>;
  /** Startup crypto self-test (design §3.14, §4.15). Default: @shuttle/crypto selfTest('kat'). */
  selfTest?(): Promise<boolean>;
  /** Display label of the remote for debug info; the host strips credentials. */
  host?: string | null;
  /** Node writes every log entry as a JSON line too (design §3.16). */
  logSink?(e: LogEntry): void;
  timings?: Partial<EventTimings>;
  budgets?: Partial<PlatformBudgets>;
  tzOffset?(epochMs: number): number;
  random?(): number;
  /** Override the periodic scan / configDir scan intervals (ms; 0 disables the timer). */
  periodicScanMs?: number;
  configScanMs?: number;
  /** The headless client (node): 30 s periodic scan, no visibility (design §3.14). */
  headless?: boolean;
  /** No timers and no automatic loop runs: the caller drives runOnce() (tests, headless `--once`). Default false. */
  manual?: boolean;
  /** design §3.7.4 per-request timeouts on the scheduler (default on; false only for adapters that time out themselves in tests). */
  requestTimeouts?: boolean;
}

/** design §3.17 DeviceSettings defaults for this platform. */
export function defaultDeviceSettings(platform: EngineDeps["fs"]["platform"]): DeviceSettings {
  return {
    deviceName: "device",
    conflictMode: "merge",
    selective: { ...DEFAULT_SELECTIVE },
    excludedFolders: [],
    configCategories: { ...DEFAULT_CONFIG_CATEGORIES },
    maxFileBytes: defaultMaxFileBytes(platform),
    deleteMode: "trash",
    strictOverlap: DEFAULT_MERGE_OPTIONS.strictOverlap,
    mode: "bidirectional",
  };
}

/** VaultInfo params → BlobPipeline content params. */
export function contentParamsOf(info: VaultInfo): ContentParams {
  const p = info.params;
  return {
    chunker: { min: p.chunker.min, avg: p.chunker.avg, max: p.chunker.max },
    inlineMax: p.inlineMax, compression: p.compression, padding: p.padding,
  };
}

/** Result of one loop iteration (tests and headless `--once`). */
export interface IterationResult {
  ran: boolean;
  reconciled: number;
  run: RunStats | null;
  drain: DrainStats | null;
  work: number;
}

type Listener<E extends EngineEventName> = (p: EngineEventMap[E]) => void;

interface Counters {
  journalByState: Record<string, number>;
  batchesByState: Record<string, number>;
  applyQueue: number;
  intents: number;
  quarantined: number;
  deferred: number;
}

const emptyCounters = (): Counters => ({ journalByState: {}, batchesByState: {}, applyQueue: 0, intents: 0, quarantined: 0, deferred: 0 });

class MemLocalRecordStore implements LocalRecordStore {
  private r: LocalRecord | null = null;
  load(): LocalRecord | null { return this.r ? structuredClone(this.r) : null; }
  save(r: LocalRecord): void { this.r = structuredClone(r); }
}

class MemSeenStore implements SeenStore {
  private s: Seen | null = null;
  load(): Seen | null { return this.s ? { ...this.s } : null; }
  save(s: Seen): void { this.s = { ...s }; }
}

export function createEngine(deps: EngineDeps, opts: EngineOptions = {}): ShuttleEngine {
  return new ShuttleEngine(deps, opts);
}

/** The engine. Implements the protocol `Engine`; extra methods are for the headless client and tests. */
export class ShuttleEngine implements Engine {
  readonly log: ActivityLog;
  readonly budget: Budget;
  readonly dirty = new DirtySet();
  readonly guards: GuardBoard;
  settings: DeviceSettings;
  filter: PathFilter;

  // assembled modules (after start)
  index!: FileIndex;
  journal!: Journal;
  runner!: OpRunner;
  applier!: RemoteApplier;
  ingest!: Ingest;
  executor!: Executor;
  reconciler!: Reconciler;
  renames!: LocalRenames;
  intents!: WriteIntents;
  blobs!: BlobPipeline;
  events!: LocalEventQueue;
  readonly echo: EchoSuppressor;
  readonly locks = new KeyedMutex();
  readonly configSync: ConfigSync;
  /** design §3.10.1 conflict-loop fallback (session state). */
  readonly conflictLoops: ConflictLoopTracker;
  /** design §3.15 chunk cache (disabled when the platform budget is 0: node). */
  readonly chunkCache: ChunkCache;

  /** deps.remote behind the per-request timeouts of design §3.7.4. */
  readonly remote: EngineDeps["remote"];
  private ring: Keyring | null;
  private readonly local: LocalRecordStore;
  private readonly seenStore: SeenStore;
  private readonly listeners = new Map<EngineEventName, Set<Listener<EngineEventName>>>();
  private readonly mergeOpts: MergeOptions;
  private readonly budgets: PlatformBudgets;

  private started = false;
  private stopped = false;
  private userPaused = false;
  /** Guard that paused the loop (cleared by answerGuard or resume()). */
  private guardPause: GuardKind | null = null;
  private tampered = false;
  private readOnly = false;
  private hidden = false;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private connectInfo: ConnectInfo | null = null;
  private vaultInfo: VaultInfo | null = null;
  private params: ContentParams | null = null;
  private sub: Subscription | null = null;
  private subGen = 0;
  private authError = false;
  private reconnectAttempts = 0;
  private lastError: string | null = null;

  private planCtx: PlanCtx = { mode: "incremental" };
  private pendingResync: ResyncMode | null = null;
  private rebuildPending = false;
  /** The pending epoch resync follows this device's own remote rebuild (no "rebuilt elsewhere" notice). */
  private ownRebuild = false;
  /** snapshotRequired{epoch} arrived: the next validated connect runs the epoch resync. */
  private epochResyncAsked = false;
  private torn: Array<{ path: string; fileId: FileId }> = [];
  private scanDue: 'fast' | 'full' | null = "fast";
  private rescopeDue = false;
  private startup: StartupClass = "normal";

  // guards state
  private emptyOverride = false;
  private parkedDeletes = new Map<FileId, DirtyKey>();
  private approvedDeletes = new Set<FileId>();
  private deletesThisIteration = 0;
  private deleteThreshold = 25;
  private conflictCopiesThisPass = 0;
  private conflictApproved = false;
  private parkedConflicts = new Map<string, DirtyKey>();
  private remoteDeleteApproved = false;
  private oversizeLogged = new Set<string>();
  /** Dirty keys reached while Locked (design §3.13); re-marked on unlock. */
  private heldWhileLocked = new Map<string, { key: DirtyKey; reason: DirtyReason }>();

  // loop state
  private running: Promise<void> | null = null;
  private loopRun: Promise<void> | null = null;
  private hiddenFlush: Promise<void> | null = null;
  private rerun = false;
  private kickTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private periodicTimer: TimerHandle | null = null;
  private configTimer: TimerHandle | null = null;
  private hiddenCloseTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private fsSub: Disposable | null = null;
  private counters: Counters = emptyCounters();
  private lastStatus: EngineStatus | null = null;
  private wasSynced = false;
  private iterationPushOnly = false;
  private everSyncedNoted = false;

  constructor(readonly deps: EngineDeps, readonly opts: EngineOptions = {}) {
    const fs = deps.fs;
    this.remote = opts.requestTimeouts === false ? deps.remote : withRequestTimeouts(deps.remote, deps.scheduler);
    this.settings = { ...defaultDeviceSettings(fs.platform), ...(opts.settings ?? {}) };
    this.settings.selective = { ...DEFAULT_SELECTIVE, ...(opts.settings?.selective ?? {}) };
    this.settings.configCategories = { ...DEFAULT_CONFIG_CATEGORIES, ...(opts.settings?.configCategories ?? {}) };
    this.ring = deps.keyring;
    this.local = opts.local ?? new MemLocalRecordStore();
    this.seenStore = opts.seen ?? new MemSeenStore();
    this.mergeOpts = { strictOverlap: this.settings.strictOverlap };
    this.budgets = budgetsFor(fs.platform, opts.budgets);
    this.log = new ActivityLog(() => deps.clock.now());
    this.log.onEntry((e) => {
      this.emit("log", e);
      opts.logSink?.(e);
    });
    this.budget = new Budget(this.budgets, () => this.settings.maxFileBytes);
    this.guards = new GuardBoard(() => deps.clock.now(), (g) => this.emit("guard", g));
    this.echo = new EchoSuppressor(deps.clock);
    this.conflictLoops = new ConflictLoopTracker(deps.clock);
    this.chunkCache = new ChunkCache({ state: deps.state, capBytes: () => this.budgets.chunkCacheBytes, now: () => deps.clock.now() });
    this.filter = this.makeFilter();
    this.configSync = new ConfigSync(() => this.filter);
  }

  // =====================================================================================
  // public API (design §3.17)
  // =====================================================================================

  on<E extends EngineEventName>(ev: E, cb: (payload: EngineEventMap[E]) => void): Disposable {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(cb as Listener<EngineEventName>);
    return { dispose: () => { set.delete(cb as Listener<EngineEventName>); } };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const d = this.deps;
    const now = (): number => d.clock.now();

    // design §3.3.1 schema + §3.3.5 eviction detection
    const before = await readMeta(d.state, "dbEpoch").catch(() => undefined);
    const prep = await prepareState(d.state, { newDbEpoch: () => uuidV4() });
    const rec = this.local.load();
    this.startup = classifyStartup(rec, prep.created && before === undefined ? null : prep.dbEpoch);
    const deviceId = rec?.deviceId ?? (await readMeta(d.state, "deviceId")) ?? uuidV4();
    if (!rec || rec.dbEpoch !== prep.dbEpoch) {
      this.local.save({
        deviceId, dbEpoch: prep.dbEpoch, remoteProfileId: rec?.remoteProfileId ?? "",
        everSynced: this.startup === "adoptIdb" || this.startup === "normal" ? (rec?.everSynced ?? true) : (rec?.everSynced ?? false),
        pendingOps: rec?.pendingOps ?? [],
      });
    }
    await writeMeta(d.state, "deviceId", deviceId);
    if (this.startup === "evicted") {
      this.rebuildPending = true;
      this.log.add({ cat: "general", key: "log.rebuildingIndex" });
    }
    const storedPaused = await readMeta(d.state, "paused");
    if (storedPaused === true) this.userPaused = true;

    await this.loadIndex();
    this.assemble(now);

    // design §3.11: filter fingerprint
    const fp = await readMeta(d.state, "filterFingerprint");
    if (fp !== this.filter.fingerprint()) {
      if (fp !== undefined) this.rescopeDue = true;
      await writeMeta(d.state, "filterFingerprint", this.filter.fingerprint());
    }

    // design §3.14 startup: self-test, leftover intents, journal resume, unpushed local changes
    const ok = await (this.opts.selfTest ?? defaultSelfTest)().catch(() => false);
    if (!ok) {
      this.tampered = true;
      this.lastError = "selfTest";
      this.log.add({ cat: "error", key: "log.selfTestFailed" });
    }
    await this.ingest.load();
    this.torn = await this.intents.startupCheck();
    await this.runner.resume();
    markPendingLocalChanges(this.index, (k, r) => this.dirty.mark(k, r));

    this.fsSub = d.fs.onEvent((e: LocalEvent) => this.events.handle(e));
    if (!this.opts.manual) {
      this.dirty.onMark(() => this.kick("local"));
      this.armPeriodic();
    }
    this.log.add({ cat: "network", key: LOG_KEYS.connecting });
    // Connect in parallel with the scan; a failed connect never blocks scanning or journaling.
    void this.ensureConnected();
    this.kick("startup");
    this.publishStatus();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.fsSub?.dispose();
    this.fsSub = null;
    this.events?.stop();
    for (const t of [this.kickTimer, this.retryTimer, this.periodicTimer, this.configTimer, this.hiddenCloseTimer, this.reconnectTimer, this.catchUpTimer]) {
      if (t !== null) this.deps.scheduler.clearTimer(t);
    }
    this.kickTimer = this.retryTimer = this.periodicTimer = this.configTimer = this.hiddenCloseTimer = this.reconnectTimer = this.catchUpTimer = null;
    await this.whenIdle();
    await this.closeRemote();
    this.started = false;
    this.publishStatus();
  }

  pause(): void {
    if (this.userPaused) return;
    this.userPaused = true;
    void writeMeta(this.deps.state, "paused", true).catch(() => undefined);
    this.log.add({ cat: "general", key: LOG_KEYS.paused });
    void this.closeRemote();
    this.publishStatus();
  }

  resume(): void {
    const wasPaused = this.userPaused || this.guardPause !== null;
    this.userPaused = false;
    if (this.guardPause && this.guardPause !== "tampered") {
      this.guards.clear(this.guardPause);
      this.guardPause = null;
    }
    if (!wasPaused) return;
    void writeMeta(this.deps.state, "paused", false).catch(() => undefined);
    this.log.add({ cat: "general", key: LOG_KEYS.resumed });
    this.scanDue = "fast";
    this.reconnectAttempts = 0;
    void this.ensureConnected();
    this.kick("resume");
    this.publishStatus();
  }

  async lock(): Promise<void> {
    // The connection stays up (status paused/locked, design §3.13); the feed closes so no batch is
    // rejected and retried while nothing can be opened. unlock() resubscribes from the cursor.
    this.enterLocked("user");
    await this.opts.onKeysDropped?.();
    this.publishStatus();
  }

  async unlock(passphrase: string): Promise<void> {
    await this.ensureConnected();
    let info = this.vaultInfo;
    if (!info) {
      const got = await this.remote.getVaultInfo();
      info = got?.info ?? null;
    }
    if (!info) throw new LockedError("no vault-info on the remote");
    const unlockFn = this.opts.unlock ?? ((p: string, i: VaultInfo, s: Seen | null) => this.defaultUnlock(p, i, s));
    const r = await unlockFn(passphrase, info, this.seenStore.load());
    this.ring = r.ring;
    if (r.pullOnly) this.setReadOnly(true);
    this.runner.keyVersionResolved();
    this.log.add({ cat: "account", key: LOG_KEYS.unlocked });
    // Keys held back while Locked are planned now (design §3.13: local events still collect).
    for (const [, h] of this.heldWhileLocked) this.dirty.mark(h.key, h.reason);
    this.heldWhileLocked.clear();
    // The feed was closed while Locked: re-validate the vault-info with the keys, then resubscribe
    // from the persisted cursor (no snapshot: nothing between the cursor and now was lost).
    if (this.connected && this.connectInfo) {
      await this.acceptVaultInfo(info, this.connectInfo);
      if (!this.blocked() && this.ring !== null && !this.rebuildPending && this.pendingResync === null) {
        const cursor = (await readMeta(this.deps.state, "cursor")) ?? 0;
        this.subscribe(cursor);
      }
    } else {
      await this.ensureConnected();
    }
    this.kick("unlock");
    this.publishStatus();
  }

  /** Enter the Locked state (design §3.13): drop the keyring and close the feed. */
  private enterLocked(reason: string): void {
    this.ring = null;
    this.closeSub();
    this.log.add({ cat: "account", key: LOG_KEYS.locked, ...(reason !== "user" ? { params: { reason } } : {}) });
  }

  /** A dirty key that could not be planned while Locked: kept until unlock, never re-spun. */
  private holdLocked(key: DirtyKey, reason: DirtyReason): void {
    this.heldWhileLocked.set(key.fileId ?? "p:" + key.path, { key, reason });
  }

  kick(reason: string): void {
    if (this.stopped || !this.started || this.opts.manual) return;
    // Locked: local events only collect (design §3.13); unlock() kicks the loop.
    if (this.ring === null && reason === "local") return;
    if (this.loopRun) {
      // The running loop picks this up after its current iteration.
      this.rerun = true;
      return;
    }
    if (this.kickTimer !== null) return;
    const delay = reason === "remote" ? REMOTE_KICK_COALESCE_MS : 0;
    this.kickTimer = this.deps.scheduler.setTimer(delay, () => {
      this.kickTimer = null;
      const p = this.loop().catch((e: unknown) => {
        this.log.add({ cat: "error", key: LOG_KEYS.error, params: { error: errName(e) } });
      });
      this.loopRun = p;
      void p.finally(() => { if (this.loopRun === p) this.loopRun = null; });
    });
  }

  onVisibility(visible: boolean): void {
    if (this.opts.headless || this.deps.fs.platform === "node") return;
    if (!visible) {
      if (this.hidden) return;
      this.hidden = true;
      // design §3.14 hidden: flush (skip debounce), one push-only iteration, close after it or 5 s.
      this.events?.flushAll();
      if (this.hiddenCloseTimer !== null) this.deps.scheduler.clearTimer(this.hiddenCloseTimer);
      this.hiddenCloseTimer = this.deps.scheduler.setTimer(HIDDEN_CLOSE_MS, () => {
        this.hiddenCloseTimer = null;
        if (this.hidden) void this.closeRemote();
      });
      const flush = (async () => {
        await this.events?.idle();
        await this.runOnce({ pushOnly: true });
      })().catch((e: unknown) => {
        this.log.add({ cat: "error", key: LOG_KEYS.error, params: { error: errName(e) } });
      }).finally(() => {
        if (this.hidden) void this.closeRemote();
        if (this.hiddenFlush === flush) this.hiddenFlush = null;
      });
      this.hiddenFlush = flush;
      return;
    }
    if (!this.hidden) return;
    this.hidden = false;
    if (this.hiddenCloseTimer !== null) this.deps.scheduler.clearTimer(this.hiddenCloseTimer);
    this.hiddenCloseTimer = null;
    this.scanDue = "fast";
    this.reconnectAttempts = 0;
    void this.ensureConnected();
    this.kick("visible");
  }

  async updateSettings(patch: Partial<DeviceSettings>): Promise<void> {
    const next: DeviceSettings = {
      ...this.settings, ...patch,
      selective: { ...this.settings.selective, ...(patch.selective ?? {}) },
      configCategories: { ...this.settings.configCategories, ...(patch.configCategories ?? {}) },
    };
    if (patch.excludedFolders) next.excludedFolders = [...patch.excludedFolders];
    this.settings = next;
    this.mergeOpts.strictOverlap = next.strictOverlap;
    const before = this.filter.fingerprint();
    this.filter = this.makeFilter();
    if (this.filter.fingerprint() !== before && this.started) {
      await writeMeta(this.deps.state, "filterFingerprint", this.filter.fingerprint());
      this.rescopeDue = true;
      this.kick("settings");
    }
    this.publishStatus();
  }

  status(): EngineStatus {
    const c = this.counters;
    const failed = c.journalByState["failed"] ?? 0;
    let pendingUp = 0;
    for (const [k, v] of Object.entries(c.journalByState)) if (k !== "failed") pendingUp += v;
    const base = { pendingUp, pendingDown: c.applyQueue, failed, locked: this.ring === null, readOnly: this.readOnly };
    if (this.tampered) return { status: "error", ...base, reason: "tampered" };
    if (this.authError) return { status: "error", ...base, reason: "AUTH" };
    if (this.userPaused) return { status: "paused", ...base, reason: "user" };
    if (this.guardPause) return { status: "paused", ...base, reason: this.guardPause };
    if (c.quarantined > 0) return { status: "error", ...base, reason: "integrity" };
    if (!this.started || !this.connected) return { status: "disconnected", ...base };
    if (this.ring === null) return { status: "paused", ...base, reason: "locked" };
    const busy = this.running !== null || this.dirty.size > 0 || pendingUp > 0 || c.applyQueue > 0 || this.pendingResync !== null || this.catchingUp;
    return { status: busy ? "syncing" : "synced", ...base };
  }

  answerGuard(id: string, choice: GuardChoice): void {
    const t = this.guards.take(id, choice);
    if (!t) return;
    const { g } = t;
    const c = t.choice;
    const unpause = (): void => {
      if (this.guardPause === g.kind) this.guardPause = null;
      this.kick("guard");
      this.publishStatus();
    };
    switch (g.kind) {
      case "emptyVault":
        if (c === "apply") { this.emptyOverride = true; this.scanDue = "fast"; unpause(); } else this.pause();
        return;
      case "massDeleteLocal":
        if (c === "apply") {
          for (const [id2, key] of this.parkedDeletes) { this.approvedDeletes.add(id2); this.dirty.mark(key, "retry"); }
          this.parkedDeletes.clear();
          unpause();
        } else this.pause();
        return;
      case "massDeleteRemote":
        if (c === "apply") { this.remoteDeleteApproved = true; unpause(); } else this.pause();
        return;
      case "massConflict":
        if (c === "apply") {
          this.conflictApproved = true;
          for (const key of this.parkedConflicts.values()) this.dirty.mark(key, "retry");
          this.parkedConflicts.clear();
          unpause();
        } else this.pause();
        return;
      case "rollback":
        if (c === "accept") {
          this.pendingResync = "rollback";
          unpause();
          void this.ensureConnected();
        } else if (c === "rebuild") {
          // design §3.13 / §2.11: rebuild the remote from this device. The precheck (§5.6.9) needs the
          // user's second confirmation when files would disappear from the remote: then stay paused
          // and ask again (the UI calls rebuildRemote({ confirmFiltered: true }) after its own prompt).
          void this.rebuildRemote().catch((e: unknown) => {
            this.log.add({ cat: "error", key: "log.rebuildRemoteFailed", params: { error: errName(e) } });
            if (this.guardPause === "rollback" || this.guardPause === null) {
              this.guardPause = "rollback";
              this.guards.raise("rollback", g.n, g.sample);
              this.publishStatus();
            }
          });
        } else this.pause();
        return;
      default:
        return;
    }
  }

  /**
   * design §2.11 step 1 / §5.6.9 precheck: what a remote rebuild from this device would leave out.
   * `files` = active tracked files that will be uploaded; the others are absent from the new epoch
   * until another device uploads them again.
   */
  rebuildPrecheck(): RebuildPrecheck {
    const out: RebuildPrecheck = { files: 0, excluded: 0, oversize: 0, illegal: 0, remoteOnly: 0 };
    if (!this.index) return out;
    const local = new Set<FileId>();
    for (const e of this.index.all()) {
      if (e.scope === "active" && e.obs !== null) {
        out.files++;
        local.add(e.fileId);
      } else if (e.scope === "excluded") out.excluded++;
      else if (e.scope === "oversize") out.oversize++;
      else if (e.scope === "illegal") out.illegal++;
    }
    for (const R of this.index.remote.all()) {
      if (R.deleted || local.has(R.fileId)) continue;
      const e = this.index.byFileId(R.fileId);
      if (e && e.scope !== "active") continue;      // counted above by scope
      out.remoteOnly++;
    }
    return out;
  }

  /**
   * Rebuild the remote vault from this device (design §2.11, §4.11.5; engine API level of §5.6.9).
   * markRebuild (same keys, epoch+1, infoRev+1, new MAC) → `remote.rebuild(info)` → this device
   * adopts the new epoch and runs the epoch resync: the remote is empty, so every tracked file is
   * pushed as a create with its own fileId (rows S8/C5 in epoch mode; absence never deletes, I28).
   * Throws `RebuildNeedsConfirmation` when the precheck finds files the new epoch would lack and
   * `confirmFiltered` is not set.
   */
  async rebuildRemote(o: { confirmFiltered?: boolean } = {}): Promise<RebuildPrecheck> {
    const r = this.remote;
    if (!this.started || this.stopped) throw new Error("engine not started");
    if (!r.rebuild) throw new Error("UNSUPPORTED: the remote cannot be rebuilt");
    if (this.tampered) throw new Error("tampered");
    const ring = this.ring;
    if (!ring) throw new LockedError();
    const pre = this.rebuildPrecheck();
    if (pre.excluded + pre.oversize + pre.illegal + pre.remoteOnly > 0 && o.confirmFiltered !== true) {
      throw Object.assign(new Error("RebuildNeedsConfirmation"), { name: "RebuildNeedsConfirmation", precheck: pre });
    }
    while (this.running) await this.running.catch(() => undefined);
    let done!: () => void;
    const gate = new Promise<void>((res) => { done = res; });
    this.running = gate;
    try {
      await this.ensureConnected();
      if (!this.connectInfo) throw new Error("not connected");
      const got = await r.getVaultInfo();
      if (!got) throw new Error("no vault-info on the remote");
      const next = await markRebuildInfo(ring, got.info);
      const res = await r.rebuild(next);
      this.log.add({ cat: "general", key: "log.rebuildRemote", params: { files: pre.files, epoch: res.epoch } });
      // The new epoch belongs to this device: seen moves forward (rollback reference reset: the old
      // maxSeq described the history we just replaced), the mirror is replaced by the epoch resync.
      const seen = this.seenStore.load();
      this.seenStore.save({
        epoch: next.epoch, infoRev: next.infoRev, activeKv: Math.max(seen?.activeKv ?? 0, next.activeKv), maxSeq: 0,
      });
      this.vaultInfo = next;
      this.connectInfo = { ...this.connectInfo, epoch: next.epoch };
      if (this.guardPause === "rollback") {
        this.guards.clear("rollback");
        this.guardPause = null;
      }
      this.closeSub();
      this.pendingResync = "epoch";
      this.ownRebuild = true;
      this.planCtx = { mode: "epoch" };
    } finally {
      this.running = null;
      done();
    }
    this.kick("rebuildRemote");
    this.publishStatus();
    return pre;
  }

  async repair(fileId: FileId): Promise<void> {
    // design §4.14: commit local content with base = current head seq, superseding the bad record.
    const e = this.index.byFileId(fileId);
    if (!e) throw new Error("unknown file");
    // The current head is the quarantined record (never mirrored), so base = the highest bad seq.
    const badSeq = await this.index.write(["integrity"], async (w) => {
      const cur = w.entry(fileId);
      if (cur) await w.putEntry({ ...cur, integrityHold: false });
      let max = 0;
      for (const row of await w.tx.integrity.getAll({ index: "fileId", only: fileId })) {
        max = Math.max(max, row.seq);
        await w.tx.integrity.delete(row.seq);
      }
      return max;
    });
    const R = this.index.remote.byFileId(fileId);
    const base = Math.max(R?.seq ?? 0, badSeq);
    const st = await this.deps.fs.stat(e.path);
    if (st && st.kind === "file") {
      await this.journal.enqueue({ kind: "put", fileId, path: e.path, base: base > 0 ? base : null });
    } else {
      this.dirty.mark({ fileId, path: e.path }, "retry");
    }
    this.log.add({ cat: "general", key: LOG_KEYS.repair, fileId, path: e.path });
    await this.refreshCounters();
    this.kick("repair");
  }

  debugInfo(): DebugInfo {
    const r = this.remote;
    const c = this.counters;
    return {
      engineVersion: ENGINE_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      platform: this.deps.fs.platform,
      remote: { kind: r.kind, capabilities: this.connectInfo?.capabilities ?? null, host: this.opts.host ?? null },
      cursor: this.cursorCache,
      indexByScope: this.index ? this.index.countByScope() : {},
      journalByState: { ...c.journalByState },
      batchesByState: { ...c.batchesByState },
      applyQueue: c.applyQueue,
      intents: c.intents,
      quarantined: c.quarantined,
      lastErrors: this.log.lastErrors(),
      filterFingerprint: this.filter.fingerprint(),
      budgets: {
        inFlightBytes: this.budgets.inFlightBytes, hashBytes: this.budgets.hashBytes, hashConcurrency: this.budgets.hashConcurrency,
        uploadConcurrency: this.budgets.uploadConcurrency, downloadConcurrency: this.budgets.downloadConcurrency,
        commitBatchOps: this.budgets.commitBatchOps, maxFileBytes: this.settings.maxFileBytes, pullPage: this.budgets.pullPage,
        scanBatch: this.budgets.scanBatch, chunkCacheBytes: this.budgets.chunkCacheBytes,
        bytesInFlight: this.budget.bytes.inFlight, bytesPeak: this.budget.bytes.stats.peak,
      },
    };
  }

  async versions(fileId: FileId): Promise<VersionRecord[]> {
    const r = this.remote;
    if (!r.listVersions) return [];
    const out: VersionRecord[] = [];
    let before: Seq | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await r.listVersions(fileId, before === undefined ? {} : { before });
      out.push(...page.records);
      if (page.next === null) break;
      before = page.next;
    }
    return out;
  }

  deletedFiles(): RemoteHead[] {
    return this.index ? [...this.index.remote.all()].filter((h) => h.deleted) : [];
  }

  // =====================================================================================
  // headless / test surface
  // =====================================================================================

  /** Run one loop iteration now (single-flight with timer-driven runs). */
  async runOnce(o: { pushOnly?: boolean } = {}): Promise<IterationResult> {
    while (this.running) await this.running.catch(() => undefined);
    let res: IterationResult = { ran: false, reconciled: 0, run: null, drain: null, work: 0 };
    const p = (async () => { res = await this.iteration(o.pushOnly === true); })();
    this.running = p.finally(() => { this.running = null; });
    await this.running;
    this.publishStatus();
    return res;
  }

  /** Iterate until an iteration does no work (bounded). */
  async settle(maxRounds = 40): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const r = await this.runOnce();
      total += r.work;
      if (r.work === 0 && this.dirty.size === 0) break;
    }
    return total;
  }

  /** Resolve when no timer-driven loop or iteration is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 1000 && (this.loopRun || this.running || this.hiddenFlush); i++) {
      await (this.hiddenFlush ?? this.loopRun ?? this.running)?.catch(() => undefined);
    }
  }

  /** Force a scan on the next iteration. */
  requestScan(mode: 'fast' | 'full' = "fast"): void {
    this.scanDue = this.scanDue === "full" ? "full" : mode;
    this.kick("scan");
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Await the in-flight connect attempt, if any. */
  async whenConnected(): Promise<boolean> {
    await this.ensureConnected();
    return this.connected;
  }

  get ctx(): PlanCtx {
    return this.planCtx;
  }

  // =====================================================================================
  // assembly
  // =====================================================================================

  private makeFilter(): PathFilter {
    const fs = this.deps.fs;
    const s: FilterSettings = {
      configDir: fs.configDir, pluginId: this.opts.pluginId ?? DEFAULT_PLUGIN_ID, platform: fs.platform,
      nameRules: nameRulesFor(fs.platform, this.opts.os ? { os: this.opts.os } : undefined), caseInsensitive: fs.caseInsensitive,
      excludedFolders: this.settings.excludedFolders, selective: this.settings.selective,
      configCategories: this.settings.configCategories, maxFileBytes: this.settings.maxFileBytes,
    };
    return new PathFilter(s);
  }

  /** Scope used by every module; logs oversize skips once per session (design §3.11.2). */
  private scopeOf = (p: string, size?: number): Scope => {
    const sc = this.filter.scope(p, size);
    if (sc === "oversize" && size !== undefined && !this.oversizeLogged.has(p)) {
      this.oversizeLogged.add(p);
      this.log.add({ cat: "skipped", key: LOG_KEYS.tooLarge, params: { mb: Math.round((size / MiB) * 10) / 10 }, path: p });
    }
    return sc;
  };

  private configDir(): string {
    return this.deps.fs.configDir;
  }

  private needsBase = (p: string, size: number): boolean => {
    const cfg = this.configDir();
    if (isConfigJson(p, cfg)) return size <= CONFIG_BASE_MAX;
    return kindOf(p, cfg) === "note" && size <= (isMobile(this.deps.fs.platform) ? 1 : 2) * MiB;
  };

  private markDirty = (k: DirtyKey, r: DirtyReason): void => {
    this.dirty.mark(k, r);
  };

  private toLog = (e: { key: string; cat: LogInput["cat"]; params?: LogInput["params"]; path?: string; fileId?: FileId }): void => {
    this.log.add({ cat: e.cat, key: e.key, ...(e.params ? { params: e.params } : {}), ...(e.path !== undefined ? { path: e.path } : {}), ...(e.fileId !== undefined ? { fileId: e.fileId } : {}) });
  };

  private assemble(now: () => number): void {
    const d = this.deps;
    const fs = d.fs;
    const cfg = fs.configDir;
    const rcOf = (p: string) => retentionClassOf(p, cfg);
    const kind = (p: string) => kindOf(p, cfg);
    const rules = nameRulesFor(fs.platform, this.opts.os ? { os: this.opts.os } : undefined);
    const hooks = d.hooks;
    const keyring = (): Keyring | null => this.ring;
    const ringOrThrow = (): Keyring => {
      if (!this.ring) throw new LockedError();
      return this.ring;
    };
    const mirror = {
      upsert: (m: PendingOpMirror) => this.updateLocal((r) => ({ ...r, pendingOps: mirrorPendingOp(r.pendingOps, m) })),
      remove: (id: FileId) => this.updateLocal((r) => ({ ...r, pendingOps: unmirrorPendingOp(r.pendingOps, id) })),
      list: () => this.local.load()?.pendingOps ?? [],
    };
    this.index = this.indexOrThrow(now);
    this.journal = new Journal({ state: d.state, now, mirror });
    this.blobs = new BlobPipeline({
      remote: this.remote, keyring: ringOrThrow,
      params: () => {
        if (!this.params) throw new LockedError("content parameters unknown until the vault-info is read");
        return this.params;
      },
      budget: { acquire: (n) => this.budget.bytes.acquire(n), release: (n) => this.budget.bytes.release(n) },
      uploadSlots: this.budget.uploadSlots,
      downloadSlots: this.budget.downloadSlots,
      ...(this.budgets.chunkCacheBytes > 0 ? { cache: this.chunkCache } : {}),
    });
    this.intents = new WriteIntents({ state: d.state, fs, now });
    this.renames = new LocalRenames({ index: this.index, scopeOf: this.scopeOf, markDirty: this.markDirty });
    // The applier's own legality check logs the Sync string; let 'illegal' through the scope gate to it.
    const applierScope = (p: string, size?: number): Scope => {
      const sc = this.scopeOf(p, size);
      return sc === "illegal" ? "active" : sc;
    };
    this.applier = new RemoteApplier({
      fs, state: d.state, index: this.index, journal: this.journal, blobs: this.blobs, intents: this.intents,
      locks: this.locks, echo: this.echo, now, ...(hooks ? { hooks } : {}), markDirty: this.markDirty, scopeOf: applierScope, kindOf: kind, rcOf,
      isLegal: (p) => !isIllegal(p, rules), needsBase: this.needsBase, maxFileBytes: () => this.settings.maxFileBytes,
      deleteMode: () => this.settings.deleteMode,
      keepFolder: (p) => p === cfg || this.settings.excludedFolders.some((f) => f === p),
      confirmMassDelete: (count) => this.confirmRemoteMassDelete(count),
      noteApplied: (p) => this.configSync.noteApplied(p),
      log: this.toLog,
    });
    this.runner = new OpRunner({
      state: d.state, index: this.index, journal: this.journal, remote: this.remote, keyring, fs, blobs: this.blobs, locks: this.locks, now,
      deviceId: () => this.connectInfo?.deviceId ?? this.local.load()?.deviceId ?? "", ...(hooks ? { hooks } : {}),
      markDirty: this.markDirty, rcOf, kindOf: kind, needsBase: this.needsBase,
      categoryOf: (p) => this.filter.categoryOf(p),
      batchMaxOps: this.budgets.commitBatchOps, ...(this.opts.random ? { random: this.opts.random } : {}),
      onAcked: (op) => {
        this.updateLocal((r) => (r.everSynced ? r : { ...r, everSynced: true }));
        if (op.kind !== "archive") this.conflictLoops.recordSuccess(op.fileId);
        void this.renames.retry();
      },
      onConflict: (fileId) => this.conflictLoops.recordConflict(fileId),
      onKeyVersion: () => { void this.refetchVaultInfo(); },
      onSnapshotRequired: () => { this.pendingResync ??= "epoch"; this.kick("snapshot"); },
      onArchiveFailed: (op, bytes) => this.writeArchiveFallback(op.path, bytes, op.fileId),
      log: this.toLog,
    });
    this.ingest = new Ingest({
      index: this.index, keyring, remote: this.remote, now, ...(hooks ? { hooks } : {}), markDirty: this.markDirty,
      onSeen: (maxSeq) => this.noteSeen(maxSeq),
      kick: () => this.kick("remote"),
      onSnapshotRequired: (info) => this.onSnapshotRequired(info),
      onVaultInfoChanged: () => { void this.refetchVaultInfo(); },
      onState: (s, detail) => this.onConnState(s, detail),
      onError: (err) => this.onRemoteError(err),
      log: this.toLog,
      rcOf,
    });
    this.executor = new Executor({
      fs, state: d.state, index: this.index, journal: this.journal, applier: this.applier, blobs: this.blobs, intents: this.intents,
      remote: this.remote, keyring, echo: this.echo, now, ...(hooks ? { hooks } : {}), markDirty: this.markDirty, rcOf,
      needsBase: this.needsBase, deviceName: () => this.settings.deviceName,
      ...(this.opts.tzOffset ? { tzOffset: this.opts.tzOffset } : {}),
      mergeOptions: this.mergeOpts,
      log: this.toLog,
      scheduleResync: () => { this.pendingResync ??= "snapshotResync"; this.kick("integrity"); },
      afterIndexChange: () => { void this.renames.retry(); },
      allowPushDelete: (fileId, path) => this.allowPushDelete(fileId, path),
    });
    const guarded: ActionExecutor = { execute: (a, c) => this.executeGuarded(a, c) };
    this.reconciler = new Reconciler({
      fs, index: this.index, locks: this.locks, echo: this.echo, scopeOf: this.scopeOf,
      kindOf: kind, isConfigJson: (p) => isConfigJson(p, cfg),
      hashFile: (p) => this.hashFile(p),
      settings: (): ReconcileSettings => ({ conflictMode: this.settings.conflictMode, mode: this.effectiveMode() }),
      ctx: () => this.planCtx, executor: guarded, markDirty: this.markDirty, isLocked: () => this.ring === null,
      onLocked: (k) => this.holdLocked(k, "retry"),
      hooks: {
        isTorn: (p, st) => this.intents.isTorn(p, st),
        reapply: async (p) => { await this.applier.reapply(p); },
        acquireHash: (n) => this.budget.acquireHash(n),
        releaseHash: (n) => this.budget.releaseHash(n),
        renames: this.renames,
        conflictLoop: (fileId) => this.conflictLoops.tripped(fileId),
      },
    });
    this.events = new LocalEventQueue({
      clock: d.clock, scheduler: d.scheduler, configDir: cfg, index: this.index,
      sink: {
        markDirty: this.markDirty,
        rename: (from, to, groupId) => this.renames.rename(from, to, groupId),
        scheduleScan: (mode) => this.requestScan(mode),
        onError: (e) => this.log.add({ cat: "error", key: LOG_KEYS.error, params: { error: errName(e) } }),
      },
      stat: (p) => fs.stat(p).catch(() => null),
      hashNow: async (p) => {
        if (this.ring === null) return null;
        try {
          return (await readAndHash(fs, p)).hash;
        } catch {
          return null;
        }
      },
      ...(this.opts.timings ? { timings: this.opts.timings } : {}),
    });
  }

  private loadedIndex: FileIndex | null = null;
  private indexOrThrow(_now: () => number): FileIndex {
    if (!this.loadedIndex) throw new Error("index not loaded");
    return this.loadedIndex;
  }

  // =====================================================================================
  // the loop (engine-spec §3.2)
  // =====================================================================================

  private async loop(): Promise<void> {
    for (let n = 0; ; n++) {
      this.rerun = false;
      const r = await this.runOnce();
      if (this.stopped) return;
      const again = this.rerun || r.work > 0;
      if (!again) break;
      if (n + 1 >= MAX_BACK_TO_BACK) {
        this.scheduleRetry(1000);
        break;
      }
    }
    await this.scheduleBackoffWake();
  }

  private blocked(): boolean {
    return this.stopped || !this.started || this.userPaused || this.guardPause !== null || this.tampered;
  }

  private async iteration(pushOnly: boolean): Promise<IterationResult> {
    const res: IterationResult = { ran: false, reconciled: 0, run: null, drain: null, work: 0 };
    if (this.blocked()) return res;
    if (this.ring === null) {
      // Locked (design §3.13): local events still collect; nothing is hashed, sealed or committed.
      await this.refreshCounters();
      return res;
    }
    res.ran = true;
    this.iterationPushOnly = pushOnly;
    this.deletesThisIteration = 0;
    this.deleteThreshold = massDeleteThreshold(this.index.activeCount());
    try {
      if (this.connected && this.torn.length > 0) {
        const torn = this.torn;
        this.torn = [];
        for (const t of torn) {
          try {
            await this.applier.applyOne(t.fileId, { planned: true, torn: t.path });
          } catch (e) {
            if (!isRemoteError(e)) throw e;
            this.torn.push(t);
          }
        }
      }
      if (this.connected && (this.rebuildPending || this.pendingResync)) {
        const mode: ResyncMode = this.rebuildPending ? "rebuild" : this.pendingResync!;
        const ok = await this.resync(mode);
        if (!ok) return res;
      }
      if (this.rescopeDue) await this.rescope();
      if (this.scanDue) {
        const mode = this.scanDue;
        this.scanDue = null;
        const ok = await this.scan(mode);
        if (!ok) return res;
      }
      if (this.connected && this.catchingUp) {
        // Catch-up first; offline startup (not connected) journals right away.
        this.scheduleRetry(1000);
        await this.refreshCounters();
        return res;
      }
      const precount = await this.precountDeletes();
      if (!precount) return res;
      res.reconciled = await this.drainDirty();
      if (this.planCtx.mode !== "incremental" && this.dirty.size === 0 && this.parkedConflicts.size === 0) {
        this.planCtx = { mode: "incremental" };
        this.conflictCopiesThisPass = 0;
      }
      if (this.blocked()) return res;
      if (this.connected && !this.vaultInfoPending) {
        res.run = await this.runner.run();
        const mode = this.effectiveMode();
        if (!pushOnly && !this.hidden && mode !== "push-only") res.drain = await this.applier.drain();
      }
      const ev = this.configSync.flush();
      if (ev) {
        this.log.add({ cat: "general", key: LOG_KEYS.configApplied, params: { needsReload: ev.needsReload, count: ev.paths.length } });
        this.emit("configApplied", ev);
      }
    } catch (e) {
      this.onIterationError(e);
    } finally {
      this.iterationPushOnly = false;
    }
    if (!this.everSyncedNoted) {
      // design §3.3.5: once anything is paired with the remote, a lost DB later means eviction (rebuild).
      for (const e of this.index.allActive()) {
        if (!e.synced) continue;
        this.everSyncedNoted = true;
        this.updateLocal((r) => (r.everSynced ? r : { ...r, everSynced: true }));
        break;
      }
    }
    const rs = res.run;
    const ds = res.drain;
    res.work = res.reconciled + (rs ? rs.prepared + rs.sent + rs.acked + rs.conflicts + rs.requeued : 0) +
      (ds ? ds.applied + ds.deleted + ds.handoff : 0);
    await this.refreshCounters();
    return res;
  }

  private onIterationError(e: unknown): void {
    if (isRemoteError(e)) {
      this.onRemoteError(e);
      if (e.code === "NETWORK" || e.code === "TIMEOUT" || e.code === "UNAVAILABLE" || e.code === "RATE_LIMITED" || e.code === "PROTOCOL" || e.code === "SERVER") {
        this.markDisconnected();
      }
      this.scheduleRetry(backoffDelay(++this.reconnectAttempts, this.opts.random));
      return;
    }
    if (isEngineError(e, "LOCKED")) return;
    // StateStore crashes (tests) and programming errors propagate; everything else is logged.
    if (e instanceof Error && (e.name === "Crash" || e.name === "StateStoreError")) throw e;
    this.lastError = errName(e);
    this.log.add({ cat: "error", key: LOG_KEYS.error, params: { error: errName(e) } });
    this.scheduleRetry(backoffDelay(++this.reconnectAttempts, this.opts.random));
  }

  private effectiveMode(): SyncMode {
    if (this.iterationPushOnly) return "push-only";
    if (this.readOnly && this.settings.mode === "bidirectional") return "pull-only";
    return this.settings.mode;
  }

  private setReadOnly(on: boolean): void {
    if (this.readOnly === on) return;
    this.readOnly = on;
    if (on) this.log.add({ cat: "general", key: LOG_KEYS.readOnly });
  }

  private async drainDirty(): Promise<number> {
    let n = 0;
    const retry: Array<{ key: DirtyKey; reason: DirtyReason }> = [];
    for (let pass = 0; pass < MAX_DIRTY_PASSES && this.dirty.size > 0; pass++) {
      if (this.blocked() || this.ring === null) break;
      const items = this.dirty.take(this.budgets.scanBatch);
      for (const item of items) {
        if (this.blocked()) {
          this.dirty.mark(item.key, item.reason);
          continue;
        }
        const fid = item.key.fileId ?? this.index.lookup(item.key)?.fileId;
        if (fid && this.parkedDeletes.has(fid)) continue;
        if (this.ring === null) {
          // Locked mid-pass (vault-info refetch): hold the rest without planning them.
          this.holdLocked(item.key, item.reason);
          continue;
        }
        try {
          const out = await this.reconciler.reconcile(item.key);
          if (out.t !== "locked") n++;
        } catch (e) {
          if (e instanceof Error && (e.name === "Crash" || e.name === "StateStoreError")) throw e;
          if (isEngineError(e, "LOCKED")) {
            this.holdLocked(item.key, item.reason);
            continue;
          }
          // design §3.11.5: stat errors and vanished files are re-checks, never uncaught exceptions.
          this.log.add({ cat: "error", key: LOG_KEYS.error, params: { error: errName(e) }, path: item.key.path });
          retry.push({ key: item.key, reason: "retry" });
          if (isRemoteError(e) && (e.code === "NETWORK" || e.code === "TIMEOUT" || e.code === "UNAVAILABLE")) this.markDisconnected();
        }
      }
      await this.renames.retry();
      await this.deps.scheduler.yieldToUi();
    }
    for (const r of retry) this.dirty.mark(r.key, r.reason);
    if (retry.length > 0) this.scheduleRetry(backoffDelay(Math.min(5, ++this.reconnectAttempts), this.opts.random));
    return n;
  }

  // ---------- scan + empty-vault guard (design §3.13) ----------

  private async scan(mode: 'fast' | 'full'): Promise<boolean> {
    let empty: { seen: number; indexedActive: number } | null = null;
    const marks: Array<{ key: DirtyKey; reason: DirtyReason }> = [];
    await scanLocal({
      fs: this.deps.fs, index: this.index, scheduler: this.deps.scheduler, scopeOf: this.scopeOf,
      kindOf: (p) => kindOf(p, this.configDir()),
      markDirty: (k, r) => marks.push({ key: k, reason: r }),
      includeConfigDir: true,
      yieldEvery: this.budgets.scanBatch,
      emptyVaultCheck: (o) => { if (looksEmpty(o.seen, o.indexedActive)) empty = o; },
    }, mode);
    const tripped = empty as { seen: number; indexedActive: number } | null;
    if (tripped && !this.emptyOverride) {
      // No deletes: drop this scan's `missing` marks, pause and ask.
      for (const m of marks) if (m.reason !== "missing") this.dirty.mark(m.key, m.reason);
      this.guardPause = "emptyVault";
      this.log.add({ cat: "error", key: LOG_KEYS.emptyVault, params: { seen: tripped.seen, indexed: tripped.indexedActive } });
      const sample = [...this.index.allActive()].slice(0, 10).map((e) => e.path);
      this.guards.raise("emptyVault", tripped.indexedActive, sample);
      this.scanDue = "fast";
      return false;
    }
    if (tripped) this.emptyOverride = false;
    for (const m of marks) this.dirty.mark(m.key, m.reason);
    if (mode === "full" || mode === "fast") await writeMeta(this.deps.state, "lastFullScanAt", this.deps.clock.now()).catch(() => undefined);
    return true;
  }

  // ---------- outgoing mass delete (design §3.13 massDeleteLocal) ----------

  /** Pre-count the deletes this iteration would push; above the threshold park them and ask. */
  private async precountDeletes(): Promise<boolean> {
    if (this.dirty.size <= this.deleteThreshold && this.parkedDeletes.size === 0) return true;
    const mode = this.effectiveMode();
    if (mode === "pull-only" || mode === "mirror-remote") return true;
    const cands: Array<{ fileId: FileId; key: DirtyKey; path: string }> = [];
    for (const item of this.dirty.peek()) {
      const e = this.index.lookup(item.key);
      if (!e || !e.synced || e.scope !== "active" || this.approvedDeletes.has(e.fileId)) continue;
      const st = await this.deps.fs.stat(e.path).catch(() => null);
      if (st) continue;
      const R = this.index.remote.byFileId(e.fileId);
      if (!R || R.deleted) continue;
      cands.push({ fileId: e.fileId, key: item.key, path: e.path });
    }
    for (const [fid, key] of this.parkedDeletes) if (!cands.some((c) => c.fileId === fid)) cands.push({ fileId: fid, key, path: key.path });
    if (cands.length <= this.deleteThreshold) {
      for (const [, key] of this.parkedDeletes) this.dirty.mark(key, "retry");
      this.parkedDeletes.clear();
      return true;
    }
    for (const c of cands) this.parkedDeletes.set(c.fileId, c.key);
    this.raiseMassDelete(cands.length, cands.map((c) => c.path));
    return true;
  }

  private raiseMassDelete(n: number, sample: string[]): void {
    if (this.guardPause !== "massDeleteLocal") this.log.add({ cat: "general", key: LOG_KEYS.massDelete, params: { count: n } });
    this.guardPause = "massDeleteLocal";
    this.guards.raise("massDeleteLocal", n, sample);
  }

  private allowPushDelete(fileId: FileId, path: string): boolean {
    if (this.approvedDeletes.delete(fileId)) return true;
    if (this.parkedDeletes.has(fileId) || this.guardPause === "emptyVault") return false;
    this.deletesThisIteration++;
    if (this.deletesThisIteration > this.deleteThreshold) {
      // Deletes the pre-count did not foresee (events during the pass): hold them and ask.
      this.parkedDeletes.set(fileId, { fileId, path });
      this.raiseMassDelete(this.deletesThisIteration, [path]);
      return false;
    }
    return true;
  }

  private confirmRemoteMassDelete(count: number): boolean {
    if (this.remoteDeleteApproved) {
      this.remoteDeleteApproved = false;
      return true;
    }
    this.guardPause = "massDeleteRemote";
    this.guards.raise("massDeleteRemote", count, []);
    this.publishStatus();
    return false;
  }

  // ---------- conflict copies during rebuild/pairing (design §3.13 massConflict) ----------

  private async executeGuarded(a: Action, c: ExecContext): Promise<void> {
    if (this.planCtx.mode !== "incremental" && makesConflictCopy(a) && !this.conflictApproved) {
      this.conflictCopiesThisPass++;
      if (this.conflictCopiesThisPass > MASS_CONFLICT_MAX) {
        const key: DirtyKey = c.entry ? { fileId: c.entry.fileId, path: c.entry.path } : { path: c.L?.path ?? actionPath(a) };
        this.parkedConflicts.set(key.fileId ?? key.path, key);
        if (this.guardPause !== "massConflict") this.log.add({ cat: "merge", key: LOG_KEYS.massConflict, params: { count: this.conflictCopiesThisPass } });
        this.guardPause = "massConflict";
        this.guards.raise("massConflict", this.conflictCopiesThisPass, [...this.parkedConflicts.values()].map((k) => k.path));
        return;
      }
    }
    await this.executor.execute(a, c);
    // design §3.10.1: the tripped fallback applies to the NEXT resolution only.
    if (c.ctx.conflictLoop && a.type === "MERGE") {
      this.log.add({ cat: "merge", key: "log.conflictLoop", fileId: a.fileId, path: a.path });
      this.conflictLoops.recordSuccess(a.fileId);
    }
  }

  // ---------- filter changes (design §3.11) ----------

  private async rescope(): Promise<void> {
    this.rescopeDue = false;
    for (const e of [...this.index.all()]) {
      const sc = this.filter.scope(e.path, e.obs?.size);
      if (sc === e.scope) continue;
      await this.index.setScope(e.fileId, sc);
      if (sc === "active") this.dirty.mark({ fileId: e.fileId, path: e.path }, "scope");
    }
    // Re-inclusion: enqueue applies for every remote head now in scope (deferred rows and unknown files).
    await this.index.write(["applyQueue", "deferred"], async (w) => {
      const tx = w.tx;
      for (const row of await tx.deferred.getAll()) {
        const R = w.remote(row.fileId);
        if (!R) {
          await tx.deferred.delete(row.fileId);
          continue;
        }
        if (this.filter.scope(R.path, R.deleted ? undefined : R.size) !== "active") continue;
        await tx.deferred.delete(row.fileId);
        await tx.applyQueue.put({ fileId: R.fileId, seq: R.seq, enqueuedAt: this.deps.clock.now(), attempts: 0 });
      }
      for (const R of [...this.index.remote.all()]) {
        if (R.deleted) continue;
        const e = w.entry(R.fileId);
        if (e && e.synced?.version === R.seq) continue;
        if (this.filter.scope(R.path, R.size) !== "active") continue;
        if (await tx.applyQueue.get(R.fileId)) continue;
        await tx.applyQueue.put({ fileId: R.fileId, seq: R.seq, enqueuedAt: this.deps.clock.now(), attempts: 0 });
      }
    });
    this.scanDue = "fast";
  }

  // ---------- snapshot resync / rebuild / rollback accept (design §3.8.6, §3.3.5) ----------

  private async resync(mode: ResyncMode): Promise<boolean> {
    this.closeSub();
    let res;
    try {
      res = await this.ingest.snapshotResync(mode);
    } catch (e) {
      if (isRemoteError(e)) {
        this.onRemoteError(e);
        this.scheduleRetry(backoffDelay(++this.reconnectAttempts, this.opts.random));
        return false;
      }
      throw e;
    }
    if (mode === "rebuild") {
      this.rebuildPending = false;
      this.planCtx = { mode: "rebuild" };
      this.scanDue = "full";
    } else if (mode === "rollback") {
      this.planCtx = { mode: "snapshotResync", rollbackAccepted: true };
      const s = this.seenStore.load();
      if (s) this.seenStore.save({ ...s, maxSeq: res.cursor });
      this.scanDue = "fast";
    } else {
      this.planCtx = { mode };
      const own = this.ownRebuild;
      this.ownRebuild = false;
      if (mode === "epoch" && !own && res.changed.length + res.purged.length > EPOCH_INFO_MIN) {
        this.log.add({ cat: "general", key: LOG_KEYS.epoch, params: { count: res.changed.length + res.purged.length } });
        this.guards.raise("epoch", res.changed.length + res.purged.length, []);
      }
    }
    if (this.pendingResync === mode || mode === "rebuild") this.pendingResync = null;
    if (this.connectInfo) await writeMeta(this.deps.state, "remoteEpoch", this.connectInfo.epoch);
    this.conflictCopiesThisPass = 0;
    this.subscribe(res.cursor);
    return true;
  }

  // =====================================================================================
  // connection (design §3.14 startup / reconnect, §4.5.3 vault-info checks)
  // =====================================================================================

  private vaultInfoPending = false;
  /** Subscribed but the catch-up has not reached live yet: reconcile waits so a fresh device sees the
   *  remote heads before it plans creates (avoids needless PATH_TAKEN conflict copies, §3.10.6). */
  private catchingUp = false;
  private catchUpTimer: TimerHandle | null = null;
  private cursorCache: Seq | null = null;

  private ensureConnected(): Promise<void> {
    if (this.connected || this.stopped || !this.started) return Promise.resolve();
    if (this.userPaused || this.tampered || this.authError) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const r = this.remote;
    try {
      const ci = await r.connect();
      this.connectInfo = ci;
      const got = await r.getVaultInfo();
      if (got) await this.acceptVaultInfo(got.info, ci);
      if (this.tampered) return;
      // design §3.13 rollback: welcome.headSeq < seen.maxSeq in the same epoch.
      const seen = this.seenStore.load();
      if (seen && ci.epoch === seen.epoch && ci.headSeq < seen.maxSeq && this.pendingResync !== "rollback") {
        this.raiseRollback(seen.maxSeq, ci.headSeq);
        this.connected = true;
        return;
      }
      // The local mirror belongs to one epoch: a newer remote epoch (rebuild elsewhere) → epoch resync;
      // an older one means the server went back (design §4.5.3 step 8) → rollback guard.
      const mirrorEpoch = await readMeta(this.deps.state, "remoteEpoch");
      if (mirrorEpoch === undefined) await writeMeta(this.deps.state, "remoteEpoch", ci.epoch);
      else if (ci.epoch > mirrorEpoch && !this.rebuildPending) this.pendingResync = "epoch";
      else if (ci.epoch < mirrorEpoch) {
        this.raiseRollback(mirrorEpoch, ci.epoch);
        this.connected = true;
        return;
      }
      if (this.epochResyncAsked) {
        // The feed asked for an epoch snapshot and the vault-info checks above passed.
        this.epochResyncAsked = false;
        if (!this.rebuildPending) this.pendingResync ??= "epoch";
      }
      this.connected = true;
      this.reconnectAttempts = 0;
      this.log.add({ cat: "network", key: LOG_KEYS.connected });
      if (this.ring !== null && !this.rebuildPending && this.pendingResync === null) {
        const cursor = (await readMeta(this.deps.state, "cursor")) ?? 0;
        this.subscribe(cursor);
      }
      this.kick("connected");
    } catch (e) {
      this.connected = false;
      if (isRemoteError(e) && (e.code === "UNAUTHENTICATED" || e.code === "REVOKED" || e.code === "FORBIDDEN")) {
        this.authError = true;
        this.log.add({ cat: "account", key: LOG_KEYS.authFailed, level: "error" });
      } else {
        this.log.add({ cat: "network", key: LOG_KEYS.connectFailed, level: "error", params: { error: errName(e) } });
        this.scheduleReconnect();
      }
    } finally {
      this.publishStatus();
    }
  }

  private async acceptVaultInfo(info: VaultInfo, ci: ConnectInfo | null): Promise<void> {
    const ring = this.ring;
    if (ci && info.epoch !== ci.epoch) return this.markTampered("epochMismatch");
    if (ring) {
      if (!ring.kvs.includes(info.activeKv)) {
        // design §3.13 / §4.5.3 "from cache": the active kv is not cached → Locked. Its MAC is made
        // with K_info(activeKv), which this device does not have, so it cannot be checked (that is not
        // tampering); nothing of this info is accepted until unlock re-validates it with the new keys.
        this.enterLocked("keyRotated");
        this.vaultInfo = null;
        return;
      }
      if (!(await ring.verifyVaultInfo(info).catch(() => false))) return this.markTampered("infoMac");
    }
    // design §4.5.3 step 8: infoRev, epoch and activeKv never go back.
    const seen = this.seenStore.load();
    if (seen && (info.infoRev < seen.infoRev || info.epoch < seen.epoch || info.activeKv < seen.activeKv)) {
      if (info.infoRev < seen.infoRev) this.raiseRollback(seen.infoRev, info.infoRev);
      else if (info.epoch < seen.epoch) this.raiseRollback(seen.epoch, info.epoch);
      else this.raiseRollback(seen.activeKv, info.activeKv);
      return;
    }
    this.vaultInfo = info;
    this.params = contentParamsOf(info);
    this.setReadOnly(info.requires.length > 0);
    this.seenStore.save({
      epoch: Math.max(seen?.epoch ?? 0, info.epoch), infoRev: Math.max(seen?.infoRev ?? 0, info.infoRev),
      activeKv: Math.max(seen?.activeKv ?? 0, info.activeKv), maxSeq: seen?.maxSeq ?? 0,
      ...(seen?.maxEntryKey !== undefined ? { maxEntryKey: seen.maxEntryKey } : {}),
    });
  }

  private markTampered(why: string): void {
    this.tampered = true;
    this.lastError = why;
    this.closeSub();
    this.log.add({ cat: "error", key: LOG_KEYS.tampered, params: { why } });
    this.guards.raise("tampered", 1, []);
    this.guardPause = "tampered";
  }

  private raiseRollback(seen: number, now: number): void {
    this.guardPause = "rollback";
    this.closeSub();
    this.log.add({ cat: "error", key: LOG_KEYS.rollback, params: { seen, now } });
    this.guards.raise("rollback", Math.max(0, seen - now), []);
  }

  /** design §4.5.3 "On vaultInfoChanged": hold commits until re-validation finishes. */
  private async refetchVaultInfo(): Promise<void> {
    if (this.vaultInfoPending) return;
    this.vaultInfoPending = true;
    try {
      const got = await this.remote.getVaultInfo();
      const ci = this.connectInfo;
      if (got && ci && got.info.epoch !== ci.epoch) {
        // design §4.5.3 / §4.9.2: the welcome of THIS connection fixed the epoch. A refetched info with
        // another epoch is never accepted against it. A newer epoch with a valid MAC is a rebuild on
        // another device while we were connected: reconnect, so the fresh welcome is checked against
        // the info (connect() then schedules the epoch resync). Anything else is tampering.
        const ring = this.ring;
        // Without the info's active key the MAC cannot be checked here; connect() then goes Locked.
        const macOk = ring && ring.kvs.includes(got.info.activeKv) ? await ring.verifyVaultInfo(got.info).catch(() => false) : true;
        const seen = this.seenStore.load();
        if (got.info.epoch > ci.epoch && macOk && got.info.epoch > (seen?.epoch ?? 0)) {
          this.log.add({ cat: "general", key: LOG_KEYS.epoch, params: { count: 0 } });
          await this.closeRemote();
          void this.ensureConnected();
        } else {
          this.markTampered("epochMismatch");
        }
        return;
      }
      if (got) await this.acceptVaultInfo(got.info, ci);
      this.runner.keyVersionResolved();
    } catch (e) {
      if (isRemoteError(e)) this.onRemoteError(e);
    } finally {
      this.vaultInfoPending = false;
      this.kick("vaultInfo");
      this.publishStatus();
    }
  }

  private subscribe(cursor: Seq): void {
    if (this.ring === null || this.blocked() || !this.connected && !this.connectInfo) return;
    this.closeSub();
    const gen = ++this.subGen;
    const ing = this.ingest;
    const live = (): boolean => gen === this.subGen;
    const sink: ChangeSink = {
      onChanges: (b) => ing.onChanges(b),
      headOf: (id) => ing.headOf(id),
      liveHeadByPathKey: (pk) => ing.liveHeadByPathKey(pk),
      onSnapshotRequired: (i) => { if (live()) ing.onSnapshotRequired(i); },
      onVaultInfoChanged: (etag) => { if (live()) ing.onVaultInfoChanged(etag); },
      onState: (s, detail) => { if (live()) ing.onState(s, detail); },
      onError: (err) => { if (live()) ing.onError(err); },
    };
    try {
      this.catchingUp = true;
      if (this.catchUpTimer !== null) this.deps.scheduler.clearTimer(this.catchUpTimer);
      this.catchUpTimer = this.deps.scheduler.setTimer(CATCH_UP_WAIT_MS, () => {
        this.catchUpTimer = null;
        if (this.catchingUp) { this.catchingUp = false; this.kick("catchUpTimeout"); }
      });
      this.sub = this.remote.subscribe(cursor, sink);
    } catch (e) {
      this.catchingUp = false;
      this.sub = null;
      if (isRemoteError(e)) this.onRemoteError(e);
      this.markDisconnected();
    }
  }

  private closeSub(): void {
    this.subGen++;
    this.catchingUp = false;
    const s = this.sub;
    this.sub = null;
    s?.close();
  }

  private async closeRemote(): Promise<void> {
    this.closeSub();
    if (!this.connected && !this.connectInfo) return;
    this.connected = false;
    await this.remote.close().catch(() => undefined);
    this.publishStatus();
  }

  private markDisconnected(): void {
    if (!this.connected) return;
    this.closeSub();
    this.connected = false;
    void this.remote.close().catch(() => undefined);
    this.log.add({ cat: "network", key: LOG_KEYS.disconnected });
    this.scheduleReconnect();
    this.publishStatus();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.stopped || this.opts.manual) return;
    const delay = backoffDelay(++this.reconnectAttempts, this.opts.random);
    this.reconnectTimer = this.deps.scheduler.setTimer(delay, () => {
      this.reconnectTimer = null;
      if (!this.hidden) void this.ensureConnected();
    });
  }

  private onConnState(s: string, _detail?: string): void {
    if (s === "offline" || s === "paused") this.markDisconnected();
    else if (s === "auth-error") {
      this.authError = true;
      this.closeSub();
      this.connected = false;
      this.log.add({ cat: "account", key: LOG_KEYS.authFailed, level: "error" });
    } else if (s === "live") {
      this.reconnectAttempts = 0;
      if (this.catchingUp) {
        this.catchingUp = false;
        this.kick("live");
      }
    }
    this.publishStatus();
  }

  private onSnapshotRequired(info: SnapshotRequiredInfo): void {
    this.closeSub();
    if (info.reason === "rollback") {
      const seen = this.seenStore.load();
      this.raiseRollback(seen?.maxSeq ?? 0, info.minSeq);
    } else if (info.reason === "epoch") {
      // design §2.11 step 5 / §4.5.3: a new epoch is accepted only through the MAC'd vault-info, and
      // the welcome epoch must equal it. Reconnect (fresh welcome + vault-info check); connect()
      // schedules the epoch resync once both agree, or goes tampered/rollback.
      this.epochResyncAsked = true;
      void this.closeRemote().then(() => this.ensureConnected());
    } else {
      this.pendingResync = "snapshotResync";
    }
    this.kick("snapshot");
    this.publishStatus();
  }

  private onRemoteError(err: RemoteError): void {
    this.lastError = err.code;
    if (err.code === "UNAUTHENTICATED" || err.code === "REVOKED" || err.code === "FORBIDDEN") {
      this.authError = true;
      this.log.add({ cat: "account", key: LOG_KEYS.authFailed, level: "error" });
    } else {
      this.log.add({ cat: "network", key: "log.remoteError", level: "error", params: { code: err.code } });
    }
  }

  private noteSeen(maxSeq: Seq): void {
    this.cursorCache = Math.max(this.cursorCache ?? 0, maxSeq);
    const s = this.seenStore.load() ?? { epoch: this.connectInfo?.epoch ?? 0, infoRev: this.vaultInfo?.infoRev ?? 0, activeKv: this.vaultInfo?.activeKv ?? 0, maxSeq: 0 };
    if (maxSeq > s.maxSeq) this.seenStore.save({ ...s, maxSeq });
  }

  // =====================================================================================
  // helpers
  // =====================================================================================

  private async defaultUnlock(pass: string, info: VaultInfo, seen: Seen | null): Promise<UnlockResult> {
    const u = await cryptoUnlock(pass, info as unknown as Parameters<typeof cryptoUnlock>[1], seen);
    await this.opts.onKeysUnlocked?.(u.cache);
    return { ring: u.ring, pullOnly: u.pullOnly };
  }

  /** Content hash for reconcile. Config JSON whose canonical form equals the synced base keeps the synced hash (I16). */
  private async hashFile(p: string): Promise<{ hash: string; size: number }> {
    const h = await readAndHash(this.deps.fs, p);
    if (!isConfigJson(p, this.configDir())) return { hash: h.hash, size: h.size };
    const e = this.index.byPath(p);
    if (!e?.synced || e.synced.hash === h.hash) return { hash: h.hash, size: h.size };
    const base = await this.deps.state.tx(["bases"], (tx) => tx.bases.get(e.fileId), "readonly");
    if (!base || base.hash !== e.synced.hash) return { hash: h.hash, size: h.size };
    const a = canonOfBytes(h.bytes);
    if (a !== null && a === canonOfBytes(base.bytes)) return { hash: e.synced.hash, size: h.size };
    return { hash: h.hash, size: h.size };
  }

  private async writeArchiveFallback(path: string, bytes: Uint8Array, fileId: FileId): Promise<void> {
    // X5: an archive failed for good; its bytes survive as a local copy next to the file.
    const fs = this.deps.fs;
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const stem = dot > slash + 1 ? path.slice(0, dot) : path;
    const ext = dot > slash + 1 ? path.slice(dot) : "";
    let copy = `${stem} (archive ${sanitizeName(this.settings.deviceName)})${ext}`;
    for (let i = 2; (await fs.stat(copy).catch(() => null)) !== null && i < 1000; i++) copy = `${stem} (archive ${sanitizeName(this.settings.deviceName)} ${i})${ext}`;
    if (slash > 0) await fs.mkdirp(path.slice(0, slash)).catch(() => undefined);
    await fs.write(copy, bytes, { mtime: this.deps.clock.now() });
    this.log.add({ cat: "merge", key: "log.archiveFailedCopy", path: copy, fileId });
    this.dirty.mark({ path: copy }, "new");
  }

  private updateLocal(fn: (r: LocalRecord) => LocalRecord): void {
    const r = this.local.load();
    if (!r) return;
    this.local.save(fn(r));
  }

  private async refreshCounters(): Promise<void> {
    if (!this.index) return;
    try {
      this.counters = await this.deps.state.tx(["journal", "batches", "applyQueue", "intents", "integrity", "deferred", "meta"], async (tx) => {
        const c = emptyCounters();
        for (const op of await tx.journal.getAll()) c.journalByState[op.state] = (c.journalByState[op.state] ?? 0) + 1;
        for (const b of await tx.batches.getAll()) c.batchesByState[b.state] = (c.batchesByState[b.state] ?? 0) + 1;
        c.applyQueue = await tx.applyQueue.count();
        c.intents = await tx.intents.count();
        c.quarantined = await tx.integrity.count();
        c.deferred = await tx.deferred.count();
        const cur = await tx.meta.get("cursor");
        this.cursorCache = cur === undefined ? null : (cur.v as Seq);
        return c;
      }, "readonly");
    } catch (e) {
      if (e instanceof Error && e.name === "StateStoreError") return;
      throw e;
    }
  }

  private publishStatus(): void {
    const s = this.status();
    const prev = this.lastStatus;
    if (prev && prev.status === s.status && prev.pendingUp === s.pendingUp && prev.pendingDown === s.pendingDown &&
        prev.failed === s.failed && prev.locked === s.locked && prev.readOnly === s.readOnly && prev.reason === s.reason) return;
    this.lastStatus = s;
    if (s.status === "synced" && !this.wasSynced) this.log.add({ cat: "general", key: LOG_KEYS.fullySynced });
    this.wasSynced = s.status === "synced";
    this.emit("status", s);
  }

  private emit<E extends EngineEventName>(ev: E, payload: EngineEventMap[E]): void {
    const set = this.listeners.get(ev);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Listener<E>)(payload);
      } catch {
        // listeners never break the engine
      }
    }
  }

  private scheduleRetry(ms: number): void {
    if (this.retryTimer !== null || this.stopped || this.opts.manual) return;
    this.retryTimer = this.deps.scheduler.setTimer(ms, () => {
      this.retryTimer = null;
      if (!this.connected) void this.ensureConnected();
      this.kick("retry");
    });
  }

  /** Wake the loop when the earliest backed-off op becomes due. */
  private async scheduleBackoffWake(): Promise<void> {
    if (this.opts.manual || this.stopped) return;
    const ops = await this.journal.ops().catch(() => []);
    const now = this.deps.clock.now();
    let next = Infinity;
    for (const o of ops) if (o.state !== "failed" && o.nextAttemptAt > now) next = Math.min(next, o.nextAttemptAt);
    if (Number.isFinite(next)) this.scheduleRetry(next - now + 1);
  }

  private armPeriodic(): void {
    const s = this.deps.scheduler;
    const node = this.opts.headless || this.deps.fs.platform === "node";
    const scanMs = this.opts.periodicScanMs ?? (node ? HEADLESS_SCAN_MS : isMobile(this.deps.fs.platform) ? 0 : PERIODIC_SCAN_MS);
    const cfgMs = this.opts.configScanMs ?? (isMobile(this.deps.fs.platform) ? CONFIG_SCAN_MOBILE_MS : CONFIG_SCAN_DESKTOP_MS);
    if (scanMs > 0) {
      const tick = (): void => {
        this.periodicTimer = s.setTimer(scanMs, tick);
        if (!this.hidden) this.requestScan("fast");
      };
      this.periodicTimer = s.setTimer(scanMs, tick);
    }
    if (cfgMs > 0 && cfgMs !== scanMs) {
      const tick = (): void => {
        this.configTimer = s.setTimer(cfgMs, tick);
        // The configDir scan reuses the fast scan (fast path: stats only, no reads for unchanged files).
        if (!this.hidden) this.requestScan("fast");
      };
      this.configTimer = s.setTimer(cfgMs, tick);
    }
  }

  /** Exposed so start() can load the index before assembling the modules. */
  async loadIndex(): Promise<void> {
    this.loadedIndex = await FileIndex.load(this.deps.state, () => this.deps.clock.now());
  }
}

function makesConflictCopy(a: Action): boolean {
  if (a.type === "KEEP_BOTH") return true;
  return a.type === "MERGE" && (a.strategy === "conflictCopy" || a.strategy === "dmp3");
}

function actionPath(a: Action): string {
  return "path" in a && typeof a.path === "string" ? a.path : "";
}

function errName(e: unknown): string {
  if (isRemoteError(e)) return e.code;
  if (e instanceof Error) return e.name;
  return "unknown";
}

function sanitizeName(s: string): string {
  let out = "";
  for (const ch of s) out += /[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 0x20 ? "_" : ch;
  return out.slice(0, 64) || "device";
}

/** design §4.11.5 markRebuild over the protocol Keyring: verify the current MAC, epoch+1, infoRev+1, new MAC. */
export async function markRebuildInfo(ring: Keyring, info: VaultInfo): Promise<VaultInfo> {
  if (!(await ring.verifyVaultInfo(info))) throw new Error("TamperedVaultInfo");
  const { infoMac: _m, ...rest } = info;
  const next = { ...rest, epoch: info.epoch + 1, infoRev: info.infoRev + 1 };
  return { ...next, infoMac: await ring.macVaultInfo(next as unknown as Parameters<Keyring["macVaultInfo"]>[0]) } as VaultInfo;
}

async function defaultSelfTest(): Promise<boolean> {
  const r = await cryptoSelfTest("kat");
  return r.ok;
}

export type { GuardEvent, ConfigCategory };
