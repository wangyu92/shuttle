// Local state DB contract (design §3.3, §3.7.1, §3.8.4, §4.14). Types only; the store schema
// (names, key paths, indexes) is a value and lives in state-schema.ts.
//
// Implementations: IdbStateStore (plugin, IndexedDB), SqliteStateStore (headless, node:sqlite,
// design §6.1.5), MemStateStore (@shuttle/testkit).
//
// Transaction contract (all implementations):
//  - `tx(stores, fn)` runs `fn` in ONE transaction over exactly the named stores. Touching a store
//    that was not named throws StateStoreError('NOT_IN_SCOPE').
//  - All or nothing: if `fn` throws or rejects, or the commit fails, no write of the transaction is
//    visible afterwards and the error propagates.
//  - `fn` MUST await only operations of its own transaction. IndexedDB auto-commits a transaction
//    when control returns to the event loop with no pending request, so awaiting network, crypto or
//    timers inside `fn` is a bug (decrypt first, then open the transaction; design §3.8.1).
//  - Do not open a transaction from inside `fn`. Transactions are serialized; a nested one deadlocks.
//  - A unique-index violation throws StateStoreError('CONSTRAINT') and aborts the transaction.
//  - Values are structured clones: mutating an object after `put` or after `get` never changes
//    the stored value.

import type { BlobId, CommitResponse, DeviceId, FileId, PathKey, RetentionClass, Seq, VersionRecord } from "./types";

// ---------- record types (design §3.3.2) ----------

export type Scope = 'active' | 'excluded' | 'ignored' | 'oversize' | 'illegal';
export type FileKind = 'note' | 'config' | 'attachment' | 'other';

export interface FileObservation { mtime: number; size: number; hash: string | null; ino?: number; ctimeMs?: number }
export interface SyncedState { version: Seq; path: string; hash: string; size: number; mtime: number; hasBase: boolean }

export interface FileEntry {
  fileId: FileId;                 // hex32, immutable key
  path: string;                   // current local path (case-preserved, NFC)
  foldKey: string;
  scope: Scope;
  kind: FileKind;                 // drives merge policy
  obs: FileObservation | null;    // last OBSERVED; null = absent
  synced: SyncedState | null;     // B. Written only in the ack txn (§3.7.3) or apply txn (§3.8.4); null = never synced
  integrityHold?: boolean;        // §4.14
  updatedAt: number;
}

/** Decrypted mirror of the latest head record per fileId (tombstones included). */
export interface RemoteHead {
  fileId: FileId; seq: Seq; base: Seq | null;
  pathKey: PathKey; path: string; deleted: boolean;
  size: number; mtime: number; contentHash: string | null; chunkSizes: number[]; blobs: BlobId[]; inline?: string;
  kv: number; deviceId: DeviceId; cid?: string; ts: number;
  /** Record header fields and inline flags needed to open `inline` and blobs later (engine part 2). */
  rc?: RetentionClass; z?: boolean; p?: boolean; ctime?: number;
}

export interface BaseRow { fileId: FileId; version: Seq; hash: string; bytes: Uint8Array }

export type OpKind = 'put' | 'delete' | 'archive';
export type OpState = 'queued' | 'blobs' | 'ready' | 'sent' | 'failed';

/** Journal op (design §3.7.1). `opSeq` is assigned by the store (autoIncrement) when absent on put. */
export interface Op {
  opSeq: number;
  kind: OpKind;
  fileId: FileId;
  path: string;                 // resolved path → pathKey at seal time
  base: Seq | null;
  contentHash?: string; size?: number; mtime?: number; ctime?: number;
  chunkSizes?: number[]; blobs?: BlobId[]; inline?: boolean;   // plaintext-derived; NEVER sealed bytes (S27)
  state: OpState;
  batchId?: string;
  attempts: number; nextAttemptAt: number; lastError?: string;
  groupId?: string;             // folder op grouping for the log
  /** Where the content comes from: the file on disk (default) or the plaintext staged at enqueue (archive, X1 base re-upload). */
  source?: 'disk' | 'staging';
  createdAt: number;
}
/** An op before the store assigned `opSeq`. */
export type NewOp = Omit<Op, 'opSeq'> & { opSeq?: number };

export type BatchState = 'sent' | 'resolved';
export interface Batch {
  batchId: string;              // = cid (UUIDv4), generated once
  opSeqs: number[];             // frozen order
  atomic: boolean;
  opsDigest: string;            // b64u SHA-256(canon(op headers)), §2.8.3
  kv: number;
  state: BatchState;
  result?: CommitResponse;      // persisted on receipt, then applied by the ack txn
  createdAt: number;
}

/** Plaintext snapshot uploaded by the op (becomes the base on ack; source for re-seal). */
export interface StagingRow { opSeq: number; bytes: Uint8Array }

export interface ApplyQueueEntry { fileId: FileId; seq: Seq; enqueuedAt: number; attempts: number; lastError?: string }

/** Write intent (design §3.8.4), persisted before an engine write. */
export interface WriteIntent { path: string; fileId: FileId; preHash: string | null; targetHash: string | null }

export type IntegrityStage = 'meta' | 'inline' | 'blob' | 'freshness' | 'hash' | 'identity' | (string & {});
/** Quarantined record (design §4.14). */
export interface IntegrityEntry { seq: Seq; fileId: FileId; reason: string; stage: IntegrityStage }

/** Chunk cache entry (LRU by `lastUsed`; disabled on headless). */
export interface ChunkCacheEntry { blobId: BlobId; sealed: Uint8Array; size: number; lastUsed: number }

export type DeferReason = 'scope' | 'illegal' | 'oversize';
/** A record skipped for scope, illegal name or size; replayed when the filter changes. */
export interface DeferredEntry { fileId: FileId; seq: Seq; reason: DeferReason; path?: string; deferredAt: number }

/** `meta` keys (design §3.3.2 row 1). */
export type MetaKey =
  | 'schemaVersion' | 'dbEpoch' | 'vaultId' | 'deviceId' | 'cursor' | 'cursorAt' | 'remoteEpoch' | 'minSeq'
  | 'lastFullScanAt' | 'filterFingerprint' | 'rebuildState' | 'paused' | 'mode';
export interface MetaRow { k: MetaKey | (string & {}); v: unknown }
/** Backing row of the AdapterStateStore (design §2.12) inside the state DB. */
export interface AdapterRow { k: string; v: unknown }

/** Value type per store. */
export interface StoreValueMap {
  meta: MetaRow;
  files: FileEntry;
  bases: BaseRow;
  remote: RemoteHead;
  history: VersionRecord;       // archive records seen live (hint only)
  journal: Op;
  batches: Batch;
  staging: StagingRow;
  applyQueue: ApplyQueueEntry;
  intents: WriteIntent;
  integrity: IntegrityEntry;
  chunkCache: ChunkCacheEntry;
  deferred: DeferredEntry;
  adapter: AdapterRow;
}
export type StoreName = keyof StoreValueMap;

/** Value accepted by `put`: the journal's autoIncrement key may be absent. */
export type StoreInput<K extends StoreName> = K extends 'journal' ? NewOp : StoreValueMap[K];

// ---------- the store interface ----------

export type StateKey = string | number;
/** Index values. Booleans are allowed (e.g. `remote.deleted`); IndexedDB implementations encode them as 0/1. */
export type IndexValue = string | number | boolean;
export type TxMode = 'readonly' | 'readwrite';

/**
 * Range query over the primary key (no `index`) or over a declared index. Results are in key order
 * (`direction: 'prev'` reverses it); entries with equal index values are ordered by primary key.
 * Ordering of mixed key types follows IndexedDB: booleans < numbers < strings.
 */
export interface StateQuery {
  index?: string;
  only?: IndexValue;
  lower?: IndexValue; upper?: IndexValue; lowerOpen?: boolean; upperOpen?: boolean;
  direction?: 'next' | 'prev';
  limit?: number;
}

export interface StoreTx<V, In = V> {
  get(key: StateKey): Promise<V | undefined>;
  /** First match of an index value (unique indexes: the one match). */
  getByIndex(index: string, value: IndexValue): Promise<V | undefined>;
  getAll(q?: StateQuery): Promise<V[]>;
  getAllKeys(q?: StateQuery): Promise<StateKey[]>;
  count(q?: StateQuery): Promise<number>;
  /** Insert or replace by key path; returns the key (assigned when the store autoIncrements and the key is absent). */
  put(value: In): Promise<StateKey>;
  delete(key: StateKey): Promise<void>;
  clear(): Promise<void>;
}

export type StateTx = { readonly [K in StoreName]: StoreTx<StoreValueMap[K], StoreInput<K>> };

export interface StateStore {
  /** Schema version of the opened database (design §3.3.1). */
  readonly schemaVersion: number;
  tx<T>(stores: readonly StoreName[], fn: (tx: StateTx) => Promise<T>, mode?: TxMode): Promise<T>;
  close(): Promise<void>;
  /** Delete the whole database (eviction recovery and tests). The store is closed afterwards. */
  destroy(): Promise<void>;
}

export type StateStoreErrorCode =
  | 'CONSTRAINT'      // unique index violated
  | 'NOT_IN_SCOPE'    // store not named in tx()
  | 'READONLY'        // write in a readonly transaction
  | 'CLOSED'          // store closed or destroyed
  | 'CRASHED'         // test fault: the process "died" before commit
  | 'COMMIT_FAILED'   // commit did not complete (quota, I/O, injected fault)
  | 'NEWER_SCHEMA'    // stored schemaVersion is newer than the code (refuse, "update plugin")
  | 'INVALID_KEY';    // value lacks its key path or the key is not a valid key
