// Three-way text merge with diff-match-patch (design §3.10.2, engine-spec §7.2, invariant I9).
//
// Direction: local's edits (diff base → local) are replayed onto the remote text, so "the original
// keeps the remote version plus local changes". Parameters are fixed on every device.
//
// Strict check (strictOverlap, default ON here; see DEFAULT_MERGE_OPTIONS). DMP applies patches
// fuzzily: when both sides edited the same or neighbouring text it can report every hunk as applied
// while dropping or duplicating one side's edit. In strict mode a merge is clean only if
//   1. every DMP hunk applied,
//   2. no local hunk overlaps or touches a remote hunk in base coordinates (closed intervals, so
//      adjacent edits and two inserts at the same offset collide; identical hunks are allowed),
//   3. every inserted run of each side is present in the result,
//   4. the DMP result equals the exact merge obtained by applying both (disjoint) hunk sets to the
//      base; this implies both sides' insertions AND deletions survived, nothing was duplicated,
//   5. the result is well-formed UTF-16 (no lone surrogate from a hunk split inside a pair).
// Anything else returns clean:false with a reason, and the caller makes a conflict copy (§3.10.5),
// so neither side's content is lost. Parity mode (strictOverlap:false) is exactly the design's
// pseudocode: clean = every hunk applied.

import DiffMatchPatch from "diff-match-patch";

// Diff_Timeout = 0 (no time limit): design §3.10.2 says 1.0, but a time-bounded diff depends on the
// device's speed, so two devices could merge the same inputs differently (I9). Lead decision D2
// (클로드 제안(미승인)) sets 0 and bounds the cost with MERGE_MAX_BYTES instead.
export const DMP_PARAMS = Object.freeze({
  Diff_Timeout: 0,
  Diff_EditCost: 4,
  Match_Threshold: 0.5,
  Match_Distance: 1000,
  Patch_DeleteThreshold: 0.5,
  Patch_Margin: 4,
});

/**
 * D2: largest side (base, local or remote, UTF-8 bytes) a 3-way text merge accepts. Above it the
 * merge is unclean (reason `tooLarge`) and the caller makes a conflict copy (design §3.10.5).
 */
export const MERGE_MAX_BYTES = 1024 * 1024;

export interface MergeOptions { strictOverlap: boolean; /** Default MERGE_MAX_BYTES. */ maxBytes?: number }

/** Strict is the conservative default; design §3.10.2 ships it off (parity). Part 3 wires DeviceSettings.strictOverlap. */
export const DEFAULT_MERGE_OPTIONS: Readonly<MergeOptions> = Object.freeze({ strictOverlap: true });

export type MergeUncleanReason = 'hunkFailed' | 'overlap' | 'insertLost' | 'diverged' | 'badSurrogate' | 'tooLarge';

/** UTF-8 byte length of a JS string (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export interface Merge3Result {
  text: string;
  clean: boolean;
  reason?: MergeUncleanReason;
}

/** One edit in base coordinates: base[start, end) replaced by `text`. */
export interface Hunk { start: number; end: number; text: string }

let shared: DiffMatchPatch | null = null;
function dmp(): DiffMatchPatch {
  if (!shared) {
    const d = new DiffMatchPatch();
    d.Diff_Timeout = DMP_PARAMS.Diff_Timeout;
    d.Diff_EditCost = DMP_PARAMS.Diff_EditCost;
    d.Match_Threshold = DMP_PARAMS.Match_Threshold;
    d.Match_Distance = DMP_PARAMS.Match_Distance;
    d.Patch_DeleteThreshold = DMP_PARAMS.Patch_DeleteThreshold;
    d.Patch_Margin = DMP_PARAMS.Patch_Margin;
    shared = d;
  }
  return shared;
}

type Diffs = ReturnType<DiffMatchPatch["diff_main"]>;

/** Group a diff of base → side into hunks in base coordinates. */
export function hunksOf(diffs: Diffs): Hunk[] {
  const out: Hunk[] = [];
  let pos = 0;
  let cur: Hunk | null = null;
  for (const d of diffs) {
    const op = d[0];
    const s = d[1];
    if (op === 0) {
      if (cur) { out.push(cur); cur = null; }
      pos += s.length;
    } else {
      cur ??= { start: pos, end: pos, text: "" };
      if (op === -1) { pos += s.length; cur.end = pos; } else cur.text += s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function diffHunks(base: string, side: string): Hunk[] {
  return hunksOf(dmp().diff_main(base, side));
}

const sameHunk = (a: Hunk, b: Hunk): boolean => a.start === b.start && a.end === b.end && a.text === b.text;

/** True when a local and a remote hunk overlap or touch (closed intervals) and are not identical. */
export function hunksCollide(local: readonly Hunk[], remote: readonly Hunk[]): boolean {
  let j = 0;
  for (const a of local) {
    while (j < remote.length && (remote[j] as Hunk).end < a.start) j++;
    for (let k = j; k < remote.length; k++) {
      const b = remote[k] as Hunk;
      if (b.start > a.end) break;
      if (!sameHunk(a, b)) return true;
    }
  }
  return false;
}

/** Apply two non-colliding hunk sets to `base` (identical hunks counted once). */
export function applyDisjoint(base: string, local: readonly Hunk[], remote: readonly Hunk[]): string {
  const all: Hunk[] = [...local];
  for (const r of remote) if (!local.some((l) => sameHunk(l, r))) all.push(r);
  all.sort((x, y) => x.start - y.start || x.end - y.end);
  let out = "";
  let pos = 0;
  for (const h of all) {
    out += base.slice(pos, h.start) + h.text;
    pos = h.end;
  }
  return out + base.slice(pos);
}

/** True when `s` contains no unpaired UTF-16 surrogate. */
export function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

export function merge3(base: string, local: string, remote: string, opts: MergeOptions = DEFAULT_MERGE_OPTIONS): Merge3Result {
  if (local === remote) return { text: remote, clean: true };
  if (base === local) return { text: remote, clean: true };
  if (base === remote) return { text: local, clean: true };
  const max = opts.maxBytes ?? MERGE_MAX_BYTES;
  // Cheap bound first (a UTF-16 unit is at most 3 UTF-8 bytes), exact count only near the cap.
  for (const t of [base, local, remote]) {
    if (t.length > max || (t.length * 3 > max && utf8ByteLength(t) > max)) return { text: remote, clean: false, reason: "tooLarge" };
  }
  const d = dmp();
  const localDiffs = d.diff_main(base, local);
  const patches = d.patch_make(base, localDiffs);
  const [text, results] = d.patch_apply(patches, remote);
  if (!results.every(Boolean)) return { text, clean: false, reason: "hunkFailed" };
  if (!opts.strictOverlap) return { text, clean: true };

  const lh = hunksOf(localDiffs);
  const rh = diffHunks(base, remote);
  if (hunksCollide(lh, rh)) return { text, clean: false, reason: "overlap" };
  for (const h of [...lh, ...rh]) {
    if (h.text !== "" && !text.includes(h.text)) return { text, clean: false, reason: "insertLost" };
  }
  if (text !== applyDisjoint(base, lh, rh)) return { text, clean: false, reason: "diverged" };
  if (!isWellFormedUtf16(text)) return { text, clean: false, reason: "badSurrogate" };
  return { text, clean: true };
}
