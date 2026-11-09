// StateStore contract (design §3.3; engine-spec §2). The interface and schema live in @shuttle/protocol
// (state.ts, state-schema.ts) so IdbStateStore (plugin), SqliteStateStore (headless) and MemStateStore
// (testkit) share one definition. This module adds typed access to the `meta` store.

export type { StateStore, StateTx, StoreTx, StoreName, StateQuery, TxMode, StateKey } from "@shuttle/protocol";
export { STATE_SCHEMA, STATE_SCHEMA_VERSION, STORE_NAMES, StateStoreError, isStateStoreError } from "@shuttle/protocol";

import type { Seq, StateStore, StateTx, SyncMode } from "@shuttle/protocol";

/** Rebuild-from-scan progress (design §3.3.5). */
export type RebuildState = 'snapshot' | 'scan' | 'pair' | null;

/** Value type per `meta` key (design §3.3.2 row 1). */
export interface MetaValues {
  schemaVersion: number;
  dbEpoch: string;
  vaultId: string;
  deviceId: string;
  cursor: Seq;
  cursorAt: number;
  remoteEpoch: number;
  minSeq: Seq;
  lastFullScanAt: number;
  filterFingerprint: string;
  rebuildState: RebuildState;
  paused: boolean;
  mode: SyncMode;
}
export type MetaName = keyof MetaValues;

/** Read one meta value inside a transaction that names `meta`. */
export async function getMeta<K extends MetaName>(tx: StateTx, k: K): Promise<MetaValues[K] | undefined> {
  const row = await tx.meta.get(k);
  return row === undefined ? undefined : (row.v as MetaValues[K]);
}

export async function setMeta<K extends MetaName>(tx: StateTx, k: K, v: MetaValues[K]): Promise<void> {
  await tx.meta.put({ k, v });
}

/** One-shot read in its own readonly transaction. */
export function readMeta<K extends MetaName>(state: StateStore, k: K): Promise<MetaValues[K] | undefined> {
  return state.tx(["meta"], (tx) => getMeta(tx, k), "readonly");
}

/** One-shot write in its own transaction. */
export function writeMeta<K extends MetaName>(state: StateStore, k: K, v: MetaValues[K]): Promise<void> {
  return state.tx(["meta"], (tx) => setMeta(tx, k, v));
}
