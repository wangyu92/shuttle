// Index-only executions of Planner actions (design §3.4.4: "ADOPT/FORGET → one index transaction").
// Part 2's executor calls these; they never touch the disk or the remote.
// FORGET must also cancel any non-frozen journal op of that fileId (part 2: Journal), because a
// queued create for a file that no longer exists must not be committed.

import type { FileEntry, FileId, FileKind, RemoteHead, Scope } from "@shuttle/protocol";
import type { FileIndex } from "../index/FileIndex";
import { foldKey } from "../path/normalize";
import type { LocalState } from "../types";
import { observationOf } from "./fastPath";

export interface AdoptInput {
  /** Remote head being adopted (its fileId becomes the entry's key). */
  R: RemoteHead;
  /** The local observation whose hash equals R.contentHash. */
  L: LocalState;
  /** Our own entry to replace when it has a different fileId. */
  replaces?: FileId;
  kind: FileKind;
  scope?: Scope;
  /** Text base to store (notes ≤ baseMaxBytes, design §3.3.4); omit for none. */
  baseBytes?: Uint8Array;
  now: number;
}

/** ADOPT: synced = R, obs = L, at R.path; replaces our entry in the same transaction. */
export function adoptInIndex(index: FileIndex, a: AdoptInput): Promise<FileEntry> {
  if (a.R.deleted || a.R.contentHash === null || a.R.contentHash !== a.L.hash) {
    return Promise.reject(new Error("ADOPT requires a live remote head with the local hash"));
  }
  return index.write(["bases"], async (w) => {
    if (a.replaces && a.replaces !== a.R.fileId) await w.deleteEntry(a.replaces);
    const prev = w.entry(a.R.fileId);
    const e: FileEntry = {
      fileId: a.R.fileId, path: a.R.path, foldKey: foldKey(a.R.path), scope: a.scope ?? prev?.scope ?? "active", kind: a.kind,
      obs: observationOf({ path: a.R.path, kind: "file", size: a.L.size, mtime: a.L.mtime, ctime: 0, ...(a.L.ino !== undefined ? { ino: a.L.ino } : {}), ...(a.L.ctimeMs !== undefined ? { ctimeMs: a.L.ctimeMs } : {}) }, a.L.hash),
      synced: { version: a.R.seq, path: a.R.path, hash: a.L.hash, size: a.L.size, mtime: a.R.mtime, hasBase: a.baseBytes !== undefined },
      updatedAt: a.now,
    };
    await w.putEntry(e);
    if (a.baseBytes !== undefined) await w.tx.bases.put({ fileId: e.fileId, version: a.R.seq, hash: a.L.hash, bytes: a.baseBytes });
    else await w.tx.bases.delete(e.fileId);
    return e;
  });
}

/** FORGET: drop the entry and its base. */
export function forgetInIndex(index: FileIndex, fileId: FileId): Promise<void> {
  return index.forget(fileId);
}
