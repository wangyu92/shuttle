// Recovery of interrupted D11 swaps (lead decision D11, 클로드 제안(미승인); design §3.8.4 write
// intents, §3.18 I6). replaceFile (replaceFile.ts) moves a target into `<dir>/.shuttle-bak-<n>/` before
// renaming the temp into place; a crash or a failed rollback can leave that backup behind. Runs at
// startup before the intent check and the first scan, and before the next replace of the same path.
//
// Rules (the pre-replace bytes are never deleted unless they are provably kept elsewhere):
//  - target missing, backup present: the swap died between its two renames. Put the backup back.
//  - both present: the target holds the new bytes. The backup may go only when its bytes are the
//    synced base (they are on the remote), equal the target's bytes, or are the pre-merge bytes of a
//    merge write whose merged result (which contains them, D1) is now the target. Otherwise the backup
//    is the user's content the engine cannot account for (an edit that raced the swap, or a state store
//    evicted after the crash, seed-730 style): it becomes a visible conflict copy, synced as a new file.
//  - replace temps (`.shuttle-replace-*`) hold only engine-produced bytes (a remote head or a staged
//    merge): swept after the backups are classified. Empty backup folders are removed last.

import type { FileId, LocalFs, LocalStat } from "@shuttle/protocol";
import { sha256Hex } from "../content/hash";
import type { FileIndex } from "../index/FileIndex";
import { dirname } from "../path/normalize";
import { hasFsCode } from "../platform/LocalFs";
import type { DirtyKey, DirtyReason } from "../types";
import {
  backupTarget, forgetSwapLeftover, isBackupDir, isReplaceTemp, replaceInFlight, setSwapResolver,
} from "./replaceFile";
import type { WriteIntents } from "./WriteIntents";

export interface SwapRecoveryDeps {
  fs: LocalFs;
  index: FileIndex;
  intents: WriteIntents;
  /** A free conflict-copy path for `path` (design §3.10.5 naming). */
  conflictPath(path: string): Promise<string>;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  log?(e: { key: string; cat: 'general' | 'error'; path?: string; fileId?: FileId; params?: Record<string, string | number | boolean | null> }): void;
}

export type SwapOutcome = 'restored' | 'dropped' | 'copied' | 'gone';

const isInternalSeg = (p: string): boolean => p.split("/").some((s) => s.startsWith(".shuttle-"));

async function readOrNull(fs: LocalFs, path: string): Promise<Uint8Array | null> {
  try {
    return await fs.read(path);
  } catch (err) {
    if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EISDIR")) return null;
    throw err;
  }
}

export class SwapRecovery {
  constructor(private readonly d: SwapRecoveryDeps) {}

  /** Let replaceFile resolve this session's failed swaps through this instance. */
  install(): void {
    setSwapResolver(this.d.fs, (bak) => this.resolve(bak).then(() => undefined));
  }

  uninstall(): void {
    setSwapResolver(this.d.fs, null);
  }

  /** Startup pass over every engine-internal leftover on disk. Returns what happened per backup. */
  async startup(): Promise<Array<{ backup: string; outcome: SwapOutcome }>> {
    const fs = this.d.fs;
    // D10: replaceFile never leaves a temp or a backup where write() replaces atomically (the headless
    // NodeLocalFs, whose listing also has scan side effects): no disk pass there.
    if (fs.atomicReplace === true) return [];
    const backups: string[] = [];
    const temps: string[] = [];
    const dirs = new Set<string>();
    const listing: AsyncIterable<LocalStat[]> = fs.listInternal ? fs.listInternal() : fs.listAll({ includeConfigDir: true });
    for await (const batch of listing) {
      for (const st of batch) {
        if (!isInternalSeg(st.path)) continue;
        if (st.kind === "folder") {
          if (isBackupDir(st.path)) dirs.add(st.path);
          continue;
        }
        if (backupTarget(st.path) !== null) {
          backups.push(st.path);
          dirs.add(dirname(st.path));
        } else if (isReplaceTemp(st.path)) temps.push(st.path);
      }
    }
    const out: Array<{ backup: string; outcome: SwapOutcome }> = [];
    for (const b of backups.sort()) out.push({ backup: b, outcome: await this.resolve(b) });
    // Only after every backup is classified: a temp may be the only copy of nothing the user wrote.
    for (const t of temps) if (!replaceInFlight(fs, t)) await fs.remove(t, "delete").catch(() => undefined);
    for (const dir of [...dirs].sort().reverse()) if (!replaceInFlight(fs, dir)) await fs.rmdirIfEmpty(dir).catch(() => false);
    return out;
  }

  /** Classify one backup file (see the rules above). Never throws for a vanished backup. */
  async resolve(bak: string): Promise<SwapOutcome> {
    const d = this.d;
    const target = backupTarget(bak);
    if (target === null) return "gone";
    const old = await readOrNull(d.fs, bak);
    if (old === null) {
      forgetSwapLeftover(d.fs, bak);
      await d.fs.rmdirIfEmpty(dirname(bak)).catch(() => false);
      return "gone";
    }
    const cur = await readOrNull(d.fs, target);
    let outcome: SwapOutcome;
    if (cur === null && (await d.fs.stat(target).catch(() => null)) === null) {
      await d.fs.mkdirp(dirname(target)).catch(() => undefined);
      await d.fs.rename(bak, target);
      outcome = "restored";            // the original bytes at the original path: nothing changed for the engine
    } else if (cur !== null && (await this.redundant(target, old, cur))) {
      await d.fs.remove(bak, "delete");
      outcome = "dropped";
    } else {
      const copy = await d.conflictPath(target);
      await d.fs.rename(bak, copy);
      outcome = "copied";
      d.markDirty({ path: copy }, "new");
      d.log?.({ key: "log.swapBackupKept", cat: "general", path: copy, params: { target } });
    }
    forgetSwapLeftover(d.fs, bak);
    await d.fs.rmdirIfEmpty(dirname(bak)).catch(() => false);
    return outcome;
  }

  /** The backup's bytes are kept elsewhere: equal to the target, the synced base, or inside a durable merge. */
  private async redundant(target: string, old: Uint8Array, cur: Uint8Array): Promise<boolean> {
    const hOld = await sha256Hex(old);
    const hCur = await sha256Hex(cur);
    if (hOld === hCur) return true;
    const e = this.d.index.byPath(target);
    if (e?.synced && e.synced.hash === hOld) return true;
    const i = await this.d.intents.get(target);
    if (i && i.preHash === hOld && i.targetHash === hCur && (await this.d.intents.stagedMerge(i)) !== null) return true;
    return false;
  }
}
