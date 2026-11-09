// Harness for engine part 3: devices built through createEngine() (the public API the plugin and the
// headless client use), over MemLocalFs + MemStateStore + a shared FakeRemoteServer (design §7.4).
// Fixtures only: no real hosts or users.

import type { DeviceSettings, EngineHooks, LocalPlatform, Scope } from "@shuttle/protocol";
import { FakeScheduler, MemLocalFs, MemStateStore, Prng, drainMicrotasks, type FsOp } from "@shuttle/testkit";
import type { Seen } from "@shuttle/crypto";
import { createEngine, type EngineOptions, type LocalRecord, type ShuttleEngine } from "../src/index";
import { CFG, Crash, TEST_PARAMS, makeWorld, serverMap, sortedEntries, type World } from "./harness";

export { CFG, TEST_PARAMS, makeWorld, serverMap, sortedEntries, type World };

/** A crash, or anything thrown by a dead store handle (MemStateStore after crash()). */
export function isCrashLike(e: unknown): boolean {
  return e instanceof Crash || (e instanceof Error && e.name === "StateStoreError");
}

export interface NodeOpts {
  name: string;
  platform?: LocalPlatform;
  caseInsensitive?: boolean;
  settings?: Partial<DeviceSettings>;
  opts?: Partial<EngineOptions>;
  /** Engine-own writes emit fs events (real platforms do). Default false for deterministic tests. */
  emitOwnEvents?: boolean;
}

/** Durable per-device "localStorage" (survives restarts and DB wipes). */
export class LocalStorageFake {
  rec: LocalRecord | null = null;
  seen: Seen | null = null;
  readonly local = { load: (): LocalRecord | null => (this.rec ? structuredClone(this.rec) : null), save: (r: LocalRecord): void => { this.rec = structuredClone(r); } };
  readonly seenStore = { load: (): Seen | null => (this.seen ? { ...this.seen } : null), save: (s: Seen): void => { this.seen = { ...s }; } };
}

export class Node {
  readonly fs: MemLocalFs;
  store: MemStateStore;
  readonly scheduler: FakeScheduler;
  readonly ls = new LocalStorageFake();
  engine!: ShuttleEngine;
  readonly deviceId: string;
  /** fs operations by the engine (after start), for read/remove spies. */
  readonly fsOps: Array<{ op: FsOp; path: string }> = [];
  crashAt = 0;
  points: string[] = [];
  /** Crash during the K-th store commit (1-based); 0 = never. */
  commitCrashAt = 0;
  commits = 0;
  crashed = false;
  private hooks: EngineHooks;

  constructor(readonly w: World, readonly o: NodeOpts) {
    this.fs = new MemLocalFs({
      clock: w.clock, emitOwnEvents: o.emitOwnEvents ?? false, caseInsensitive: o.caseInsensitive ?? false, configDir: CFG,
      platform: o.platform ?? "desktop", writeCreatesParents: false,
    });
    this.fs.before((op, path) => { this.fsOps.push({ op, path }); });
    this.store = new MemStateStore(undefined, { beforeCommit: () => this.onCommit() });
    this.scheduler = new FakeScheduler(w.clock);
    this.deviceId = new Prng("node-" + o.name).b64u(16);
    this.hooks = {
      crashPoint: (name: string) => {
        if (this.crashed) throw new Crash(name);
        this.points.push(name);
        if (this.crashAt > 0 && this.points.length === this.crashAt) {
          this.crashed = true;
          this.store.crash();
          throw new Crash(name);
        }
      },
    };
  }

  private onCommit(): void {
    this.commits++;
    if (this.commitCrashAt > 0 && this.commits === this.commitCrashAt) {
      this.crashed = true;
      this.store.crash();
    }
  }

  async start(): Promise<ShuttleEngine> {
    const remote = this.w.server.adapter(this.deviceId, { name: this.o.name });
    this.engine = createEngine({
      fs: this.fs, state: this.store, remote, keyring: this.w.ring, clock: this.w.clock, scheduler: this.scheduler, hooks: this.hooks,
    }, {
      settings: { deviceName: this.o.name, ...(this.o.settings ?? {}) },
      manual: true, selfTest: async () => true, local: this.ls.local, seen: this.ls.seenStore,
      random: () => 0.5, tzOffset: () => 0,
      ...(this.o.opts ?? {}),
    });
    await this.engine.start();
    await this.engine.whenConnected();
    return this.engine;
  }

  /** Kill the engine (store handle dies), keep disk, server and localStorage. */
  async restart(o: { wipeState?: boolean } = {}): Promise<ShuttleEngine> {
    await this.engine.stop().catch(() => undefined);
    const opts = { beforeCommit: () => this.onCommit() };
    this.store = o.wipeState ? new MemStateStore(undefined, opts) : this.store.reopen(opts);
    this.crashAt = 0;
    this.commitCrashAt = 0;
    this.crashed = false;
    this.points = [];
    return this.start();
  }

  /** Deliver pending fs events now (skip debounce timers and delete holds). */
  async flushEvents(): Promise<void> {
    this.engine.events.flushAll();
    await this.engine.events.idle();
    await drainMicrotasks();
  }

  /** Iterate this device and deliver feeds until quiet. */
  async sync(rounds = 40): Promise<void> {
    await syncAll([this], rounds);
  }

  /** Active path → content hash on disk (I7 oracle). */
  async diskMap(scope: (p: string, size: number) => Scope = (p, s) => this.engine.filter.scope(p, s)): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [p, bytes] of this.fs.files({ includeConfigDir: true })) {
      if (scope(p, bytes.length) !== "active") continue;
      const d = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
      out.set(p, [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    return out;
  }

  ops(op: FsOp): string[] {
    return this.fsOps.filter((o) => o.op === op).map((o) => o.path);
  }
}

/**
 * Run every node and deliver feeds until all are quiet: two consecutive rounds without work, nothing
 * dirty, nothing pending up or down, and no node waiting for its catch-up. Backed-off ops get time.
 */
export async function syncAll(nodes: readonly Node[], rounds = 40): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < rounds; i++) {
    let work = 0;
    for (const n of nodes) {
      await n.flushEvents();
      const r = await n.engine.runOnce();
      work += r.work + n.engine.dirty.size;
      await n.w.server.settle();
    }
    const busy = nodes.some((n) => {
      const s = n.engine.status();
      return s.status === "syncing" || s.pendingUp > 0 || s.pendingDown > 0;
    });
    if (work === 0 && !busy) {
      if (++quiet >= 2) return;
      continue;
    }
    quiet = 0;
    if (work === 0) nodes[0]!.w.clock.tick(10 * 60 * 1000);
  }
}
