// Eviction detection (design §3.3.5; engine-spec §2.5). Pure classifier over the four-row table plus
// the localStorage record shape and the capped pendingOps mirror (S26).
// The rebuild-from-scan procedure itself (snapshot → scan → pair) is part 2 / part 3 work; it reads
// `meta.rebuildState` (state/StateStore.ts MetaValues) to resume.

import type { FileId } from "@shuttle/protocol";

export const PENDING_OPS_CAP = 500;

export interface PendingOpMirror { fileId: FileId; kind: 'put' | 'delete' | 'archive'; fromPath?: string; toPath?: string }

/** Vault-scoped localStorage record (design §3.3.5). */
export interface LocalRecord {
  deviceId: string;
  dbEpoch: string;
  remoteProfileId: string;
  everSynced: boolean;
  pendingOps: PendingOpMirror[];
}

export type StartupClass =
  | 'fresh'      // nothing anywhere: onboarding (non-empty vault warning)
  | 'evicted'    // localStorage says we synced, the DB is gone or a different one: rebuild
  | 'adoptIdb'   // localStorage cleared, DB intact: adopt it and rewrite localStorage
  | 'normal';

/**
 * design §3.3.5 table. `idbEpoch` is meta.dbEpoch, or null when the DB is absent or empty.
 * A localStorage record that never synced with a missing or mismatched DB is treated as fresh: nothing
 * was ever paired, and onboarding uses the same no-base rules as a rebuild (never deletes).
 */
export function classifyStartup(local: Pick<LocalRecord, "dbEpoch" | "everSynced"> | null, idbEpoch: string | null): StartupClass {
  if (!local) return idbEpoch === null ? "fresh" : "adoptIdb";
  if (idbEpoch !== null && idbEpoch === local.dbEpoch) return "normal";
  return local.everSynced ? "evicted" : "fresh";
}

/** Add or replace the mirror entry for `op.fileId`, keeping at most PENDING_OPS_CAP entries (oldest dropped). */
export function mirrorPendingOp(list: readonly PendingOpMirror[], op: PendingOpMirror): PendingOpMirror[] {
  const out = list.filter((x) => x.fileId !== op.fileId);
  out.push(op);
  return out.length > PENDING_OPS_CAP ? out.slice(out.length - PENDING_OPS_CAP) : out;
}

export function unmirrorPendingOp(list: readonly PendingOpMirror[], fileId: FileId): PendingOpMirror[] {
  return list.filter((x) => x.fileId !== fileId);
}
