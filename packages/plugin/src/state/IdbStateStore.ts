// StateStore on IndexedDB (design §3.3; contract in @shuttle/protocol state.ts).
//
// - Database `shuttle/<appId>/<remoteProfileId>` (design §3.3.1), version = STATE_SCHEMA_VERSION.
//   Stores and indexes come from STATE_SCHEMA; a stored version newer than the code → NEWER_SCHEMA.
// - Index values: IndexedDB cannot index booleans (`remote.deleted`), so each index reads a shadow
//   field `_sx_<keyPath>` holding the value with booleans encoded as 0/1 (protocol state.ts). Shadow
//   fields are added on put and stripped on read.
// - Transactions run one at a time (the contract serializes them; it also keeps readonly scans from
//   interleaving with writers). A failed request dooms the transaction even when `fn` caught it.
// - journal.opSeq: keys are assigned here, from a per-session counter seeded with the largest stored
//   key, so an aborted transaction never hands its key to a later op in the same session. (IndexedDB's
//   own generator is rolled back on abort.)

import { STATE_SCHEMA, STATE_SCHEMA_VERSION, StateStoreError, isStateKey } from "@shuttle/protocol";
import type { IndexValue, StateKey, StateQuery, StateStore, StateTx, StoreName, StoreSpec, StoreTx, TxMode } from "@shuttle/protocol";

export const SHADOW_PREFIX = "_sx_";

export interface IdbEnv {
  indexedDB: IDBFactory;
  IDBKeyRange: { only(v: unknown): IDBKeyRange; bound(l: unknown, u: unknown, lo?: boolean, uo?: boolean): IDBKeyRange; lowerBound(l: unknown, o?: boolean): IDBKeyRange; upperBound(u: unknown, o?: boolean): IDBKeyRange };
}

/** IndexedDB database name (design §3.3.1). */
export function idbName(appId: string, remoteProfileId: string): string {
  return `shuttle/${appId}/${remoteProfileId}`;
}

function encodeIx(v: unknown): IDBValidKey | undefined {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return v;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  return undefined;
}

function storeErr(e: unknown, what: string): StateStoreError {
  if (e instanceof StateStoreError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  const msg = `${what}: ${e instanceof Error || (e && typeof (e as { message?: unknown }).message === "string") ? (e as Error).message : String(e)}`;
  if (name === "ConstraintError") return new StateStoreError("CONSTRAINT", msg);
  if (name === "DataError") return new StateStoreError("INVALID_KEY", msg);
  if (name === "ReadOnlyError") return new StateStoreError("READONLY", msg);
  if (name === "TransactionInactiveError" || name === "InvalidStateError") return new StateStoreError("CLOSED", msg);
  if (name === "NotFoundError") return new StateStoreError("NOT_IN_SCOPE", msg);
  return new StateStoreError("COMMIT_FAILED", msg);
}

function promisify<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class IdbStateStore implements StateStore {
  readonly schemaVersion = STATE_SCHEMA_VERSION;
  private db: IDBDatabase | null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private nextOpSeq: number | null = null;

  private constructor(readonly name: string, db: IDBDatabase, private readonly env: IdbEnv) {
    this.db = db;
    // Another tab or a newer plugin wants to upgrade: let it (the next call reports CLOSED).
    db.onversionchange = () => {
      db.close();
      this.db = null;
      this.closed = true;
    };
  }

  /** Open (creating or upgrading) the database. */
  static async open(name: string, env?: IdbEnv): Promise<IdbStateStore> {
    const e = env ?? defaultEnv();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = e.indexedDB.open(name, STATE_SCHEMA_VERSION);
      } catch (err) {
        reject(storeErr(err, "open"));
        return;
      }
      req.onupgradeneeded = () => {
        try {
          upgrade(req.result);
        } catch (err) {
          req.transaction?.abort();
          reject(storeErr(err, "upgrade"));
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        const err = req.error;
        if (err?.name === "VersionError") {
          reject(new StateStoreError("NEWER_SCHEMA", `${name}: the stored database is newer than this plugin; update SHUTTLE`));
        } else reject(storeErr(err, "open"));
      };
      req.onblocked = () => {
        // An older connection in another window holds the database; open() waits for it to close.
      };
    });
    return new IdbStateStore(name, db, e);
  }

  tx<T>(stores: readonly StoreName[], fn: (tx: StateTx) => Promise<T>, mode: TxMode = "readwrite"): Promise<T> {
    const run = (): Promise<T> => this.run(stores, fn, mode);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async run<T>(stores: readonly StoreName[], fn: (tx: StateTx) => Promise<T>, mode: TxMode): Promise<T> {
    const db = this.db;
    if (this.closed || !db) throw new StateStoreError("CLOSED", "state store is closed");
    for (const s of stores) if (!(s in STATE_SCHEMA)) throw new StateStoreError("NOT_IN_SCOPE", `unknown store "${s}"`);
    let t: IDBTransaction;
    try {
      t = db.transaction([...new Set(stores)], mode);
    } catch (e) {
      throw storeErr(e, "transaction");
    }
    const st: TxState = { active: true, failure: null, mode, t };
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onabort = () => reject(st.failure ?? storeErr(t.error ?? new Error("aborted"), "commit"));
      t.onerror = () => { /* request errors bubble here; onabort follows */ };
    });
    done.catch(() => undefined);
    const named = new Set(stores);
    const txObj = {} as Record<StoreName, StoreTx<never, never>>;
    for (const name of Object.keys(STATE_SCHEMA) as StoreName[]) {
      Object.defineProperty(txObj, name, {
        enumerable: true,
        get: () => (named.has(name) ? this.storeTx(st, name) : outOfScope(name)),
      });
    }
    let result: T;
    try {
      result = await fn(txObj as unknown as StateTx);
    } catch (e) {
      st.active = false;
      abortQuietly(t);
      await done.catch(() => undefined);
      throw e;
    }
    st.active = false;
    if (st.failure) {
      abortQuietly(t);
      await done.catch(() => undefined);
      throw st.failure;
    }
    try {
      (t as { commit?: () => void }).commit?.();
    } catch { /* already committing */ }
    await done;
    return result;
  }

  private storeTx(st: TxState, name: StoreName): StoreTx<never, never> {
    const spec: StoreSpec = STATE_SCHEMA[name];
    const store = (): IDBObjectStore => st.t.objectStore(name);
    const guard = (write: boolean): void => {
      if (!st.active) throw new StateStoreError("CLOSED", "transaction already finished (did fn await something outside the transaction?)");
      if (st.failure) throw st.failure;
      if (write && st.mode === "readonly") throw new StateStoreError("READONLY", `write to "${name}" in a readonly transaction`);
    };
    const call = async <R>(write: boolean, what: string, mk: () => IDBRequest<R>): Promise<R> => {
      guard(write);
      let r: IDBRequest<R>;
      try {
        r = mk();
      } catch (e) {
        const err = storeErr(e, `${name}.${what}`);
        if (err.code === "CONSTRAINT" || write) st.failure ??= err;
        throw err;
      }
      try {
        return await promisify(r);
      } catch (e) {
        const err = storeErr(e, `${name}.${what}`);
        st.failure ??= err;
        throw err;
      }
    };
    const source = (index: string | undefined): IDBObjectStore | IDBIndex => {
      if (index === undefined) return store();
      if (!spec.indexes[index]) throw new StateStoreError("NOT_IN_SCOPE", `store "${name}" has no index "${index}"`);
      return store().index(index);
    };
    const strip = (v: unknown): never => {
      if (v && typeof v === "object") for (const ix of Object.values(spec.indexes)) delete (v as Record<string, unknown>)[SHADOW_PREFIX + ix.keyPath];
      return v as never;
    };
    const range = (q: StateQuery, index: string | undefined): IDBKeyRange | null | "empty" => {
      const enc = (v: IndexValue | undefined): IDBValidKey | undefined => (v === undefined ? undefined : index === undefined ? (isStateKey(v) ? v : undefined) : encodeIx(v));
      const R = this.env.IDBKeyRange;
      if (q.only !== undefined) {
        const o = enc(q.only);
        return o === undefined ? "empty" : R.only(o);
      }
      const lo = enc(q.lower);
      const up = enc(q.upper);
      if ((q.lower !== undefined && lo === undefined) || (q.upper !== undefined && up === undefined)) return "empty";
      if (lo !== undefined && up !== undefined) {
        const c = this.env.indexedDB.cmp(lo, up);
        if (c > 0 || (c === 0 && (q.lowerOpen || q.upperOpen))) return "empty";
        return R.bound(lo, up, !!q.lowerOpen, !!q.upperOpen);
      }
      if (lo !== undefined) return R.lowerBound(lo, !!q.lowerOpen);
      if (up !== undefined) return R.upperBound(up, !!q.upperOpen);
      return null;
    };
    /** Rows (value + primary key) in key order, honouring direction and limit. */
    const scan = async (q: StateQuery, want: "values" | "keys"): Promise<unknown[]> => {
      guard(false);
      const src = source(q.index);
      const r = range(q, q.index);
      if (r === "empty") return [];
      const limit = q.limit !== undefined ? Math.max(0, Math.floor(q.limit)) : undefined;
      if (limit === 0) return [];
      if (q.direction !== "prev") {
        return want === "values"
          ? (await call(false, "getAll", () => src.getAll(r ?? undefined, limit))).map(strip)
          : await call(false, "getAllKeys", () => src.getAllKeys(r ?? undefined, limit));
      }
      guard(false);
      const out: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        let req: IDBRequest<IDBCursorWithValue | null>;
        try {
          req = src.openCursor(r ?? undefined, "prev");
        } catch (e) {
          reject(storeErr(e, `${name}.openCursor`));
          return;
        }
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          out.push(want === "values" ? strip(c.value) : c.primaryKey);
          if (limit !== undefined && out.length >= limit) return resolve();
          c.continue();
        };
        req.onerror = () => {
          const err = storeErr(req.error, `${name}.openCursor`);
          st.failure ??= err;
          reject(err);
        };
      });
      return out;
    };
    const api = {
      get: async (key: StateKey) => {
        if (!isStateKey(key)) throw new StateStoreError("INVALID_KEY", `${name}.get: invalid key`);
        const v = await call(false, "get", () => store().get(key));
        return v === undefined ? undefined : strip(v);
      },
      getByIndex: async (index: string, value: IndexValue) => {
        guard(false);
        const src = source(index);
        const k = encodeIx(value);
        if (k === undefined) return undefined;
        const v = await call(false, "getByIndex", () => src.get(k));
        return v === undefined ? undefined : strip(v);
      },
      getAll: (q: StateQuery = {}) => scan(q, "values"),
      getAllKeys: (q: StateQuery = {}) => scan(q, "keys"),
      count: async (q: StateQuery = {}) => {
        guard(false);
        const src = source(q.index);
        const r = range(q, q.index);
        if (r === "empty") return 0;
        const n = await call(false, "count", () => src.count(r ?? undefined));
        return q.limit !== undefined ? Math.min(n, Math.max(0, q.limit)) : n;
      },
      put: async (value: Record<string, unknown>) => {
        guard(true);
        if (!value || typeof value !== "object") throw new StateStoreError("INVALID_KEY", `${name}.put: not an object`);
        const row: Record<string, unknown> = { ...value };
        let key = row[spec.keyPath];
        // Seed the session counter from the stored maximum before any journal write, explicit keys
        // included: otherwise an update of op 7 after a restart would set the counter to 8 and the
        // next new op would overwrite a stored op 8.
        if (spec.autoIncrement) await this.seedKeys(st, name);
        if (key === undefined && spec.autoIncrement) {
          key = this.nextOpSeq ?? 1;
          this.nextOpSeq = (key as number) + 1;
          row[spec.keyPath] = key;
        } else if (!isStateKey(key)) {
          throw new StateStoreError("INVALID_KEY", `${name}.put: missing or invalid "${spec.keyPath}"`);
        } else if (spec.autoIncrement && typeof key === "number") {
          this.nextOpSeq = Math.max(this.nextOpSeq ?? 0, Math.floor(key) + 1);
        }
        for (const ix of Object.values(spec.indexes)) {
          const v = encodeIx(row[ix.keyPath]);
          if (v === undefined) delete row[SHADOW_PREFIX + ix.keyPath];
          else row[SHADOW_PREFIX + ix.keyPath] = v;
        }
        await call(true, "put", () => store().put(row));
        return key as StateKey;
      },
      delete: async (key: StateKey) => {
        if (!isStateKey(key)) throw new StateStoreError("INVALID_KEY", `${name}.delete: invalid key`);
        await call(true, "delete", () => store().delete(key));
      },
      clear: async () => {
        await call(true, "clear", () => store().clear());
      },
    };
    return api as unknown as StoreTx<never, never>;
  }

  /** Seed the per-session journal key counter with the largest stored key (inside the same tx). */
  private async seedKeys(st: TxState, name: StoreName): Promise<void> {
    if (this.nextOpSeq !== null) return;
    const req = st.t.objectStore(name).openCursor(null, "prev");
    const c = await promisify(req);
    const max = c && typeof c.primaryKey === "number" ? c.primaryKey : 0;
    if (this.nextOpSeq === null) this.nextOpSeq = Math.floor(max) + 1;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.queue.catch(() => undefined);
    this.closed = true;
    this.db?.close();
    this.db = null;
  }

  async destroy(): Promise<void> {
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const req = this.env.indexedDB.deleteDatabase(this.name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(storeErr(req.error, "destroy"));
      req.onblocked = () => { /* resolves once other connections close */ };
    });
  }
}

interface TxState { active: boolean; failure: StateStoreError | null; mode: TxMode; t: IDBTransaction }

function upgrade(db: IDBDatabase): void {
  // Forward-only (design §3.3.1). v1 creates every store; later versions add stores or indexes here.
  for (const [name, spec] of Object.entries(STATE_SCHEMA) as Array<[StoreName, StoreSpec]>) {
    if (db.objectStoreNames.contains(name)) continue;
    const os = db.createObjectStore(name, { keyPath: spec.keyPath, autoIncrement: spec.autoIncrement });
    for (const [ixName, ix] of Object.entries(spec.indexes)) os.createIndex(ixName, SHADOW_PREFIX + ix.keyPath, { unique: ix.unique });
  }
}

function abortQuietly(t: IDBTransaction): void {
  try {
    t.abort();
  } catch { /* already finished or aborted */ }
}

function outOfScope(name: StoreName): StoreTx<never, never> {
  const refuse = async (): Promise<never> => {
    throw new StateStoreError("NOT_IN_SCOPE", `store "${name}" is not part of this transaction`);
  };
  return { get: refuse, getByIndex: refuse, getAll: refuse, getAllKeys: refuse, count: refuse, put: refuse, delete: refuse, clear: refuse };
}

function defaultEnv(): IdbEnv {
  const g = globalThis as unknown as { indexedDB?: IDBFactory; IDBKeyRange?: IdbEnv["IDBKeyRange"] };
  if (!g.indexedDB || !g.IDBKeyRange) throw new StateStoreError("CLOSED", "IndexedDB is not available");
  return { indexedDB: g.indexedDB, IDBKeyRange: g.IDBKeyRange };
}
