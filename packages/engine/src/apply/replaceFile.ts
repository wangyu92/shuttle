// Crash-safe replacement of a file's content (lead decisions D8, D10, D11; design §3.2 "temp file +
// rename", §3.8.4 write intents). Merge writes and pull applies never write into the target in place.
// Three platform shapes:
//
//  - D10 `fs.atomicReplace`: write() already replaces the target crash-atomically (temp + fsync +
//    rename inside the LocalFs, the headless NodeLocalFs). One write(), no second temp hop.
//  - D8 (`fs.renameReplaces` true or absent): the bytes go to a same-folder temp
//    (REPLACE_TEMP_PREFIX), then LocalFs.rename moves it over the target. LocalFs implementations let a
//    rename from such a name replace an existing file; every other rename refuses an occupied target.
//  - D11 (`fs.renameReplaces === false`, or a D8 rename refused with EEXIST): a recoverable swap. The
//    target is moved aside into a backup folder `<dir>/.shuttle-bak-<n>/<basename>` (the basename is
//    kept whole, so the target can always be found again), the temp is renamed into the freed path, and
//    the backup is removed. The pre-replace bytes exist on disk at every instant: in the target, or in
//    the backup until the new bytes are in place. A crash at any step leaves a state SwapRecovery
//    (startup, and before the next replace of the same path) resolves without deleting user bytes.
//
// The temp and backup names are dot names: the path filter ignores them (design §3.11 step 2;
// tempFiles.ts isEngineInternalName).

import type { LocalFs, LocalStat } from "@shuttle/protocol";
import { basename, dirname, join } from "../path/normalize";

/** Basename prefix of replace temps. Also known to MemLocalFs, NodeLocalFs and ObsidianLocalFs. */
export const REPLACE_TEMP_PREFIX = ".shuttle-replace-";
/** Folder-name prefix of D11 swap backups: `<dir>/.shuttle-bak-<n>/<basename of the target>`. */
export const BACKUP_DIR_PREFIX = ".shuttle-bak-";

export function isReplaceTemp(path: string): boolean {
  return basename(path).startsWith(REPLACE_TEMP_PREFIX);
}

/** True for a D11 backup folder (`<dir>/.shuttle-bak-<n>`). */
export function isBackupDir(path: string): boolean {
  return basename(path).startsWith(BACKUP_DIR_PREFIX);
}

/** The target a D11 backup file was moved away from (`a/.shuttle-bak-3/n.md` → `a/n.md`), else null. */
export function backupTarget(path: string): string | null {
  const dir = dirname(path);
  if (dir === "" || !isBackupDir(dir)) return null;
  return join(dirname(dir), basename(path));
}

/** Temp paths of replacements in flight, per LocalFs (the stale-temp sweep leaves them alone). */
const inFlight = new WeakMap<LocalFs, Set<string>>();

export function replaceInFlight(fs: LocalFs, path: string): boolean {
  return inFlight.get(fs)?.has(path) ?? false;
}

/**
 * D11 leftovers of this session: backup file path → 'decided' (the swap completed, only the backup's
 * removal failed: the engine already chose to replace those bytes) or 'unresolved' (the swap failed
 * part-way and its rollback failed too: classify like a crash leftover).
 */
const leftovers = new WeakMap<LocalFs, Map<string, 'decided' | 'unresolved'>>();
/** SwapRecovery.resolve for this LocalFs (installed by the engine; absent in bare unit tests). */
const resolvers = new WeakMap<LocalFs, (backup: string) => Promise<void>>();

export function setSwapResolver(fs: LocalFs, fn: ((backup: string) => Promise<void>) | null): void {
  if (fn) resolvers.set(fs, fn);
  else resolvers.delete(fs);
}

/** Known session leftovers (tests, debug info). */
export function swapLeftovers(fs: LocalFs): Array<{ backup: string; state: 'decided' | 'unresolved' }> {
  return [...(leftovers.get(fs)?.entries() ?? [])].map(([backup, state]) => ({ backup, state }));
}

export function forgetSwapLeftover(fs: LocalFs, backup: string): void {
  leftovers.get(fs)?.delete(backup);
}

function noteLeftover(fs: LocalFs, backup: string, state: 'decided' | 'unresolved'): void {
  let m = leftovers.get(fs);
  if (!m) leftovers.set(fs, (m = new Map()));
  m.set(backup, state);
}

/** Thrown when an unresolved backup of the target is still on disk: the replace waits (retry later). */
export class SwapPendingError extends Error {
  readonly code = "EIO";
  constructor(readonly path: string, readonly backup: string) {
    super(`a backup of ${path} from an interrupted replace is not resolved yet`);
    this.name = "SwapPendingError";
  }
}

/**
 * Temp names come from a counter per LocalFs, not from randomness: a name only has to differ from the other
 * replacements in flight (a leftover temp from an earlier process is simply overwritten). Drawing
 * random bytes here would shift every deterministic simulation run (design §7.4).
 */
const seqs = new WeakMap<LocalFs, number>();

function nextSeq(fs: LocalFs): string {
  const seq = ((seqs.get(fs) ?? 0) + 1) % Number.MAX_SAFE_INTEGER;
  seqs.set(fs, seq);
  return seq.toString(36);
}

const isFsCode = (e: unknown, ...codes: string[]): boolean =>
  typeof e === "object" && e !== null && codes.includes(String((e as { code?: unknown }).code));

/** A simulated process death (tests) or a dead state store: nothing after it runs, recovery is on disk. */
const isDeath = (e: unknown): boolean => e instanceof Error && (e.name === "Crash" || e.name === "StateStoreError");

/** Resolve this session's leftovers for `path` before replacing it again (D11 "before each apply"). */
async function settleLeftovers(fs: LocalFs, path: string): Promise<void> {
  const m = leftovers.get(fs);
  if (!m || m.size === 0) return;
  for (const [bak, state] of [...m]) {
    if (backupTarget(bak) !== path) continue;
    if (state === "decided") {
      await fs.remove(bak, "delete").catch(() => undefined);
      if ((await fs.stat(bak).catch(() => null)) === null) {
        m.delete(bak);
        await fs.rmdirIfEmpty(dirname(bak)).catch(() => false);
      }
    } else {
      const resolve = resolvers.get(fs);
      if (resolve) await resolve(bak);
    }
    if (m.has(bak)) throw new SwapPendingError(path, bak);
  }
}

/**
 * Write `data` to `path` without a moment where the target holds a mix of old and new bytes and
 * without removing the target first. Returns the stat of the target.
 */
export async function replaceFile(fs: LocalFs, path: string, data: Uint8Array, opts: { mtime: number; ctime?: number }): Promise<LocalStat> {
  const dir = dirname(path);
  await fs.mkdirp(dir).catch(() => undefined);
  await settleLeftovers(fs, path);
  if (fs.atomicReplace === true) return fs.write(path, data, opts);       // D10
  const tmp = join(dir, `${REPLACE_TEMP_PREFIX}${nextSeq(fs)}`);
  let flying = inFlight.get(fs);
  if (!flying) inFlight.set(fs, (flying = new Set()));
  flying.add(tmp);
  try {
    try {
      await fs.write(tmp, data, opts);
    } catch (err) {
      if (!isDeath(err)) await fs.remove(tmp, "delete").catch(() => undefined);
      throw err;
    }
    let swap = false;
    if (fs.renameReplaces === false && (await fs.stat(path)) !== null) swap = true;
    else {
      try {
        await fs.rename(tmp, path);
      } catch (err) {
        if (isDeath(err)) throw err;
        // A platform without the D8 replace rename (target exists): never write the temp's bytes over
        // the target in place (D11); swap through a backup instead. Anything else propagates.
        if (!isFsCode(err, "EEXIST", "PATH_TAKEN")) {
          await fs.remove(tmp, "delete").catch(() => undefined);
          throw err;
        }
        swap = true;
      }
    }
    if (swap) await swapInto(fs, tmp, path, flying);
  } finally {
    flying.delete(tmp);
  }
  const st = await fs.stat(path);
  if (st && st.kind === "file") return st;
  return { path, kind: "file", size: data.byteLength, mtime: opts.mtime, ctime: opts.ctime ?? opts.mtime };
}

/** D11 swap: target → backup folder, temp → target, remove backup. `tmp` holds the new bytes in full. */
async function swapInto(fs: LocalFs, tmp: string, path: string, flying: Set<string>): Promise<void> {
  const dir = dirname(path);
  let bakDir = "";
  for (let i = 0; i < 1000; i++) {
    const cand = join(dir, `${BACKUP_DIR_PREFIX}${nextSeq(fs)}`);
    if ((await fs.stat(cand)) === null) { bakDir = cand; break; }       // a leftover from an earlier process: skip it
  }
  if (bakDir === "") throw Object.assign(new Error(`no free backup folder name in ${dir || "the vault root"}`), { code: "EIO" });
  const bak = join(bakDir, basename(path));
  flying.add(bakDir);
  try {
    try {
      await fs.mkdirp(bakDir);
      await fs.rename(path, bak);                                         // step 2: old bytes now in the backup
    } catch (err) {
      if (!isDeath(err)) {
        // The target was not moved (rename refused or failed before it happened): it is whole.
        if ((await fs.stat(bak).catch(() => null)) === null) {
          await fs.rmdirIfEmpty(bakDir).catch(() => false);
          await fs.remove(tmp, "delete").catch(() => undefined);
        } else noteLeftover(fs, bak, "unresolved");
      }
      throw err;
    }
    try {
      await fs.rename(tmp, path);                                         // step 3: new bytes in place
    } catch (err) {
      if (isDeath(err)) throw err;
      // Put the old file back; if that fails too, the backup stays and is resolved before the next
      // replace of this path and at startup (never deleted unclassified).
      try {
        if ((await fs.stat(path)) === null) await fs.rename(bak, path);
        else noteLeftover(fs, bak, "unresolved");
      } catch {
        noteLeftover(fs, bak, "unresolved");
      }
      if (!leftovers.get(fs)?.has(bak)) await fs.rmdirIfEmpty(bakDir).catch(() => false);
      await fs.remove(tmp, "delete").catch(() => undefined);
      throw err;
    }
    try {
      await fs.remove(bak, "delete");                                     // step 4: the replace is complete
      await fs.rmdirIfEmpty(bakDir);
    } catch (err) {
      if (isDeath(err)) throw err;
      if ((await fs.stat(bak).catch(() => null)) !== null) noteLeftover(fs, bak, "decided");
    }
  } finally {
    flying.delete(bakDir);
  }
}
