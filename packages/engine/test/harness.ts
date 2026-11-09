// Test harness for engine part 2: one Device = MemLocalFs + MemStateStore + FileIndex + Journal +
// OpRunner + RemoteApplier + Ingest + Executor + Reconciler, connected to a shared FakeRemoteServer.
// A Device can crash at its N-th crash point (or at a store commit) and restart over the committed
// state (design §7.4 crash model). Paths and names are fixtures only.

import { SxKeyring } from "@shuttle/crypto";
import type { EngineHooks, Keyring, Scope, Subscription, VersionRecord } from "@shuttle/protocol";
import { FakeClock, FakeRemoteServer, FakeScheduler, MemLocalFs, MemStateStore, Prng, TestIds, type FakeRemote } from "@shuttle/testkit";
import {
  BlobPipeline, DirtySet, EchoSuppressor, Executor, FileIndex, Ingest, Journal, KeyedMutex, LocalRenames, OpRunner, Reconciler,
  RemoteApplier, WriteIntents, decodeRecord, markPendingLocalChanges, isConfigJson, isIllegal, kindOf, readAndHash, readMeta, retentionClassOf, scanLocal,
  type ContentParams, type PendingOpMirror, type PlanCtx, type ReconcileSettings,
} from "../src/index";

export const CFG = ".obsidian";

export class Crash extends Error {
  constructor(readonly point: string) {
    super(`crash at ${point}`);
    this.name = "Crash";
  }
}

export function isCrash(e: unknown): boolean {
  return e instanceof Crash || (e instanceof Error && (e.name === "StateStoreError") && /CRASHED|crash/i.test(e.message));
}

export const scopeOf = (p: string, size?: number): Scope => {
  if (p.split("/").some((s, i) => s.startsWith(".") && !(i === 0 && s === CFG))) return "ignored";
  if (p.startsWith("excluded/")) return "excluded";
  if (size !== undefined && size > 50_000_000) return "oversize";
  return "active";
};

/** Small FastCDC parameters so test files exercise multi-chunk uploads. */
export const TEST_PARAMS: ContentParams = {
  chunker: { min: 2048, avg: 4096, max: 16384 }, inlineMax: 4096, compression: "deflate-raw", padding: "none",
};

export interface World {
  clock: FakeClock;
  server: FakeRemoteServer;
  ring: Keyring;
  ids: TestIds;
}

export async function makeWorld(seed = "world"): Promise<World> {
  const clock = new FakeClock();
  const server = new FakeRemoteServer({ clock, prng: new Prng(seed) });
  const ids = new TestIds(seed);
  const vmk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) vmk[i] = (i * 37 + 11) & 0xff;
  const vaultId = ids.vaultId();
  const ring = await SxKeyring.fromVmks(vaultId, new Map([[1, vmk]]), 1);
  const boot = server.adapter("bootstrapdev0000000000");
  await boot.connect();
  const info = ids.vaultInfo({ vaultId });
  info.params.chunker = { alg: "fastcdc-k1", ...TEST_PARAMS.chunker };
  // A real infoMac, so engines built by createEngine() accept the vault-info (design §4.5.3 step 7).
  const { infoMac: _mac, ...unsigned } = info;
  info.infoMac = await ring.macVaultInfo(unsigned as unknown as Parameters<typeof ring.macVaultInfo>[0]);
  await boot.createVaultInfo(info);
  await boot.close();
  return { clock, server, ring, ids };
}

export interface DeviceOpts {
  name: string;
  /** Path filter of this device (default: the shared test scopeOf). */
  scope?: (p: string, size?: number) => Scope;
  caseInsensitive?: boolean;
  settings?: Partial<ReconcileSettings>;
}

export class Device {
  readonly fs: MemLocalFs;
  store: MemStateStore;
  remote!: FakeRemote;
  sub: Subscription | null = null;
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
  dirty = new DirtySet();
  /** The localStorage pendingOps mirror (survives crashes, like localStorage). */
  readonly mirror = new Map<string, PendingOpMirror>();
  echo: EchoSuppressor;
  locks = new KeyedMutex();
  settings: ReconcileSettings;
  ctx: PlanCtx = { mode: "incremental" };
  readonly deviceId: string;
  /** Crash control: crash at the N-th crash point (1-based); 0 = never. */
  crashAt = 0;
  points: string[] = [];
  crashed = false;
  snapshotRequired = 0;
  logs: Array<{ key: string; path?: string }> = [];
  private readonly scheduler: FakeScheduler;
  private readonly hooks: EngineHooks;

  /** Crash during the K-th store commit (1-based; design §7.4 commit-time crash points); 0 = never. */
  commitCrashAt = 0;
  commits = 0;

  readonly scope: (p: string, size?: number) => Scope;

  constructor(readonly w: World, readonly o: DeviceOpts) {
    this.scope = o.scope ?? scopeOf;
    this.fs = new MemLocalFs({ clock: w.clock, emitOwnEvents: false, caseInsensitive: o.caseInsensitive ?? false, configDir: CFG });
    this.store = new MemStateStore(undefined, { beforeCommit: () => this.onCommit() });
    this.echo = new EchoSuppressor(w.clock);
    this.scheduler = new FakeScheduler(w.clock);
    this.settings = { conflictMode: "merge", mode: "bidirectional", ...o.settings };
    this.deviceId = new Prng("dev-" + o.name).b64u(16);
    this.hooks = {
      crashPoint: (name: string) => {
        if (this.crashed) throw new Crash(name);
        this.points.push(name);
        if (this.crashAt > 0 && this.points.length === this.crashAt) this.crash(name);
      },
    };
  }

  private onCommit(): void {
    this.commits++;
    if (this.commitCrashAt > 0 && this.commits === this.commitCrashAt) {
      this.crashed = true;
      this.store.crash();
      this.sub?.close();
      this.sub = null;
      void this.remote?.close();
    }
  }

  /** Kill the process: the store handle dies, the feed closes; disk and server stay. */
  crash(at = "manual"): never {
    this.crashed = true;
    this.store.crash();
    this.sub?.close();
    this.sub = null;
    void this.remote?.close();
    throw new Crash(at);
  }

  async start(): Promise<void> {
    const w = this.w;
    const now = (): number => w.clock.now();
    const rcOf = (p: string) => retentionClassOf(p, CFG);
    const needsBase = (p: string, size: number): boolean => kindOf(p, CFG) === "note" && size <= 2 * 1024 * 1024;
    const markDirty = (k: Parameters<DirtySet["mark"]>[0], r: Parameters<DirtySet["mark"]>[1]): void => this.dirty.mark(k, r);
    this.crashed = false;
    this.dirty = new DirtySet();
    this.echo = new EchoSuppressor(w.clock);
    this.locks = new KeyedMutex();
    this.remote = w.server.adapter(this.deviceId, { name: this.o.name });
    this.index = await FileIndex.load(this.store, now);
    this.journal = new Journal({
      state: this.store, now,
      mirror: { upsert: (m) => { this.mirror.set(m.fileId, m); }, remove: (id) => { this.mirror.delete(id); }, list: () => [...this.mirror.values()] },
    });
    this.blobs = new BlobPipeline({ remote: this.remote, keyring: () => w.ring, params: () => TEST_PARAMS });
    this.intents = new WriteIntents({ state: this.store, fs: this.fs });
    this.renames = new LocalRenames({ index: this.index, scopeOf: this.scope, markDirty });
    this.applier = new RemoteApplier({
      fs: this.fs, state: this.store, index: this.index, journal: this.journal, blobs: this.blobs, intents: this.intents,
      locks: this.locks, echo: this.echo, now, hooks: this.hooks, markDirty, scopeOf: this.scope, kindOf: (p) => kindOf(p, CFG), rcOf,
      isLegal: (p) => !isIllegal(p, "posix"), needsBase, maxFileBytes: () => 200 * 1024 * 1024, deleteMode: () => "trash",
      log: (e) => this.logs.push({ key: e.key, ...(e.path !== undefined ? { path: e.path } : {}) }),
    });
    this.runner = new OpRunner({
      state: this.store, index: this.index, journal: this.journal, remote: this.remote, keyring: () => w.ring, fs: this.fs,
      blobs: this.blobs, locks: this.locks, now, deviceId: () => this.deviceId, hooks: this.hooks, markDirty, rcOf,
      kindOf: (p) => kindOf(p, CFG), needsBase, batchMaxOps: 50, random: () => 0.5,
      onAcked: () => { void this.renames.retry(); },
      onArchiveFailed: async (op, bytes) => {
        const copy = op.path.replace(/(\.[^./]+)?$/, (m) => ` (archive failed)${m}`);
        await this.fs.mkdirp(copy.split("/").slice(0, -1).join("/")).catch(() => undefined);
        await this.fs.write(copy, bytes, { mtime: now() });
        markDirty({ path: copy }, "new");
      },
      log: (e) => this.logs.push({ key: e.key, ...(e.path !== undefined ? { path: e.path } : {}) }),
    });
    this.ingest = new Ingest({
      index: this.index, keyring: () => w.ring, remote: this.remote, now, hooks: this.hooks, markDirty,
      onSnapshotRequired: () => { this.snapshotRequired++; },
    });
    this.executor = new Executor({
      fs: this.fs, state: this.store, index: this.index, journal: this.journal, applier: this.applier, blobs: this.blobs,
      intents: this.intents, remote: this.remote, keyring: () => w.ring, echo: this.echo, now, hooks: this.hooks, markDirty, rcOf,
      needsBase, deviceName: () => this.o.name, tzOffset: () => 0,
      afterIndexChange: () => { void this.renames.retry(); },
      log: (e) => this.logs.push({ key: e.key, ...(e.path !== undefined ? { path: e.path } : {}) }),
    });
    this.reconciler = new Reconciler({
      fs: this.fs, index: this.index, locks: this.locks, echo: this.echo, scopeOf: this.scope,
      kindOf: (p) => kindOf(p, CFG), isConfigJson: (p) => isConfigJson(p, CFG),
      hashFile: async (p) => { const h = await readAndHash(this.fs, p); return { hash: h.hash, size: h.size }; },
      settings: () => this.settings, ctx: () => this.ctx, executor: this.executor, markDirty, isLocked: () => false,
      hooks: {
        isTorn: (p, st) => this.intents.isTorn(p, st),
        reapply: async (p) => { await this.applier.reapply(p); },
        renames: this.renames,
      },
    });
    // design §3.8.4: leftover intents are checked before the first scan.
    for (const t of await this.intents.startupCheck()) await this.applier.applyOne(t.fileId, { planned: true, torn: t.path });
    await this.runner.resume();
    markPendingLocalChanges(this.index, markDirty);
    await this.remote.connect();
    const cursor = (await readMeta(this.store, "cursor")) ?? 0;
    this.sub = this.remote.subscribe(cursor, this.ingest);
  }

  /** Restart after a crash: reopen the committed state and resume. */
  async restart(): Promise<void> {
    this.sub?.close();
    this.sub = null;
    await this.remote?.close();
    this.store = this.store.reopen({ beforeCommit: () => this.onCommit() });
    this.crashAt = 0;
    this.commitCrashAt = 0;
    await this.start();
  }

  /** Scan and reconcile only (no journal run, no apply). */
  async reconcileAll(): Promise<void> {
    await scanLocal({
      fs: this.fs, index: this.index, scheduler: this.scheduler, scopeOf: this.scope, kindOf: (p) => kindOf(p, CFG),
      markDirty: (k, r) => this.dirty.mark(k, r), includeConfigDir: true,
    }, "fast");
    for (let guard = 0; this.dirty.size > 0 && guard < 50; guard++) {
      for (const item of this.dirty.take()) await this.reconciler.reconcile(item.key);
      await this.renames.retry();
    }
  }

  /** Reconcile everything dirty, run the journal, deliver the feed, drain the apply queue, until quiet. */
  async sync(maxRounds = 40): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      let work = 0;
      await scanLocal({
        fs: this.fs, index: this.index, scheduler: this.scheduler, scopeOf: this.scope, kindOf: (p) => kindOf(p, CFG),
        markDirty: (k, r) => this.dirty.mark(k, r), includeConfigDir: true,
      }, "fast");
      for (let guard = 0; this.dirty.size > 0 && guard < 50; guard++) {
        for (const item of this.dirty.take()) {
          await this.reconciler.reconcile(item.key);
          work++;
        }
        await this.renames.retry();
      }
      const rs = await this.runner.run();
      work += rs.prepared + rs.sent + rs.acked + rs.conflicts + rs.requeued;
      await this.w.server.settle();
      const ds = await this.applier.drain();
      work += ds.applied + ds.deleted + ds.handoff;
      if (work === 0 && this.dirty.size === 0) {
        const ops = await this.journal.ops();
        const waiting = ops.filter((o) => o.state !== "failed");
        if (waiting.length === 0 && (await this.queueSize()) === 0) return;
        const next = Math.min(...waiting.map((o) => o.nextAttemptAt), Infinity);
        if (next > this.w.clock.now() && Number.isFinite(next)) this.w.clock.tick(next - this.w.clock.now() + 1);
        else if (waiting.length === 0) return;
      }
    }
  }

  queueSize(): Promise<number> {
    return this.store.tx(["applyQueue"], (tx) => tx.applyQueue.count(), "readonly");
  }

  /** Active path → content hash on disk (I7 oracle). */
  async diskMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [p, bytes] of this.fs.files({ includeConfigDir: true })) {
      if (this.scope(p, bytes.length) !== "active") continue;
      const d = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
      out.set(p, [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    }
    return out;
  }
}

/** Live remote heads, decrypted: path → content hash (I7 oracle). */
export async function serverMap(w: World): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rec of w.server.inspect().heads) {
    if (rec.kind !== "put") continue;
    const h = (await decodeRecord(w.ring, rec)).head;
    if (h && h.contentHash) out.set(h.path, h.contentHash);
  }
  return out;
}

export function recordsOf(w: World, pred: (r: VersionRecord) => boolean = () => true): VersionRecord[] {
  return w.server.inspect().log.filter(pred);
}

export function sortedEntries(m: Map<string, string>): Array<[string, string]> {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Bytes that are large enough for several FastCDC chunks with TEST_PARAMS. */
export function bigBytes(seed: string, n = 40_000): Uint8Array {
  return new Prng(seed).bytes(n);
}

/** Plaintext of any record (archive included), read through a fresh adapter. */
export async function contentOf(w: World, rec: VersionRecord): Promise<Uint8Array> {
  const dec = await decodeRecord(w.ring, rec);
  const m = dec.meta as { path: string; size: number; mtime: number; hash: string; chunks: number[]; z: boolean; p: boolean };
  const ad = w.server.adapter("inspectordev000000000");
  await ad.connect();
  const pipe = new BlobPipeline({ remote: ad, keyring: () => w.ring, params: () => TEST_PARAMS });
  const head = {
    fileId: rec.fileId, seq: rec.seq, base: rec.base, pathKey: rec.pathKey, path: m.path, deleted: false, size: m.size, mtime: m.mtime,
    contentHash: m.hash, chunkSizes: rec.blobs.length ? m.chunks : [], blobs: rec.blobs, kv: rec.kv, deviceId: rec.device, ts: rec.ts,
    rc: rec.rc, z: m.z, p: m.p, ...(rec.inline !== undefined ? { inline: rec.inline } : {}),
  };
  const kind = rec.kind;
  if (kind === "archive" && rec.inline !== undefined) {
    // Inline archives are sealed with kind "archive" in the AAD.
    return w.ring.openInline(rec.inline, { fileId: rec.fileId, kv: rec.kv, kind, base: rec.base, rc: rec.rc, blobs: [], pathKey: rec.pathKey }, m.z, m.p, m.size);
  }
  const out = await pipe.download(head, rec.rc);
  await ad.close();
  return out;
}
