// Conflict-copy naming (design §3.10.5, engine-spec §7.5). Pure: the caller supplies the time stamp
// and an `exists` predicate, so the same inputs give the same name on every platform.
//
//   <dir>/<stem> (Conflicted copy <device-name> YYYYMMDDHHMM).<ext>
//   collision: " 2", " 3", … before the closing parenthesis.

import { sanitizeSegment, utf8Length, MAX_SEGMENT_BYTES } from "../path/illegal";
import { dirname, extname, join, stem } from "../path/normalize";

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/**
 * YYYYMMDDHHMM in the detecting device's local time. `tzOffsetMin` follows Date#getTimezoneOffset
 * (UTC minus local, in minutes; KST is -540).
 */
export function conflictStamp(epochMs: number, tzOffsetMin: number): string {
  const d = new Date(epochMs - tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** The host's current offset for `epochMs` (the only impure helper here; inject it in tests). */
export function hostTzOffset(epochMs: number): number {
  return new Date(epochMs).getTimezoneOffset();
}

export const MAX_COLLISION_SUFFIX = 10_000;

function cutToBytes(s: string, max: number): string {
  let r = "";
  for (const ch of s) {
    if (utf8Length(r + ch) > max) break;
    r += ch;
  }
  return r;
}

/**
 * Conflict-copy path for `path`. `exists(p)` must answer for the local disk and the index (compare by
 * foldKey on case-insensitive platforms). Throws only if 10 000 suffixes are all taken.
 */
export function conflictCopyPath(path: string, deviceName: string, stamp: string, exists: (p: string) => boolean): string {
  const dir = dirname(path);
  const ext = extname(path);
  const st = stem(path);
  const dev = sanitizeSegment(deviceName);
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n++) {
    const tag = ` (Conflicted copy ${dev} ${stamp}${n === 1 ? "" : " " + n})`;
    const tail = tag + (ext === "" ? "" : "." + ext);
    const room = MAX_SEGMENT_BYTES - utf8Length(tail);
    const name = cutToBytes(st, Math.max(0, room)) + tail;
    const p = join(dir, name);
    if (!exists(p)) return p;
  }
  throw new Error(`conflictCopyPath: no free name for ${JSON.stringify(path)}`);
}

/** True when `path` looks like a conflict copy (used to avoid copies of copies in the log). */
export function isConflictCopyName(path: string): boolean {
  return / \(Conflicted copy [^()]* \d{12}( \d+)?\)(\.[^./]+)?$/.test(path);
}
