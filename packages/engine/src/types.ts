// Engine vocabulary (design §3.1). Record types live in @shuttle/protocol (state.ts) so StateStore is
// fully typed for every implementation; they are re-exported here, never redefined.

export type {
  ApplyQueueEntry, Batch, BaseRow, ChunkCacheEntry, DeferredEntry, FileEntry, FileKind, FileObservation,
  IntegrityEntry, MetaKey, MetaRow, Op, OpKind, OpState, NewOp, RemoteHead, Scope, StagingRow, SyncedState,
  WriteIntent, ConflictMode, SyncMode, DeviceSettings, LogCategory, FileId, Seq,
} from "@shuttle/protocol";

import type { FileId, LocalStat, RemoteHead } from "@shuttle/protocol";

/** What reconcile observed on disk for one file (design §3.4.4 `L`). */
export interface LocalState {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  ino?: number;
  ctimeMs?: number;
}

/** Why a key entered the dirty set (design §3.4.2). */
export type DirtyReason =
  | 'new' | 'stat-changed' | 'missing' | 'event' | 'rename' | 'remote' | 'apply' | 'pathTaken' | 'conflict'
  | 'scope' | 'retry' | 'redirty';

/**
 * Dirty-set key: fileId when known, else path (design §3.4.2). `pathTaken` carries the holder from a
 * PATH_TAKEN commit result into the Planner (row P1).
 */
export interface DirtyKey {
  fileId?: FileId;
  path: string;
  pathTaken?: RemoteHead;
  stat?: LocalStat;
}

/** Reconcile pass context (design §3.4.3 `ctx.mode`). */
export type PlanMode = 'incremental' | 'snapshotResync' | 'rebuild' | 'epoch';
