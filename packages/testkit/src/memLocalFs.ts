// In-memory LocalFs (design §3.2) with fault injection and an event stream (ops-spec §3 SimDevice:
// torn reads, ENOENT between list and read, write failures, dropped or merged events,
// case-insensitive mode).
//
// Two ways to change the tree:
//  - the LocalFs methods (what the engine calls), and
//  - `external.*` (the user, another app, a sync of the vault folder by other means).
// Both emit LocalEvents by default, as real platforms do for the engine's own writes too (echo
// suppression, design §3.6.2, exists because of that). Events are delivered asynchronously
// (one microtask each, in order) so a listener never runs inside the call that caused it.

import type {
  Clock, Disposable, LocalEvent, LocalFs, LocalFsErrorCode, LocalPlatform, LocalStat, RemoveMode,
} from "@shuttle/protocol";
import { FakeClock } from "./clock";

export class LocalFsError extends Error {
  readonly code: LocalFsErrorCode;
  readonly path: string;
  constructor(code: LocalFsErrorCode, path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    this.name = "LocalFsError";
    this.code = code;
    this.path = path;
  }
}

export function isLocalFsError(e: unknown, code?: LocalFsErrorCode): e is LocalFsError {
  return e instanceof LocalFsError && (code === undefined || e.code === code);
}

export type FsOp = 'list' | 'stat' | 'read' | 'write' | 'rename' | 'remove' | 'mkdir' | 'rmdir' | 'processText';

interface FileNode { kind: 'file'; name: string; bytes: Uint8Array; mtime: number; ctime: number; ino: number }
interface FolderNode { kind: 'folder'; name: string; mtime: number; ctime: number; ino: number }
type Node = FileNode | FolderNode;

export interface TrashedItem { path: string; kind: 'file' | 'folder'; bytes?: Uint8Array; at: number }

export interface MemLocalFsOptions {
  platform?: LocalPlatform;
  caseInsensitive?: boolean;
  configDir?: string;
  clock?: Clock;
  /** Stats per listAll() batch. */
  listBatch?: number;
  /** Emit events for the engine's own writes, renames and removes (default true). */
  emitOwnEvents?: boolean;
  /** A folder rename/delete emits one event per contained file as well (default false: one folder event). */
  expandFolderEvents?: boolean;
  /** write() creates missing parent folders (default false: ENOENT, like a plain fs.writeFile). */
  writeCreatesParents?: boolean;
}

interface PendingFault { op: FsOp; code: LocalFsErrorCode; path?: string; skip: number }

/** A non-atomic write that stops part-way (ops-spec §3 SimDevice "torn write"). */
export interface TearSpec {
  /** Only writes to this path (default: any write). */
  path?: string;
  /** Bytes of the new content that reach the disk (default: half, rounded down). */
  keep?: number;
  /** Fraction of the new content that reaches the disk (used when `keep` is absent). */
  fraction?: number;
  /**
   * Skip this many matching writes first. A write to an engine replace temp in the folder of `path`
   * matches too (D8: the engine writes `path` through such a temp).
   */
  skip?: number;
  /**
   * Called after the prefix is on disk, before the write fails (e.g. kill the state store to model
   * a process death mid-write). If it throws, that error is what the write throws.
   */
  onTear?: (path: string) => void;
  /** Error code of the failed write when onTear does not throw (default EIO). */
  code?: LocalFsErrorCode;
}
type BeforeHook = (op: FsOp, path: string) => void | Promise<void>;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

function nfc(p: string): string {
  return p.normalize("NFC");
}
/**
 * Basename prefix of the engine's replace temps (lead decision D8; engine apply/replaceFile.ts, which
 * testkit cannot import). A rename from such a name may replace an existing file.
 */
export const REPLACE_TEMP_PREFIX = ".shuttle-replace-";

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function checkPath(p: string): void {
  if (p === "" || p.startsWith("/") || p.endsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new LocalFsError("EIO", p, `invalid vault path: ${JSON.stringify(p)}`);
  }
}

export class MemLocalFs implements LocalFs {
  readonly platform: LocalPlatform;
  readonly caseInsensitive: boolean;
  readonly configDir: string;
  readonly clock: Clock;
  private readonly listBatch: number;
  private readonly expandFolderEvents: boolean;
  private readonly writeCreatesParents: boolean;
  emitOwnEvents: boolean;

  private nodes = new Map<string, Node>();
  private nextIno = 1;
  private listeners = new Set<(e: LocalEvent) => void>();
  private faults: PendingFault[] = [];
  private tears: TearSpec[] = [];
  /** Every torn write so far: path and the prefix length left on disk. */
  readonly torn: Array<{ path: string; kept: number; of: number }> = [];
  private beforeHooks: BeforeHook[] = [];
  private eventsPaused = false;
  private heldEvents: LocalEvent[] = [];
  private dropPredicate: ((e: LocalEvent) => boolean) | null = null;
  private dropCount = 0;
  /** Removed with mode 'trash' (newest last). */
  readonly trash: TrashedItem[] = [];
  /** Every event emitted (after drop filtering), for assertions. */
  readonly eventLog: LocalEvent[] = [];
  readonly stats = { reads: 0, writes: 0, stats: 0, lists: 0, renames: 0, removes: 0 };

  constructor(o: MemLocalFsOptions = {}) {
    this.platform = o.platform ?? "node";
    this.caseInsensitive = o.caseInsensitive ?? false;
    this.configDir = o.configDir ?? ".obsidian";
    this.clock = o.clock ?? new FakeClock();
    this.listBatch = o.listBatch ?? 500;
    this.emitOwnEvents = o.emitOwnEvents ?? true;
    this.expandFolderEvents = o.expandFolderEvents ?? false;
    this.writeCreatesParents = o.writeCreatesParents ?? false;
  }

  // ---------- keys ----------

  private key(p: string): string {
    const n = nfc(p);
    return this.caseInsensitive ? n.toLowerCase() : n;
  }
  private get(p: string): Node | undefined {
    return this.nodes.get(this.key(p));
  }
  private toStat(n: Node): LocalStat {
    return {
      path: nfc(n.name), kind: n.kind, size: n.kind === "file" ? n.bytes.length : 0,
      mtime: n.mtime, ctime: n.ctime, ino: n.ino, ctimeMs: n.ctime,
    };
  }
  private children(p: string): Node[] {
    const prefix = this.key(p) + "/";
    return [...this.nodes.entries()].filter(([k]) => k.startsWith(prefix)).map(([, n]) => n);
  }

  // ---------- fault injection ----------

  /** The next `op` (optionally only on `path`), after skipping `skip` matches, throws `code`. */
  failNext(op: FsOp, code: LocalFsErrorCode, o: { path?: string; skip?: number } = {}): void {
    const f: PendingFault = { op, code, skip: o.skip ?? 0 };
    if (o.path !== undefined) f.path = o.path;
    this.faults.push(f);
  }

  /**
   * Run `hook` before every operation (after the fault check). Use it for torn reads (change the file
   * between stat and read) or ENOENT between list and read (remove it before the read).
   * Returns a Disposable that removes the hook.
   */
  before(hook: BeforeHook): Disposable {
    this.beforeHooks.push(hook);
    return { dispose: () => { this.beforeHooks = this.beforeHooks.filter((h) => h !== hook); } };
  }

  /**
   * Tear the next matching write: only a prefix of the new bytes lands (mtime updated, no event,
   * as when the process dies or the disk fails mid-write on a platform without atomic writes),
   * then the write throws (see TearSpec.onTear). Writes through processText are not torn.
   */
  tearNextWrite(spec: TearSpec = {}): void {
    this.tears.push({ ...spec });
  }

  /** Pending tear specs (tests assert they were consumed). */
  get pendingTears(): number {
    return this.tears.length;
  }

  /** Change `path` externally right before its next read (torn read). */
  tornReadOnce(path: string, newContent: Uint8Array | string): void {
    let fired = false;
    const d = this.before(async (op, p) => {
      if (fired || op !== "read" || this.key(p) !== this.key(path)) return;
      fired = true;
      d.dispose();
      this.external.write(path, newContent);
    });
  }

  /** Remove `path` externally right before its next read (ENOENT between list and read). */
  vanishBeforeRead(path: string): void {
    let fired = false;
    const d = this.before(async (op, p) => {
      if (fired || op !== "read" || this.key(p) !== this.key(path)) return;
      fired = true;
      d.dispose();
      this.external.remove(path);
    });
  }

  private async enter(op: FsOp, path: string): Promise<void> {
    const i = this.faults.findIndex((f) => f.op === op && (f.path === undefined || this.key(f.path) === this.key(path)));
    if (i >= 0) {
      const f = this.faults[i] as PendingFault;
      if (f.skip > 0) f.skip--;
      else {
        this.faults.splice(i, 1);
        throw new LocalFsError(f.code, path, `injected ${f.code} on ${op} ${path}`);
      }
    }
    for (const h of [...this.beforeHooks]) await h(op, path);
  }

  // ---------- events ----------

  onEvent(cb: (e: LocalEvent) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }

  /** Drop the next `n` events, or every event matching `pred` until cleared with dropEvents(0). */
  dropEvents(n: number | ((e: LocalEvent) => boolean)): void {
    if (typeof n === "number") { this.dropCount = n; this.dropPredicate = null; }
    else this.dropPredicate = n;
  }

  /** Hold events until resumeEvents() (models a watcher that batches). */
  pauseEvents(): void {
    this.eventsPaused = true;
  }

  /**
   * Release held events. With `merge`, consecutive events for the same path collapse to the last one
   * (create+modify → create, modify×n → modify), as coalescing watchers do.
   */
  resumeEvents(o: { merge?: boolean } = {}): void {
    this.eventsPaused = false;
    let held = this.heldEvents;
    this.heldEvents = [];
    if (o.merge) held = mergeEvents(held);
    for (const e of held) this.deliver(e);
  }

  /** Emit an arbitrary event (e.g. `{t:'rescan-hint'}` or a `raw` config event). */
  emit(e: LocalEvent): void {
    if (this.dropPredicate?.(e)) return;
    if (this.dropCount > 0) { this.dropCount--; return; }
    if (this.eventsPaused) { this.heldEvents.push(e); return; }
    this.deliver(e);
  }

  private deliver(e: LocalEvent): void {
    this.eventLog.push(e);
    queueMicrotask(() => {
      for (const l of [...this.listeners]) l(e);
    });
  }

  private emitOwn(e: LocalEvent): void {
    if (this.emitOwnEvents) this.emit(e);
  }

  private isConfig(p: string): boolean {
    return p === this.configDir || p.startsWith(this.configDir + "/");
  }

  private changeEvent(t: 'create' | 'modify', n: Node): LocalEvent {
    const path = nfc(n.name);
    if (this.isConfig(path)) return { t: "raw", path };
    return { t, path, stat: this.toStat(n) };
  }

  // ---------- core mutations (shared by engine API and external API) ----------

  private mkdirpRaw(p: string, events: LocalEvent[]): void {
    if (p === "") return;
    const existing = this.get(p);
    if (existing) {
      if (existing.kind !== "folder") throw new LocalFsError("ENOTDIR", p);
      return;
    }
    this.mkdirpRaw(parentOf(p), events);
    const now = this.clock.now();
    const n: FolderNode = { kind: "folder", name: nfc(p), mtime: now, ctime: now, ino: this.nextIno++ };
    this.nodes.set(this.key(p), n);
    events.push(this.isConfig(n.name) ? { t: "raw", path: n.name } : { t: "create", path: n.name, stat: this.toStat(n) });
  }

  private writeRaw(p: string, data: Uint8Array, mtime: number, ctime: number | undefined, mkParents: boolean, events: LocalEvent[]): Node {
    checkPath(p);
    const parent = parentOf(p);
    if (parent !== "") {
      const pn = this.get(parent);
      if (!pn) {
        if (!mkParents) throw new LocalFsError("ENOENT", parent, `parent folder missing: ${parent}`);
        this.mkdirpRaw(parent, events);
      } else if (pn.kind !== "folder") throw new LocalFsError("ENOTDIR", parent);
    }
    const prev = this.get(p);
    if (prev?.kind === "folder") throw new LocalFsError("EISDIR", p);
    const n: FileNode = {
      kind: "file",
      name: prev ? prev.name : nfc(p),                // an existing file keeps its on-disk name (case)
      bytes: new Uint8Array(data),                     // copy: the caller may reuse its buffer
      mtime,
      ctime: prev ? prev.ctime : (ctime ?? mtime),
      ino: prev ? prev.ino : this.nextIno++,
    };
    this.nodes.set(this.key(p), n);
    events.push(this.changeEvent(prev ? "modify" : "create", n));
    return n;
  }

  private renameRaw(from: string, to: string, events: LocalEvent[]): void {
    checkPath(to);
    const src = this.get(from);
    if (!src) throw new LocalFsError("ENOENT", from);
    const dst = this.get(to);
    const sameNode = dst === src;                      // case-only rename on a case-insensitive fs
    // Lead decision D8: a rename from an engine replace temp (same-folder temp file) atomically
    // replaces an existing file at the target; every other rename refuses an occupied target.
    const replace = dst !== null && dst !== undefined && !sameNode && src.kind === "file" && dst.kind === "file" &&
      baseName(from).startsWith(REPLACE_TEMP_PREFIX);
    if (dst && !sameNode && !replace) throw new LocalFsError("EEXIST", to);
    if (replace && dst) this.nodes.delete(this.key(dst.name));
    if (src.kind === "folder" && (this.key(to) + "/").startsWith(this.key(from) + "/")) {
      throw new LocalFsError("EIO", to, "cannot move a folder into itself");
    }
    this.mkdirpRaw(parentOf(to), events);              // design §3.2: rename creates missing parents (S21)
    const fromName = src.name;
    const toName = nfc(to);
    const moved: Array<[string, Node]> = [];
    if (src.kind === "folder") {
      const fromPrefix = this.key(fromName) + "/";
      for (const [k, n] of [...this.nodes.entries()]) {
        if (!k.startsWith(fromPrefix)) continue;
        this.nodes.delete(k);
        const rest = n.name.slice(fromName.length);
        moved.push([n.name, { ...n, name: toName + rest }]);
      }
    }
    this.nodes.delete(this.key(fromName));
    this.nodes.set(this.key(toName), { ...src, name: toName });
    for (const [, n] of moved) this.nodes.set(this.key(n.name), n);
    events.push({ t: "rename", from: nfc(fromName), to: toName, kind: src.kind });
    if (src.kind === "folder" && this.expandFolderEvents) {
      for (const [oldName, n] of moved) if (n.kind === "file") events.push({ t: "rename", from: nfc(oldName), to: n.name, kind: "file" });
    }
  }

  private removeRaw(p: string, mode: RemoveMode, events: LocalEvent[]): void {
    const n = this.get(p);
    if (!n) throw new LocalFsError("ENOENT", p);
    const now = this.clock.now();
    const kids = n.kind === "folder" ? this.children(n.name) : [];
    for (const c of kids) {
      this.nodes.delete(this.key(c.name));
      if (mode === "trash" && c.kind === "file") this.trash.push({ path: c.name, kind: "file", bytes: c.bytes, at: now });
      if (n.kind === "folder" && this.expandFolderEvents && c.kind === "file") events.push({ t: "delete", path: c.name, kind: "file" });
    }
    this.nodes.delete(this.key(n.name));
    if (mode === "trash") {
      const item: TrashedItem = { path: n.name, kind: n.kind, at: now };
      if (n.kind === "file") item.bytes = n.bytes;
      this.trash.push(item);
    }
    events.push({ t: "delete", path: nfc(n.name), kind: n.kind });
  }

  // ---------- LocalFs ----------

  async *listAll(opts: { includeConfigDir: boolean }): AsyncIterable<LocalStat[]> {
    await this.enter("list", "");
    this.stats.lists++;
    const all = [...this.nodes.values()]
      .filter((n) => opts.includeConfigDir || !this.isConfig(nfc(n.name)))
      .map((n) => this.toStat(n))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (let i = 0; i < all.length; i += this.listBatch) yield all.slice(i, i + this.listBatch);
  }

  async stat(path: string): Promise<LocalStat | null> {
    await this.enter("stat", path);
    this.stats.stats++;
    const n = this.get(path);
    return n ? this.toStat(n) : null;
  }

  async read(path: string): Promise<Uint8Array> {
    await this.enter("read", path);
    this.stats.reads++;
    const n = this.get(path);
    if (!n) throw new LocalFsError("ENOENT", path);
    if (n.kind !== "file") throw new LocalFsError("EISDIR", path);
    return new Uint8Array(n.bytes);
  }

  async processText(path: string, fn: (current: string) => string | null): Promise<boolean> {
    await this.enter("processText", path);
    const n = this.get(path);
    if (!n) throw new LocalFsError("ENOENT", path);
    if (n.kind !== "file") throw new LocalFsError("EISDIR", path);
    const next = fn(dec.decode(n.bytes));
    if (next === null) return false;
    const events: LocalEvent[] = [];
    this.writeRaw(path, enc.encode(next), this.clock.now(), undefined, false, events);
    this.stats.writes++;
    for (const e of events) this.emitOwn(e);
    return true;
  }

  async write(path: string, data: Uint8Array, opts: { mtime: number; ctime?: number }): Promise<LocalStat> {
    await this.enter("write", path);
    // A tear aimed at `path` also hits a replace temp in its folder: the engine writes merges and pull
    // applies through one (lead decision D8), so that is the write a crash would tear.
    const viaTemp = (t: TearSpec): boolean => t.path !== undefined && baseName(path).startsWith(REPLACE_TEMP_PREFIX) &&
      this.key(parentOf(path)) === this.key(parentOf(t.path));
    const ti = this.tears.findIndex((t) => t.path === undefined || this.key(t.path) === this.key(path) || viaTemp(t));
    if (ti >= 0) {
      const t = this.tears[ti] as TearSpec;
      if ((t.skip ?? 0) > 0) t.skip = (t.skip ?? 0) - 1;
      else {
        this.tears.splice(ti, 1);
        const keep = Math.max(0, Math.min(data.length, t.keep ?? Math.floor(data.length * (t.fraction ?? 0.5))));
        // The prefix lands without an event: nobody is alive to see one.
        this.writeRaw(path, data.subarray(0, keep), opts.mtime, opts.ctime, this.writeCreatesParents, []);
        this.stats.writes++;
        this.torn.push({ path: nfc(path), kept: keep, of: data.length });
        t.onTear?.(path);
        throw new LocalFsError(t.code ?? "EIO", path, `torn write of ${path} (${keep} of ${data.length} bytes)`);
      }
    }
    const events: LocalEvent[] = [];
    const n = this.writeRaw(path, data, opts.mtime, opts.ctime, this.writeCreatesParents, events);
    this.stats.writes++;
    for (const e of events) this.emitOwn(e);
    return this.toStat(n);
  }

  async writeChunked(path: string, chunks: AsyncIterable<Uint8Array>, opts: { mtime: number }): Promise<LocalStat> {
    const parts: Uint8Array[] = [];
    let len = 0;
    for await (const c of chunks) { parts.push(new Uint8Array(c)); len += c.length; }
    const all = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    return this.write(path, all, opts);   // all-or-nothing: nothing is visible until every chunk arrived
  }

  async rename(from: string, to: string): Promise<void> {
    await this.enter("rename", from);
    const events: LocalEvent[] = [];
    this.renameRaw(from, to, events);
    this.stats.renames++;
    for (const e of events) this.emitOwn(e);
  }

  async remove(path: string, mode: RemoveMode): Promise<void> {
    await this.enter("remove", path);
    const events: LocalEvent[] = [];
    this.removeRaw(path, mode, events);
    this.stats.removes++;
    for (const e of events) this.emitOwn(e);
  }

  async mkdirp(path: string): Promise<void> {
    await this.enter("mkdir", path);
    checkPath(path);
    const events: LocalEvent[] = [];
    this.mkdirpRaw(path, events);
    for (const e of events) this.emitOwn(e);
  }

  async rmdirIfEmpty(path: string): Promise<boolean> {
    await this.enter("rmdir", path);
    const n = this.get(path);
    if (!n || n.kind !== "folder") return false;
    if (this.children(n.name).length > 0) return false;
    const events: LocalEvent[] = [];
    this.removeRaw(path, "delete", events);
    for (const e of events) this.emitOwn(e);
    return true;
  }

  // ---------- external changes (always emit events) ----------

  readonly external = {
    /** Create or overwrite a file; creates parent folders. */
    write: (path: string, content: Uint8Array | string, o: { mtime?: number; ctime?: number } = {}): void => {
      const events: LocalEvent[] = [];
      const bytes = typeof content === "string" ? enc.encode(content) : content;
      this.writeRaw(path, bytes, o.mtime ?? this.clock.now(), o.ctime, true, events);
      for (const e of events) this.emit(e);
    },
    remove: (path: string): void => {
      const events: LocalEvent[] = [];
      this.removeRaw(path, "delete", events);
      for (const e of events) this.emit(e);
    },
    rename: (from: string, to: string): void => {
      const events: LocalEvent[] = [];
      this.renameRaw(from, to, events);
      for (const e of events) this.emit(e);
    },
    mkdir: (path: string): void => {
      const events: LocalEvent[] = [];
      this.mkdirpRaw(path, events);
      for (const e of events) this.emit(e);
    },
  };

  /** Set a file's tree state without emitting events (fixtures before the engine starts). */
  seed(files: Record<string, Uint8Array | string>, o: { mtime?: number } = {}): void {
    for (const [p, c] of Object.entries(files)) {
      this.writeRaw(p, typeof c === "string" ? enc.encode(c) : c, o.mtime ?? this.clock.now(), undefined, true, []);
    }
  }

  // ---------- inspection ----------

  /** Path → bytes of every file (NFC paths), for oracle comparisons. */
  files(o: { includeConfigDir?: boolean } = {}): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const n of [...this.nodes.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (n.kind !== "file") continue;
      if (!o.includeConfigDir && this.isConfig(nfc(n.name))) continue;
      out.set(nfc(n.name), new Uint8Array(n.bytes));
    }
    return out;
  }

  readText(path: string): string | null {
    const n = this.get(path);
    return n && n.kind === "file" ? dec.decode(n.bytes) : null;
  }

  exists(path: string): boolean {
    return this.get(path) !== undefined;
  }
}

/** Collapse consecutive same-path create/modify events (coalescing watcher model). */
export function mergeEvents(events: readonly LocalEvent[]): LocalEvent[] {
  const out: LocalEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && (e.t === "create" || e.t === "modify") && (last.t === "create" || last.t === "modify") && last.path === e.path) {
      const merged: LocalEvent = { t: last.t, path: e.path };
      if (e.stat) merged.stat = e.stat;
      out[out.length - 1] = merged;
      continue;
    }
    out.push(e);
  }
  return out;
}
