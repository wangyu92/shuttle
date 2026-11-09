// LocalFs over the Obsidian Vault and DataAdapter APIs (design §3.2).
//
// - Files Obsidian indexes (everything outside dot folders) go through Vault so its cache, open
//   editors and other plugins see the change; the configuration folder and other dot paths go
//   through the DataAdapter, because Vault does not index them.
// - Writes replace the file in place (Vault.modifyBinary / createBinary, adapter.writeBinary). They
//   are not crash-atomic: DataAdapter.rename refuses to overwrite an existing file, and the overwrite
//   behaviour on mobile is unmeasured (P0 M22). The engine's write intents (design §3.8.4) and the
//   staged merge (lead decision D1) restore a torn write at the next start.
// - Paths are NFC towards the engine. A file whose on-disk name is not NFC (Android, Linux) is
//   remembered under its NFC form so reads and writes reach the real file.
// - Events are registered when the engine asks (after `workspace.onLayoutReady`, so the load-time
//   `create` burst never reaches it); the configuration folder is watched through the undocumented
//   `raw` event (P0 M13).

import type { Disposable, LocalEvent, LocalFs, LocalFsErrorCode, LocalPlatform, LocalStat, RemoveMode } from "@shuttle/protocol";

// ---------- the Obsidian surface used here (structural, so tests can pass a fake) ----------

export interface FileStatLike { ctime: number; mtime: number; size: number }
export interface AbstractFileLike { path: string; name: string }
export interface FileLike extends AbstractFileLike { stat: FileStatLike; extension: string }
export interface FolderLike extends AbstractFileLike { children: AbstractFileLike[] }
export interface AdapterStat { type: "file" | "folder"; ctime: number; mtime: number; size: number }
export interface WriteOpts { mtime?: number; ctime?: number }

export interface AdapterLike {
  exists(path: string, sensitive?: boolean): Promise<boolean>;
  stat(path: string): Promise<AdapterStat | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer, opts?: WriteOpts): Promise<void>;
  mkdir(path: string): Promise<void>;
  trashSystem(path: string): Promise<boolean>;
  trashLocal(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface VaultLike {
  readonly configDir: string;
  readonly adapter: AdapterLike;
  getAbstractFileByPath(path: string): AbstractFileLike | null;
  getFiles(): FileLike[];
  modifyBinary(file: FileLike, data: ArrayBuffer, opts?: WriteOpts): Promise<void>;
  createBinary(path: string, data: ArrayBuffer, opts?: WriteOpts): Promise<FileLike>;
  createFolder(path: string): Promise<unknown>;
  rename(file: AbstractFileLike, newPath: string): Promise<void>;
  delete(file: AbstractFileLike, force?: boolean): Promise<void>;
  process(file: FileLike, fn: (data: string) => string, opts?: WriteOpts): Promise<string>;
  on(name: string, cb: (...args: never[]) => unknown): unknown;
  offref(ref: unknown): void;
}

export interface FileManagerLike { trashFile(file: AbstractFileLike): Promise<void> }

export interface ObsidianLocalFsOptions {
  vault: VaultLike;
  fileManager: FileManagerLike;
  platform: LocalPlatform;
  caseInsensitive: boolean;
  /** Stats per listAll() batch (design §3.15: yield every 250-500 items). */
  listBatch?: number;
}

const FS_CODES: readonly LocalFsErrorCode[] = ["ENOENT", "EEXIST", "ENOSPC", "EACCES", "EISDIR", "ENOTDIR", "ENOTEMPTY", "EIO"];

export class PluginFsError extends Error {
  constructor(readonly code: LocalFsErrorCode, readonly path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    this.name = "PluginFsError";
  }
}

/** Map an adapter error (Node errors on desktop, Capacitor messages on mobile) to a LocalFs code. */
export function fsCodeOf(e: unknown): LocalFsErrorCode {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === "string" && (FS_CODES as readonly string[]).includes(c)) return c as LocalFsErrorCode;
  if (c === "EPERM") return "EACCES";
  const m = e instanceof Error ? e.message : String(e);
  if (/ENOENT|no such file|does not exist|not exist|not found/i.test(m)) return "ENOENT";
  if (/EEXIST|already exists/i.test(m)) return "EEXIST";
  if (/ENOSPC|no space|quota/i.test(m)) return "ENOSPC";
  if (/EACCES|EPERM|permission|not permitted/i.test(m)) return "EACCES";
  if (/ENOTEMPTY|not empty/i.test(m)) return "ENOTEMPTY";
  if (/EISDIR|is a directory/i.test(m)) return "EISDIR";
  if (/ENOTDIR|not a directory/i.test(m)) return "ENOTDIR";
  return "EIO";
}

function wrap(e: unknown, path: string): PluginFsError {
  if (e instanceof PluginFsError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new PluginFsError(fsCodeOf(e), path, msg);
}

function isFolder(f: AbstractFileLike | null): f is FolderLike {
  return !!f && Array.isArray((f as Partial<FolderLike>).children);
}
function isFile(f: AbstractFileLike | null): f is FileLike {
  return !!f && !isFolder(f) && typeof (f as Partial<FileLike>).stat === "object";
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const nfc = (p: string): string => p.normalize("NFC");

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export class ObsidianLocalFs implements LocalFs {
  readonly platform: LocalPlatform;
  readonly caseInsensitive: boolean;
  readonly configDir: string;
  private readonly vault: VaultLike;
  private readonly fm: FileManagerLike;
  private readonly batch: number;
  /** NFC path → on-disk path, only for names that are not NFC on disk. */
  private readonly real = new Map<string, string>();
  private readonly refs = new Set<unknown>();

  constructor(o: ObsidianLocalFsOptions) {
    this.vault = o.vault;
    this.fm = o.fileManager;
    this.platform = o.platform;
    this.caseInsensitive = o.caseInsensitive;
    this.configDir = o.vault.configDir;
    this.batch = Math.max(1, o.listBatch ?? 400);
  }

  /** Paths Vault does not index: the configuration folder and every dot path. */
  private viaAdapter(p: string): boolean {
    return p.split("/").some((seg) => seg.startsWith("."));
  }

  private isConfig(p: string): boolean {
    return p === this.configDir || p.startsWith(this.configDir + "/");
  }

  /** The on-disk path for an engine (NFC) path. */
  private disk(p: string): string {
    return this.real.get(p) ?? p;
  }

  private note(diskPath: string): string {
    const n = nfc(diskPath);
    if (n !== diskPath) this.real.set(n, diskPath);
    return n;
  }

  private abs(p: string): AbstractFileLike | null {
    return this.vault.getAbstractFileByPath(this.disk(p));
  }

  async *listAll(opts: { includeConfigDir: boolean }): AsyncIterable<LocalStat[]> {
    let out: LocalStat[] = [];
    for (const f of this.vault.getFiles()) {
      out.push({ path: this.note(f.path), kind: "file", size: f.stat.size, mtime: f.stat.mtime, ctime: f.stat.ctime });
      if (out.length >= this.batch) {
        yield out;
        out = [];
      }
    }
    if (opts.includeConfigDir) {
      const stack = [this.configDir];
      while (stack.length) {
        const dir = stack.pop() as string;
        let l: { files: string[]; folders: string[] };
        try {
          l = await this.vault.adapter.list(dir);
        } catch {
          continue; // configDir missing or unreadable: nothing to list
        }
        for (const sub of l.folders) stack.push(sub);
        for (const fp of l.files) {
          const st = await this.vault.adapter.stat(fp).catch(() => null);
          if (!st || st.type !== "file") continue;
          out.push({ path: this.note(fp), kind: "file", size: st.size, mtime: st.mtime, ctime: st.ctime });
          if (out.length >= this.batch) {
            yield out;
            out = [];
          }
        }
      }
    }
    if (out.length) yield out;
  }

  async stat(path: string): Promise<LocalStat | null> {
    // Always the adapter (not Vault's cached TFile.stat): after an external change the cache can lag
    // behind the disk until Obsidian's watcher catches up.
    let st: AdapterStat | null;
    try {
      st = await this.vault.adapter.stat(this.disk(path));
    } catch (e) {
      if (fsCodeOf(e) === "ENOENT") return null;
      throw wrap(e, path);
    }
    if (!st) return null;
    return { path, kind: st.type, size: st.type === "file" ? st.size : 0, mtime: st.mtime, ctime: st.ctime };
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.abs(path);
    if (isFolder(f)) throw new PluginFsError("EISDIR", path);
    try {
      return new Uint8Array(await this.vault.adapter.readBinary(this.disk(path)));
    } catch (e) {
      throw wrap(e, path);
    }
  }

  async processText(path: string, fn: (current: string) => string | null): Promise<boolean> {
    const f = this.abs(path);
    if (!isFile(f)) return false;
    let aborted = false;
    try {
      await this.vault.process(f, (cur) => {
        const next = fn(cur);
        if (next === null) {
          aborted = true;
          return cur;
        }
        return next;
      });
    } catch (e) {
      throw wrap(e, path);
    }
    return !aborted;
  }

  async write(path: string, data: Uint8Array, opts: { mtime: number; ctime?: number }): Promise<LocalStat> {
    const buf = toBuffer(data);
    const wopts: WriteOpts = { mtime: opts.mtime, ...(opts.ctime !== undefined ? { ctime: opts.ctime } : {}) };
    const parent = parentOf(path);
    if (parent) await this.mkdirp(parent);
    const disk = this.disk(path);
    try {
      if (this.viaAdapter(path)) {
        await this.vault.adapter.writeBinary(disk, buf, wopts);
      } else {
        const f = this.vault.getAbstractFileByPath(disk);
        if (isFolder(f)) throw new PluginFsError("EISDIR", path);
        if (isFile(f)) await this.vault.modifyBinary(f, buf, wopts);
        else {
          try {
            await this.vault.createBinary(disk, buf, wopts);
          } catch (e) {
            // The file exists on disk but Vault has not indexed it yet: write it directly.
            if (fsCodeOf(e) !== "EEXIST") throw e;
            await this.vault.adapter.writeBinary(disk, buf, wopts);
          }
        }
      }
    } catch (e) {
      throw wrap(e, path);
    }
    const st = await this.stat(path);
    if (st && st.kind === "file") return st;
    return { path, kind: "file", size: data.byteLength, mtime: opts.mtime, ctime: opts.ctime ?? opts.mtime };
  }

  async rename(from: string, to: string): Promise<void> {
    const parent = parentOf(to);
    if (parent) await this.mkdirp(parent);
    const f = this.abs(from);
    try {
      if (f && !this.viaAdapter(from) && !this.viaAdapter(to)) await this.vault.rename(f, to);
      else await this.vault.adapter.rename(this.disk(from), to);
    } catch (e) {
      throw wrap(e, from);
    }
    const d = this.real.get(from);
    if (d !== undefined) this.real.delete(from);
    this.note(to);
  }

  async remove(path: string, mode: RemoveMode): Promise<void> {
    const f = this.abs(path);
    try {
      if (f && !this.viaAdapter(path)) {
        if (mode === "trash") await this.fm.trashFile(f);
        else await this.vault.delete(f, true);
      } else {
        const disk = this.disk(path);
        const st = await this.vault.adapter.stat(disk);
        if (!st) throw new PluginFsError("ENOENT", path);
        if (mode === "trash") {
          const ok = await this.vault.adapter.trashSystem(disk).catch(() => false);
          if (!ok) await this.vault.adapter.trashLocal(disk);
        } else if (st.type === "folder") await this.vault.adapter.rmdir(disk, true);
        else await this.vault.adapter.remove(disk);
      }
    } catch (e) {
      throw wrap(e, path);
    }
    this.real.delete(path);
  }

  async mkdirp(path: string): Promise<void> {
    const segs = path.split("/").filter(Boolean);
    let cur = "";
    for (const s of segs) {
      cur = cur ? `${cur}/${s}` : s;
      const disk = this.disk(cur);
      const known = this.vault.getAbstractFileByPath(disk);
      if (isFolder(known)) continue;
      if (isFile(known)) throw new PluginFsError("ENOTDIR", cur);
      try {
        if (await this.vault.adapter.exists(disk)) {
          const st = await this.vault.adapter.stat(disk);
          if (st && st.type !== "folder") throw new PluginFsError("ENOTDIR", cur);
          continue;
        }
        if (this.viaAdapter(cur)) await this.vault.adapter.mkdir(disk);
        else await this.vault.createFolder(disk);
      } catch (e) {
        if (e instanceof PluginFsError) throw e;
        // Created concurrently (another event, the user): fine when it is a folder now.
        const st = await this.vault.adapter.stat(disk).catch(() => null);
        if (st?.type === "folder") continue;
        throw wrap(e, cur);
      }
    }
  }

  async rmdirIfEmpty(path: string): Promise<boolean> {
    const disk = this.disk(path);
    let l: { files: string[]; folders: string[] };
    try {
      l = await this.vault.adapter.list(disk);
    } catch {
      return false;
    }
    if (l.files.length > 0 || l.folders.length > 0) return false;
    const f = this.vault.getAbstractFileByPath(disk);
    try {
      if (isFolder(f) && !this.viaAdapter(path)) await this.vault.delete(f, false);
      else await this.vault.adapter.rmdir(disk, false);
    } catch (e) {
      const c = fsCodeOf(e);
      if (c === "ENOENT" || c === "ENOTEMPTY") return false;
      throw wrap(e, path);
    }
    return true;
  }

  onEvent(cb: (e: LocalEvent) => void): Disposable {
    const v = this.vault;
    const refs: unknown[] = [];
    const statOf = (f: FileLike): LocalStat => ({ path: this.note(f.path), kind: "file", size: f.stat.size, mtime: f.stat.mtime, ctime: f.stat.ctime });
    const kindOf = (f: AbstractFileLike): "file" | "folder" => (isFolder(f) ? "folder" : "file");
    refs.push(v.on("create", ((f: AbstractFileLike) => {
      if (isFile(f)) cb({ t: "create", path: this.note(f.path), stat: statOf(f) });
    }) as (...a: never[]) => unknown));
    refs.push(v.on("modify", ((f: AbstractFileLike) => {
      if (isFile(f)) cb({ t: "modify", path: this.note(f.path), stat: statOf(f) });
    }) as (...a: never[]) => unknown));
    refs.push(v.on("delete", ((f: AbstractFileLike) => {
      const p = nfc(f.path);
      this.real.delete(p);
      cb({ t: "delete", path: p, kind: kindOf(f) });
    }) as (...a: never[]) => unknown));
    refs.push(v.on("rename", ((f: AbstractFileLike, oldPath: string) => {
      const from = nfc(oldPath);
      this.real.delete(from);
      cb({ t: "rename", from, to: this.note(f.path), kind: kindOf(f) });
    }) as (...a: never[]) => unknown));
    // `raw` fires for every change under the vault folder; only configDir paths are forwarded,
    // the rest already arrive as create/modify/delete/rename above.
    refs.push(v.on("raw", ((p: string) => {
      if (typeof p === "string" && this.isConfig(p)) cb({ t: "raw", path: this.note(p) });
    }) as (...a: never[]) => unknown));
    for (const r of refs) this.refs.add(r);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const r of refs) {
          v.offref(r);
          this.refs.delete(r);
        }
      },
    };
  }

  /** Unregister every event handler (plugin unload). */
  dispose(): void {
    for (const r of this.refs) this.vault.offref(r);
    this.refs.clear();
  }
}
