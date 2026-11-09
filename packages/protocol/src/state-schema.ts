// State DB schema as data (design §3.3.2), shared by IdbStateStore, SqliteStateStore and MemStateStore
// so all three agree on key paths and indexes.

import type { MetaKey, StateKey, StateStore, StateStoreErrorCode, StoreName } from "./state";
import type { AdapterStateStore } from "./types";

/** Current schema version written to `meta.schemaVersion`. Migrations are forward-only. */
export const STATE_SCHEMA_VERSION = 1;

export interface IndexSpec { keyPath: string; unique: boolean }
export interface StoreSpec { keyPath: string; autoIncrement: boolean; indexes: Readonly<Record<string, IndexSpec>> }

const idx = (keyPath: string, unique = false): IndexSpec => ({ keyPath, unique });
const store = (keyPath: string, indexes: Record<string, IndexSpec> = {}, autoIncrement = false): StoreSpec =>
  ({ keyPath, autoIncrement, indexes: Object.freeze(indexes) });

/** design §3.3.2. Index names equal their key paths. */
export const STATE_SCHEMA: Readonly<Record<StoreName, StoreSpec>> = Object.freeze({
  meta: store("k"),
  files: store("fileId", { path: idx("path", true), foldKey: idx("foldKey"), scope: idx("scope") }),
  bases: store("fileId"),
  remote: store("fileId", { pathKey: idx("pathKey"), path: idx("path"), deleted: idx("deleted") }),
  history: store("seq", { fileId: idx("fileId") }),
  journal: store("opSeq", { fileId: idx("fileId"), state: idx("state"), batchId: idx("batchId") }, true),
  batches: store("batchId", { state: idx("state") }),
  staging: store("opSeq"),
  applyQueue: store("fileId", { seq: idx("seq") }),
  intents: store("path", { fileId: idx("fileId") }),
  integrity: store("seq", { fileId: idx("fileId") }),
  chunkCache: store("blobId", { lastUsed: idx("lastUsed") }),
  deferred: store("fileId"),
  adapter: store("k"),
});

export const STORE_NAMES: readonly StoreName[] = Object.freeze(Object.keys(STATE_SCHEMA) as StoreName[]);

export const META_KEYS: readonly MetaKey[] = Object.freeze([
  "schemaVersion", "dbEpoch", "vaultId", "deviceId", "cursor", "cursorAt", "remoteEpoch", "minSeq",
  "lastFullScanAt", "filterFingerprint", "rebuildState", "paused", "mode",
] as MetaKey[]);

export class StateStoreError extends Error {
  readonly code: StateStoreErrorCode;
  constructor(code: StateStoreErrorCode, message: string) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
  }
}

export function isStateStoreError(e: unknown, code?: StateStoreErrorCode): e is StateStoreError {
  return e instanceof StateStoreError && (code === undefined || e.code === code);
}

/** True for values usable as a primary key (finite number or string). */
export function isStateKey(v: unknown): v is StateKey {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * The adapter's durable state (design §2.12 AdapterStateStore) on top of the engine's state DB
 * (`adapter` store, §3.3.2). Each call is its own transaction.
 */
export function adapterStateStoreOver(state: StateStore): AdapterStateStore {
  return {
    get: (k) => state.tx(["adapter"], async (tx) => (await tx.adapter.get(k))?.v, "readonly"),
    put: (k, v) => state.tx(["adapter"], async (tx) => { await tx.adapter.put({ k, v }); }),
    delete: (k) => state.tx(["adapter"], (tx) => tx.adapter.delete(k)),
  };
}
