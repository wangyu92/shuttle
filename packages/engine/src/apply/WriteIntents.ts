// Write intents (design §3.8.4 S9): persisted before every engine write, cleared in the apply
// transaction. A file whose current hash is neither the intent's preHash nor its targetHash is a torn
// engine write, not a user edit: it is rewritten from the remote head and never pushed (I30).

import type { FileId, LocalFs, LocalStat, StateStore, WriteIntent } from "@shuttle/protocol";
import { readAndHash } from "../content/hash";
import { hasFsCode } from "../platform/LocalFs";

export interface WriteIntentsDeps {
  state: StateStore;
  fs: LocalFs;
  hashFile?(path: string): Promise<{ hash: string; size: number }>;
}

export type IntentCheck = 'none' | 'absent' | 'pre' | 'target' | 'torn';

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

  /** design §3.8.4 `intents.isTorn(path, st)`. */
  async isTorn(path: string, _st?: LocalStat): Promise<boolean> {
    return (await this.check(path)).c === "torn";
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
    return { c: "torn", intent };
  }

  /**
   * Startup check of every leftover intent, before the first scan (design §3.8.4). Returns the fileIds
   * whose files are torn (the caller re-applies them). An intent whose write never happened (pre) or
   * completed (target) stays; the apply queue entry finishes the job and clears it.
   */
  async startupCheck(): Promise<Array<{ path: string; fileId: FileId }>> {
    const torn: Array<{ path: string; fileId: FileId }> = [];
    for (const i of await this.all()) {
      const r = await this.check(i.path);
      if (r.c === "torn") {
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
