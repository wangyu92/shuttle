// Rename rule and scope transitions (design §3.6.1, S22; engine-spec §3.5 rename rows).
//
//  - to out of scope: the entry stays at `from` and is marked missing (→ S5 PUSH_DELETE); `to` is a
//    new untracked path (reconcile tracks it with its scope flag).
//  - from out of scope, to active: `to` is a create (PUSH_CREATE, or ADOPT when the remote has the same
//    content there); the out-of-scope entry is left alone (filters never delete).
//  - both active, `to` free: entry.path = to immediately (memory + store), mark the fileId dirty; the
//    Planner sees path != synced.path (S3/S4).
//  - both active, `to` held by a stale entry: never rewrite (unique `path` index). Mark the stale entry
//    missing and keep the rename pending; retry() applies it once `to` is free. While pending, the
//    Reconciler (ReconcileHooks.renames) defers the mover and treats `to` as absent for the holder.
//    Callers MUST call retry() after each reconcile batch (and after FORGET / delete acks).

import { isStateStoreError, type FileId } from "@shuttle/protocol";
import type { FileIndex } from "../index/FileIndex";
import type { DirtyKey, DirtyReason } from "../types";
import type { ScopeFn } from "./scope";

export interface RenameDeps {
  index: FileIndex;
  scopeOf: ScopeFn;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
}

interface PendingRename { fileId: FileId; from: string; to: string; groupId?: string }

export class LocalRenames {
  private pending = new Map<string, PendingRename>();
  /** groupId per fileId of the latest folder move, for the activity log ("Moved folder X (N files)"). */
  readonly groups = new Map<FileId, string>();

  constructor(private readonly d: RenameDeps) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** True while `fileId` waits for its rename target to free up; reconcile defers it (no S5 for the mover). */
  isPendingSource(fileId: FileId): boolean {
    for (const p of this.pending.values()) if (p.fileId === fileId) return true;
    return false;
  }

  /**
   * The mover whose content now sits at `path` while the rename is pending. reconcile treats `path` as
   * absent for every other entry, so the stale holder never adopts the mover's bytes as its own edit.
   */
  pendingMoverFor(path: string): FileId | null {
    return this.pending.get(path)?.fileId ?? null;
  }

  async rename(from: string, to: string, groupId?: string): Promise<void> {
    const e = this.d.index.byPath(from);
    if (!e) {
      this.d.markDirty({ path: to }, "new");
      return;
    }
    const scTo = this.d.scopeOf(to);
    if (scTo !== "active" || e.scope !== "active") {
      if (e.scope === "active") this.d.markDirty({ fileId: e.fileId, path: from }, "missing");
      this.d.markDirty({ path: to }, "new");
      return;
    }
    await this.tryMove({ fileId: e.fileId, from, to, ...(groupId !== undefined ? { groupId } : {}) });
  }

  /** Re-attempt pending renames whose target became free. Call after each reconcile batch. */
  async retry(): Promise<void> {
    for (const p of [...this.pending.values()]) {
      this.pending.delete(p.to);
      const e = this.d.index.byFileId(p.fileId);
      if (!e || e.path !== p.from) continue;
      await this.tryMove(p);
    }
  }

  private async tryMove(p: PendingRename): Promise<void> {
    const holder = this.d.index.byPath(p.to);
    if (holder && holder.fileId !== p.fileId) {
      this.pending.set(p.to, p);
      this.d.markDirty({ fileId: holder.fileId, path: holder.path }, "missing");
      return;
    }
    try {
      await this.d.index.setPath(p.fileId, p.to);
    } catch (err) {
      if (!isStateStoreError(err, "CONSTRAINT")) throw err;
      this.pending.set(p.to, p);
      return;
    }
    if (p.groupId !== undefined) this.groups.set(p.fileId, p.groupId);
    this.d.markDirty({ fileId: p.fileId, path: p.to }, "rename");
  }
}
