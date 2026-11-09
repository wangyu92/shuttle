// Planner.decide (design §3.4.3, engine-spec §3.3, invariant I8). PURE: no IO, no timers, no clock.
//
// Inputs are L (disk), B (entry.synced), R (remote head), P (PATH_TAKEN holder), scope, kind and the
// pass context. Output is one Action tagged with the design row that produced it. Path and content are
// resolved independently: a conflict row may carry `preRename` (LOCAL_RENAME to the resolved path,
// which the executor runs BEFORE any content write or push), and every push after a conflict row
// carries the resolved path and base = R.seq.
//
// Extension points:
//  - Part 2 (journal, op runner, applier) executes Actions through reconcile/Reconciler.ts
//    ActionExecutor. Conflict-copy names (merge/conflictName.ts) and template-prefix ADOPT
//    (MergePolicy.isTemplatePrefix) are computed there, because they need time, device name, disk
//    existence and file content.
//  - Part 3 (modes) applies applySyncMode() after decide(); the table itself never looks at SyncMode.

import type { ConflictMode, FileId, FileKind, LogCategory, RemoteHead, Scope, Seq, SyncMode, SyncedState } from "@shuttle/protocol";
import { strategyFor, type MergeStrategy } from "../merge/MergePolicy";
import { foldKey } from "../path/normalize";
import type { LocalState, PlanMode } from "../types";

export type PlanRow =
  | 'SCOPE' | 'HOLD'
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8'
  | 'X1'
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8'
  | 'P1'
  | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7';

/** i18n key + params for the activity log (design §3.16); the executor emits it. */
export interface LogHint { key: string; cat: LogCategory; params?: Record<string, string | number | boolean | null> }

interface ActionBase {
  row: PlanRow;
  /** Path resolution: rename the local file from → to first (design §3.4.3 "path and content"). */
  preRename?: { from: string; to: string };
  log?: LogHint;
}

/** Where the bytes of a push come from: the file on disk, or the stored base (row X1 with L absent). */
export type PushSource = 'local' | 'base';

export type Action =
  | (ActionBase & { type: 'NOOP'; why: string })
  /** Journal `put` op. */
  | (ActionBase & { type: 'PUSH_PUT'; fileId: FileId; path: string; base: Seq; source: PushSource })
  /** Journal `put` with base null. `fileId: null` = generate a fresh fileId (and a FileEntry) first. */
  /** `replaces`: the entry that holds `path` now and is superseded by the new fileId (same transaction). */
  | (ActionBase & { type: 'PUSH_CREATE'; fileId: FileId | null; path: string; source: PushSource; replaces?: FileId })
  /** Journal `delete` op (mass-delete guard applies, design §3.13). */
  | (ActionBase & { type: 'PUSH_DELETE'; fileId: FileId; path: string; base: Seq })
  /**
   * Apply the remote head locally into `path` (applier.applyOne). `thenPush`: push the local path
   * afterwards (row C8). `forget`: a never-synced local entry to drop once R is applied.
   */
  | (ActionBase & { type: 'PULL'; fileId: FileId; seq: Seq; path: string; thenPush?: { path: string; base: Seq }; forget?: FileId })
  /** Remove the local file (trash: content stays recoverable; design §1.3 invariant 10). */
  | (ActionBase & { type: 'LOCAL_DELETE'; fileId: FileId | null; path: string; mode: 'trash' })
  /** Rename locally and mark the file dirty again; content is resolved on the next pass (row C7). */
  | (ActionBase & { type: 'LOCAL_RENAME'; fileId: FileId; from: string; to: string })
  /**
   * Index-only: local content equals R. Track the file as R.fileId at version R.seq, path R.path.
   * `replaces`: our own (different) fileId to forget in the same transaction.
   */
  | (ActionBase & { type: 'ADOPT'; fileId: FileId; seq: Seq; path: string; replaces?: FileId })
  /** Drop the entry and its base; no file or remote change. */
  | (ActionBase & { type: 'FORGET'; fileId: FileId })
  /**
   * Both changed: resolve content per strategy, write locally if needed, push `fileId` with base = R.seq
   * at `path` (fileId is always R's identity, since the CAS is against R's head). `replaces`: a
   * never-synced local entry with another fileId to drop in the same transaction (row N4).
   */
  | (ActionBase & { type: 'MERGE'; strategy: MergeStrategy; fileId: FileId; path: string; base: Seq; remote: { fileId: FileId; seq: Seq }; replaces?: FileId })
  /**
   * Keep both by renaming the local file away to a conflict-copy name (keeps its fileId, or none yet),
   * then re-plan it there (it pushes as S3/S4/N1). `pull`: afterwards apply this remote head into the
   * original path (row N5). `allowTemplateAdopt`: notes only, design §3.10.6 refinement.
   */
  | (ActionBase & { type: 'KEEP_BOTH'; fileId: FileId | null; path: string; pull?: { fileId: FileId; seq: Seq; path: string }; allowTemplateAdopt: boolean })
  /** Local corruption or server bug: log, keep the local file, no delete anywhere, schedule snapshotResync. */
  | (ActionBase & { type: 'INTEGRITY_ERROR'; fileId: FileId | null; path: string; reason: string });

export type ActionType = Action['type'];

export interface PlanCtx {
  mode: PlanMode;
  /** Snapshot resync after the user accepted a server rollback: rows X1 apply to R absent too (design §3.13). */
  rollbackAccepted?: boolean;
  /** The conflict-loop fallback tripped for this file (design §3.10.1). */
  conflictLoop?: boolean;
}

export interface PlanEntry { fileId: FileId; path: string; synced: SyncedState | null; integrityHold?: boolean }

export interface PlanInput {
  /** Local disk state; null = absent. Its path is the entry's current path. */
  L: LocalState | null;
  /** Current tracked entry, if any (B = entry.synced). */
  entry: PlanEntry | null;
  /** With B: remote[entry.fileId]. Without B: the live head at this foldKey, else a tombstone there. */
  R: RemoteHead | null;
  /** PATH_TAKEN holder from a push result (row P1). */
  P?: RemoteHead | null;
  /** Path being reconciled when there is no entry. */
  path: string;
  scope: Scope;
  kind: FileKind;
  configJson: boolean;
  conflictMode: ConflictMode;
  ctx: PlanCtx;
  /** Row N6 (rebuild only): hash of the version the tombstone deleted (fetched with getVersion). */
  tombstoneBaseHash?: string | null;
  /** This device's scope of the live remote head's path (R.path); absent = active. */
  rScope?: Scope;
}

const LOG = {
  restored: { key: "log.restoredChangedElsewhere", cat: "general" },
  resurrect: { key: "log.resurrectedDeleted", cat: "general" },
  recreate: { key: "log.recreatedPurged", cat: "general" },
  lostInRestore: { key: "log.lostInServerRestore", cat: "error" },
  remotePathWins: { key: "log.remoteMoveWins", cat: "general" },
  integrity: { key: "log.integrityMissingHead", cat: "error" },
  conflict: { key: "log.mergeConflict", cat: "merge" },
  pathTaken: { key: "log.pathTaken", cat: "merge" },
  readOnly: { key: "log.skippedReadOnly", cat: "skipped" },
  pushOnly: { key: "log.skippedPushOnly", cat: "skipped" },
  reverted: { key: "log.revertedToRemote", cat: "general" },
} as const satisfies Record<string, LogHint>;

function noop(row: PlanRow, why: string): Action {
  return { type: "NOOP", row, why };
}

function withPre<A extends Action>(a: A, from: string, to: string): A {
  if (from !== to) a.preRename = { from, to };
  return a;
}

/** design §3.4.3. Total: every input yields exactly one Action. */
export function decide(i: PlanInput): Action {
  if (i.scope !== "active") return noop("SCOPE", `scope:${i.scope}`);
  if (i.entry?.integrityHold) return noop("HOLD", "integrityHold");
  const B = i.entry?.synced ?? null;
  const L = i.L;
  const P = i.P ?? null;
  if (pathTakenApplies(i)) return decidePathTaken(i, L as LocalState, P as RemoteHead);
  return B && i.entry ? decideWithBase(i, i.entry.fileId, B) : decideNoBase(i);
}

/**
 * Row P1 applies when a live holder under another fileId holds the path the local file is at now
 * (same foldKey). A holder of some other path is stale (the file moved since the push) and is ignored.
 */
export function pathTakenApplies(i: Pick<PlanInput, "L" | "P" | "entry">): boolean {
  const P = i.P ?? null;
  return !!P && !!i.L && !P.deleted && P.fileId !== i.entry?.fileId && foldKey(P.path) === foldKey(i.L.path);
}

function decidePathTaken(i: PlanInput, L: LocalState, P: RemoteHead): Action {
  const own = i.entry?.fileId ?? null;
  if (P.contentHash !== null && P.contentHash === L.hash) {
    const a: Action = { type: "ADOPT", row: "P1", fileId: P.fileId, seq: P.seq, path: P.path, log: LOG.pathTaken };
    if (own) a.replaces = own;
    return withPre(a, L.path, P.path);
  }
  // Never re-push the taken path: rename away, then the next pass pushes at the copy path. The holder
  // is pulled into the freed path right away (its head may already be known, so no apply is queued).
  return { type: "KEEP_BOTH", row: "P1", fileId: own, path: L.path, allowTemplateAdopt: false, pull: { fileId: P.fileId, seq: P.seq, path: P.path }, log: LOG.pathTaken };
}

function decideWithBase(i: PlanInput, fileId: FileId, B: SyncedState): Action {
  const L = i.L;
  const R = i.R;
  const lMoved = !!L && L.path !== B.path;
  const lMod = !!L && L.hash !== B.hash;
  const lc = lMoved || lMod;
  const curPath = L?.path ?? i.entry?.path ?? B.path;

  // X1: the remote went backwards (only after a rollback accept). Local is newer; never PULL.
  const behind = R ? R.seq < B.version : !!i.ctx.rollbackAccepted;
  if (behind) {
    if (L) {
      return R
        ? { type: "PUSH_PUT", row: "X1", fileId, path: L.path, base: R.seq, source: "local" }
        : { type: "PUSH_CREATE", row: "X1", fileId, path: L.path, source: "local" };
    }
    if (B.hasBase) {
      return R
        ? { type: "PUSH_PUT", row: "X1", fileId, path: B.path, base: R.seq, source: "base" }
        : { type: "PUSH_CREATE", row: "X1", fileId, path: B.path, source: "base" };
    }
    return { type: "FORGET", row: "X1", fileId, log: LOG.lostInRestore };
  }

  // R absent (purged): S8 / C5 / C6. Incremental mode → integrity error, never a delete.
  if (!R) {
    const row: PlanRow = !L ? "C6" : lc ? "C5" : "S8";
    if (i.ctx.mode === "incremental") {
      return { type: "INTEGRITY_ERROR", row, fileId, path: curPath, reason: "base without remote head", log: LOG.integrity };
    }
    if (!L) return { type: "FORGET", row, fileId };
    if (i.ctx.mode === "epoch") return { type: "PUSH_CREATE", row, fileId, path: L.path, source: "local", log: LOG.recreate };
    if (!lc) return { type: "LOCAL_DELETE", row, fileId, path: L.path, mode: "trash" };
    // C5 outside epoch mode: the old fileId is gone remotely; a new one takes over this path.
    return { type: "PUSH_CREATE", row, fileId: null, path: L.path, source: "local", replaces: fileId, log: LOG.recreate };
  }

  // Tombstone (newer than or equal to B): S7 / C4 / C6.
  if (R.deleted) {
    if (!L) return { type: "FORGET", row: "C6", fileId };
    if (!lc) return { type: "LOCAL_DELETE", row: "S7", fileId, path: L.path, mode: "trash" };
    return { type: "PUSH_PUT", row: "C4", fileId, path: L.path, base: R.seq, source: "local", log: LOG.resurrect };
  }

  // Remote unchanged since B: S1–S5.
  if (R.seq === B.version) {
    if (!L) return { type: "PUSH_DELETE", row: "S5", fileId, path: B.path, base: B.version };
    if (!lc) return noop("S1", "unchanged");
    const row: PlanRow = lMoved && lMod ? "S4" : lMoved ? "S3" : "S2";
    return { type: "PUSH_PUT", row, fileId, path: L.path, base: B.version, source: "local" };
  }

  // Remote live and changed.
  const rMoved = R.path !== B.path;
  const rContent = R.contentHash !== B.hash;
  if (rMoved && (i.rScope === "excluded" || i.rScope === "ignored")) {
    // Lead decision D6: the remote moved the file into a folder this device excludes. Never rename the
    // local file into it: the applier treats the file as gone from scope (an unchanged copy is
    // removed, a locally changed one stays here as a new file), so nothing is lost and no delete is
    // pushed.
    return { type: "PULL", row: "C7", fileId: R.fileId, seq: R.seq, path: R.path };
  }
  if (!L) {
    // A newer head with the base's content at the base's path (an epoch re-create, an echo of a
    // re-sealed record) is no remote change: the local delete stands, as in S5 (base = the head).
    if (!rContent && !rMoved) return { type: "PUSH_DELETE", row: "S5", fileId, path: B.path, base: R.seq };
    return { type: "PULL", row: "C3", fileId: R.fileId, seq: R.seq, path: R.path, log: LOG.restored };
  }
  if (!lc) {
    if (!rContent && !rMoved) return { type: "ADOPT", row: "S6", fileId: R.fileId, seq: R.seq, path: R.path };
    return { type: "PULL", row: "S6", fileId: R.fileId, seq: R.seq, path: R.path };
  }
  if (lMoved && rMoved && L.path !== R.path) {
    return { type: "LOCAL_RENAME", row: "C7", fileId, from: L.path, to: R.path, log: LOG.remotePathWins };
  }
  const resolved = rMoved ? R.path : L.path;
  if (R.contentHash !== null && L.hash === R.contentHash) {
    if (resolved === R.path) return withPre({ type: "ADOPT", row: "C1", fileId: R.fileId, seq: R.seq, path: R.path }, L.path, resolved);
    return { type: "PUSH_PUT", row: "C1", fileId, path: resolved, base: R.seq, source: "local" };
  }
  if (!rContent) {
    // Content: local edit over an unchanged remote (S2/S4); path: remote wins if it moved.
    return withPre({ type: "PUSH_PUT", row: "C2", fileId, path: resolved, base: R.seq, source: "local" }, L.path, resolved);
  }
  if (!lMod) {
    // Local only moved; remote changed content.
    if (resolved === R.path) return { type: "PULL", row: "S6", fileId: R.fileId, seq: R.seq, path: R.path };
    return { type: "PULL", row: "C8", fileId: R.fileId, seq: R.seq, path: L.path, thenPush: { path: L.path, base: R.seq } };
  }
  const strategy = strategyFor({ kind: i.kind, configJson: i.configJson, conflictMode: i.conflictMode, conflictLoop: !!i.ctx.conflictLoop });
  return withPre({
    type: "MERGE", row: "C2", strategy, fileId, path: resolved, base: R.seq, remote: { fileId: R.fileId, seq: R.seq }, log: LOG.conflict,
  }, L.path, resolved);
}

function decideNoBase(i: PlanInput): Action {
  const L = i.L;
  const R = i.R;
  const own = i.entry?.fileId ?? null;
  if (!L) {
    if (R && !R.deleted) {
      const a: Action = { type: "PULL", row: "N2", fileId: R.fileId, seq: R.seq, path: R.path };
      if (own && own !== R.fileId) a.forget = own;
      return a;
    }
    // N7. A never-synced entry whose file is gone holds nothing: drop it so its path frees up.
    return own ? { type: "FORGET", row: "N7", fileId: own } : noop("N7", "absent on both sides");
  }
  if (!R) return { type: "PUSH_CREATE", row: "N1", fileId: own, path: L.path, source: "local" };
  if (R.deleted) {
    if (i.ctx.mode === "rebuild" && i.tombstoneBaseHash != null && i.tombstoneBaseHash === L.hash && L.mtime <= R.ts) {
      return { type: "LOCAL_DELETE", row: "N6", fileId: own, path: L.path, mode: "trash" };
    }
    // The entry's own fileId is the tombstoned one (a never-acked pull of it was interrupted): a create
    // under that fileId would conflict forever; the content takes a new fileId.
    if (own && own === R.fileId) return { type: "PUSH_CREATE", row: "N1", fileId: null, path: L.path, source: "local", replaces: own };
    return { type: "PUSH_CREATE", row: "N1", fileId: own, path: L.path, source: "local" };
  }
  if (R.contentHash !== null && R.contentHash === L.hash) {
    // Equal content. Paths differ at most in case (same foldKey): the remote's spelling wins.
    const a: Action = { type: "ADOPT", row: "N3", fileId: R.fileId, seq: R.seq, path: R.path };
    if (own && own !== R.fileId) a.replaces = own;
    return withPre(a, L.path, R.path);
  }
  if (i.configJson) {
    const a: Action = {
      type: "MERGE", row: "N4", strategy: "json", fileId: R.fileId, path: R.path, base: R.seq, remote: { fileId: R.fileId, seq: R.seq },
    };
    if (own && own !== R.fileId) a.replaces = own;
    return withPre(a, L.path, R.path);
  }
  // The entry never got a base for its own head (an interrupted pull): the local bytes are not that
  // file's content, so they move away as a new file and the head is pulled into the path.
  return {
    type: "KEEP_BOTH", row: "N5", fileId: own === R.fileId ? null : own, path: L.path, pull: { fileId: R.fileId, seq: R.seq, path: R.path },
    allowTemplateAdopt: i.kind === "note", log: LOG.conflict,
  };
}

// ---------- sync modes (design §3.17; ops-spec §1 [XS]) ----------

/** True when executing `a` would commit anything to the remote. */
export function pushesRemote(a: Action): boolean {
  switch (a.type) {
    case "PUSH_PUT": case "PUSH_CREATE": case "PUSH_DELETE": case "MERGE": case "KEEP_BOTH": return true;
    case "PULL": return !!a.thenPush;
    default: return false;
  }
}

/** True when executing `a` would change the local disk. */
export function writesLocal(a: Action): boolean {
  if (a.preRename) return true;
  switch (a.type) {
    case "PULL": case "LOCAL_DELETE": case "LOCAL_RENAME": case "MERGE": case "KEEP_BOTH": return true;
    case "PUSH_PUT": case "PUSH_CREATE": return false;
    default: return false;
  }
}

/**
 * Post-pass for the device mode, applied by the Reconciler after decide():
 *  - pull-only: no push of any kind (a PULL keeps its local part; a C8 loses its follow-up push).
 *  - push-only: nothing that writes the local disk.
 *  - mirror-remote: every push becomes "restore the remote head locally" (PULL, or LOCAL_DELETE in trash
 *    mode for a tombstone; nothing when the remote has no head). The executor keeps the reverted local
 *    content (headless: outside the vault, ops-spec §1) before overwriting.
 */
export function applySyncMode(a: Action, mode: SyncMode, R: RemoteHead | null): Action {
  if (mode === "bidirectional") return a;
  if (mode === "pull-only") {
    if (a.type === "PULL" && a.thenPush) {
      const { thenPush: _drop, ...rest } = a;
      return rest;
    }
    return pushesRemote(a) ? { type: "NOOP", row: a.row, why: "pull-only", log: LOG.readOnly } : a;
  }
  if (mode === "push-only") {
    return writesLocal(a) ? { type: "NOOP", row: a.row, why: "push-only", log: LOG.pushOnly } : a;
  }
  // mirror-remote
  if (!pushesRemote(a)) return a;
  if (R && !R.deleted) return { type: "PULL", row: a.row, fileId: R.fileId, seq: R.seq, path: R.path, log: LOG.reverted };
  if (R && R.deleted && "path" in a) {
    const local = a.type === "KEEP_BOTH" || a.type === "MERGE" || a.type === "PUSH_PUT" || a.type === "PUSH_CREATE" ? (a.preRename?.from ?? a.path) : null;
    if (local !== null) return { type: "LOCAL_DELETE", row: a.row, fileId: R.fileId, path: local, mode: "trash", log: LOG.reverted };
  }
  return { type: "NOOP", row: a.row, why: "mirror-remote: no remote head", log: LOG.readOnly };
}
