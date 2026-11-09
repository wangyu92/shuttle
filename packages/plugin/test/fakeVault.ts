// In-memory stand-in for Obsidian's Vault, DataAdapter and FileManager (the subset ObsidianLocalFs
// uses). Behaviour follows Obsidian where the plugin depends on it: Vault indexes only paths without
// dot segments, createBinary refuses an existing file and a missing parent, DataAdapter.rename refuses
// an existing destination, `raw` fires for every change, trashFile moves into `.trash/`.

import type { AbstractFileLike, AdapterLike, AdapterStat, FileLike, FileManagerLike, FolderLike, VaultLike, WriteOpts } from "../src/platform/ObsidianLocalFs";

interface Node { kind: "file" | "folder"; bytes: Uint8Array; mtime: number; ctime: number }
type Cb = (...a: unknown[]) => unknown;

const parent = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const hidden = (p: string): boolean => p.split("/").some((s) => s.startsWith("."));
const err = (code: string, msg: string): Error => Object.assign(new Error(msg), { code });

export class FakeVault implements VaultLike {
  readonly nodes = new Map<string, Node>();
  private readonly handlers = new Map<string, Set<Cb>>();
  readonly adapter: AdapterLike;
  readonly fileManager: FileManagerLike;
  now = 1_700_000_000_000;
  /** Calls by method name (assertions). */
  readonly calls: string[] = [];

  constructor(readonly configDir = ".obsidian") {
    this.adapter = this.makeAdapter();
    this.fileManager = { trashFile: async (f) => { this.calls.push(`trashFile:${f.path}`); this.moveToTrash(f.path, true); } };
    this.nodes.set(configDir, { kind: "folder", bytes: new Uint8Array(0), mtime: this.now, ctime: this.now });
  }

  // ---------- events ----------
  on(name: string, cb: (...args: never[]) => unknown): unknown {
    let s = this.handlers.get(name);
    if (!s) { s = new Set(); this.handlers.set(name, s); }
    s.add(cb as Cb);
    return { name, cb };
  }
  offref(ref: unknown): void {
    const r = ref as { name: string; cb: Cb };
    this.handlers.get(r.name)?.delete(r.cb);
  }
  listenerCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }
  private emit(name: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(name) ?? [])]) cb(...args);
  }
  private emitChange(kind: "create" | "modify", p: string): void {
    this.emit("raw", p);
    if (!hidden(p)) this.emit(kind, this.getAbstractFileByPath(p));
  }

  // ---------- Vault ----------
  private tfile(p: string, n: Node): FileLike {
    const name = base(p);
    return { path: p, name, extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "", stat: { size: n.bytes.length, mtime: n.mtime, ctime: n.ctime } };
  }
  getAbstractFileByPath(p: string): AbstractFileLike | null {
    if (hidden(p)) return null;
    const n = this.nodes.get(p);
    if (!n) return null;
    if (n.kind === "file") return this.tfile(p, n);
    const children = [...this.nodes.keys()].filter((k) => parent(k) === p).map((k) => ({ path: k, name: base(k) }));
    return { path: p, name: base(p), children } as FolderLike;
  }
  getFiles(): FileLike[] {
    return [...this.nodes].filter(([p, n]) => n.kind === "file" && !hidden(p)).map(([p, n]) => this.tfile(p, n));
  }
  async modifyBinary(f: FileLike, data: ArrayBuffer, o?: WriteOpts): Promise<void> {
    this.calls.push(`modifyBinary:${f.path}`);
    const n = this.nodes.get(f.path);
    if (!n || n.kind !== "file") throw err("ENOENT", "File does not exist");
    this.put(f.path, new Uint8Array(data), o);
    this.emitChange("modify", f.path);
  }
  async createBinary(p: string, data: ArrayBuffer, o?: WriteOpts): Promise<FileLike> {
    this.calls.push(`createBinary:${p}`);
    if (this.nodes.has(p)) throw new Error("File already exists.");
    if (parent(p) && this.nodes.get(parent(p))?.kind !== "folder") throw err("ENOENT", "no such file or directory");
    this.put(p, new Uint8Array(data), o);
    this.emitChange("create", p);
    return this.tfile(p, this.nodes.get(p) as Node);
  }
  async createFolder(p: string): Promise<unknown> {
    this.calls.push(`createFolder:${p}`);
    if (this.nodes.has(p)) throw new Error("Folder already exists.");
    this.mkdirs(p);
    return this.getAbstractFileByPath(p);
  }
  async rename(f: AbstractFileLike, to: string): Promise<void> {
    this.calls.push(`rename:${f.path}->${to}`);
    this.move(f.path, to);
  }
  async delete(f: AbstractFileLike): Promise<void> {
    this.calls.push(`delete:${f.path}`);
    const n = this.nodes.get(f.path);
    if (!n) throw err("ENOENT", "File does not exist");
    for (const k of [...this.nodes.keys()]) if (k === f.path || k.startsWith(f.path + "/")) this.nodes.delete(k);
    this.emit("raw", f.path);
    this.emit("delete", { ...f, ...(n.kind === "folder" ? { children: [] } : { stat: { size: 0, mtime: 0, ctime: 0 }, extension: "" }) });
  }
  async process(f: FileLike, fn: (data: string) => string): Promise<string> {
    const n = this.nodes.get(f.path);
    if (!n) throw err("ENOENT", "File does not exist");
    const cur = new TextDecoder().decode(n.bytes);
    const next = fn(cur);
    if (next !== cur) {
      this.put(f.path, new TextEncoder().encode(next));
      this.emitChange("modify", f.path);
    }
    return next;
  }

  // ---------- helpers ----------
  private put(p: string, bytes: Uint8Array, o?: WriteOpts): void {
    this.now += 1000;
    const prev = this.nodes.get(p);
    this.nodes.set(p, { kind: "file", bytes: bytes.slice(), mtime: o?.mtime ?? this.now, ctime: o?.ctime ?? prev?.ctime ?? this.now });
  }
  private mkdirs(p: string): void {
    let cur = "";
    for (const s of p.split("/").filter(Boolean)) {
      cur = cur ? `${cur}/${s}` : s;
      if (this.nodes.has(cur)) continue;
      this.nodes.set(cur, { kind: "folder", bytes: new Uint8Array(0), mtime: this.now, ctime: this.now });
      this.emit("raw", cur);
      if (!hidden(cur)) this.emit("create", this.getAbstractFileByPath(cur));
    }
  }
  private move(from: string, to: string): void {
    const n = this.nodes.get(from);
    if (!n) throw err("ENOENT", "File does not exist");
    if (this.nodes.has(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error("Destination file already exists!");
    if (parent(to) && this.nodes.get(parent(to))?.kind !== "folder") throw err("ENOENT", "no such file or directory");
    for (const k of [...this.nodes.keys()].sort()) {
      if (k === from || k.startsWith(from + "/")) {
        const v = this.nodes.get(k) as Node;
        this.nodes.delete(k);
        this.nodes.set(to + k.slice(from.length), v);
      }
    }
    this.emit("raw", to);
    if (!hidden(to)) this.emit("rename", this.getAbstractFileByPath(to), from);
  }
  private moveToTrash(p: string, emitDelete: boolean): void {
    const n = this.nodes.get(p);
    if (!n) throw err("ENOENT", "File does not exist");
    if (!this.nodes.has(".trash")) this.nodes.set(".trash", { kind: "folder", bytes: new Uint8Array(0), mtime: this.now, ctime: this.now });
    let dest = `.trash/${base(p)}`;
    for (let i = 1; this.nodes.has(dest); i++) dest = `.trash/${i}-${base(p)}`;
    for (const k of [...this.nodes.keys()]) {
      if (k === p || k.startsWith(p + "/")) {
        const v = this.nodes.get(k) as Node;
        this.nodes.delete(k);
        this.nodes.set(dest + k.slice(p.length), v);
      }
    }
    this.emit("raw", p);
    if (emitDelete && !hidden(p)) this.emit("delete", n.kind === "folder" ? { path: p, name: base(p), children: [] } : { path: p, name: base(p), stat: { size: 0, mtime: 0, ctime: 0 }, extension: "" });
  }

  /** A change by the user or another app (Obsidian's watcher fires the events). */
  userWrite(p: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const existed = this.nodes.has(p);
    if (parent(p)) this.mkdirs(parent(p));
    this.put(p, bytes);
    this.emitChange(existed ? "modify" : "create", p);
  }
  text(p: string): string | null {
    const n = this.nodes.get(p);
    return n && n.kind === "file" ? new TextDecoder().decode(n.bytes) : null;
  }

  private makeAdapter(): AdapterLike {
    return {
      exists: async (p) => this.nodes.has(p),
      stat: async (p): Promise<AdapterStat | null> => {
        const n = this.nodes.get(p);
        return n ? { type: n.kind, size: n.kind === "file" ? n.bytes.length : 0, mtime: n.mtime, ctime: n.ctime } : null;
      },
      list: async (p) => {
        const n = this.nodes.get(p);
        if (!n || n.kind !== "folder") throw err("ENOENT", "no such file or directory");
        const kids = [...this.nodes.keys()].filter((k) => parent(k) === p);
        return { files: kids.filter((k) => this.nodes.get(k)?.kind === "file"), folders: kids.filter((k) => this.nodes.get(k)?.kind === "folder") };
      },
      readBinary: async (p) => {
        const n = this.nodes.get(p);
        if (!n || n.kind !== "file") throw err("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
        return n.bytes.slice().buffer;
      },
      writeBinary: async (p, data, o) => {
        this.calls.push(`adapter.writeBinary:${p}`);
        if (parent(p) && this.nodes.get(parent(p))?.kind !== "folder") throw err("ENOENT", "no such file or directory");
        const existed = this.nodes.has(p);
        this.put(p, new Uint8Array(data), o);
        this.emitChange(existed ? "modify" : "create", p);
      },
      mkdir: async (p) => { this.mkdirs(p); },
      trashSystem: async () => false,
      trashLocal: async (p) => { this.calls.push(`trashLocal:${p}`); this.moveToTrash(p, false); },
      rmdir: async (p, recursive) => {
        const kids = [...this.nodes.keys()].filter((k) => k.startsWith(p + "/"));
        if (kids.length && !recursive) throw err("ENOTEMPTY", "directory not empty");
        for (const k of [p, ...kids]) this.nodes.delete(k);
        this.emit("raw", p);
      },
      remove: async (p) => {
        this.calls.push(`adapter.remove:${p}`);
        if (!this.nodes.delete(p)) throw err("ENOENT", "no such file");
        this.emit("raw", p);
      },
      rename: async (from, to) => { this.move(from, to); },
    };
  }
}
