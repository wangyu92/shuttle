// SQLite storage, schema v1 (design §2.8.2, §2.8.3) on node:sqlite DatabaseSync. AGPL-3.0-only.
// Everything here is synchronous on purpose: commits, the blob PUT's final step and GC phase (b)
// rely on running without an await between their reads and writes (design §2.8.1, §2.7.7).
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const SCHEMA_VERSION = "1";

const SCHEMA_SQL = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE users (
  user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  pw_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  created_at INTEGER NOT NULL);
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users,
  name TEXT NOT NULL, platform TEXT NOT NULL, client_version TEXT,
  token_hash BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, last_ip TEXT, revoked_at INTEGER);
CREATE TABLE enroll_codes (
  code_hash BLOB PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users,
  created_by TEXT, expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT);
CREATE TABLE vaults (
  vault_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, owner_user TEXT NOT NULL REFERENCES users,
  info_json TEXT NOT NULL, info_etag TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0, min_seq INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1,
  restored_seq INTEGER, rollback_at INTEGER,
  quota_bytes INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE vault_members (vault_id TEXT, user_id TEXT, role TEXT NOT NULL, PRIMARY KEY (vault_id, user_id));
CREATE TABLE device_cursors (vault_id TEXT, device_id TEXT, acked_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  rollback_ack INTEGER,
  PRIMARY KEY (vault_id, device_id));
CREATE TABLE files (
  vault_id TEXT, file_id TEXT, head_seq INTEGER NOT NULL, head_kind TEXT NOT NULL CHECK (head_kind IN ('put','del')),
  path_key TEXT NOT NULL, rc TEXT NOT NULL,
  PRIMARY KEY (vault_id, file_id));
CREATE INDEX files_by_head ON files (vault_id, head_seq);
CREATE UNIQUE INDEX files_live_path ON files (vault_id, path_key) WHERE head_kind = 'put';
CREATE TABLE versions (
  vault_id TEXT, seq INTEGER, file_id TEXT NOT NULL, path_key TEXT NOT NULL, base_seq INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('put','del','archive')), rc TEXT NOT NULL,
  kv INTEGER NOT NULL, meta BLOB NOT NULL, inline BLOB, enc_size INTEGER NOT NULL,
  device_id TEXT NOT NULL, ts INTEGER NOT NULL, cid TEXT,
  PRIMARY KEY (vault_id, seq));
CREATE INDEX versions_by_file ON versions (vault_id, file_id, seq);
CREATE TABLE version_blobs (vault_id TEXT, seq INTEGER, ord INTEGER, blob_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, seq, ord));
CREATE INDEX vb_by_blob ON version_blobs (vault_id, blob_id);
CREATE TABLE blobs (
  vault_id TEXT, blob_id TEXT, size INTEGER NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','doomed')),
  PRIMARY KEY (vault_id, blob_id));
CREATE TABLE commits (vault_id TEXT, device_id TEXT, cid TEXT, ops_digest BLOB NOT NULL, result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, device_id, cid));
CREATE TABLE pairing (vault_id TEXT, pair_id TEXT, body TEXT NOT NULL, created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY (vault_id, pair_id));
`;

export class SchemaError extends Error {}

/** Opens (and on first use creates) shuttle.db with the §2.6.2 pragmas. */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?)").run(SCHEMA_VERSION);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
  } else {
    const row = db.prepare("SELECT v FROM meta WHERE k='schema'").get() as { v: string } | undefined;
    if (row?.v !== SCHEMA_VERSION) {
      db.close();
      throw new SchemaError(`unsupported database schema ${row?.v ?? "(none)"}; this server reads schema ${SCHEMA_VERSION}`);
    }
  }
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE … COMMIT; rolls back on throw. fn must be synchronous. */
export function txImmediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let ok = false;
  try {
    const r = fn();
    db.exec("COMMIT");
    ok = true;
    return r;
  } finally {
    if (!ok && db.isTransaction) db.exec("ROLLBACK");
  }
}

/** Prepared-statement cache keyed by SQL text. */
export class Stmts {
  private cache = new Map<string, StatementSync>();
  constructor(readonly db: DatabaseSync) {}
  q(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  get<T>(sql: string, ...args: SqlArg[]): T | undefined {
    return this.q(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SqlArg[]): T[] {
    return this.q(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SqlArg[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.q(sql).run(...args);
  }
}

export type SqlArg = string | number | null | Uint8Array | bigint;

export function metaGet(s: Stmts, k: string): string | null {
  return s.get<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v ?? null;
}

export function metaSet(s: Stmts, k: string, v: string): void {
  s.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
}
