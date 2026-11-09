// A small in-memory IndexedDB for the IdbStateStore tests (fake-indexeddb is not a dependency).
// It models the parts the store relies on, following the IndexedDB spec:
//  - requests complete asynchronously (one macrotask each, in order); a transaction commits
//    automatically once a macrotask passes with no pending request;
//  - a failed request fires `error` on the request and, unless prevented, aborts the transaction;
//  - booleans, null and NaN are not valid keys (records with such index values are not indexed);
//  - key order: numbers < strings (UTF-16 code units); index entries with equal keys by primary key;
//  - unique indexes raise ConstraintError; autoIncrement generators are rolled back on abort;
//  - opening with a lower version than stored fails with VersionError.
// Not modelled: Date/array/binary keys, multiEntry, concurrent transaction scheduling (the store
// under test serializes its transactions itself).

type Key = number | string;

class FakeDomError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

function validKey(k: unknown): k is Key {
  return (typeof k === "number" && !Number.isNaN(k)) || typeof k === "string";
}

export function cmp(a: unknown, b: unknown): number {
  if (!validKey(a) || !validKey(b)) throw new FakeDomError("DataError", "invalid key");
  const ta = typeof a === "number" ? 0 : 1;
  const tb = typeof b === "number" ? 0 : 1;
  if (ta !== tb) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class FakeKeyRange {
  constructor(readonly lower: Key | undefined, readonly upper: Key | undefined, readonly lowerOpen: boolean, readonly upperOpen: boolean) {}
  static only(v: unknown): FakeKeyRange { check(v); return new FakeKeyRange(v as Key, v as Key, false, false); }
  static bound(l: unknown, u: unknown, lo = false, uo = false): FakeKeyRange {
    check(l); check(u);
    if (cmp(l, u) > 0 || (cmp(l, u) === 0 && (lo || uo))) throw new FakeDomError("DataError", "bad range");
    return new FakeKeyRange(l as Key, u as Key, lo, uo);
  }
  static lowerBound(l: unknown, o = false): FakeKeyRange { check(l); return new FakeKeyRange(l as Key, undefined, o, false); }
  static upperBound(u: unknown, o = false): FakeKeyRange { check(u); return new FakeKeyRange(undefined, u as Key, false, o); }
  includes(k: Key): boolean {
    if (this.lower !== undefined) { const c = cmp(k, this.lower); if (c < 0 || (c === 0 && this.lowerOpen)) return false; }
    if (this.upper !== undefined) { const c = cmp(k, this.upper); if (c > 0 || (c === 0 && this.upperOpen)) return false; }
    return true;
  }
}
function check(v: unknown): void { if (!validKey(v)) throw new FakeDomError("DataError", "invalid key"); }
function toRange(q: unknown): FakeKeyRange | null {
  if (q === undefined || q === null) return null;
  if (q instanceof FakeKeyRange) return q;
  return FakeKeyRange.only(q);
}

interface IndexDef { keyPath: string; unique: boolean }
interface StoreData { keyPath: string; autoIncrement: boolean; gen: number; indexes: Map<string, IndexDef>; rows: Map<string, { key: Key; value: unknown }> }
interface DbData { version: number; stores: Map<string, StoreData> }

const sk = (k: Key): string => `${typeof k}:${String(k)}`;
const clone = <T>(v: T): T => structuredClone(v);

function cloneStore(s: StoreData): StoreData {
  return { keyPath: s.keyPath, autoIncrement: s.autoIncrement, gen: s.gen, indexes: new Map(s.indexes), rows: new Map([...s.rows].map(([k, r]) => [k, { key: r.key, value: clone(r.value) }])) };
}

type Handler = ((ev: { target: unknown; preventDefault(): void }) => void) | null;

export class FakeRequest<T = unknown> {
  result: T = undefined as T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  transaction: FakeTransaction | null = null;
  readyState: "pending" | "done" = "pending";
}

export class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

export class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: Handler = null;
  error: Error | null = null;
  private queue: Array<() => void> = [];
  private finished = false;
  private scheduled = false;
  private readonly work = new Map<string, StoreData>();

  constructor(readonly db: FakeDatabase, readonly names: readonly string[], readonly mode: "readonly" | "readwrite" | "versionchange") {
    for (const n of names) {
      const s = db.data.stores.get(n);
      if (!s) throw new FakeDomError("NotFoundError", `no store ${n}`);
      this.work.set(n, mode === "readonly" ? s : cloneStore(s));
    }
    this.schedule();
  }

  get active(): boolean { return !this.finished; }

  objectStore(name: string): FakeObjectStore {
    const s = this.work.get(name);
    if (!s) throw new FakeDomError("NotFoundError", `store ${name} not in scope`);
    return new FakeObjectStore(this, name, s);
  }

  /** Used by createObjectStore inside versionchange. */
  addStore(name: string, s: StoreData): void { this.work.set(name, s); }

  enqueue<T>(req: FakeRequest<T>, op: () => T): FakeRequest<T> {
    if (this.finished) throw new FakeDomError("TransactionInactiveError", "transaction finished");
    req.transaction = this;
    this.queue.push(() => {
      if (this.finished) return;
      let ok = true;
      try {
        req.result = op();
      } catch (e) {
        ok = false;
        req.error = e as Error;
      }
      req.readyState = "done";
      if (ok) {
        req.onsuccess?.({ target: req, preventDefault() {} });
      } else {
        let prevented = false;
        const ev = { target: req, preventDefault() { prevented = true; } };
        req.onerror?.(ev);
        this.onerror?.(ev);
        if (!prevented) this.abortWith(req.error);
      }
    });
    this.schedule();
    return req;
  }

  private schedule(): void {
    if (this.scheduled || this.finished) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (this.finished) return;
      const next = this.queue.shift();
      if (next) {
        next();
        this.schedule();
        return;
      }
      this.commit();
    }, 0);
  }

  commit(): void {
    if (this.finished) return;
    if (this.queue.length) return; // pending requests run first; it commits after them
    this.finished = true;
    if (this.mode !== "readonly") for (const [n, s] of this.work) this.db.data.stores.set(n, s);
    this.oncomplete?.();
  }

  abort(): void {
    if (this.finished) throw new FakeDomError("InvalidStateError", "transaction finished");
    this.abortWith(new FakeDomError("AbortError", "aborted"));
  }

  private abortWith(err: Error | null): void {
    if (this.finished) return;
    this.finished = true;
    this.error = err;
    this.queue = [];
    if (this.mode === "versionchange") this.db.revert();
    this.onabort?.();
  }
}

function indexKeys(s: StoreData, ix: IndexDef, value: unknown): Key | undefined {
  const v = (value as Record<string, unknown>)[ix.keyPath];
  return validKey(v) ? v : undefined;
}

class Source {
  constructor(protected readonly t: FakeTransaction, protected readonly s: StoreData, private readonly ix: IndexDef | null) {}
  /** Entries in order: [key in this source, primary key, value]. */
  protected entries(range: FakeKeyRange | null): Array<[Key, Key, unknown]> {
    const out: Array<[Key, Key, unknown]> = [];
    for (const r of this.s.rows.values()) {
      const k = this.ix ? indexKeys(this.s, this.ix, r.value) : r.key;
      if (k === undefined) continue;
      if (range && !range.includes(k)) continue;
      out.push([k, r.key, r.value]);
    }
    return out.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  }
  get(q: unknown): FakeRequest {
    const range = toRange(q);
    return this.t.enqueue(new FakeRequest(), () => { const e = this.entries(range)[0]; return e ? clone(e[2]) : undefined; });
  }
  getAll(q?: unknown, count?: number): FakeRequest {
    const range = toRange(q);
    return this.t.enqueue(new FakeRequest(), () => this.entries(range).slice(0, count && count > 0 ? count : undefined).map((e) => clone(e[2])));
  }
  getAllKeys(q?: unknown, count?: number): FakeRequest {
    const range = toRange(q);
    return this.t.enqueue(new FakeRequest(), () => this.entries(range).slice(0, count && count > 0 ? count : undefined).map((e) => e[1]));
  }
  count(q?: unknown): FakeRequest {
    const range = toRange(q);
    return this.t.enqueue(new FakeRequest(), () => this.entries(range).length);
  }
  openCursor(q?: unknown, direction: "next" | "prev" = "next"): FakeRequest {
    const range = toRange(q);
    const req = new FakeRequest();
    let list: Array<[Key, Key, unknown]> | null = null;
    let i = 0;
    const step = (): unknown => {
      if (!list) { list = this.entries(range); if (direction === "prev") list.reverse(); }
      const e = list[i++];
      if (!e) return null;
      return { key: e[0], primaryKey: e[1], value: clone(e[2]), continue: () => { this.t.enqueue(req, step); } };
    };
    return this.t.enqueue(req, step);
  }
}

export class FakeIndex extends Source {}

export class FakeObjectStore extends Source {
  constructor(t: FakeTransaction, readonly name: string, s: StoreData) { super(t, s, null); }
  get indexNames(): { contains(n: string): boolean } { return { contains: (n) => this.s.indexes.has(n) }; }
  index(name: string): FakeIndex {
    const ix = this.s.indexes.get(name);
    if (!ix) throw new FakeDomError("NotFoundError", `no index ${name}`);
    return new FakeIndex(this.t, this.s, ix);
  }
  createIndex(name: string, keyPath: string, o: { unique?: boolean } = {}): void {
    this.s.indexes.set(name, { keyPath, unique: !!o.unique });
  }
  private writable(): void {
    if (this.t.mode === "readonly") throw new FakeDomError("ReadOnlyError", "readonly transaction");
  }
  put(value: unknown): FakeRequest {
    this.writable();
    const v = clone(value) as Record<string, unknown>;
    return this.t.enqueue(new FakeRequest(), () => {
      let key = v[this.s.keyPath];
      if (key === undefined && this.s.autoIncrement) {
        key = ++this.s.gen;
        v[this.s.keyPath] = key;
      }
      if (!validKey(key)) throw new FakeDomError("DataError", "invalid primary key");
      if (this.s.autoIncrement && typeof key === "number" && key > this.s.gen) this.s.gen = Math.floor(key);
      for (const ix of this.s.indexes.values()) {
        if (!ix.unique) continue;
        const k = indexKeys(this.s, ix, v);
        if (k === undefined) continue;
        for (const r of this.s.rows.values()) {
          if (cmp(r.key, key) === 0) continue;
          const other = indexKeys(this.s, ix, r.value);
          if (other !== undefined && cmp(other, k) === 0) throw new FakeDomError("ConstraintError", `unique index ${ix.keyPath}`);
        }
      }
      this.s.rows.set(sk(key), { key, value: v });
      return key;
    });
  }
  delete(key: unknown): FakeRequest {
    this.writable();
    check(key);
    return this.t.enqueue(new FakeRequest(), () => { this.s.rows.delete(sk(key as Key)); return undefined; });
  }
  clear(): FakeRequest {
    this.writable();
    return this.t.enqueue(new FakeRequest(), () => { this.s.rows.clear(); return undefined; });
  }
}

export class FakeDatabase {
  onversionchange: (() => void) | null = null;
  closed = false;
  private backup: DbData | null = null;
  upgradeTx: FakeTransaction | null = null;

  constructor(readonly name: string, readonly data: DbData) {}

  get version(): number { return this.data.version; }
  get objectStoreNames(): { contains(n: string): boolean; length: number } {
    return { contains: (n) => this.data.stores.has(n), length: this.data.stores.size };
  }
  beginUpgrade(): void {
    this.backup = { version: this.data.version, stores: new Map([...this.data.stores].map(([n, s]) => [n, cloneStore(s)])) };
  }
  revert(): void {
    if (!this.backup) return;
    this.data.version = this.backup.version;
    this.data.stores = this.backup.stores;
  }
  createObjectStore(name: string, o: { keyPath: string; autoIncrement?: boolean }): FakeObjectStore {
    if (!this.upgradeTx) throw new FakeDomError("InvalidStateError", "not in versionchange");
    const s: StoreData = { keyPath: o.keyPath, autoIncrement: !!o.autoIncrement, gen: 0, indexes: new Map(), rows: new Map() };
    this.data.stores.set(name, s);
    this.upgradeTx.addStore(name, s);
    return new FakeObjectStore(this.upgradeTx, name, s);
  }
  transaction(names: string | string[], mode: "readonly" | "readwrite" = "readonly"): FakeTransaction {
    if (this.closed) throw new FakeDomError("InvalidStateError", "database closed");
    return new FakeTransaction(this, typeof names === "string" ? [names] : names, mode);
  }
  close(): void { this.closed = true; }
}

/** The IDBFactory stand-in. One instance = one browser profile's databases. */
export class FakeIndexedDb {
  readonly dbs = new Map<string, DbData>();
  readonly open_ = new Set<FakeDatabase>();

  open(name: string, version?: number): FakeOpenRequest {
    const req = new FakeOpenRequest();
    setTimeout(() => {
      let data = this.dbs.get(name);
      const want = version ?? data?.version ?? 1;
      if (data && want < data.version) {
        req.error = new FakeDomError("VersionError", `stored version ${data.version} > requested ${want}`);
        req.onerror?.({ target: req, preventDefault() {} });
        return;
      }
      const old = data?.version ?? 0;
      if (!data) { data = { version: 0, stores: new Map() }; this.dbs.set(name, data); }
      const db = new FakeDatabase(name, data);
      this.open_.add(db);
      if (want > old) {
        db.beginUpgrade();
        data.version = want;
        const t = new FakeTransaction(db, [], "versionchange");
        db.upgradeTx = t;
        req.result = db;
        (req as unknown as { transaction: FakeTransaction }).transaction = t;
        t.oncomplete = () => { db.upgradeTx = null; req.readyState = "done"; req.onsuccess?.({ target: req, preventDefault() {} }); };
        t.onabort = () => { db.upgradeTx = null; if (old === 0) this.dbs.delete(name); req.error = new FakeDomError("AbortError", "upgrade aborted"); req.onerror?.({ target: req, preventDefault() {} }); };
        (req.onupgradeneeded as unknown as ((ev: { oldVersion: number; newVersion: number; target: unknown }) => void) | null)?.({ oldVersion: old, newVersion: want, target: req });
        return;
      }
      req.result = db;
      req.readyState = "done";
      req.onsuccess?.({ target: req, preventDefault() {} });
    }, 0);
    return req;
  }

  deleteDatabase(name: string): FakeRequest {
    const req = new FakeRequest();
    setTimeout(() => {
      this.dbs.delete(name);
      req.onsuccess?.({ target: req, preventDefault() {} });
    }, 0);
    return req;
  }

  cmp(a: unknown, b: unknown): number { return cmp(a, b); }
}

/** An IdbEnv for IdbStateStore.open() over a fresh fake. */
export function fakeIdbEnv(idb = new FakeIndexedDb()): { indexedDB: IDBFactory; IDBKeyRange: typeof FakeKeyRange; fake: FakeIndexedDb } {
  return { indexedDB: idb as unknown as IDBFactory, IDBKeyRange: FakeKeyRange, fake: idb };
}
