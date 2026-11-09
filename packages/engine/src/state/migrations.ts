// Schema version handling (design §3.3.1). A newer stored version than the code knows → refuse
// ("update plugin"). Migrations are forward-only, one step per version, each in one transaction.
// IdbStateStore runs the store/index part of a migration in onupgradeneeded; the steps here migrate
// row contents and are shared by every StateStore implementation.

import { STATE_SCHEMA_VERSION, STORE_NAMES, StateStoreError, type StateStore, type StateTx } from "@shuttle/protocol";
import { getMeta, setMeta } from "./StateStore";

export interface Migration {
  /** Version this step produces (from = to - 1). */
  to: number;
  run(tx: StateTx): Promise<void>;
}

/** v1 is the first schema; later versions append steps here. */
export const MIGRATIONS: readonly Migration[] = [];

export interface OpenResult {
  /** The database had no schemaVersion (fresh or wiped) and was initialised. */
  created: boolean;
  /** dbEpoch stored in meta (design §3.3.5 eviction detection). */
  dbEpoch: string;
  migratedFrom: number | null;
}

/**
 * Check or initialise `meta.schemaVersion` and `meta.dbEpoch`, then run pending migrations.
 * Throws StateStoreError('NEWER_SCHEMA') when the stored version is newer than this code.
 */
export async function prepareState(
  state: StateStore,
  o: { newDbEpoch: () => string; migrations?: readonly Migration[]; codeVersion?: number },
): Promise<OpenResult> {
  const code = o.codeVersion ?? STATE_SCHEMA_VERSION;
  const steps = [...(o.migrations ?? MIGRATIONS)].sort((a, b) => a.to - b.to);
  if (state.schemaVersion > code) {
    throw new StateStoreError("NEWER_SCHEMA", `state DB schema ${state.schemaVersion} is newer than ${code}; update the plugin`);
  }
  return state.tx([...STORE_NAMES], async (tx) => {
    const stored = await getMeta(tx, "schemaVersion");
    let dbEpoch = await getMeta(tx, "dbEpoch");
    if (stored === undefined) {
      dbEpoch ??= o.newDbEpoch();
      await setMeta(tx, "schemaVersion", code);
      await setMeta(tx, "dbEpoch", dbEpoch);
      return { created: true, dbEpoch, migratedFrom: null };
    }
    if (stored > code) throw new StateStoreError("NEWER_SCHEMA", `state DB schema ${stored} is newer than ${code}; update the plugin`);
    let v = stored;
    for (const m of steps) {
      if (m.to <= v) continue;
      if (m.to !== v + 1) throw new StateStoreError("COMMIT_FAILED", `missing migration to schema ${v + 1}`);
      await m.run(tx);
      v = m.to;
    }
    if (v !== code) throw new StateStoreError("COMMIT_FAILED", `no migration path from schema ${stored} to ${code}`);
    if (v !== stored) await setMeta(tx, "schemaVersion", v);
    if (dbEpoch === undefined) {
      dbEpoch = o.newDbEpoch();
      await setMeta(tx, "dbEpoch", dbEpoch);
    }
    return { created: false, dbEpoch, migratedFrom: v !== stored ? stored : null };
  });
}
