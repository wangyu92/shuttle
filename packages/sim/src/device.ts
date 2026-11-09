// SimDevice (design §7.4, ops-spec §3.4): the real engine (createEngine, design §3.17) over MemLocalFs,
// MemStateStore, a skewed view of the shared FakeClock, a FakeScheduler and the world's FakeKeyring,
// talking to the server through SimNet. The engine runs in manual mode: the sim drives every
// iteration, so a run is a pure function of the seed.
//
// Crash model (design §7.4): `hooks.crashPoint(name)` throws at a chosen point; the store handle dies
// (only committed transactions survive), the disk stays. restart() builds a new engine over the
// reopened store, the same disk and the same localStorage. evict() models iOS dropping IndexedDB:
// a fresh empty store under the surviving localStorage record (I20 path).

import type { DeviceSettings, EngineHooks, GuardEvent, LocalPlatform, Scope } from "@shuttle/protocol";
import type { Seen } from "@shuttle/crypto";
import { FakeScheduler, MemLocalFs, MemStateStore, drainMicrotasks, type Prng } from "@shuttle/testkit";
import { createEngine, sha256Hex, type LocalRecord, type PlatformBudgets, type ShuttleEngine } from "@shuttle/engine";
import { CFG, type SimWorld } from "./world";
import { NO_FAULTS, SimNet, type CommitRecord, type NetViolation } from "./net";

/** Thrown at an armed crash point; the name matches what the engine lets propagate. */
export class SimCrash extends Error {
  constructor(readonly point: string) {
    super(`sim crash at ${point}`);
    this.name = "Crash";
  }
}

/** A crash, or anything thrown by the dead store handle afterwards. */
export function isCrashLike(e: unknown): boolean {
  return e instanceof SimCrash || (e instanceof Error && (e.name === "Crash" || e.name === "StateStoreError"));
}

/** Durable per-device "localStorage" (survives restarts and store eviction). */
export class LocalStorageFake {
  rec: LocalRecord | null = null;
  seen: Seen | null = null;
  readonly local = { load: (): LocalRecord | null => (this.rec ? structuredClone(this.rec) : null), save: (r: LocalRecord): void => { this.rec = structuredClone(r); } };
  readonly seenStore = { load: (): Seen | null => (this.seen ? { ...this.seen } : null), save: (s: Seen): void => { this.seen = { ...s }; } };
}

export interface SimDeviceConfig {
  name: string;
  platform: LocalPlatform;
  /** Wall-clock skew of this device (design §7.4: ±36 h, ±0.1 %). */
  offsetMs: number;
  drift: number;
  settings: Partial<DeviceSettings>;
  /** Override platform budgets (I24 tests shrink the in-flight cap). */
  budgets?: Partial<PlatformBudgets>;
}

export interface GuardRecord { step: number; device: string; kind: string; answer: string }

export class SimDevice {
  readonly fs: MemLocalFs;
  store: MemStateStore;
  readonly scheduler: FakeScheduler;
  readonly ls = new LocalStorageFake();
  readonly net: SimNet;
  engine!: ShuttleEngine;
  /** Engine is dead (crashed) until restart(). */
  dead = false;
  /** Armed crash: throw at this crash-point count (0 = off). */
  crashAt = 0;
  points = 0;
  /** Armed store-commit crash: the K-th commit from now kills the store (0 = off). */
  commitCrashAt = 0;
  commits = 0;
  restarts = 0;
  settings: Partial<DeviceSettings>;
  /** Guards the engine raised and the answer the sim gave. */
  readonly guards: GuardRecord[];
  private pendingGuards: GuardEvent[] = [];
  /** Peak budget figures across engine instances (I24). */
  readonly budgetPeaks = { bytes: 0, bytesCap: 0, largestAlone: 0, upload: 0, uploadCap: 0, download: 0, downloadCap: 0, maxFileBytes: 0 };
  /** Answer for the rollback guard: the sim accepts only in the DB-restore scenario. */
  rollbackAnswer: 'accept' | 'pause' = "pause";
  step = 0;
  /** Engine activity log entries go here when tracing (design §3.16 keys and params). */
  logSink: ((device: string, key: string, params: Record<string, unknown>) => void) | null = null;
  private readonly hooks: EngineHooks;

  constructor(
    readonly w: SimWorld, readonly cfg: SimDeviceConfig, private readonly prng: Prng,
    commits: CommitRecord[], violations: NetViolation[], guards: GuardRecord[],
  ) {
    const clock = w.clock.skewed({ offsetMs: cfg.offsetMs, drift: cfg.drift });
    this.fs = new MemLocalFs({
      clock, emitOwnEvents: false, caseInsensitive: cfg.platform === "ios" || cfg.platform === "android", configDir: CFG,
      platform: cfg.platform, writeCreatesParents: false,
    });
    // A dead process touches no file: engine fs calls after kill() fail like the crash itself.
    this.fs.before((op) => { if (this.dead) throw new SimCrash(`fs.${op} after death`); });
    this.store = new MemStateStore(undefined, { beforeCommit: () => this.onCommit() });
    this.scheduler = new FakeScheduler(w.clock);
    this.settings = { ...cfg.settings };
    this.guards = guards;
    this.net = new SimNet(w.server, prng.fork("net").b64u(16), cfg.name, prng.fork("faults"), commits, violations);
    this.hooks = {
      crashPoint: (name: string) => {
        if (this.dead) throw new SimCrash(name);
        this.points++;
        if (this.crashAt > 0 && this.points >= this.crashAt) {
          this.kill();
          throw new SimCrash(name);
        }
      },
    };
  }

  get name(): string {
    return this.cfg.name;
  }

  get deviceId(): string {
    return this.net.deviceId;
  }

  private onCommit(): void {
    this.commits++;
    if (this.commitCrashAt > 0 && this.commits >= this.commitCrashAt) this.kill();
  }

  /** Process death: the store handle dies, armed faults clear; disk, server and localStorage stay. */
  kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.crashAt = 0;
    this.commitCrashAt = 0;
    this.store.crash();
    // The process is gone: so is its socket (the server sees the connection drop).
    this.w.server.disconnect(this.deviceId);
  }

  async start(): Promise<void> {
    const engineClock = this.w.clock.skewed({ offsetMs: this.cfg.offsetMs, drift: this.cfg.drift });
    const rnd = this.prng.fork("engine-" + this.restarts);
    this.engine = createEngine({
      fs: this.fs, state: this.store, remote: this.net, keyring: this.w.ring, clock: engineClock, scheduler: this.scheduler, hooks: this.hooks,
    }, {
      settings: { deviceName: this.cfg.name, ...this.settings },
      manual: true, selfTest: async () => true, local: this.ls.local, seen: this.ls.seenStore,
      random: () => rnd.float(), tzOffset: () => 0,
      ...(this.cfg.budgets ? { budgets: this.cfg.budgets } : {}),
    });
    this.engine.on("guard", (g) => { this.pendingGuards.push(g); });
    // design §2.6.1: hello.rollbackAck comes from the engine (the host wires it the same way).
    const engine = this.engine;
    this.net.session = () => engine.helloContext();
    if (this.logSink) {
      const sink = this.logSink;
      this.engine.on("log", (e) => { sink(this.name, e.key, { ...e.params, ...(e.path !== undefined ? { path: e.path } : {}) }); });
    }
    this.dead = false;
    this.points = 0;
    this.commits = 0;
    try {
      await this.engine.start();
      await this.engine.whenConnected();
    } catch (e) {
      // A crash during startup (an armed tear hit the startup intent check): the device stays down.
      if (!isCrashLike(e) && !this.dead) throw e;
      this.kill();
    }
  }

  /**
   * Restart after a crash (or a clean stop): reopen the committed state; `evict` drops it (iOS).
   * The first iteration runs right away, as start() kicks the loop on a real device (design §3.14).
   */
  async restart(o: { evict?: boolean; run?: boolean } = {}): Promise<void> {
    this.recordBudget();
    await this.engine.stop().catch(() => undefined);
    const opts = { beforeCommit: () => this.onCommit() };
    this.store = o.evict ? new MemStateStore(undefined, opts) : this.store.reopen(opts);
    this.crashAt = 0;
    this.commitCrashAt = 0;
    this.restarts++;
    await this.start();
    if (o.run !== false) await this.iterate();
  }

  /** Arm a crash `k` crash points from now. */
  armCrash(k: number): void {
    this.crashAt = this.points + Math.max(1, k);
  }

  /** Drop armed crashes that did not fire (a tear stays armed: testkit has no way to cancel it). */
  disarm(): void {
    this.crashAt = 0;
    this.commitCrashAt = 0;
  }

  /** Arm a store-commit crash `k` commits from now. */
  armCommitCrash(k: number): void {
    this.commitCrashAt = this.commits + Math.max(1, k);
  }

  /** Torn write (design §7.4): the next engine write keeps a prefix, then the process dies. */
  armTornWrite(fraction: number): void {
    this.fs.tearNextWrite({ fraction, onTear: () => { this.kill(); } });
  }

  setOnline(on: boolean): void {
    if (this.net.offline === !on) return;
    this.net.offline = !on;
    if (!on) this.w.server.disconnect(this.deviceId);
  }

  /**
   * One engine iteration: deliver fs events, reconnect if needed, run, deliver the feed. Crash
   * errors are absorbed (the device is then dead); anything else is a harness or engine bug.
   */
  async iterate(): Promise<number> {
    if (this.dead) return 0;
    this.net.step = this.step;
    let work = 0;
    try {
      this.engine.events.flushAll();
      await this.engine.events.idle();
      await drainMicrotasks();
      if (!this.net.offline && !this.engine.isConnected()) await this.engine.whenConnected();
      const r = await this.engine.runOnce();
      work = r.work + this.engine.dirty.size;
      await this.w.server.settle();
    } catch (e) {
      // After kill() (e.g. a torn write) the dying engine may still throw ordinary errors.
      if (!isCrashLike(e) && !this.dead) throw e;
      this.kill();
    }
    if (this.dead) {
      // Background work of the dead engine (feed delivery) must not touch the new one.
      await this.w.server.settle().catch(() => undefined);
    }
    this.answerGuards();
    this.recordBudget();
    return work;
  }

  /** The user's answers (design §3.13): deletes and conflicts the user caused are approved. */
  private answerGuards(): void {
    const gs = this.pendingGuards;
    this.pendingGuards = [];
    for (const g of gs) {
      let answer: string;
      switch (g.kind) {
        case "massDeleteLocal": case "massDeleteRemote": case "massConflict": case "emptyVault":
          answer = "apply"; break;
        case "rollback":
          answer = this.rollbackAnswer; break;
        default:
          answer = "none";
      }
      this.guards.push({ step: this.step, device: this.name, kind: g.kind, answer });
      if (answer !== "none" && !this.dead) this.engine.answerGuard(g.id, answer as 'apply' | 'accept' | 'pause');
    }
  }

  private recordBudget(): void {
    if (!this.engine) return;
    const b = this.engine.budget;
    const p = this.budgetPeaks;
    p.bytes = Math.max(p.bytes, b.bytes.stats.peak);
    p.bytesCap = b.bytes.cap;
    p.largestAlone = Math.max(p.largestAlone, b.bytes.stats.largestAlone);
    p.upload = Math.max(p.upload, b.uploadSlots.stats.peak);
    p.uploadCap = b.uploadSlots.limit;
    p.download = Math.max(p.download, b.downloadSlots.stats.peak);
    p.downloadCap = b.downloadSlots.limit;
    p.maxFileBytes = this.engine.settings.maxFileBytes;
  }

  /** Quiet the device for the oracle: alive, online, no faults. */
  async heal(): Promise<void> {
    this.net.rates = NO_FAULTS;
    this.setOnline(true);
    if (this.dead) await this.restart();
    else if (!this.engine.isConnected()) await this.engine.whenConnected();
  }

  scopeOf(p: string, size: number): Scope {
    return this.engine.filter.scope(p, size);
  }

  /** Active path → sha256 hex of the bytes on disk (I7). */
  async activeMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [p, bytes] of this.fs.files({ includeConfigDir: true })) {
      if (this.scopeOf(p, bytes.length) !== "active") continue;
      out.set(p, await sha256Hex(bytes));
    }
    return out;
  }
}
