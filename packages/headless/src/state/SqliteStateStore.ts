// StateStore on node:sqlite (design §6.1.5, §3.3). One table per engine store; values are JSON text
// with binary fields moved into a BLOB column; WAL, synchronous=FULL, busy_timeout=5000; read-write
// engine transactions map to BEGIN IMMEDIATE … COMMIT.
//
// Semantics match the StateStore contract in @shuttle/protocol (state.ts) and MemStateStore:
//  - one transaction at a time per handle (a promise chain; node:sqlite itself is synchronous, so a
//    transaction's statements never interleave with another's),
//  - all or nothing; a unique-index violation dooms the transaction even when the caller catches it,
//  - IndexedDB key order: booleans < numbers < strings, strings by UTF-16 code units (strings are
//    sorted through a UTF-16BE BLOB column, whose byte order is code-unit order),
//  - journal.opSeq is never reused inside one process, even after a rolled-back transaction.
//
// Layout versioning: PRAGMA user_version holds the table layout version of this file. A newer
// layout, or a meta.schemaVersion newer than the code, is refused with NEWER_SCHEMA (headless exits 4).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  STATE_SCHEMA, STATE_SCHEMA_VERSION, StateStoreError, isStateKey,
} from "@shuttle/protocol";
import type {
  IndexValue, StateKey, StateQuery, StateStore, StateTx, StoreName, StoreSpec, StoreTx, TxMode,
} from "@shuttle/protocol";

/** Table layout version written to PRAGMA user_version. */
export const SQLITE_LAYOUT_VERSION = 1;
/** Nightly backups kept (design §6.1.5). */
export const BACKUPS_KEPT = 3;

export interface SqliteStateStoreOptions {
  /**
   * PRAGMA synchronous (design §6.1.5: FULL). NORMAL keeps every commit durable across a process
   * crash (WAL) but may lose the last commits on power loss; FULL fsyncs the WAL on every commit,
   * which costs about 100 ms per commit on the NAS btrfs volume and blocks the event loop meanwhile
   * (node:sqlite is synchronous).
   */
  synchronous?: "full" | "normal";
  /** Called before each read-write COMMIT; throwing rolls the transaction back (fault tests). */
  beforeCommit?: (info: { stores: readonly StoreName[]; writes: number; n: number }) => void;
}

type Rank = 0 | 1 | 2;
interface Enc { r: Rank; n: number | null; s: Uint8Array | null; u: string }

const STORES = Object.keys(STATE_SCHEMA) as StoreName[];
const BIN_TAG = "\u0000bin";

function rank(v: IndexValue): Rank {
  return typeof v === "boolean" ? 0 : typeof v === "number" ? 1 : 2;
}

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 * i] = c >>> 8;
    out[2 * i + 1] = c & 0xff;
  }
  return out;
}

/** Typed sort columns plus the equality key (`b:1`, `n:3`, `s:abc`, like MemStateStore's ixKey). */
function enc(v: IndexValue): Enc {
  if (typeof v === "boolean") return { r: 0, n: v ? 1 : 0, s: null, u: `b:${v ? 1 : 0}` };
  if (typeof v === "number") return { r: 1, n: v, s: null, u: `n:${v}` };
  return { r: 2, n: null, s: utf16be(v), u: `s:${v}` };
}

function isIndexValue(v: unknown): v is IndexValue {
  return typeof v === "boolean" || isStateKey(v);
}

function decodeKey(k: string): StateKey {
  return k.startsWith("n:") ? Number(k.slice(2)) : k.slice(2);
}

function col(ix: string): string {
  return ix.replace(/[^A-Za-z0-9_]/g, "_");
}

// ---------- value codec: JSON text + one BLOB holding every Uint8Array ----------

export function encodeValue(value: unknown): { v: string; b: Uint8Array | null } {
  const bins: Uint8Array[] = [];
  const v = JSON.stringify(value, function (this: Record<string, unknown>, key: string, val: unknown) {
    const orig = key === "" ? value : this[key];
    if (orig instanceof Uint8Array) {
      bins.push(orig);
      return { [BIN_TAG]: bins.length - 1 };
    }
    if (ArrayBuffer.isView(orig) || orig instanceof ArrayBuffer) {
      throw new StateStoreError("INVALID_KEY", "only Uint8Array binary values are supported");
    }
    return val;
  });
  if (bins.length === 0) return { v, b: null };
  let total = 4 + 4 * bins.length;
  for (const x of bins) total += x.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, bins.length);
  let off = 4 + 4 * bins.length;
  bins.forEach((x, i) => {
    dv.setUint32(4 + 4 * i, x.length);
    out.set(x, off);
    off += x.length;
  });
  return { v, b: out };
}

export function decodeValue(v: string, b: Uint8Array | null): unknown {
  const bins: Uint8Array[] = [];
  if (b && b.length >= 4) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getUint32(0);
    let off = 4 + 4 * n;
    for (let i = 0; i < n; i++) {
      const len = dv.getUint32(4 + 4 * i);
      bins.push(b.slice(off, off + len));
      off += len;
    }
  }
  return JSON.parse(v, (_k, val: unknown) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const idx = o[BIN_TAG];
      if (typeof idx === "number" && Object.keys(o).length === 1) return bins[idx] ?? new Uint8Array(0);
    }
    return val;
  });
}

// ---------- the store ----------

class TxState {
  writes = 0;
  failure: unknown = null;
  done = false;
  constructor(readonly stores: ReadonlySet<StoreName>, readonly mode: TxMode) {}
}

interface Row { k: string; v: string; b: Uint8Array | null }

export class SqliteStateStore implements StateStore {
  readonly file: string;
  private db: DatabaseSync | null;
  private readonly stmts = new Map<string, StatementSync>();
  private lock: Promise<void> = Promise.resolve();
  private readonly autoInc = new Map<StoreName, number>();
  private closed = false;
  private crashed = false;
  private commits = 0;
  private readonly storedSchema: number;

  private constructor(file: string, db: DatabaseSync, private readonly opts: SqliteStateStoreOptions) {
    this.file = file;
    this.db = db;
    this.storedSchema = this.readStoredSchema();
    for (const name of STORES) {
      if (!STATE_SCHEMA[name].autoIncrement) continue;
      const max = this.q(`SELECT MAX(kn) AS m FROM "t_${name}" WHERE kr = 1`).get() as { m: number | null } | undefined;
      const saved = this.q(`SELECT n FROM "_autoinc" WHERE store = ?`).get(name) as { n: number } | undefined;
      this.autoInc.set(name, Math.max(Math.floor(max?.m ?? 0), saved?.n ?? 0));
    }
  }

  /** Open (creating if needed) the database at `file` (`:memory:` for tests). */
  static open(file: string, opts: SqliteStateStoreOptions = {}): SqliteStateStore {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      if (file !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
      db.exec(`PRAGMA synchronous=${opts.synchronous === "normal" ? "NORMAL" : "FULL"}`);
      const uv = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (uv > SQLITE_LAYOUT_VERSION) {
        throw new StateStoreError("NEWER_SCHEMA", `state.db layout ${uv} is newer than ${SQLITE_LAYOUT_VERSION}; update shuttle-headless`);
      }
      if (uv < SQLITE_LAYOUT_VERSION) createLayout(db);
    } catch (e) {
      db.close();
      throw e;
    }
    return new SqliteStateStore(file, db, opts);
  }

  /** meta.schemaVersion as stored, or the code's version for a fresh database. */
  get schemaVersion(): number {
    return this.storedSchema;
  }

  get commitCount(): number {
    return this.commits;
  }

  private readStoredSchema(): number {
    const row = this.q(`SELECT v, b FROM "t_meta" WHERE k = ?`).get("s:schemaVersion") as Row | undefined;
    if (!row) return STATE_SCHEMA_VERSION;
    const val = decodeValue(row.v, row.b) as { v?: unknown };
    return typeof val.v === "number" ? val.v : STATE_SCHEMA_VERSION;
  }

  private q(sql: string): StatementSync {
    const db = this.db;
    if (!db) throw new StateStoreError(this.crashed ? "CRASHED" : "CLOSED", "state store is closed");
    let s = this.stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private assertAlive(): void {
    if (this.crashed) throw new StateStoreError("CRASHED", "state store handle is dead (abandoned)");
    if (this.closed || !this.db) throw new StateStoreError("CLOSED", "state store is closed");
  }

  async tx<T>(stores: readonly StoreName[], fn: (tx: StateTx) => Promise<T>, mode: TxMode = "readwrite"): Promise<T> {
    this.assertAlive();
    for (const s of stores) if (!STATE_SCHEMA[s]) throw new StateStoreError("NOT_IN_SCOPE", `unknown store ${String(s)}`);
    const prev = this.lock;
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.lock = prev.then(() => mine);
    await prev;
    try {
      this.assertAlive();
      const db = this.db as DatabaseSync;
      db.exec(mode === "readwrite" ? "BEGIN IMMEDIATE" : "BEGIN");
      const st = new TxState(new Set(stores), mode);
      let ok = false;
      try {
        let result: T;
        try {
          result = await fn(this.makeTx(st));
        } finally {
          st.done = true;
        }
        if (st.failure) throw st.failure;
        this.assertAlive();
        if (mode === "readwrite") {
          const n = ++this.commits;
          this.opts.beforeCommit?.({ stores: [...st.stores], writes: st.writes, n });
          this.assertAlive();
        }
        try {
          db.exec("COMMIT");
        } catch (e) {
          throw new StateStoreError("COMMIT_FAILED", `commit failed: ${(e as Error).message}`);
        }
        ok = true;
        return result;
      } finally {
        if (!ok && this.db && this.db.isTransaction) {
          try { this.db.exec("ROLLBACK"); } catch { /* the connection is gone */ }
        }
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.lock.catch(() => undefined);
    this.closed = true;
    this.stmts.clear();
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  async destroy(): Promise<void> {
    await this.close();
    if (this.file === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(this.file + suffix, { force: true });
  }

  /**
   * Process death for tests (kill -9 at the state level): the connection closes without COMMIT, so
   * an in-flight transaction is rolled back by SQLite, and this handle refuses every further call.
   * Reopen the file with SqliteStateStore.open() to see only committed data.
   */
  abandon(): void {
    this.crashed = true;
    this.stmts.clear();
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
  }

  /**
   * `VACUUM INTO <dir>/state-YYYYMMDD.db` (design §6.1.5), then keep the newest BACKUPS_KEPT files.
   * Runs between transactions. Returns the file written, or null when today's backup exists.
   */
  async backup(dir: string, now: Date = new Date()): Promise<string | null> {
    this.assertAlive();
    const prev = this.lock;
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.lock = prev.then(() => mine);
    await prev;
    try {
      this.assertAlive();
      mkdirSync(dir, { recursive: true });
      const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const target = path.join(dir, `state-${ymd}.db`);
      let wrote: string | null = null;
      try {
        statSync(target);
      } catch {
        (this.db as DatabaseSync).prepare("VACUUM INTO ?").run(target);
        wrote = target;
      }
      const old = readdirSync(dir).filter((f) => /^state-\d{8}\.db$/.test(f)).sort().reverse().slice(BACKUPS_KEPT);
      for (const f of old) rmSync(path.join(dir, f), { force: true });
      return wrote;
    } finally {
      release();
    }
  }

  // ---------- transaction handles ----------

  private makeTx(st: TxState): StateTx {
    const handles = {} as Record<StoreName, unknown>;
    const cache = new Map<StoreName, unknown>();
    for (const name of STORES) {
      Object.defineProperty(handles, name, {
        enumerable: true,
        get: () => {
          if (!st.stores.has(name)) throw new StateStoreError("NOT_IN_SCOPE", `store "${name}" is not part of this transaction`);
          let h = cache.get(name);
          if (!h) { h = this.storeTx(st, name); cache.set(name, h); }
          return h;
        },
      });
    }
    return handles as unknown as StateTx;
  }

  /** WHERE/ORDER for a query; returns SQL fragments and parameters. */
  private plan(name: StoreName, q: StateQuery): { where: string; order: string; params: Array<string | number | Uint8Array | null> } {
    const spec = STATE_SCHEMA[name];
    const params: Array<string | number | Uint8Array | null> = [];
    const conds: string[] = [];
    let r = "kr", n = "kn", s = "ks", u = "k";
    if (q.index !== undefined) {
      if (!spec.indexes[q.index]) throw new StateStoreError("NOT_IN_SCOPE", `store "${name}" has no index "${q.index}"`);
      const c = col(q.index);
      r = `i_${c}_r`; n = `i_${c}_n`; s = `i_${c}_s`; u = `i_${c}_u`;
      conds.push(`${r} IS NOT NULL`);
    }
    if (q.only !== undefined) {
      if (q.index === undefined && !isStateKey(q.only)) {
        conds.push("0");
      } else {
        conds.push(`${u} = ?`);
        params.push(enc(q.only).u);
      }
    }
    const bound = (v: IndexValue, open: boolean | undefined, dir: "lower" | "upper"): void => {
      const e = enc(v);
      const gt = dir === "lower" ? ">" : "<";
      const ge = open ? gt : gt + "=";
      if (e.r === 2) {
        conds.push(`(${r} ${gt} ? OR (${r} = ? AND ${s} ${ge} ?))`);
        params.push(e.r, e.r, e.s);
      } else {
        conds.push(`(${r} ${gt} ? OR (${r} = ? AND ${n} ${ge} ?))`);
        params.push(e.r, e.r, e.n);
      }
    };
    if (q.lower !== undefined) bound(q.lower, q.lowerOpen, "lower");
    if (q.upper !== undefined) bound(q.upper, q.upperOpen, "upper");
    const d = q.direction === "prev" ? "DESC" : "ASC";
    const keyOrder = `kr ${d}, kn ${d}, ks ${d}`;
    const order = q.index !== undefined ? `${r} ${d}, ${n} ${d}, ${s} ${d}, ${keyOrder}` : keyOrder;
    return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", order, params };
  }

  private storeTx(st: TxState, name: StoreName): StoreTx<never, never> {
    const spec: StoreSpec = STATE_SCHEMA[name];
    const table = `"t_${name}"`;
    const ixNames = Object.keys(spec.indexes);
    const guard = (write: boolean): void => {
      if (this.crashed) throw new StateStoreError("CRASHED", "transaction belongs to an abandoned store");
      if (st.done) throw new StateStoreError("CLOSED", "transaction already finished (did fn await something outside the transaction?)");
      if (st.failure) throw st.failure;
      if (write && st.mode === "readonly") throw new StateStoreError("READONLY", `write to "${name}" in a readonly transaction`);
    };
    const doom = (e: StateStoreError): never => {
      st.failure = e;
      throw e;
    };
    const select = (cols: string, q: StateQuery = {}): Row[] => {
      const p = this.plan(name, q);
      const lim = q.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(q.limit))}` : "";
      return this.q(`SELECT ${cols} FROM ${table} ${p.where} ORDER BY ${p.order}${lim}`).all(...p.params) as unknown as Row[];
    };
    const value = (row: Row): unknown => decodeValue(row.v, row.b);
    const insertCols = ["k", "kr", "kn", "ks", "v", "b"];
    for (const ix of ixNames) { const c = col(ix); insertCols.push(`i_${c}_r`, `i_${c}_n`, `i_${c}_s`, `i_${c}_u`); }
    // Upsert on the primary key only: a unique-index clash must raise, never delete the other row
    // (INSERT OR REPLACE would silently remove the holder).
    const insertSql = `INSERT INTO ${table} (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(k) DO UPDATE SET ${insertCols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`;

    const api = {
      get: async (key: StateKey) => {
        guard(false);
        if (!isStateKey(key)) return undefined;
        const row = this.q(`SELECT v, b FROM ${table} WHERE k = ?`).get(enc(key).u) as Row | undefined;
        return row ? value(row) : undefined;
      },
      getByIndex: async (index: string, v: IndexValue) => {
        guard(false);
        const row = select("v, b", { index, only: v, limit: 1 })[0];
        return row ? value(row) : undefined;
      },
      getAll: async (q?: StateQuery) => {
        guard(false);
        return select("v, b", q).map(value);
      },
      getAllKeys: async (q?: StateQuery) => {
        guard(false);
        return select("k", q).map((r) => decodeKey(r.k));
      },
      count: async (q?: StateQuery) => {
        guard(false);
        const p = this.plan(name, { ...(q ?? {}), direction: "next" });
        if (q?.limit !== undefined) return select("k", q).length;
        return (this.q(`SELECT COUNT(*) AS c FROM ${table} ${p.where}`).get(...p.params) as { c: number }).c;
      },
      put: async (input: unknown) => {
        guard(true);
        if (typeof input !== "object" || input === null) return doom(new StateStoreError("INVALID_KEY", `put into "${name}": value must be an object`));
        let encoded: { v: string; b: Uint8Array | null };
        const obj = { ...(input as Record<string, unknown>) };
        let key = obj[spec.keyPath];
        if (key === undefined && spec.autoIncrement) {
          const next = (this.autoInc.get(name) ?? 0) + 1;
          this.autoInc.set(name, next);
          key = next;
          obj[spec.keyPath] = key;
        }
        if (!isStateKey(key)) return doom(new StateStoreError("INVALID_KEY", `put into "${name}": "${spec.keyPath}" is not a valid key`));
        if (spec.autoIncrement && typeof key === "number" && key > (this.autoInc.get(name) ?? 0)) {
          this.autoInc.set(name, Math.floor(key));
        }
        try {
          encoded = encodeValue(obj);
        } catch (e) {
          if (e instanceof StateStoreError) return doom(e);
          return doom(new StateStoreError("INVALID_KEY", `put into "${name}": value is not serializable: ${(e as Error).message}`));
        }
        const ke = enc(key);
        const args: Array<string | number | Uint8Array | null> = [ke.u, ke.r, ke.n, ke.s, encoded.v, encoded.b];
        for (const ix of ixNames) {
          const ixSpec = spec.indexes[ix];
          const iv = ixSpec ? obj[ixSpec.keyPath] : undefined;
          if (isIndexValue(iv)) {
            const e = enc(iv);
            if (ixSpec?.unique) {
              const clash = this.q(`SELECT k FROM ${table} WHERE i_${col(ix)}_u = ? AND k <> ? LIMIT 1`).get(e.u, ke.u) as { k: string } | undefined;
              if (clash) {
                return doom(new StateStoreError("CONSTRAINT",
                  `unique index "${name}.${ix}" violated by key ${String(key)} (held by ${String(decodeKey(clash.k))})`));
              }
            }
            args.push(e.r, e.n, e.s, e.u);
          } else {
            args.push(null, null, null, null);
          }
        }
        try {
          this.q(insertSql).run(...args);
          if (spec.autoIncrement) {
            this.q(`INSERT OR REPLACE INTO "_autoinc" (store, n) VALUES (?, ?)`).run(name, this.autoInc.get(name) ?? 0);
          }
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (/UNIQUE|constraint/i.test(msg)) return doom(new StateStoreError("CONSTRAINT", `put into "${name}": ${msg}`));
          return doom(new StateStoreError("COMMIT_FAILED", `put into "${name}": ${msg}`));
        }
        st.writes++;
        return key;
      },
      delete: async (key: StateKey) => {
        guard(true);
        if (isStateKey(key)) this.q(`DELETE FROM ${table} WHERE k = ?`).run(enc(key).u);
        st.writes++;
      },
      clear: async () => {
        guard(true);
        this.q(`DELETE FROM ${table}`).run();
        st.writes++;
      },
    };
    return api as unknown as StoreTx<never, never>;
  }
}

function createLayout(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS "_autoinc" (store TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
    for (const name of STORES) {
      const spec = STATE_SCHEMA[name];
      const cols = ["k TEXT PRIMARY KEY", "kr INTEGER NOT NULL", "kn REAL", "ks BLOB", "v TEXT NOT NULL", "b BLOB"];
      for (const ix of Object.keys(spec.indexes)) {
        const c = col(ix);
        cols.push(`i_${c}_r INTEGER`, `i_${c}_n REAL`, `i_${c}_s BLOB`, `i_${c}_u TEXT`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS "t_${name}" (${cols.join(", ")})`);
      db.exec(`CREATE INDEX IF NOT EXISTS "o_${name}" ON "t_${name}" (kr, kn, ks)`);
      for (const [ix, ixs] of Object.entries(spec.indexes)) {
        const c = col(ix);
        db.exec(`CREATE INDEX IF NOT EXISTS "x_${name}_${c}" ON "t_${name}" (i_${c}_r, i_${c}_n, i_${c}_s, kr, kn, ks)`);
        db.exec(`CREATE ${ixs.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "u_${name}_${c}" ON "t_${name}" (i_${c}_u)`);
      }
    }
    db.exec(`PRAGMA user_version = ${SQLITE_LAYOUT_VERSION}`);
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
