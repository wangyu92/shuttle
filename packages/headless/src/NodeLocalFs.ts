// LocalFs on node:fs for the headless client (design §6.1.3).
//
// - Paths given to and returned by this class are vault-relative, '/'-separated and NFC. On disk a
//   name may be NFD (written by macOS tools): the name map resolves every NFC path to its on-disk
//   name, and all IO uses the on-disk name (S10). Two on-disk names with one NFC form: the first in
//   byte order (an NFC one wins) is the file, the other is skipped and logged once (never synced,
//   never deleted).
// - write(): temp file in `tmpDir` (same mount as the vault: rename(2) across bind mounts is EXDEV) →
//   fsync → utimes(mtime) → mkdirp → rename into place → fsync the parent directory. Crash-atomic, so
//   the class declares `atomicReplace` (lead decision D10) and the engine's replaceFile writes merges and
//   pull applies with this one write() instead of a second temp + rename + directory fsync.
// - rename(): refuses an occupied target, except from an engine replace temp (`.shuttle-replace-*`,
//   lead decision D8): that rename replaces the file at the target atomically.
// - stat(): lstat; ENOENT/ENOTDIR → null. Symlinks are never followed nor listed.
// - read(): readFile through one fd; size or mtime changed during the read → TornReadError.
// - remove(): files are unlinked, then empty parents are removed up to (never including) the root.
//   Folders and 'trash' removals are MOVED into `<tmpDir>/trash/` instead of being deleted, so no
//   folder subtree is ever destroyed by the engine (the mirror's deleteMode is 'delete', design §6.1.3).
// - readOnly (push-only mode): every mutating method throws ReadOnlyFsError (design §6.1.1).
// - listAll(): iterative opendir walk with lstat per entry, batches of `listBatch`. Dot directories
//   (except configDir when asked for) are pruned, matching PathFilter rule 2, so `.git`, `.trash` and
//   `.claude` are never descended. A directory that cannot be read aborts the listing (throws): a
//   partial listing would look like a mass delete to the scanner.
//
// Each completed listing is diffed against the previous one (non-config files only) to count changes
// the watcher never reported (passive miss detection, design §6.1.4); see onScan().

import { constants as FS, mkdirSync, promises as fsp, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Disposable, LocalEvent, LocalFs, LocalFsErrorCode, LocalPlatform, LocalStat, RemoveMode } from "@shuttle/protocol";
import { REPLACE_TEMP_PREFIX } from "@shuttle/engine";
import type { Logger } from "./log";

export class LocalFsError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: LocalFsErrorCode | 'EROFS' | 'ETORN' | 'EINVAL', p: string, message?: string) {
    super(message ?? `${code}: ${p}`);
    this.name = "LocalFsError";
    this.code = code;
    this.path = p;
  }
}
export class ReadOnlyFsError extends LocalFsError {
  constructor(p: string, op: string) {
    super("EROFS", p, `read-only file system (push-only mode): refused ${op} ${p}`);
    this.name = "ReadOnlyFsError";
  }
}
export class TornReadError extends LocalFsError {
  constructor(p: string) {
    super("ETORN", p, `file changed while it was read: ${p}`);
    this.name = "TornReadError";
  }
}
export class FileVanishedError extends LocalFsError {
  constructor(p: string) {
    super("ENOENT", p, `file vanished: ${p}`);
    this.name = "FileVanishedError";
  }
}
export class PathTakenError extends LocalFsError {
  constructor(p: string) {
    super("EEXIST", p, `path taken: ${p}`);
    this.name = "PathTakenError";
  }
}

export interface ScanReport {
  at: number;
  ms: number;
  files: number;
  dirs: number;
  /** Paths added, removed or changed since the previous complete listing (null on the first). */
  changes: string[] | null;
}

export interface NodeLocalFsOptions {
  /** Absolute vault root. */
  root: string;
  /** Temp directory on the same mount as the vault (design §6.1.3). */
  tmpDir: string;
  configDir?: string;
  readOnly?: boolean;
  /** Linux: false (design §6.1.3). */
  caseInsensitive?: boolean;
  listBatch?: number;
  log?: Logger;
  /** Extra directory pruning (vault-relative NFC path of the directory). */
  prune?: (relDir: string) => boolean;
  /** File mode for new files (umask applies). */
  fileMode?: number;
  /**
   * Where removed folders and 'trash' removals are parked (default `<tmpDir>/trash`). mirror-remote
   * uses `<state>/reverted` (design §6.1.1). Another mount is fine: the move falls back to copy+remove.
   */
  parkDir?: string;
  /** Park a copy of every file a write replaces (mirror-remote: reverted local edits are kept). */
  keepOverwritten?: boolean;
  /**
   * Lead decision D10: declare `atomicReplace` (write() is temp + fsync + rename, so the engine skips
   * its own temp hop). Default true; false only to measure or test the D8 path.
   */
  atomicReplace?: boolean;
}

type Sig = string;

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);
const toPosix = (p: string): string => p.split(path.sep).join("/");

function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

function checkRel(p: string): void {
  if (p === "" || p.startsWith("/") || p.endsWith("/") || p.includes("\0") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new LocalFsError("EINVAL", p, `invalid vault path: ${JSON.stringify(p)}`);
  }
}

function sigOf(st: LocalStat): Sig {
  return `${st.size}:${st.mtime}:${st.ino ?? ""}:${st.ctimeMs ?? ""}`;
}

export class NodeLocalFs implements LocalFs {
  readonly platform: LocalPlatform = "node";
  /** D10: write() replaces the target crash-atomically (see the header). */
  readonly atomicReplace: boolean;
  /** D8: rename(2) from a replace temp replaces an existing file. */
  readonly renameReplaces = true;
  readonly caseInsensitive: boolean;
  readonly configDir: string;
  readonly root: string;
  readonly tmpDir: string;
  readonly readOnly: boolean;
  private readonly listBatch: number;
  private readonly log: Logger | undefined;
  private readonly prune: ((relDir: string) => boolean) | undefined;
  private readonly fileMode: number;
  readonly parkDir: string;
  private readonly keepOverwritten: boolean;
  /** NFC vault path → on-disk relative path, for names whose disk form differs. */
  private readonly nameMap = new Map<string, string>();
  private readonly listeners = new Set<(e: LocalEvent) => void>();
  private readonly loggedOnce = new Set<string>();
  private snapshot: Map<string, Sig> | null = null;
  private readonly scanListeners = new Set<(r: ScanReport) => void>();
  /** Counters for debug output. */
  readonly stats = { reads: 0, writes: 0, renames: 0, removes: 0, lists: 0, tornReads: 0 };
  lastScan: ScanReport | null = null;

  constructor(o: NodeLocalFsOptions) {
    this.root = path.resolve(o.root);
    this.tmpDir = path.resolve(o.tmpDir);
    this.atomicReplace = o.atomicReplace ?? true;
    this.configDir = o.configDir ?? ".obsidian";
    this.readOnly = o.readOnly ?? false;
    this.caseInsensitive = o.caseInsensitive ?? false;
    this.listBatch = o.listBatch ?? 500;
    this.log = o.log;
    this.prune = o.prune;
    this.fileMode = o.fileMode ?? 0o664;
    this.parkDir = path.resolve(o.parkDir ?? path.join(this.tmpDir, "trash"));
    this.keepOverwritten = o.keepOverwritten ?? false;
  }

  /** Move `abs` (vault entry `disk`) under parkDir/<timestamp>/; copies when parkDir is on another mount. */
  private async park(abs: string, disk: string, copyOnly = false): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.parkDir, stamp, disk);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (copyOnly) {
      await fsp.cp(abs, dest, { recursive: true, preserveTimestamps: true });
      return;
    }
    try {
      await fsp.rename(abs, dest);
    } catch (err) {
      if (codeOf(err) !== "EXDEV") throw err;
      await fsp.cp(abs, dest, { recursive: true, preserveTimestamps: true });
      await fsp.rm(abs, { recursive: true, force: true });
    }
  }

  // ---------- events (fed by the Watcher) ----------

  onEvent(cb: (e: LocalEvent) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }

  /** Deliver a watcher event to the engine. Listener errors are logged, never thrown into the watcher. */
  emit(e: LocalEvent): void {
    for (const l of [...this.listeners]) {
      try { l(e); } catch (err) { this.log?.error("watcher", "event listener failed", { err: String(err) }); }
    }
  }

  /** Called with every completed listing (scan duration, counts, changes since the previous one). */
  onScan(cb: (r: ScanReport) => void): Disposable {
    this.scanListeners.add(cb);
    return { dispose: () => { this.scanListeners.delete(cb); } };
  }

  // ---------- path resolution ----------

  /** Absolute on-disk path for a vault path (NFC in), resolving NFD names. Null when absent. */
  async resolve(rel: string): Promise<string | null> {
    const disk = await this.diskRel(rel);
    return disk === null ? null : path.join(this.root, disk);
  }

  private async diskRel(rel: string): Promise<string | null> {
    const nfc = rel.normalize("NFC");
    const mapped = this.nameMap.get(nfc);
    if (mapped !== undefined) {
      if (await this.exists(mapped)) return mapped;
      this.nameMap.delete(nfc);
    }
    if (await this.exists(nfc)) return nfc;
    if (isAscii(nfc)) return null;
    // Walk segment by segment, matching each by its NFC form.
    const segs = nfc.split("/");
    let cur = "";
    for (const seg of segs) {
      const exact = cur ? `${cur}/${seg}` : seg;
      if (await this.exists(exact)) { cur = exact; continue; }
      let names: string[];
      try {
        names = await fsp.readdir(path.join(this.root, cur));
      } catch {
        return null;
      }
      const hit = names.sort().find((n) => n.normalize("NFC") === seg);
      if (hit === undefined) return null;
      cur = cur ? `${cur}/${hit}` : hit;
    }
    if (cur !== nfc) this.nameMap.set(nfc, cur);
    return cur;
  }

  /** On-disk path for a write or a new name: existing parents keep their disk names, new segments are NFC. */
  private async diskRelForCreate(rel: string): Promise<string> {
    const existing = await this.diskRel(rel);
    if (existing !== null) return existing;
    const nfc = rel.normalize("NFC");
    const i = nfc.lastIndexOf("/");
    if (i < 0) return nfc;
    const parent = await this.diskRelForCreate(nfc.slice(0, i));
    return `${parent}/${nfc.slice(i + 1)}`;
  }

  private async exists(diskRel: string): Promise<boolean> {
    try {
      await fsp.lstat(path.join(this.root, diskRel));
      return true;
    } catch {
      return false;
    }
  }

  private toStat(rel: string, s: import("node:fs").Stats): LocalStat {
    return {
      path: rel, kind: s.isDirectory() ? "folder" : "file", size: s.isDirectory() ? 0 : s.size,
      // Integer ms: utimes(mtime) followed by stat must round-trip exactly or the fast path misses.
      mtime: Math.round(s.mtimeMs), ctime: Math.round(s.birthtimeMs || s.ctimeMs), ino: s.ino, ctimeMs: s.ctimeMs,
    };
  }

  private once(key: string, f: () => void): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    f();
  }

  private assertWritable(op: string, p: string): void {
    if (this.readOnly) throw new ReadOnlyFsError(p, op);
  }

  private isConfig(rel: string): boolean {
    return rel === this.configDir || rel.startsWith(this.configDir + "/");
  }

  /** PathFilter rule 2 for directories: dot segments are ignored (configDir only when asked for). */
  private pruned(relDir: string, includeConfigDir: boolean): boolean {
    const segs = relDir.split("/");
    const cfgSegs = this.configDir.split("/").length;
    if (this.isConfig(relDir)) {
      if (!includeConfigDir) return true;
      if (segs.slice(cfgSegs).some((x) => x.startsWith("."))) return true;
    } else if (this.configDir.startsWith(relDir + "/")) {
      // An ancestor of a nested configDir: descend only when the config dir is wanted.
      if (!includeConfigDir) return segs.some((x) => x.startsWith("."));
    } else if (segs.some((x) => x.startsWith("."))) {
      return true;
    }
    return this.prune?.(relDir) ?? false;
  }

  // ---------- LocalFs ----------

  async *listAll(opts: { includeConfigDir: boolean }): AsyncIterable<LocalStat[]> {
    const started = Date.now();
    this.stats.lists++;
    const snap = new Map<string, Sig>();
    let batch: LocalStat[] = [];
    let files = 0;
    let dirs = 0;
    const stack: Array<{ disk: string; nfc: string }> = [{ disk: "", nfc: "" }];
    const claimed = new Map<string, string>();      // NFC path → on-disk path that holds it
    const freshMap = new Map<string, string>();
    while (stack.length > 0) {
      const d = stack.pop() as { disk: string; nfc: string };
      const absDir = path.join(this.root, d.disk);
      let ents: Dirent[];
      try {
        const handle = await fsp.opendir(absDir);
        ents = [];
        for await (const e of handle) ents.push(e);
      } catch (err) {
        // Fail the whole listing: a missing subtree would be read as "files deleted" (design §6.1.3).
        const code = codeOf(err) ?? "EIO";
        throw new LocalFsError(code === "ENOENT" ? "ENOENT" : code === "EACCES" ? "EACCES" : "EIO", d.nfc || ".",
          `cannot list ${d.nfc || "the vault root"}: ${code}`);
      }
      dirs++;
      // NFC names first, then byte order: the NFC spelling wins a duplicate deterministically.
      ents.sort((a, b) => {
        const an = a.name === a.name.normalize("NFC") ? 0 : 1;
        const bn = b.name === b.name.normalize("NFC") ? 0 : 1;
        return an - bn || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
      for (const e of ents) {
        const diskRel = d.disk ? `${d.disk}/${e.name}` : e.name;
        const nfcRel = d.nfc ? `${d.nfc}/${e.name.normalize("NFC")}` : e.name.normalize("NFC");
        let st: import("node:fs").Stats;
        try {
          st = await fsp.lstat(path.join(this.root, diskRel));
        } catch (err) {
          if (codeOf(err) === "ENOENT") continue;             // vanished since readdir: really gone
          throw new LocalFsError("EIO", nfcRel, `cannot stat ${nfcRel}: ${codeOf(err) ?? "error"}`);
        }
        if (st.isSymbolicLink()) {
          this.once(`symlink:${nfcRel}`, () => this.log?.info("skipped", "symlink", { path: nfcRel }));
          continue;
        }
        const holder = claimed.get(nfcRel);
        if (holder !== undefined && holder !== diskRel) {
          this.once(`dup:${diskRel}`, () => this.log?.warn("skipped", "duplicate name after NFC normalization", { path: nfcRel }));
          continue;
        }
        claimed.set(nfcRel, diskRel);
        if (diskRel !== nfcRel) freshMap.set(nfcRel, diskRel);
        if (st.isDirectory()) {
          if (this.pruned(nfcRel, opts.includeConfigDir)) continue;
          stack.push({ disk: diskRel, nfc: nfcRel });
          continue;
        }
        if (!st.isFile()) {
          this.once(`special:${nfcRel}`, () => this.log?.info("skipped", "not a regular file", { path: nfcRel }));
          continue;
        }
        const ls = this.toStat(nfcRel, st);
        files++;
        if (!this.isConfig(nfcRel)) snap.set(nfcRel, sigOf(ls));
        batch.push(ls);
        if (batch.length >= this.listBatch) {
          yield batch;
          batch = [];
        }
      }
    }
    if (batch.length > 0) yield batch;
    for (const [k, v] of freshMap) this.nameMap.set(k, v);
    // Completed listing: diff against the previous one.
    let changes: string[] | null = null;
    if (this.snapshot) {
      changes = [];
      for (const [p, s] of snap) if (this.snapshot.get(p) !== s) changes.push(p);
      for (const p of this.snapshot.keys()) if (!snap.has(p)) changes.push(p);
    }
    this.snapshot = snap;
    const report: ScanReport = { at: started, ms: Date.now() - started, files, dirs, changes };
    this.lastScan = report;
    for (const l of [...this.scanListeners]) {
      try { l(report); } catch { /* observers never break a scan */ }
    }
  }

  async stat(p: string): Promise<LocalStat | null> {
    const nfc = p.normalize("NFC");
    try {
      const disk = await this.diskRel(nfc);
      if (disk === null) return null;
      const st = await fsp.lstat(path.join(this.root, disk));
      if (st.isSymbolicLink()) return null;
      if (!st.isFile() && !st.isDirectory()) return null;
      return this.toStat(nfc, st);
    } catch (err) {
      const c = codeOf(err);
      if (c === "ENOENT" || c === "ENOTDIR") return null;
      throw err;
    }
  }

  async read(p: string): Promise<Uint8Array> {
    const nfc = p.normalize("NFC");
    const disk = await this.diskRel(nfc);
    if (disk === null) throw new FileVanishedError(nfc);
    this.stats.reads++;
    let fh: import("node:fs/promises").FileHandle;
    try {
      fh = await fsp.open(path.join(this.root, disk), FS.O_RDONLY | FS.O_NOFOLLOW);
    } catch (err) {
      if (codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR") throw new FileVanishedError(nfc);
      if (codeOf(err) === "ELOOP") throw new FileVanishedError(nfc);   // a symlink appeared
      throw err;
    }
    try {
      const before = await fh.stat();
      if (before.isDirectory()) throw new LocalFsError("EISDIR", nfc);
      const buf = await fh.readFile();
      const after = await fh.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || buf.length !== after.size) {
        this.stats.tornReads++;
        throw new TornReadError(nfc);
      }
      // A plain Uint8Array (not a Buffer): values may be stored and compared structurally.
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  async write(p: string, data: Uint8Array, opts: { mtime: number; ctime?: number }): Promise<LocalStat> {
    async function* one(): AsyncIterable<Uint8Array> { yield data; }
    return this.writeChunked(p, one(), opts);
  }

  async writeChunked(p: string, chunks: AsyncIterable<Uint8Array>, opts: { mtime: number }): Promise<LocalStat> {
    const nfc = p.normalize("NFC");
    checkRel(nfc);
    this.assertWritable("write", nfc);
    const disk = await this.diskRelForCreate(nfc);
    const abs = path.join(this.root, disk);
    const existing = await fsp.lstat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new LocalFsError("EISDIR", nfc);
    const tmp = path.join(this.tmpDir, `.shuttle-tmp-${randomBytes(8).toString("hex")}`);
    let fh: import("node:fs/promises").FileHandle | null = null;
    try {
      fh = await fsp.open(tmp, "wx", this.fileMode);
      for await (const c of chunks) {
        let off = 0;
        while (off < c.length) {
          const { bytesWritten } = await fh.write(c, off, c.length - off);
          off += bytesWritten;
        }
      }
      await fh.sync();
      await fh.close();
      fh = null;
      const t = opts.mtime / 1000;
      await fsp.utimes(tmp, t, t);
      if (this.keepOverwritten && existing?.isFile()) await this.park(abs, disk, true);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.rename(tmp, abs);
      await fsyncDir(path.dirname(abs));
    } catch (err) {
      if (fh) await fh.close().catch(() => undefined);
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
    this.stats.writes++;
    if (disk !== nfc) this.nameMap.set(nfc, disk);
    const st = await fsp.lstat(abs);
    return this.toStat(nfc, st);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = from.normalize("NFC");
    const t = to.normalize("NFC");
    checkRel(t);
    this.assertWritable("rename", f);
    const src = await this.diskRel(f);
    if (src === null) throw new LocalFsError("ENOENT", f);
    const dst = await this.diskRelForCreate(t);
    const dstAbs = path.join(this.root, dst);
    const srcAbs = path.join(this.root, src);
    const taken = await fsp.lstat(dstAbs).catch(() => null);
    if (taken) {
      const s = await fsp.lstat(srcAbs);
      // Same inode = the same entry under another spelling (case/normalization-only rename).
      // Lead decision D8: a rename from an engine replace temp replaces an existing file atomically
      // (rename(2) over the target); every other rename refuses an occupied target.
      const replace = path.posix.basename(f).startsWith(REPLACE_TEMP_PREFIX) && s.isFile() && taken.isFile();
      if (!(taken.ino === s.ino && taken.dev === s.dev) && !replace) throw new PathTakenError(t);
      // mirror-remote keeps every file a write replaces; a replace rename is such a write.
      if (replace && this.keepOverwritten) await this.park(dstAbs, dst, true);
    }
    await fsp.mkdir(path.dirname(dstAbs), { recursive: true });
    await fsp.rename(srcAbs, dstAbs);
    await fsyncDir(path.dirname(dstAbs));
    this.stats.renames++;
    for (const k of [...this.nameMap.keys()]) if (k === f || k.startsWith(f + "/")) this.nameMap.delete(k);
  }

  async remove(p: string, mode: RemoveMode): Promise<void> {
    const nfc = p.normalize("NFC");
    checkRel(nfc);
    this.assertWritable("remove", nfc);
    const disk = await this.diskRel(nfc);
    if (disk === null) throw new LocalFsError("ENOENT", nfc);
    const abs = path.join(this.root, disk);
    const st = await fsp.lstat(abs);
    if (st.isDirectory() || mode === "trash") {
      // Never destroy content the engine asked to "trash", nor a whole subtree: park it.
      await this.park(abs, disk);
    } else {
      await fsp.unlink(abs);
    }
    this.stats.removes++;
    for (const k of [...this.nameMap.keys()]) if (k === nfc || k.startsWith(nfc + "/")) this.nameMap.delete(k);
    await fsyncDir(path.dirname(abs)).catch(() => undefined);
    // Remove now-empty parents up to (never including) the root.
    let parent = nfc.includes("/") ? nfc.slice(0, nfc.lastIndexOf("/")) : "";
    while (parent !== "") {
      if (!(await this.rmdirIfEmpty(parent))) break;
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
  }

  async mkdirp(p: string): Promise<void> {
    const nfc = p.normalize("NFC");
    checkRel(nfc);
    this.assertWritable("mkdir", nfc);
    const disk = await this.diskRelForCreate(nfc);
    await fsp.mkdir(path.join(this.root, disk), { recursive: true });
  }

  async rmdirIfEmpty(p: string): Promise<boolean> {
    const nfc = p.normalize("NFC");
    if (nfc === "" || nfc === ".") return false;
    checkRel(nfc);
    this.assertWritable("rmdir", nfc);
    const disk = await this.diskRel(nfc);
    if (disk === null) return false;
    const abs = path.join(this.root, disk);
    if (path.resolve(abs) === this.root) return false;
    try {
      const st = await fsp.lstat(abs);
      if (!st.isDirectory()) return false;
      await fsp.rmdir(abs);
      this.nameMap.delete(nfc);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- helpers for the daemon ----------

  /** Vault-relative NFC path for an absolute on-disk path under the root (watcher), or null. */
  relOf(abs: string): string | null {
    const r = path.relative(this.root, abs);
    if (r === "" || r.startsWith("..") || path.isAbsolute(r)) return null;
    return toPosix(r).normalize("NFC");
  }

  /** Paths the scan listed last time (non-config files), for passive miss detection. */
  get lastSnapshotSize(): number {
    return this.snapshot?.size ?? 0;
  }
}

/** fsync a directory so a rename in it is durable; filesystems that refuse it are tolerated. */
export async function fsyncDir(dir: string): Promise<void> {
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await fsp.open(dir, FS.O_RDONLY);
    await fh.sync();
  } catch (err) {
    const c = codeOf(err);
    if (c !== "EINVAL" && c !== "EISDIR" && c !== "EPERM" && c !== "EBADF") throw err;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export interface StartupCheckInput {
  vaultPath: string;
  tmpPath: string;
  readOnly: boolean;
  /** Active files in the index (state DB). */
  indexedActive: number;
}

export interface StartupCheckResult { ok: boolean; failures: string[]; emptyVault: boolean }

/** design §6.1.3 startup checks 1-3 (prodGuard and secrets permissions are checked by their modules). */
export async function startupChecks(i: StartupCheckInput): Promise<StartupCheckResult> {
  const failures: string[] = [];
  let emptyVault = false;
  let vaultDev: number | null = null;
  try {
    const st = await fsp.stat(i.vaultPath);
    if (!st.isDirectory()) failures.push("vault path is not a directory");
    vaultDev = st.dev;
    const names = (await fsp.readdir(i.vaultPath)).filter((n) => !n.startsWith("."));
    if (names.length === 0 && i.indexedActive >= 20) {
      emptyVault = true;
      failures.push(`vault is empty but the index has ${i.indexedActive} active files (unmounted volume?)`);
    }
  } catch {
    emptyVault = i.indexedActive >= 20;
    failures.push("vault path is missing");
  }
  if (!i.readOnly) {
    try {
      const st = await fsp.stat(i.tmpPath);
      if (vaultDev !== null && st.dev !== vaultDev) failures.push("temp dir is on another device than the vault (atomic rename impossible)");
      const probe = path.join(i.tmpPath, `.shuttle-tmp-probe-${randomBytes(4).toString("hex")}`);
      await fsp.writeFile(probe, "", { flag: "wx" });
      await fsp.unlink(probe);
    } catch (err) {
      if (!failures.some((f) => f.startsWith("temp dir"))) failures.push(`temp dir is not writable (${codeOf(err) ?? "error"})`);
    }
  }
  return { ok: failures.length === 0, failures, emptyVault };
}

/**
 * `setup`: create the temp dir (design §6.1.3 checks 2-3) and prove it usable, so a fresh daemon starts.
 * The vault root itself is never created: a missing root is how an unmounted volume looks (I22).
 * Throws an Error with a message meant for the operator; nothing is created when the vault is missing.
 */
export function prepareTmpDir(vaultPath: string, tmpPath: string): void {
  let vaultDev: number;
  try {
    const st = statSync(vaultPath);
    if (!st.isDirectory()) throw new Error(`vault path is not a directory: ${vaultPath}`);
    vaultDev = st.dev;
  } catch (e) {
    if (codeOf(e) === "ENOENT") throw new Error(`vault path does not exist: ${vaultPath} (create it first; shuttle never creates the vault root, so an unmounted volume is not mistaken for an empty vault)`);
    throw e;
  }
  try {
    mkdirSync(tmpPath, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot create temp dir ${tmpPath} (${codeOf(e) ?? String(e)}); pass --tmp <dir> on the vault's filesystem`);
  }
  const st = statSync(tmpPath);
  if (!st.isDirectory()) throw new Error(`temp path is not a directory: ${tmpPath}`);
  if (st.dev !== vaultDev) throw new Error(`temp dir ${tmpPath} is on another filesystem than the vault (atomic rename impossible); pass --tmp <dir> next to the vault`);
  const probe = path.join(tmpPath, `.shuttle-tmp-probe-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(probe, "", { flag: "wx" });
    unlinkSync(probe);
  } catch (e) {
    throw new Error(`temp dir ${tmpPath} is not writable (${codeOf(e) ?? String(e)})`);
  }
}
