// The deterministic multi-device simulation (design §7.4, ops-spec §3.4).
//
// One run = one seed. A seeded stream picks every action: user edits (notes carry unique token lines,
// binaries are random bytes), creates, deletes, renames, folder moves and deletes, moves into and out
// of an excluded folder, the same note edited on two devices, the same new path on two devices, 0-byte
// and oversize files, filter changes, engine iterations, offline periods, network faults, crashes at
// engine crash points and store commits, torn engine writes, store eviction, clock jumps, server
// compaction and a remote rebuild from a filtered device. Devices run strictly one after another, so
// the run is a pure function of (seed, devices, steps, options).
//
// Every `checkEvery` steps and at the end the sim heals all devices (alive, online, no faults), runs
// them until quiet and checks the oracles (design §3.18, §7.2 sim rows):
//   I7 convergence, I6 content ledger, I16 no echo commits (a full rescan after quiet commits nothing),
//   no ghosts and no spontaneous deletes (I17, I28), I1/I4 on each device's committed state,
//   I5 blobs before meta (on every commit), I24 budgets, and "no tampered/integrity guard".

import type { FileEntry, Op, VersionRecord } from "@shuttle/protocol";
import { Prng, setMacrotaskHook } from "@shuttle/testkit";
import { decodeRecord, sha256Hex } from "@shuttle/engine";
import { SimDevice, isCrashLike, type GuardRecord, type SimDeviceConfig } from "./device";
import { Evidence, Ledger, noteBytes, noteLines, tokensOf } from "./ledger";
import { NO_FAULTS, type CommitRecord, type NetFaultRates, type NetViolation } from "./net";
import { installDeterministicAsync, installDeterministicRandom } from "./random";
import { makeSimWorld, type SimWorld } from "./world";

export interface SimOptions {
  seed: number;
  devices: number;
  steps: number;
  /** Quiesce and check every N steps (0 = only at the end). Default 100. */
  checkEvery?: number;
  /** Enable network/crash/fs faults (default true). */
  faults?: boolean;
  /** Override action weights (0 disables an action). */
  weights?: Partial<Record<ActionName, number>>;
  /** Keep the per-step trace in the result (CLI --trace-dir writes it). */
  keepTrace?: boolean;
  /**
   * The user may change files while the device's engine is dead (another editor, app closed; default
   * true). False limits user actions to devices whose engine runs.
   */
  editWhileDown?: boolean;
  /**
   * After a restart, run the device until its catch-up is done before the next user action (default
   * false). Without it a user edit can land between restart and the torn-write re-apply (openIssues).
   */
  settleRestart?: boolean;
  /** Devices may exclude a folder and change that filter (default true). */
  excludedFolders?: boolean;
  /** Stop at the first failing checkpoint (default true). */
  stopOnFailure?: boolean;
}

export interface SimFailure { inv: string; step: number; detail: string }

export interface SimStats {
  commits: number; okOps: number; crashes: number; restarts: number; evictions: number; netFaults: number;
  conflictCopies: number; checkpoints: number; rebuilds: number; compactions: number; ledgerEntries: number; downloads: number;
}

export interface SimResult {
  seed: number; devices: number; steps: number;
  ok: boolean;
  failures: SimFailure[];
  /** First step whose checkpoint failed (replay with --steps <this>). */
  failStep: number | null;
  ms: number;
  /** sha256 over the trace, the commit log and the final server log: equal across replays of a seed. */
  traceHash: string;
  stats: SimStats;
  trace?: string[];
}

export const ACTIONS = [
  "editNote", "createNote", "editBoth", "createBoth", "deleteFile", "renameFile", "moveFolder", "deleteFolder",
  "writeBinary", "emptyNote", "oversize", "iterate", "iterateAll", "offline", "crash", "commitCrash", "tornWrite",
  "restart", "evict", "netFaults", "filterChange", "compact", "clockJump", "rebuild",
] as const;
export type ActionName = typeof ACTIONS[number];

export const DEFAULT_WEIGHTS: Readonly<Record<ActionName, number>> = {
  editNote: 20, createNote: 8, editBoth: 4, createBoth: 1.5, deleteFile: 4, renameFile: 5, moveFolder: 1.5, deleteFolder: 0.7,
  writeBinary: 4, emptyNote: 1, oversize: 0.5, iterate: 30, iterateAll: 6, offline: 3, crash: 3, commitCrash: 1, tornWrite: 1,
  restart: 2, evict: 0.4, netFaults: 2, filterChange: 0.6, compact: 0.5, clockJump: 1, rebuild: 0.15,
};

const FAULT_ACTIONS: ReadonlySet<ActionName> = new Set(["offline", "crash", "commitCrash", "tornWrite", "evict", "netFaults", "compact", "rebuild"]);
const FOLDERS = ["", "notes", "notes/sub", "proj", "private", "arch"];
const PRIVATE = "private";
/** Mobile devices get a small file cap so the oversize action is cheap (design §3.15 scope). */
const MOBILE_MAX_FILE = 64 * 1024;
const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

const isNote = (p: string): boolean => p.endsWith(".md");

/** Run one seed. Never throws for engine behavior: failures are returned. */
export async function runSim(o: SimOptions): Promise<SimResult> {
  const restore = installDeterministicRandom(new Prng(`rand-${o.seed}`));
  const restoreAsync = installDeterministicAsync(setMacrotaskHook);
  const sim = new Sim(o);
  const onUnhandled = (e: unknown): void => { sim.fail("unhandled", `unhandled rejection: ${errText(e)}`); };
  const proc = (globalThis as unknown as { process?: { on(ev: string, f: (e: unknown) => void): void; off(ev: string, f: (e: unknown) => void): void } }).process;
  proc?.on("unhandledRejection", onUnhandled);
  const t0 = Date.now();
  let ms = 0;
  try {
    await sim.run();
  } catch (e) {
    sim.fail("crash", `harness or engine threw: ${errText(e)}`);
  } finally {
    ms = Date.now() - t0;
    // Background work of this run (feed delivery, in-flight WebCrypto calls) must not run into the
    // next seed: it would draw from that seed's random stream and break bit-for-bit replay (design
    // §7.4). Stop every engine, then let the queued work finish before the stream is swapped back.
    await sim.teardown();
    await restoreAsync();
    proc?.off("unhandledRejection", onUnhandled);
    restore();
  }
  return sim.result(ms);
}

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? "\n" + e.stack.split("\n").slice(1, 6).join("\n") : ""}`;
  return String(e);
}

export class Sim {
  readonly prng: Prng;
  w!: SimWorld;
  devices: SimDevice[] = [];
  readonly ledger = new Ledger();
  evidence!: Evidence;
  readonly commits: CommitRecord[] = [];
  readonly netViolations: NetViolation[] = [];
  readonly guards: GuardRecord[] = [];
  readonly trace: string[] = [];
  /** Engine activity log and commits, interleaved with the trace when keepTrace is on (not hashed). */
  readonly detail: string[] = [];
  readonly failures: SimFailure[] = [];
  readonly weights: Record<ActionName, number>;
  readonly stats: SimStats = {
    commits: 0, okOps: 0, crashes: 0, restarts: 0, evictions: 0, netFaults: 0, conflictCopies: 0, checkpoints: 0, rebuilds: 0,
    compactions: 0, ledgerEntries: 0, downloads: 0,
  };
  step = 0;
  failStep: number | null = null;
  private seq = 0;
  /** Paths and folder prefixes the user touched since the last checkpoint (ghost / spontaneous-delete oracle). */
  private touched = new Map<string, Array<{ device: string; kind: 'write' | 'delete'; step: number }>>();
  private touchedFolders = new Set<string>();
  private rebuiltInWindow = false;
  /** Steps of remote rebuilds in this window. */
  private rebuiltAt: number[] = [];
  /**
   * Store evictions in this window and the step their rebuild finished (null: still running). A
   * delete made before a rebuild finished may come back: rebuild mode never deletes (§3.3.5, S26).
   */
  private evictions: Array<{ device: SimDevice; at: number; done: number | null }> = [];
  /**
   * Remote rebuilds and, per device, the step its epoch resync for that rebuild finished. A delete made
   * on a device that had not finished it yet is planned against the new epoch, where absence never
   * means delete (design §2.11 step 5, row C6 FORGET): the file may come back. Kept across windows
   * until every device caught up.
   */
  private rebuilds: Array<{ at: number; epoch: number; caught: Map<string, number> }> = [];
  /** Steps of server compactions in this window: a purged tombstone may come back (I21, S8/C5). */
  private compactedAt: number[] = [];
  /** Server live heads (path → hash and fileId) at the last checkpoint. */
  private lastHeads: Map<string, { hash: string; fileId: string }> | null = null;
  /** FileIds of files a deferred (out-of-scope) user action touched (exempt like `deferred` paths). */
  private deferredIds = new Set<string>();
  private violationsSeen = 0;

  constructor(readonly o: SimOptions) {
    this.prng = new Prng(o.seed);
    const faults = o.faults !== false;
    const w = { ...DEFAULT_WEIGHTS, ...(o.weights ?? {}) };
    if (!faults) for (const a of FAULT_ACTIONS) w[a] = 0;
    if (o.excludedFolders === false) w.filterChange = 0;
    this.weights = w;
  }

  fail(inv: string, detail: string): void {
    if (this.tornDown) return;
    this.failures.push({ inv, step: this.step, detail });
    if (this.failStep === null) this.failStep = this.step;
  }

  private log(entry: Record<string, unknown>): void {
    if (this.tornDown) return;
    const line = JSON.stringify({ s: this.step, ...entry });
    this.trace.push(line);
    if (this.o.keepTrace) this.detail.push(line);
  }

  /** Build the world and start every device (scripted scenarios call this, then drive the sim). */
  async setup(overrides: Array<Partial<SimDeviceConfig>> = []): Promise<void> {
    const setup = this.prng.fork("setup");
    this.w = await makeSimWorld(this.o.seed, setup.fork("world"));
    this.evidence = new Evidence(this.w.ring);
    // All per-device constants are drawn before any device code runs.
    const cfgs: SimDeviceConfig[] = [];
    for (let i = 0; i < this.o.devices; i++) {
      const mobile = i === 2 || (i > 2 && setup.bool(0.3));
      const excluded = setup.bool(0.3) && this.o.excludedFolders !== false ? [PRIVATE] : [];
      cfgs.push({
        name: NAMES[i] ?? `dev${i}`,
        platform: mobile ? "ios" : "desktop",
        offsetMs: Math.round((setup.float() * 2 - 1) * 36 * 3600 * 1000),
        drift: (setup.float() * 2 - 1) * 0.001,
        settings: { excludedFolders: excluded, ...(mobile ? { maxFileBytes: MOBILE_MAX_FILE } : {}) },
        ...(overrides[i] ?? {}),
      });
    }
    for (const cfg of cfgs) {
      const d = new SimDevice(this.w, cfg, setup.fork("dev-" + cfg.name), this.commits, this.netViolations, this.guards);
      this.devices.push(d);
      this.log({ a: "device", d: cfg.name, platform: cfg.platform, offsetMs: cfg.offsetMs, drift: cfg.drift, excluded: cfg.settings.excludedFolders });
    }
    if (this.o.keepTrace) {
      for (const d of this.devices) {
        d.logSink = (dev, key, params) => { this.detail.push(JSON.stringify({ s: this.step, d: dev, log: key, ...params })); };
      }
      let n = 0;
      const commits = this.commits;
      const push = commits.push.bind(commits);
      commits.push = (...cs: CommitRecord[]): number => {
        for (const c of cs) this.detail.push(JSON.stringify({ s: this.step, commit: n++, ...c }));
        return push(...cs);
      };
    }
    for (const d of this.devices) await d.start();
  }

  /** Set once the run is over: background work of the stopped engines no longer counts. */
  private tornDown = false;

  /** End of run: stop every engine and let their in-flight work drain (see runSim). */
  async teardown(): Promise<void> {
    this.tornDown = true;
    for (const d of this.devices) await d.shutdown();
  }

  async run(): Promise<void> {
    await this.setup();
    const every = this.o.checkEvery ?? 100;
    const stop = this.o.stopOnFailure !== false;
    for (this.step = 1; this.step <= this.o.steps; this.step++) {
      for (const d of this.devices) d.step = this.step;
      this.w.clock.tick(this.prng.range(10, 3000));
      const a = this.pickAction();
      await this.act(a);
      this.onlineChecks();
      if (stop && this.failures.length) return;
      if (every > 0 && this.step % every === 0 && this.step < this.o.steps) {
        await this.checkpoint();
        if (stop && this.failures.length) return;
      }
    }
    this.step = this.o.steps;
    await this.checkpoint();
  }

  private pickAction(): ActionName {
    let total = 0;
    for (const a of ACTIONS) total += this.weights[a];
    let x = this.prng.float() * total;
    for (const a of ACTIONS) {
      x -= this.weights[a];
      if (x < 0) return a;
    }
    return "iterate";
  }

  private dev(): SimDevice {
    return this.prng.pick(this.devices);
  }

  /** Device for a user action (alive only when editWhileDown is off). */
  private userDev(): SimDevice | null {
    const pool = this.o.editWhileDown === false ? this.devices.filter((d) => !d.dead) : this.devices;
    return pool.length ? this.prng.pick(pool) : null;
  }

  private userPair(): [SimDevice, SimDevice] | null {
    const pool = this.o.editWhileDown === false ? this.devices.filter((d) => !d.dead) : this.devices;
    if (pool.length < 2) return null;
    const [a, b] = this.prng.shuffle(pool);
    return [a!, b!];
  }

  private userFiles(d: SimDevice, pred: (p: string) => boolean = () => true): string[] {
    return [...d.fs.files().keys()].filter(pred);
  }

  /** Union-find over paths a user rename linked in this window: one file identity, several names. */
  private family = new Map<string, string>();

  private root(p: string): string {
    let r = p;
    for (let n = this.family.get(r); n !== undefined && n !== r; n = this.family.get(r)) r = n;
    return r;
  }

  private link(a: string, b: string): void {
    const ra = this.root(a), rb = this.root(b);
    if (ra !== rb) this.family.set(rb, ra);
    if (!this.family.has(ra)) this.family.set(ra, ra);
  }

  /** Every action on any name of the file now at `p` (renames followed) in this window. */
  private actionsOf(p: string): Array<{ device: string; kind: 'write' | 'delete'; step: number }> {
    if (!this.family.has(p)) return this.touched.get(p) ?? [];
    const r = this.root(p);
    const out: Array<{ device: string; kind: 'write' | 'delete'; step: number }> = [];
    for (const [q, acts] of this.touched) if (this.family.has(q) && this.root(q) === r) out.push(...acts);
    return out.sort((x, y) => x.step - y.step);
  }

  /**
   * Paths (and folder prefixes) a user changed while they were out of the acting device's scope. Such
   * an action reaches the remote only when the scope changes back (S11), possibly many windows later,
   * so these paths are exempt from the ghost and spontaneous-change checks for the rest of the run.
   */
  private deferred = new Set<string>();

  private noteScope(d: SimDevice, path: string): void {
    if (d.scopeOf(path, 0) !== "active") this.deferred.add(path);
  }

  /**
   * Oracle rule (lead review needed): a user change made in scope but not yet pushed when the device
   * excludes its folder stays local while excluded (design v1-design.md line 1425: excluded → `NOOP`
   * both directions, never push) and is pushed when the folder comes back (line 2036, I12: re-enabling
   * restores 3-way behaviour, bases kept). That push lands in a later checkpoint window than the
   * action, so the path is exempt like an out-of-scope action. Unpushed = the disk differs from the
   * remote head and from what the engine last synced at that path (a remote change the device has not
   * pulled yet is not exempt).
   */
  private async deferUnpushed(d: SimDevice, folder: string): Promise<void> {
    if (d.dead) return;
    const under = (p: string): boolean => p.startsWith(folder + "/");
    const heads = await this.serverHeads();
    const disk = new Map<string, string>();
    for (const [p, bytes] of d.fs.files()) if (under(p)) disk.set(p, await sha256Hex(bytes));
    const paths = new Set<string>([...disk.keys(), ...[...heads.keys()].filter(under)]);
    for (const p of paths) {
      const local = disk.get(p) ?? null;
      const head = heads.get(p)?.hash ?? null;
      if (local === head) continue;
      const e = d.engine.index?.byPath(p) ?? null;
      const synced = e?.synced && e.synced.path === p ? e.synced.hash : null;
      if (local !== null && local === synced) continue;
      if (local === null && e === null) continue;
      this.deferred.add(p);
    }
  }

  private isDeferred(p: string): boolean {
    for (const f of this.deferred) if (p === f || p.startsWith(f + "/")) return true;
    return false;
  }

  private touch(path: string, device: string, kind: 'write' | 'delete'): void {
    const d = this.devices.find((x) => x.name === device);
    if (d) this.noteScope(d, path);
    let l = this.touched.get(path);
    if (!l) this.touched.set(path, (l = []));
    l.push({ device, kind, step: this.step });
  }

  private freshName(ext: string): string {
    const folder = this.prng.pick(FOLDERS);
    const name = `f${++this.seq}${ext}`;
    return folder ? `${folder}/${name}` : name;
  }

  // ---------------------------------------------------------------- user actions

  /** A user write (ledger, evidence cache, fs event, ghost bookkeeping). */
  async userWrite(d: SimDevice, path: string, next: Uint8Array): Promise<void> {
    const prev = d.fs.exists(path) ? (d.fs.files({ includeConfigDir: true }).get(path) ?? null) : null;
    // A real edit moves mtime: scripted scenarios write several times without other clock movement,
    // and a same-size rewrite with the same mtime is invisible to the stat fast path (design §3.6).
    this.w.clock.tick(1);
    await this.ledger.write(d.name, path, prev, next, this.step, isNote(path));
    await this.evidence.remember(next);
    d.fs.external.write(path, next);
    this.touch(path, d.name, "write");
  }

  /** Restart a device; with settleRestart, run it until its catch-up is done before the user acts. */
  async restartDev(d: SimDevice, evict = false): Promise<void> {
    await d.restart({ evict });
    if (!this.o.settleRestart) return;
    for (let i = 0; i < 4 && !d.dead && d.engine.status().status === "syncing"; i++) {
      this.w.clock.tick(1000);
      await d.iterate();
    }
  }

  /** Server compaction up to `upTo` (retention/purge model of the fake, design §2.7.1). */
  async compact(upTo: number): Promise<{ removed: number; purgedFiles: number }> {
    await this.evidence.capture(this.w.server);
    this.compactedAt.push(this.step);
    return this.w.server.expire(upTo);
  }

  /** A user delete of a file or folder. */
  async userRemove(d: SimDevice, path: string): Promise<void> {
    for (const [p, b] of d.fs.files({ includeConfigDir: true })) if (p === path || p.startsWith(path + "/")) await this.ledger.retireContent(b);
    const folder = !d.fs.files({ includeConfigDir: true }).has(path);
    d.fs.external.remove(path);
    if (folder) {
      this.touchedFolders.add(path);
      this.noteScope(d, path);
    } else this.touch(path, d.name, "delete");
  }

  /** A user rename of a file or folder. */
  userRename(d: SimDevice, from: string, to: string): void {
    const folder = !d.fs.files({ includeConfigDir: true }).has(from);
    d.fs.external.rename(from, to);
    if (folder) {
      this.touchedFolders.add(from);
      this.touchedFolders.add(to);
      this.noteScope(d, from);
      this.noteScope(d, to);
      return;
    }
    this.link(from, to);
    this.touch(from, d.name, "delete");
    this.touch(to, d.name, "write");
  }

  /** A note of `n` fresh token lines (ledger-tracked once written). */
  noteOf(n: number): Uint8Array {
    return noteBytes(Array.from({ length: n }, () => this.ledger.token()));
  }

  private editedNote(prev: Uint8Array | null): Uint8Array {
    const lines = noteLines(prev);
    const r = this.prng.int(4);
    if (lines.length === 0 || r === 0) lines.push(this.ledger.token());
    else if (r === 1) lines.splice(this.prng.int(lines.length + 1), 0, this.ledger.token());
    else if (r === 2) lines.splice(this.prng.int(lines.length), 1);
    else lines[this.prng.int(lines.length)] = this.ledger.token();
    return noteBytes(lines);
  }

  private async editNote(d: SimDevice, path?: string): Promise<string | null> {
    const notes = this.userFiles(d, isNote);
    const p = path ?? (notes.length ? this.prng.pick(notes) : null);
    if (!p) return null;
    const prev = d.fs.files().get(p) ?? null;
    await this.userWrite(d, p, this.editedNote(prev));
    return p;
  }

  private async act(a: ActionName): Promise<void> {
    switch (a) {
      case "editNote": {
        const d = this.userDev();
        if (!d) return;
        const p = await this.editNote(d);
        if (p) this.log({ a, d: d.name, p });
        return;
      }
      case "createNote": {
        const d = this.userDev();
        if (!d) return;
        const p = this.freshName(".md");
        const lines = Array.from({ length: this.prng.range(1, 6) }, () => this.ledger.token());
        await this.userWrite(d, p, noteBytes(lines));
        this.log({ a, d: d.name, p });
        return;
      }
      case "editBoth": {
        const pair = this.userPair();
        if (!pair) return;
        const [d1, d2] = pair;
        const both = this.userFiles(d1, (p) => isNote(p) && d2.fs.exists(p));
        if (!both.length) return;
        const p = this.prng.pick(both);
        await this.editNote(d1, p);
        await this.editNote(d2, p);
        this.log({ a, d: [d1.name, d2.name], p });
        return;
      }
      case "createBoth": {
        const pair = this.userPair();
        if (!pair) return;
        const [d1, d2] = pair;
        const p = this.freshName(".md");
        for (const d of [d1, d2]) await this.userWrite(d, p, noteBytes([this.ledger.token(), this.ledger.token()]));
        this.log({ a, d: [d1.name, d2.name], p });
        return;
      }
      case "deleteFile": {
        const d = this.userDev();
        if (!d) return;
        const fs = this.userFiles(d);
        if (!fs.length) return;
        const p = this.prng.pick(fs);
        await this.ledger.retireContent(d.fs.files().get(p)!);
        d.fs.external.remove(p);
        this.touch(p, d.name, "delete");
        this.log({ a, d: d.name, p });
        return;
      }
      case "renameFile": {
        const d = this.userDev();
        if (!d) return;
        const fs = this.userFiles(d);
        if (!fs.length) return;
        const from = this.prng.pick(fs);
        const ext = from.slice(from.lastIndexOf("."));
        const to = this.freshName(ext);
        if (d.fs.exists(to)) return;
        d.fs.external.rename(from, to);
        this.link(from, to);
        this.touch(from, d.name, "delete");
        this.touch(to, d.name, "write");
        this.log({ a, d: d.name, from, to });
        return;
      }
      case "moveFolder": {
        const d = this.userDev();
        if (!d) return;
        const folders = new Set<string>();
        for (const p of this.userFiles(d)) {
          const parts = p.split("/");
          for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
        }
        if (!folders.size) return;
        const from = this.prng.pick([...folders].sort());
        const parent = this.prng.pick(["", "arch", PRIVATE].filter((x) => x !== from && !x.startsWith(from + "/")));
        const to = (parent ? parent + "/" : "") + `dir${++this.seq}`;
        if (d.fs.exists(to)) return;
        d.fs.external.rename(from, to);
        this.touchedFolders.add(from);
        this.touchedFolders.add(to);
        this.noteScope(d, from);
        this.noteScope(d, to);
        this.log({ a, d: d.name, from, to });
        return;
      }
      case "deleteFolder": {
        const d = this.userDev();
        if (!d) return;
        const folders = new Set<string>();
        for (const p of this.userFiles(d)) if (p.includes("/")) folders.add(p.slice(0, p.indexOf("/")));
        if (!folders.size) return;
        const f = this.prng.pick([...folders].sort());
        for (const [p, b] of d.fs.files()) if (p.startsWith(f + "/")) await this.ledger.retireContent(b);
        d.fs.external.remove(f);
        this.touchedFolders.add(f);
        this.noteScope(d, f);
        this.log({ a, d: d.name, p: f });
        return;
      }
      case "writeBinary": {
        const d = this.userDev();
        if (!d) return;
        const bins = this.userFiles(d, (p) => p.endsWith(".png"));
        const p = bins.length && this.prng.bool(0.5) ? this.prng.pick(bins) : this.freshName(".png");
        await this.userWrite(d, p, this.prng.bytes(this.prng.bool(0.3) ? this.prng.range(5000, 40000) : this.prng.range(1, 3000)));
        this.log({ a, d: d.name, p });
        return;
      }
      case "emptyNote": {
        const d = this.userDev();
        if (!d) return;
        const p = this.freshName(".md");
        await this.userWrite(d, p, new Uint8Array(0));
        this.log({ a, d: d.name, p });
        return;
      }
      case "oversize": {
        const d = this.userDev();
        if (!d) return;
        const p = this.freshName(".pdf");
        await this.userWrite(d, p, this.prng.bytes(MOBILE_MAX_FILE + this.prng.range(1, 8000)));
        this.log({ a, d: d.name, p });
        return;
      }
      case "iterate": {
        const d = this.dev();
        await d.iterate();
        this.log({ a, d: d.name, dead: d.dead });
        return;
      }
      case "iterateAll": {
        for (const d of this.devices) await d.iterate();
        this.log({ a });
        return;
      }
      case "offline": {
        const d = this.dev();
        d.setOnline(d.net.offline);
        this.log({ a, d: d.name, offline: d.net.offline });
        return;
      }
      case "crash": case "commitCrash": case "tornWrite": {
        const d = this.dev();
        if (d.dead) return;
        if (a === "crash") d.armCrash(this.prng.range(1, 40));
        else if (a === "commitCrash") d.armCommitCrash(this.prng.range(1, 6));
        else d.armTornWrite(this.prng.float());
        await d.iterate();
        d.disarm();
        if (d.dead) this.stats.crashes++;
        this.log({ a, d: d.name, dead: d.dead });
        return;
      }
      case "restart": {
        const dead = this.devices.filter((d) => d.dead);
        const d = dead.length ? this.prng.pick(dead) : this.dev();
        await this.restartDev(d);
        this.stats.restarts++;
        this.log({ a, d: d.name });
        return;
      }
      case "evict": {
        const d = this.dev();
        this.evictions.push({ device: d, at: this.step, done: null });
        await this.restartDev(d, true);
        this.stats.evictions++;
        this.log({ a, d: d.name });
        return;
      }
      case "netFaults": {
        const d = this.dev();
        const on = this.prng.bool(0.6);
        const rates: NetFaultRates = on
          ? { dropRequest: this.prng.float() * 0.15, dropResponse: this.prng.float() * 0.15, duplicate: this.prng.float() * 0.2, serverError: this.prng.float() * 0.05 }
          : NO_FAULTS;
        d.net.rates = rates;
        this.log({ a, d: d.name, on });
        return;
      }
      case "filterChange": {
        const d = this.dev();
        if (d.dead) return;
        const ex = d.engine.settings.excludedFolders.length ? [] : [PRIVATE];
        if (ex.length) await this.deferUnpushed(d, PRIVATE);
        d.settings = { ...d.settings, excludedFolders: ex };
        try {
          await d.engine.updateSettings({ excludedFolders: ex });
        } catch (e) {
          if (!isCrashLike(e)) throw e;
          d.kill();
        }
        this.log({ a, d: d.name, excluded: ex });
        return;
      }
      case "compact": {
        const srv = this.w.server;
        const head = srv.headSeq;
        if (head < 5 || head - 1 < Math.max(1, srv.minSeq)) return;
        const upTo = this.prng.range(Math.max(1, srv.minSeq), head - 1);
        const r = await this.compact(upTo);
        this.stats.compactions++;
        this.log({ a, upTo, removed: r.removed, purged: r.purgedFiles });
        return;
      }
      case "clockJump": {
        this.w.clock.tick(this.prng.range(3600_000, 2 * 86400_000));
        this.log({ a });
        return;
      }
      case "rebuild": {
        const cands = this.devices.filter((d) => !d.dead && !d.net.offline && d.engine.isConnected() && d.engine.settings.excludedFolders.length > 0);
        if (!cands.length) return;
        const d = this.prng.pick(cands);
        await this.evidence.capture(this.w.server);
        try {
          await d.engine.rebuildRemote({ confirmFiltered: true });
          this.stats.rebuilds++;
          this.rebuiltInWindow = true;
          this.rebuiltAt.push(this.step);
          this.rebuilds.push({ at: this.step, epoch: d.engine.helloContext().epoch ?? 0, caught: new Map() });
          this.log({ a, d: d.name, ok: true });
        } catch (e) {
          this.log({ a, d: d.name, ok: false, err: e instanceof Error ? e.name : "?" });
        }
        await this.w.server.settle();
        return;
      }
    }
  }

  // ---------------------------------------------------------------- oracles

  /** Checks that hold after every step (cheap). */
  private onlineChecks(): void {
    for (const e of this.evictions) {
      const d = e.device;
      if (e.done === null && !d.dead && d.engine.isConnected() && d.engine.ctx.mode === "incremental" && d.engine.status().status === "synced") e.done = this.step;
    }
    for (const r of this.rebuilds) {
      for (const d of this.devices) {
        // "synced" also rules out a pending epoch resync (the seen epoch moves at connect, before it).
        if (r.caught.has(d.name) || d.dead || !d.engine.isConnected() || d.engine.ctx.mode !== "incremental" || d.engine.status().status !== "synced") continue;
        if ((d.engine.helloContext().epoch ?? 0) >= r.epoch && this.step > r.at) r.caught.set(d.name, this.step);
      }
    }
    for (let i = this.violationsSeen; i < this.netViolations.length; i++) {
      const v = this.netViolations[i]!;
      this.fail(v.inv, v.detail);
    }
    this.violationsSeen = this.netViolations.length;
    for (const d of this.devices) {
      const b = d.budgetPeaks;
      // I24: in-flight blob bytes stay under the cap, except one item admitted alone (≤ maxFileBytes).
      if (b.bytes > Math.max(b.bytesCap, b.largestAlone)) this.fail("I24", `${d.name}: in-flight ${b.bytes} > cap ${b.bytesCap} (largest alone ${b.largestAlone})`);
      if (b.largestAlone > b.maxFileBytes) this.fail("I24", `${d.name}: item of ${b.largestAlone} admitted alone > maxFileBytes ${b.maxFileBytes}`);
      if (b.upload > b.uploadCap) this.fail("I24", `${d.name}: ${b.upload} concurrent uploads > ${b.uploadCap}`);
      if (b.download > b.downloadCap) this.fail("I24", `${d.name}: ${b.download} concurrent downloads > ${b.downloadCap}`);
    }
    for (const g of this.guards) {
      if (g.kind === "tampered" || g.kind === "integrity") {
        this.fail("guard", `${g.device} raised ${g.kind} at step ${g.step}`);
        g.kind = `${g.kind}(reported)`;
      }
    }
  }

  /** Heal, run until quiet; false if the devices never go quiet. */
  async quiesce(maxRounds = 60): Promise<boolean> {
    for (const d of this.devices) await d.heal();
    // The periodic fast scan (design §3.14) is part of "every loop ran": manual mode has no timers.
    for (const d of this.devices) d.engine.requestScan("fast");
    let quiet = 0;
    for (let round = 0; round < maxRounds; round++) {
      let work = 0;
      for (const d of this.devices) {
        if (d.dead) {
          await d.restart();
          work++;
        }
        work += await d.iterate();
      }
      const busy = this.devices.some((d) => {
        if (d.dead) return true;
        const s = d.engine.status();
        return s.status === "syncing" || s.pendingUp > 0 || s.pendingDown > 0;
      });
      if (work === 0 && !busy) {
        if (++quiet >= 2) return true;
        continue;
      }
      quiet = 0;
      // Backed-off ops and catch-up waits need fake time.
      if (work === 0) this.w.clock.tick(10 * 60 * 1000);
    }
    return false;
  }

  /** Live server heads: path → hash, plus the size for per-device scope. */
  private async serverHeads(): Promise<Map<string, { hash: string; size: number; fileId: string }>> {
    const out = new Map<string, { hash: string; size: number; fileId: string }>();
    for (const rec of this.w.server.inspect().heads) {
      if (rec.kind !== "put") continue;
      const h = (await decodeRecord(this.w.ring, rec)).head;
      if (h && h.contentHash !== null) out.set(h.path, { hash: h.contentHash, size: h.size, fileId: h.fileId });
    }
    return out;
  }

  async checkpoint(): Promise<void> {
    this.stats.checkpoints++;
    const quietOk = await this.quiesce();
    this.onlineChecks();
    if (!quietOk) {
      const st = this.devices.map((d) => `${d.name}:${d.dead ? "dead" : JSON.stringify(d.engine.status())}`).join(" ");
      this.fail("liveness", `devices did not go quiet: ${st}`);
    }
    const heads = await this.serverHeads();

    // I7: each device's active map equals the server heads in that device's scope.
    for (const d of this.devices) {
      const disk = await d.activeMap();
      const diffs: string[] = [];
      for (const [p, h] of disk) {
        const r = heads.get(p);
        if (!r) diffs.push(`${p} only on ${d.name}`);
        else if (r.hash !== h) diffs.push(`${p} differs on ${d.name}`);
      }
      for (const [p, r] of heads) {
        if (d.scopeOf(p, r.size) !== "active") continue;
        if (!disk.has(p)) diffs.push(`${p} missing on ${d.name}`);
      }
      if (diffs.length) this.fail("I7", diffs.slice(0, 8).join("; ") + (diffs.length > 8 ? ` (+${diffs.length - 8})` : ""));
      if (!d.dead) {
        const s = d.engine.status();
        if (s.pendingUp || s.pendingDown) this.fail("I7", `${d.name} not idle after quiet: up ${s.pendingUp} down ${s.pendingDown}`);
      }
    }

    // I1 / I4 on committed state.
    const log = new Map<number, VersionRecord>(this.w.server.inspect().log.map((r) => [r.seq, r]));
    for (const d of this.devices) {
      const dump = d.store.dump() as unknown as { files?: FileEntry[]; journal?: Op[] };
      const ids = new Set<string>();
      for (const op of (dump.journal ?? []).filter((x) => x.kind !== "archive")) {
        if (ids.has(op.fileId)) this.fail("I4", `${d.name}: two journal ops for ${op.fileId}`);
        ids.add(op.fileId);
      }
      for (const e of dump.files ?? []) {
        // Out-of-scope entries keep their old base on purpose (S11); retention may drop that record.
        if (!e.synced || e.scope !== "active") continue;
        const r = log.get(e.synced.version);
        if (!r || r.fileId !== e.fileId) { this.fail("I1", `${d.name}: ${e.fileId} synced at ${e.synced.version}, no such record`); continue; }
        const h = (await decodeRecord(this.w.ring, r)).head;
        if (h?.contentHash !== e.synced.hash) this.fail("I1", `${d.name}: ${e.fileId} synced hash differs from record ${r.seq}`);
      }
    }

    // I16: after quiet, a full rescan everywhere commits nothing.
    const before = this.commits.length;
    for (const d of this.devices) d.engine.requestScan("full");
    for (let i = 0; i < 2; i++) for (const d of this.devices) await d.iterate();
    const echo = this.commits.slice(before);
    if (echo.length) this.fail("I16", `commits after quiet: ${echo.map((c) => `${c.device}[${c.kinds.join(",")}]`).join(" ")}`);

    // I6: every live ledger entry is somewhere.
    await this.evidence.capture(this.w.server);
    const tokens = new Set(this.evidence.serverTokens);
    const hashes = new Set(this.evidence.serverHashes);
    for (const d of this.devices) {
      const items: Uint8Array[] = [...d.fs.files({ includeConfigDir: true }).values()];
      for (const t of d.fs.trash) if (t.bytes) items.push(t.bytes);
      for (const b of items) {
        hashes.add(await this.evidence.remember(b));
        for (const t of tokensOf(b)) tokens.add(t);
      }
    }
    const lost = this.ledger.live().filter((e) => (e.kind === "token" ? !tokens.has(e.value) : !hashes.has(e.value)));
    if (lost.length) {
      this.fail("I6", `${lost.length} user edits lost: ` + lost.slice(0, 6).map((e) => `${e.kind === "token" ? e.value : e.value.slice(0, 12)} (${e.device} ${e.path} step ${e.step})`).join("; "));
    }

    // Ghosts and spontaneous deletes (I17, I28): judged against the previous checkpoint.
    const underTouched = (p: string): boolean => [...this.touchedFolders].some((f) => p === f || p.startsWith(f + "/"));
    for (const p of this.touched.keys()) {
      if (underTouched(p) || this.isDeferred(p)) continue;
      const acts = this.actionsOf(p);
      const devs = new Set(acts.map((x) => x.device));
      const last = acts[acts.length - 1]!;
      const actor = this.devices.find((d) => d.name === last.device)!;
      // A delete by one device alone, in its active scope, must stay deleted everywhere (no ghost).
      // A store eviction after the delete (on the deleter, or on a device that had not applied it yet)
      // rebuilds without a base: rebuild mode never deletes, so the file may come back (§3.3.5, S26).
      // A remote rebuild after the delete drops its tombstone: devices that had not applied the delete
      // re-create the file in epoch mode, never delete (design §2.11 step 5, rows S8/C5).
      const evicted = this.evictions.some((e) => (e.done ?? Infinity) >= last.step) || this.compactedAt.some((c) => c >= last.step) ||
        this.rebuiltAt.some((r) => r >= last.step) ||
        this.rebuilds.some((r) => r.at <= last.step && (r.caught.get(last.device) ?? Infinity) >= last.step);
      if (devs.size === 1 && last.kind === "delete" && !evicted && heads.has(p) && actor.scopeOf(p, heads.get(p)!.size) === "active") {
        this.fail("ghost", `${p} deleted on ${last.device} is back`);
      }
    }
    // A deferred (out-of-scope) action follows the file, not the path: a remote move may carry the file
    // to a path the deferral never named before the action reaches the remote (S11).
    for (const [p, h] of [...(this.lastHeads ?? new Map()), ...heads]) if (this.isDeferred(p)) this.deferredIds.add(h.fileId);
    if (this.lastHeads) {
      for (const [p, prev] of this.lastHeads) {
        if (this.touched.has(p) || underTouched(p) || this.isDeferred(p) || this.deferredIds.has(prev.fileId)) continue;
        const h = prev.hash;
        const now = heads.get(p);
        if (now && now.hash === h) continue;
        // After a rebuild from a filtered device, files nobody holds in scope may leave the epoch (§2.11).
        if (this.rebuiltInWindow && !this.devices.some((d) => d.scopeOf(p, 0) === "active" && d.fs.exists(p))) continue;
        this.fail(now ? "spontaneous-change" : "spontaneous-delete", `${p} ${now ? "changed" : "vanished"} without a user action`);
      }
    }
    this.lastHeads = new Map([...heads].map(([p, r]) => [p, { hash: r.hash, fileId: r.fileId }]));
    this.touched = new Map();
    this.family = new Map();
    this.touchedFolders = new Set();
    this.rebuiltInWindow = false;
    this.rebuiltAt = [];
    this.rebuilds = this.rebuilds.filter((r) => r.caught.size < this.devices.length);
    this.compactedAt = [];
    this.evictions = [];
    this.log({ a: "checkpoint", heads: heads.size, ledger: this.ledger.entries.size });
  }

  async result(ms: number): Promise<SimResult> {
    const s = this.stats;
    s.commits = this.commits.length;
    s.okOps = this.commits.reduce((n, c) => n + c.okOps, 0);
    s.netFaults = this.devices.reduce((n, d) => n + d.net.faults.length, 0);
    s.ledgerEntries = this.ledger.entries.size;
    s.downloads = this.evidence?.downloads ?? 0;
    let copies = 0;
    for (const d of this.devices) for (const p of d.fs.files().keys()) if (p.includes("Conflicted copy")) copies++;
    s.conflictCopies = copies;
    const parts = [...this.trace, ...this.commits.map((c) => `${c.device}|${c.step}|${c.kinds.join(",")}|${c.okOps}|${c.replayed}`)];
    if (this.w) for (const r of this.w.server.inspect().log) parts.push(`${r.seq}|${r.kind}|${r.fileId}|${r.pathKey}|${r.blobs.join(",")}`);
    const traceHash = await sha256Hex(new TextEncoder().encode(parts.join("\n")));
    const res: SimResult = {
      seed: this.o.seed, devices: this.o.devices, steps: this.o.steps, ok: this.failures.length === 0, failures: this.failures,
      failStep: this.failStep, ms, traceHash, stats: s,
    };
    if (this.o.keepTrace) res.trace = this.detail;
    return res;
  }
}

/** The command that replays a seed (printed for every failure). */
export function replayCommand(r: Pick<SimResult, 'seed' | 'devices' | 'steps'>, extra = ""): string {
  return `npm run sim -w @shuttle/sim -- --seed ${r.seed} --devices ${r.devices} --steps ${r.steps}${extra}`;
}

/**
 * Shrink a failing seed: the smallest step count that still fails with the same first invariant (the
 * action stream of a shorter run is a prefix of the longer one). Binary search, so it assumes the
 * failure, once present, stays; the result is always a verified failing run.
 */
export async function shrinkSteps(o: SimOptions, failing: SimResult): Promise<SimResult> {
  const inv = failing.failures[0]?.inv;
  const same = (r: SimResult): boolean => !r.ok && r.failures[0]?.inv === inv;
  let best = failing;
  let lo = 1, hi = failing.failStep ?? o.steps;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await runSim({ ...o, steps: mid });
    if (same(r)) { best = r; hi = Math.min(mid, r.failStep ?? mid); } else lo = mid + 1;
  }
  if (best.steps !== hi) {
    const r = await runSim({ ...o, steps: hi });
    if (same(r)) best = r;
  }
  return best;
}

