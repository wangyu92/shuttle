// Write intents (design §3.8.4 S9): persisted before every engine write, cleared in the apply
// transaction. A file whose current hash is neither the intent's preHash nor its targetHash is
// 'foreign'. Lead decision D5 (클로드 제안(미승인)): foreign content is a torn engine write ONLY when it
// is a strict prefix of the target bytes (the way a non-atomic write fails; size known). Torn bytes
// are rewritten from the remote head and never pushed (I30); any other content is the user's edit
// against the base preHash and is planned as a local change (merge or conflict copy, I6). The prefix
// test needs the target bytes, so it runs in RemoteApplier (`classifyForeign`), not here.
//
// Merge writes (lead decision D1, 클로드 제안(미승인)): before the engine writes merged bytes, the
// merged plaintext is staged as the file's push op (`staging[opSeq]`, source 'staging') in the same
// transaction as the intent whose targetHash is the merged hash. A torn or never-finished merge write
// is therefore re-applied from staging, never from the remote head, so the merged local edits survive
// a crash at every point (I6). Recovery applies when the file is torn (a prefix of the merged bytes,
// the way a non-atomic write fails), still holds the pre-merge bytes, or is absent; any other content
// is treated as a user edit and left alone (the staged merge still reaches the remote history).

import type { FileId, LocalFs, LocalStat, StateStore, WriteIntent } from "@shuttle/protocol";
import { readAndHash, sha256Hex } from "../content/hash";
import { dirname } from "../path/normalize";
import { hasFsCode } from "../platform/LocalFs";
import { replaceFile } from "./replaceFile";

export interface WriteIntentsDeps {
  state: StateStore;
  fs: LocalFs;
  hashFile?(path: string): Promise<{ hash: string; size: number }>;
  /** mtime for files rewritten from staging (injected Clock). */
  now?(): number;
}

function isPrefix(a: Uint8Array, of: Uint8Array): boolean {
  if (a.length > of.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== of[i]) return false;
  return true;
}

/** 'foreign': neither preHash nor targetHash (torn write or user edit; D5 decides). */
export type IntentCheck = 'none' | 'absent' | 'pre' | 'target' | 'foreign';

/** D5: `cur` is a strict prefix of `target` (shorter, same leading bytes). */
export function isStrictPrefix(cur: Uint8Array, target: Uint8Array): boolean {
  return cur.length < target.length && isPrefix(cur, target);
}

export class WriteIntents {
  constructor(private readonly d: WriteIntentsDeps) {}

  put(i: WriteIntent): Promise<void> {
    return this.d.state.tx(["intents"], async (tx) => { await tx.intents.put(i); });
  }

  delete(path: string): Promise<void> {
    return this.d.state.tx(["intents"], async (tx) => { await tx.intents.delete(path); });
  }

  get(path: string): Promise<WriteIntent | undefined> {
    return this.d.state.tx(["intents"], (tx) => tx.intents.get(path), "readonly");
  }

  all(): Promise<WriteIntent[]> {
    return this.d.state.tx(["intents"], (tx) => tx.intents.getAll(), "readonly");
  }

  /**
   * design §3.8.4 `intents.isTorn(path, st)`: true when the file is foreign to its intent. The caller
   * (`applier.reapply`) then decides torn vs user edit (D5); a user edit is never overwritten.
   */
  async isTorn(path: string, _st?: LocalStat): Promise<boolean> {
    return (await this.check(path)).c === "foreign";
  }

  /** Classify the file at `path` against its intent. */
  async check(path: string): Promise<{ c: IntentCheck; intent?: WriteIntent }> {
    const intent = await this.get(path);
    if (!intent) return { c: "none" };
    let hash: string;
    try {
      hash = (await (this.d.hashFile ? this.d.hashFile(path) : readAndHash(this.d.fs, path))).hash;
    } catch (err) {
      if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) return { c: "absent", intent };
      throw err;
    }
    if (hash === intent.targetHash) return { c: "target", intent };
    if (hash === intent.preHash) return { c: "pre", intent };
    return { c: "foreign", intent };
  }

  /**
   * D1: the staged merged bytes this intent wrote, if the intent belongs to a merge write (a put op of
   * the file with source 'staging' whose bytes hash to the intent's targetHash).
   */
  async stagedMerge(i: WriteIntent): Promise<Uint8Array | null> {
    if (i.targetHash === null) return null;
    const rows = await this.d.state.tx(["journal", "staging"], async (tx) => {
      const out: Uint8Array[] = [];
      for (const op of await tx.journal.getAll({ index: "fileId", only: i.fileId })) {
        // An archive op here is a staged merge kept after a CONFLICT or a newer change (Journal, I6).
        if ((op.kind !== "put" && op.kind !== "archive") || op.source !== "staging") continue;
        if (op.contentHash !== undefined && op.contentHash !== i.targetHash) continue;
        const row = await tx.staging.get(op.opSeq);
        if (row) out.push(row.bytes);
      }
      return out;
    }, "readonly");
    for (const b of rows) if ((await sha256Hex(b)) === i.targetHash) return b;
    return null;
  }

  /**
   * D1 recovery of a merge write at `path`. Returns 'restored' after rewriting the staged merged
   * bytes (intent cleared), 'done' when the file already holds them (intent cleared), 'userEdit' when
   * the file holds foreign content (intent cleared, file untouched), or 'none' when the intent is not
   * a merge write.
   */
  async recoverMerge(path: string, onWrite?: (bytes: Uint8Array, hash: string) => void): Promise<'none' | 'restored' | 'done' | 'userEdit'> {
    const intent = await this.get(path);
    if (!intent) return "none";
    const staged = await this.stagedMerge(intent);
    if (!staged) return "none";
    let cur: Uint8Array | null;
    try {
      cur = await this.d.fs.read(path);
    } catch (err) {
      if (!hasFsCode(err, "ENOENT") && !hasFsCode(err, "ENOTDIR")) throw err;
      cur = null;
    }
    const h = cur ? await sha256Hex(cur) : null;
    if (h === intent.targetHash) {
      await this.delete(path);
      return "done";
    }
    if (cur && h !== intent.preHash && !isPrefix(cur, staged)) {
      await this.delete(path);
      return "userEdit";
    }
    onWrite?.(staged, intent.targetHash as string);
    await this.d.fs.mkdirp(dirname(path)).catch(() => undefined);
    await replaceFile(this.d.fs, path, staged, { mtime: this.d.now ? this.d.now() : 0 });
    await this.delete(path);
    return "restored";
  }

  /**
   * Startup check of every leftover intent, before the first scan (design §3.8.4). Merge writes are
   * recovered from staging here (D1). Returns the files whose pulled content is foreign: the caller
   * classifies them (D5, needs the target bytes, so it waits for the connection) and re-applies only
   * the torn ones. An intent whose write never happened (pre) or completed (target) stays; the apply
   * queue entry finishes the job and clears it.
   */
  async startupCheck(): Promise<Array<{ path: string; fileId: FileId }>> {
    const torn: Array<{ path: string; fileId: FileId }> = [];
    for (const i of await this.all()) {
      if ((await this.recoverMerge(i.path)) !== "none") continue;
      const r = await this.check(i.path);
      if (r.c === "foreign") {
        torn.push({ path: i.path, fileId: i.fileId });
        continue;
      }
      // Not torn and no apply pending: a stale intent must not make a later user edit look torn.
      await this.d.state.tx(["intents", "applyQueue"], async (tx) => {
        if ((await tx.applyQueue.get(i.fileId)) === undefined) await tx.intents.delete(i.path);
      });
    }
    return torn;
  }
}
