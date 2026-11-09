// In-memory index with write-through to the StateStore (design §3.3.3, §3.6; engine-spec §2.3).
//
// Startup: one getAll() on `files` and `remote` fills the maps. Every mutation runs inside ONE
// StateStore transaction; the memory maps change only after that transaction committed, so a failed
// transaction leaves memory as it was ("rollback"). Writes are serialized through an internal queue so
// memory is updated in commit order.
//
// Remote mirror monotonicity (design §3.6.3, S12): IndexWriter.upsertRemote keeps the record with the
// maximum seq. Ingest and the ack transaction (part 2) MUST write `remote` through it.

import type { FileEntry, FileId, FileKind, LocalStat, PathKey, RemoteHead, Scope, StateStore, StateTx, StoreName } from "@shuttle/protocol";
import { foldKey, isUnder } from "../path/normalize";

class MultiMap<K, V> {
  private m = new Map<K, Set<V>>();
  add(k: K, v: V): void {
    let s = this.m.get(k);
    if (!s) this.m.set(k, (s = new Set()));
    s.add(v);
  }
  remove(k: K, v: V): void {
    const s = this.m.get(k);
    if (!s) return;
    s.delete(v);
    if (s.size === 0) this.m.delete(k);
  }
  get(k: K): ReadonlySet<V> {
    return this.m.get(k) ?? EMPTY;
  }
  clear(): void { this.m.clear(); }
}
const EMPTY: ReadonlySet<never> = new Set();

const clone = <T>(v: T): T => structuredClone(v);

/** Read-only view of the decrypted remote heads (design §3.3.3 remote byFileId, byPathKey). */
export class RemoteMirror {
  private byId = new Map<FileId, RemoteHead>();
  private liveByPk = new MultiMap<PathKey, FileId>();
  private liveByFold = new MultiMap<string, FileId>();
  private tombByFold = new MultiMap<string, FileId>();

  byFileId(id: FileId): RemoteHead | null {
    return this.byId.get(id) ?? null;
  }

  private best(ids: ReadonlySet<FileId>): RemoteHead | null {
    let out: RemoteHead | null = null;
    for (const id of ids) {
      const h = this.byId.get(id);
      if (h && (!out || h.seq > out.seq)) out = h;
    }
    return out;
  }

  liveByPathKey(pk: PathKey): RemoteHead | null {
    return this.best(this.liveByPk.get(pk));
  }

  /** The live head at this foldKey (the newest if a server bug left two). */
  liveByFoldKey(fk: string): RemoteHead | null {
    return this.best(this.liveByFold.get(fk));
  }

  /** The newest tombstone whose path folds to `fk` (rows N1/N6). */
  tombstoneByFoldKey(fk: string): RemoteHead | null {
    return this.best(this.tombByFold.get(fk));
  }

  /** Live head at fk if any, else the newest tombstone there (Planner input R when there is no base). */
  headForFoldKey(fk: string): RemoteHead | null {
    return this.liveByFoldKey(fk) ?? this.tombstoneByFoldKey(fk);
  }

  all(): IterableIterator<RemoteHead> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }

  /** @internal */
  _set(h: RemoteHead): void {
    this._delete(h.fileId);
    this.byId.set(h.fileId, h);
    const fk = foldKey(h.path);
    if (h.deleted) this.tombByFold.add(fk, h.fileId);
    else {
      this.liveByPk.add(h.pathKey, h.fileId);
      this.liveByFold.add(fk, h.fileId);
    }
  }

  /** @internal */
  _delete(id: FileId): void {
    const old = this.byId.get(id);
    if (!old) return;
    this.byId.delete(id);
    const fk = foldKey(old.path);
    this.tombByFold.remove(fk, id);
    this.liveByPk.remove(old.pathKey, id);
    this.liveByFold.remove(fk, id);
  }

  /** @internal */
  _clear(): void {
    this.byId.clear();
    this.liveByPk.clear();
    this.liveByFold.clear();
    this.tombByFold.clear();
  }
}

type MemOp =
  | { t: "putEntry"; e: FileEntry }
  | { t: "delEntry"; id: FileId }
  | { t: "putRemote"; h: RemoteHead }
  | { t: "delRemote"; id: FileId };

/** Handle passed to FileIndex.write(); reads see this transaction's own pending writes. */
export interface IndexWriter {
  /** The raw transaction, for other stores named in write(extra). Do not write `files`/`remote` through it. */
  readonly tx: StateTx;
  entry(fileId: FileId): FileEntry | null;
  entryByPath(path: string): FileEntry | null;
  putEntry(e: FileEntry): Promise<void>;
  /** Removes the entry and its base row. */
  deleteEntry(fileId: FileId): Promise<void>;
  remote(fileId: FileId): RemoteHead | null;
  /** Keeps the max seq (design §3.6.3). Returns false when an equal-or-newer head is already stored. */
  upsertRemote(h: RemoteHead): Promise<boolean>;
  deleteRemote(fileId: FileId): Promise<void>;
}

export class FileIndex {
  private byId = new Map<FileId, FileEntry>();
  private byPathMap = new Map<string, FileId>();
  private byFold = new MultiMap<string, FileId>();
  readonly remote = new RemoteMirror();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly state: StateStore, private readonly now: () => number) {}

  /** design §3.3.3: one getAll() on files and remote. */
  static async load(state: StateStore, now: () => number): Promise<FileIndex> {
    const ix = new FileIndex(state, now);
    const [files, remote] = await state.tx(["files", "remote"], async (tx) => [await tx.files.getAll(), await tx.remote.getAll()] as const, "readonly");
    for (const e of files) ix.memPutEntry(e);
    for (const h of remote) ix.remote._set(h);
    return ix;
  }

  // ---------- reads (committed state) ----------

  byFileId(id: FileId): FileEntry | null {
    const e = this.byId.get(id);
    return e ? clone(e) : null;
  }

  /** Exact (case-sensitive, NFC) path lookup. */
  byPath(path: string): FileEntry | null {
    const id = this.byPathMap.get(path);
    return id ? this.byFileId(id) : null;
  }

  /** All entries whose path folds to `fk` (several on case-sensitive platforms). */
  byFoldKey(fk: string): FileEntry[] {
    return [...this.byFold.get(fk)].map((id) => this.byFileId(id)).filter((e): e is FileEntry => e !== null);
  }

  /** Entry lookup by dirty key: fileId first, then exact path. */
  lookup(key: { fileId?: FileId; path: string }): FileEntry | null {
    return (key.fileId ? this.byFileId(key.fileId) : null) ?? this.byPath(key.path);
  }

  /** Entries strictly under folder `folder` (folder delete/rename expansion, design §3.5). */
  entriesUnder(folder: string): FileEntry[] {
    const out: FileEntry[] = [];
    for (const e of this.byId.values()) if (isUnder(e.path, folder)) out.push(clone(e));
    return out;
  }

  *all(): IterableIterator<FileEntry> {
    for (const e of this.byId.values()) yield clone(e);
  }

  *allActive(): IterableIterator<FileEntry> {
    for (const e of this.byId.values()) if (e.scope === "active") yield clone(e);
  }

  activeCount(): number {
    let n = 0;
    for (const e of this.byId.values()) if (e.scope === "active") n++;
    return n;
  }

  countByScope(): Partial<Record<Scope, number>> {
    const out: Partial<Record<Scope, number>> = {};
    for (const e of this.byId.values()) out[e.scope] = (out[e.scope] ?? 0) + 1;
    return out;
  }

  get size(): number {
    return this.byId.size;
  }

  // ---------- writes ----------

  /**
   * Run `fn` in one transaction over `files`, `remote`, `bases` and `extra`. Memory changes apply only
   * after commit. `fn` must await only operations of this transaction (StateStore contract).
   */
  write<T>(extra: readonly StoreName[], fn: (w: IndexWriter) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const stores = [...new Set<StoreName>(["files", "remote", "bases", ...extra])];
      const ops: MemOp[] = [];
      const result = await this.state.tx(stores, async (tx) => {
        ops.length = 0;
        return fn(this.writer(tx, ops));
      });
      for (const op of ops) this.applyMem(op);
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private writer(tx: StateTx, ops: MemOp[]): IndexWriter {
    const pendingEntries = new Map<FileId, FileEntry | null>();
    const pendingPaths = new Map<string, FileId | null>();
    const pendingRemote = new Map<FileId, RemoteHead | null>();
    const self = this;
    const entry = (id: FileId): FileEntry | null => {
      if (pendingEntries.has(id)) {
        const e = pendingEntries.get(id);
        return e ? clone(e) : null;
      }
      return self.byFileId(id);
    };
    return {
      tx,
      entry,
      entryByPath(path) {
        if (pendingPaths.has(path)) {
          const id = pendingPaths.get(path);
          return id ? entry(id) : null;
        }
        const id = self.byPathMap.get(path);
        if (!id) return null;
        const e = entry(id);
        return e && e.path === path ? e : null;
      },
      async putEntry(e) {
        const v = clone({ ...e, foldKey: foldKey(e.path) });
        await tx.files.put(v);
        const old = entry(v.fileId);
        if (old && old.path !== v.path) pendingPaths.set(old.path, null);
        pendingPaths.set(v.path, v.fileId);
        pendingEntries.set(v.fileId, v);
        ops.push({ t: "putEntry", e: v });
      },
      async deleteEntry(id) {
        const old = entry(id);
        await tx.files.delete(id);
        await tx.bases.delete(id);
        if (old) pendingPaths.set(old.path, null);
        pendingEntries.set(id, null);
        ops.push({ t: "delEntry", id });
      },
      remote(id) {
        if (pendingRemote.has(id)) {
          const h = pendingRemote.get(id);
          return h ? clone(h) : null;
        }
        return self.remote.byFileId(id);
      },
      async upsertRemote(h) {
        const cur = await tx.remote.get(h.fileId);
        if (cur && cur.seq >= h.seq) return false;
        const v = clone(h);
        await tx.remote.put(v);
        pendingRemote.set(v.fileId, v);
        ops.push({ t: "putRemote", h: v });
        return true;
      },
      async deleteRemote(id) {
        await tx.remote.delete(id);
        pendingRemote.set(id, null);
        ops.push({ t: "delRemote", id });
      },
    };
  }

  private applyMem(op: MemOp): void {
    switch (op.t) {
      case "putEntry": this.memPutEntry(op.e); break;
      case "delEntry": this.memDelEntry(op.id); break;
      case "putRemote": this.remote._set(op.h); break;
      case "delRemote": this.remote._delete(op.id); break;
    }
  }

  private memDelEntry(id: FileId): void {
    const old = this.byId.get(id);
    if (!old) return;
    this.byId.delete(id);
    if (this.byPathMap.get(old.path) === id) this.byPathMap.delete(old.path);
    this.byFold.remove(old.foldKey, id);
  }

  private memPutEntry(e: FileEntry): void {
    this.memDelEntry(e.fileId);
    this.byId.set(e.fileId, e);
    this.byPathMap.set(e.path, e.fileId);
    this.byFold.add(e.foldKey, e.fileId);
  }

  // ---------- convenience mutations (each one transaction) ----------

  /** New entry (fresh fileId chosen by the caller). Throws StateStoreError CONSTRAINT if the path is held. */
  async createEntry(o: { fileId: FileId; path: string; scope: Scope; kind: FileKind; obs: FileEntry["obs"] }): Promise<FileEntry> {
    const e: FileEntry = {
      fileId: o.fileId, path: o.path, foldKey: foldKey(o.path), scope: o.scope, kind: o.kind, obs: o.obs, synced: null, updatedAt: this.now(),
    };
    await this.write([], (w) => w.putEntry(e));
    return clone(e);
  }

  /** Untracked file outside the active scope: entry with the scope flag and no hash (design §3.4.1). */
  trackOutOfScope(o: { fileId: FileId; st: LocalStat; scope: Scope; kind: FileKind }): Promise<FileEntry> {
    return this.createEntry({
      fileId: o.fileId, path: o.st.path, scope: o.scope, kind: o.kind,
      obs: { mtime: o.st.mtime, size: o.st.size, hash: null, ...(o.st.ino !== undefined ? { ino: o.st.ino } : {}), ...(o.st.ctimeMs !== undefined ? { ctimeMs: o.st.ctimeMs } : {}) },
    });
  }

  /** Apply `patch` to the entry; returns the new entry or null if it no longer exists. */
  update(fileId: FileId, patch: (e: FileEntry) => FileEntry | void): Promise<FileEntry | null> {
    return this.write([], async (w) => {
      const e = w.entry(fileId);
      if (!e) return null;
      const next = patch(e) ?? e;
      next.updatedAt = this.now();
      await w.putEntry(next);
      return clone({ ...next, foldKey: foldKey(next.path) });
    });
  }

  setScope(fileId: FileId, scope: Scope): Promise<FileEntry | null> {
    return this.update(fileId, (e) => { e.scope = scope; });
  }

  updateObs(fileId: FileId, obs: FileEntry["obs"]): Promise<FileEntry | null> {
    return this.update(fileId, (e) => { e.obs = obs; });
  }

  /** Path change (rename rule §3.6.1). Throws StateStoreError CONSTRAINT if `to` is held. */
  setPath(fileId: FileId, to: string): Promise<FileEntry | null> {
    return this.update(fileId, (e) => { e.path = to; e.foldKey = foldKey(to); });
  }

  /** Drop the entry and its base (FORGET). */
  forget(fileId: FileId): Promise<void> {
    return this.write([], (w) => w.deleteEntry(fileId));
  }

  /** Remote head write keeping the max seq (design §3.6.3). */
  upsertRemote(h: RemoteHead): Promise<boolean> {
    return this.write([], (w) => w.upsertRemote(h));
  }
}
