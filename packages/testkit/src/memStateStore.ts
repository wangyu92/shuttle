// In-memory StateStore (design §3.3; ops-spec §3 crash points) with crash injection.
//
// Semantics follow the StateStore contract in @shuttle/protocol (state.ts): one transaction at a time,
// all-or-nothing commit, unique indexes enforced, structured-clone values, IndexedDB key ordering.
// Writes go to a per-transaction overlay and reach the committed data only when `fn` resolves and the
// commit is not faulted. `crash()` models a process death: in-flight transactions are dropped, the
// handle refuses all further calls, and `reopen()` returns a fresh handle over the committed data only.

import {
  STATE_SCHEMA, STATE_SCHEMA_VERSION, StateStoreError, isStateKey,
} from "@shuttle/protocol";
import type {
  IndexValue, StateKey, StateQuery, StateStore, StateTx, StoreName, StoreSpec, StoreTx, TxMode,
} from "@shuttle/protocol";

type Row = { key: StateKey; value: Record<string, unknown> };

/** Committed contents, shared by every handle opened on it. */
export class MemStateData {
  readonly stores = new Map<StoreName, Map<string, Row>>();
  readonly autoInc = new Map<StoreName, number>();
  schemaVersion: number;
  /** Bumped by crash()/destroy(); transactions and handles from an older generation are dead. */
  generation = 0;
  /** Serializes transactions across all handles. */
  lock: Promise<void> = Promise.resolve();
  commits = 0;

  constructor(schemaVersion = STATE_SCHEMA_VERSION) {
    this.schemaVersion = schemaVersion;
    this.reset();
  }

  reset(): void {
    this.stores.clear();
    for (const name of Object.keys(STATE_SCHEMA) as StoreName[]) this.stores.set(name, new Map());
    this.autoInc.clear();
  }
}

export interface CommitInfo { stores: readonly StoreName[]; writes: number; n: number }
export type CommitFault = 'crash' | 'fail';

export interface MemStateStoreOptions {
  /** Schema version reported by this store (tests of the "newer schema" refusal). */
  schemaVersion?: number;
  /** Called before each read-write commit is applied; throwing drops the transaction. */
  beforeCommit?: (info: CommitInfo) => void;
}

const clone = <T>(v: T): T => structuredClone(v);

function keyStr(k: StateKey): string {
  return typeof k === "number" ? `n:${k}` : `s:${k}`;
}

function rank(v: IndexValue): number {
  return typeof v === "boolean" ? 0 : typeof v === "number" ? 1 : 2;
}

/** IndexedDB-style ordering: booleans < numbers < strings; strings by UTF-16 code units. */
export function compareKeys(a: IndexValue, b: IndexValue): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "boolean") return Number(a) - Number(b as boolean);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isIndexValue(v: unknown): v is IndexValue {
  return typeof v === "boolean" || isStateKey(v);
}

function inRange(v: IndexValue, q: StateQuery): boolean {
  if (q.only !== undefined && compareKeys(v, q.only) !== 0) return false;
  if (q.lower !== undefined) {
    const c = compareKeys(v, q.lower);
    if (c < 0 || (c === 0 && q.lowerOpen)) return false;
  }
  if (q.upper !== undefined) {
    const c = compareKeys(v, q.upper);
    if (c > 0 || (c === 0 && q.upperOpen)) return false;
  }
  return true;
}

class TxState {
  readonly overlay = new Map<StoreName, Map<string, Row | null>>();
  readonly cleared = new Set<StoreName>();
  writes = 0;
  failure: unknown = null;
  done = false;
  constructor(readonly generation: number, readonly stores: ReadonlySet<StoreName>, readonly mode: TxMode) {}
}

export class MemStateStore implements StateStore {
  readonly data: MemStateData;
  private readonly generation: number;
  private closed = false;
  private readonly opts: MemStateStoreOptions;
  private faults: Array<{ kind: CommitFault; skip: number }> = [];

  constructor(data: MemStateData = new MemStateData(), opts: MemStateStoreOptions = {}) {
    this.data = data;
    if (opts.schemaVersion !== undefined) data.schemaVersion = opts.schemaVersion;
    this.generation = data.generation;
    this.opts = opts;
  }

  get schemaVersion(): number {
    return this.data.schemaVersion;
  }

  // ---------- test controls ----------

  /** Process death: drop in-flight transactions; this handle refuses every further call. */
  crash(): void {
    this.data.generation++;
    this.data.lock = Promise.resolve();
  }

  /** A new handle over the committed data (what a restarted engine opens). */
  reopen(opts: MemStateStoreOptions = {}): MemStateStore {
    return new MemStateStore(this.data, opts);
  }

  /** The `n+1`-th next read-write commit fails ('fail') or crashes the store ('crash'). */
  injectCommitFault(kind: CommitFault, skip = 0): void {
    this.faults.push({ kind, skip });
  }

  /** iOS eviction: everything is gone, including the schema version row. */
  evict(): void {
    this.data.reset();
    this.data.generation++;
    this.data.lock = Promise.resolve();
  }

  /** Committed contents (deep copies), for assertions. */
  dump(): Record<StoreName, unknown[]> {
    const out = {} as Record<StoreName, unknown[]>;
    for (const [name, m] of this.data.stores) {
      out[name] = [...m.values()].sort((a, b) => compareKeys(a.key, b.key)).map((r) => clone(r.value));
    }
    return out;
  }

  get commitCount(): number {
    return this.data.commits;
  }

  // ---------- StateStore ----------

  private assertAlive(): void {
    if (this.generation !== this.data.generation) throw new StateStoreError("CRASHED", "state store handle is dead (crash or evict)");
    if (this.closed) throw new StateStoreError("CLOSED", "state store is closed");
  }

  async tx<T>(stores: readonly StoreName[], fn: (tx: StateTx) => Promise<T>, mode: TxMode = "readwrite"): Promise<T> {
    this.assertAlive();
    for (const s of stores) if (!STATE_SCHEMA[s]) throw new StateStoreError("NOT_IN_SCOPE", `unknown store ${String(s)}`);
    const prev = this.data.lock;
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.data.lock = prev.then(() => mine);
    await prev;
    try {
      this.assertAlive();
      const st = new TxState(this.generation, new Set(stores), mode);
      let result: T;
      try {
        result = await fn(this.makeTx(st));
      } catch (e) {
        st.done = true;
        throw e;
      }
      st.done = true;
      if (st.failure) throw st.failure;
      this.assertAlive();
      if (mode === "readwrite") this.commit(st);
      return result;
    } finally {
      release();
    }
  }

  private commit(st: TxState): void {
    const n = ++this.data.commits;
    const info: CommitInfo = { stores: [...st.stores], writes: st.writes, n };
    const fault = this.faults[0];
    if (fault) {
      if (fault.skip > 0) fault.skip--;
      else {
        this.faults.shift();
        if (fault.kind === "crash") {
          this.crash();
          throw new StateStoreError("CRASHED", `injected crash at commit #${n}`);
        }
        throw new StateStoreError("COMMIT_FAILED", `injected commit failure at commit #${n}`);
      }
    }
    if (this.opts.beforeCommit) this.opts.beforeCommit(info);
    if (this.generation !== this.data.generation) throw new StateStoreError("CRASHED", "crashed before commit");
    for (const name of st.cleared) this.data.stores.get(name)?.clear();
    for (const [name, ov] of st.overlay) {
      const base = this.data.stores.get(name) as Map<string, Row>;
      for (const [k, row] of ov) {
        if (row === null) base.delete(k);
        else base.set(k, row);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async destroy(): Promise<void> {
    this.data.reset();
    this.data.generation++;
    this.data.lock = Promise.resolve();
    this.closed = true;
  }

  // ---------- transaction handles ----------

  private makeTx(st: TxState): StateTx {
    const handles = {} as Record<StoreName, unknown>;
    for (const name of Object.keys(STATE_SCHEMA) as StoreName[]) {
      Object.defineProperty(handles, name, {
        enumerable: true,
        get: () => {
          if (!st.stores.has(name)) throw new StateStoreError("NOT_IN_SCOPE", `store "${name}" is not part of this transaction`);
          return this.storeTx(st, name);
        },
      });
    }
    return handles as unknown as StateTx;
  }

  private rows(st: TxState, name: StoreName): Row[] {
    const base = st.cleared.has(name) ? new Map<string, Row>() : (this.data.stores.get(name) as Map<string, Row>);
    const ov = st.overlay.get(name);
    if (!ov) return [...base.values()];
    const merged = new Map(base);
    for (const [k, row] of ov) {
      if (row === null) merged.delete(k);
      else merged.set(k, row);
    }
    return [...merged.values()];
  }

  private getRow(st: TxState, name: StoreName, key: StateKey): Row | undefined {
    const ov = st.overlay.get(name);
    const k = keyStr(key);
    if (ov?.has(k)) return ov.get(k) ?? undefined;
    if (st.cleared.has(name)) return undefined;
    return this.data.stores.get(name)?.get(k);
  }

  private query(st: TxState, name: StoreName, q: StateQuery = {}): Row[] {
    const spec = STATE_SCHEMA[name];
    let entries: Array<{ v: IndexValue; row: Row }>;
    if (q.index !== undefined) {
      const ix = spec.indexes[q.index];
      if (!ix) throw new StateStoreError("NOT_IN_SCOPE", `store "${name}" has no index "${q.index}"`);
      entries = [];
      for (const row of this.rows(st, name)) {
        const v = row.value[ix.keyPath];
        if (isIndexValue(v)) entries.push({ v, row });
      }
    } else {
      entries = this.rows(st, name).map((row) => ({ v: row.key, row }));
    }
    const out = entries.filter((e) => inRange(e.v, q))
      .sort((a, b) => compareKeys(a.v, b.v) || compareKeys(a.row.key, b.row.key));
    if (q.direction === "prev") out.reverse();
    const rows = out.map((e) => e.row);
    return q.limit !== undefined ? rows.slice(0, Math.max(0, q.limit)) : rows;
  }

  private storeTx(st: TxState, name: StoreName): StoreTx<never, never> {
    const spec: StoreSpec = STATE_SCHEMA[name];
    const guard = (write: boolean): void => {
      if (st.generation !== this.data.generation) throw new StateStoreError("CRASHED", "transaction belongs to a crashed store");
      if (st.done) throw new StateStoreError("CLOSED", "transaction already finished (did fn await something outside the transaction?)");
      if (st.failure) throw st.failure;
      if (write && st.mode === "readonly") throw new StateStoreError("READONLY", `write to "${name}" in a readonly transaction`);
    };
    const doom = (e: StateStoreError): never => {
      st.failure = e;
      throw e;
    };
    const overlay = (): Map<string, Row | null> => {
      let ov = st.overlay.get(name);
      if (!ov) { ov = new Map(); st.overlay.set(name, ov); }
      return ov;
    };
    const api = {
      get: async (key: StateKey) => {
        guard(false);
        const r = this.getRow(st, name, key);
        return r ? clone(r.value) : undefined;
      },
      getByIndex: async (index: string, value: IndexValue) => {
        guard(false);
        const r = this.query(st, name, { index, only: value, limit: 1 })[0];
        return r ? clone(r.value) : undefined;
      },
      getAll: async (q?: StateQuery) => {
        guard(false);
        return this.query(st, name, q).map((r) => clone(r.value));
      },
      getAllKeys: async (q?: StateQuery) => {
        guard(false);
        return this.query(st, name, q).map((r) => r.key);
      },
      count: async (q?: StateQuery) => {
        guard(false);
        return this.query(st, name, q).length;
      },
      put: async (input: unknown) => {
        guard(true);
        if (typeof input !== "object" || input === null) return doom(new StateStoreError("INVALID_KEY", `put into "${name}": value must be an object`));
        const value = clone(input) as Record<string, unknown>;
        let key = value[spec.keyPath];
        if (key === undefined && spec.autoIncrement) {
          const next = (this.data.autoInc.get(name) ?? 0) + 1;
          this.data.autoInc.set(name, next);
          key = next;
          value[spec.keyPath] = key;
        }
        if (!isStateKey(key)) return doom(new StateStoreError("INVALID_KEY", `put into "${name}": "${spec.keyPath}" is not a valid key`));
        if (spec.autoIncrement && typeof key === "number" && key > (this.data.autoInc.get(name) ?? 0)) {
          this.data.autoInc.set(name, Math.floor(key));
        }
        for (const [ixName, ix] of Object.entries(spec.indexes)) {
          if (!ix.unique) continue;
          const v = value[ix.keyPath];
          if (!isIndexValue(v)) continue;
          const clash = this.query(st, name, { index: ixName, only: v }).find((r) => compareKeys(r.key, key as StateKey) !== 0);
          if (clash) {
            return doom(new StateStoreError("CONSTRAINT",
              `unique index "${name}.${ixName}" violated by key ${String(key)} (held by ${String(clash.key)})`));
          }
        }
        overlay().set(keyStr(key), { key, value });
        st.writes++;
        return key;
      },
      delete: async (key: StateKey) => {
        guard(true);
        overlay().set(keyStr(key), null);
        st.writes++;
      },
      clear: async () => {
        guard(true);
        st.cleared.add(name);
        st.overlay.delete(name);
        st.writes++;
      },
    };
    return api as unknown as StoreTx<never, never>;
  }
}
