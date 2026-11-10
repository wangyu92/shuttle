// Crash-safe replacement of a file's content (lead decision D8, design §3.2 "temp file + rename",
// §3.8.4 write intents). Merge writes and pull applies never write into the target in place: the bytes
// go to a temp file in the same folder first, then LocalFs.rename moves it over the target. A crash or
// a torn write before the rename leaves the old file whole (the pre-merge local edit survives until the
// merged bytes are durable). The temp name carries REPLACE_TEMP_PREFIX: LocalFs implementations let a
// rename from such a name replace an existing file (every other rename still refuses an occupied
// target), and the path filter ignores it (design §3.11 step 2: dot names; tempFiles.ts).
//
// Residual risk (D8): where a platform cannot rename over an existing file, its LocalFs falls back to
// an in-place write of the temp's bytes (the pre-D8 exposure, covered by intents and staging).

import type { LocalFs, LocalStat } from "@shuttle/protocol";
import { basename, dirname, join } from "../path/normalize";

/** Basename prefix of replace temps. Also known to MemLocalFs, NodeLocalFs and ObsidianLocalFs. */
export const REPLACE_TEMP_PREFIX = ".shuttle-replace-";

export function isReplaceTemp(path: string): boolean {
  return basename(path).startsWith(REPLACE_TEMP_PREFIX);
}

/** Temp paths of replacements in flight, per LocalFs (the stale-temp sweep leaves them alone). */
const inFlight = new WeakMap<LocalFs, Set<string>>();

export function replaceInFlight(fs: LocalFs, path: string): boolean {
  return inFlight.get(fs)?.has(path) ?? false;
}

/**
 * Temp names come from a counter per LocalFs, not from randomness: a name only has to differ from the other
 * replacements in flight (a leftover temp from an earlier process is simply overwritten). Drawing
 * random bytes here would shift every deterministic simulation run (design §7.4).
 */
const seqs = new WeakMap<LocalFs, number>();

const isFsCode = (e: unknown, ...codes: string[]): boolean =>
  typeof e === "object" && e !== null && codes.includes(String((e as { code?: unknown }).code));

/**
 * Write `data` to `path` through a same-folder temp file and a rename over the target. Returns the
 * stat of the target. The target is never removed first: if the rename fails, it is untouched.
 */
export async function replaceFile(fs: LocalFs, path: string, data: Uint8Array, opts: { mtime: number; ctime?: number }): Promise<LocalStat> {
  const dir = dirname(path);
  const seq = ((seqs.get(fs) ?? 0) + 1) % Number.MAX_SAFE_INTEGER;
  seqs.set(fs, seq);
  const tmp = join(dir, `${REPLACE_TEMP_PREFIX}${seq.toString(36)}`);
  await fs.mkdirp(dir).catch(() => undefined);
  let flying = inFlight.get(fs);
  if (!flying) inFlight.set(fs, (flying = new Set()));
  flying.add(tmp);
  try {
    try {
      await fs.write(tmp, data, opts);
    } catch (err) {
      await fs.remove(tmp, "delete").catch(() => undefined);
      throw err;
    }
    try {
      await fs.rename(tmp, path);
    } catch (err) {
      await fs.remove(tmp, "delete").catch(() => undefined);
      // An implementation without the replace convention (a target that exists): write in place,
      // the pre-D8 behaviour (intents and staging cover a torn write). Anything else propagates.
      if (!isFsCode(err, "EEXIST", "PATH_TAKEN")) throw err;
      return await fs.write(path, data, opts);
    }
  } finally {
    flying.delete(tmp);
  }
  const st = await fs.stat(path);
  if (st && st.kind === "file") return st;
  return { path, kind: "file", size: data.byteLength, mtime: opts.mtime, ctime: opts.ctime ?? opts.mtime };
}
