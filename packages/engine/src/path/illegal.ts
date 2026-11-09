// Per-platform illegal-name rules (design §3.11.4). Pure.
//
// The rules depend on the filesystem family, which LocalPlatform alone does not say ('desktop' can be
// Windows, macOS or Linux), so callers pass a NameRules value; nameRulesFor() derives it.

import type { LocalPlatform } from "@shuttle/protocol";
import { segments } from "./normalize";

export type NameRules = 'windows' | 'android' | 'apple' | 'posix';

export type IllegalReason =
  | 'empty'            // empty path or empty segment
  | 'dot-segment'      // "." or ".."
  | 'control-char'     // NUL or C0/DEL control characters
  | 'segment-too-long' // > 255 UTF-8 bytes
  | 'reserved-char'    // platform-forbidden character
  | 'trailing-dot-space'
  | 'reserved-name';   // CON, PRN, AUX, NUL, COM1-9, LPT1-9 (any extension)

export type PortabilityWarning = 'special-char' | 'multiple-periods' | 'emoji';

export const MAX_SEGMENT_BYTES = 255;

/** Log string for skipped downloads (design §3.11.4). */
export const ILLEGAL_NAME_LOG = "Unable to download file with illegal name";

const WINDOWS_CHARS = '\\:*?"<>|';
const RESERVED = new Set(["con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

export function nameRulesFor(platform: LocalPlatform, hint?: { os?: 'windows' | 'macos' | 'linux' }): NameRules {
  if (platform === "ios") return "apple";
  if (platform === "android") return "android";
  if (hint?.os === "windows") return "windows";
  if (hint?.os === "macos") return "apple";
  return "posix";
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** First reason a single segment is illegal under `rules`, or null. */
export function illegalSegment(seg: string, rules: NameRules): IllegalReason | null {
  if (seg === "") return "empty";
  if (seg === "." || seg === "..") return "dot-segment";
  if (hasControl(seg)) return "control-char";
  if (utf8Length(seg) > MAX_SEGMENT_BYTES) return "segment-too-long";
  if (rules === "windows" || rules === "android") {
    for (const ch of seg) if (WINDOWS_CHARS.includes(ch)) return "reserved-char";
    const last = seg[seg.length - 1];
    if (last === " " || last === ".") return "trailing-dot-space";
    const dot = seg.indexOf(".");
    const head = (dot < 0 ? seg : seg.slice(0, dot)).toLowerCase();
    if (RESERVED.has(head)) return "reserved-name";
  }
  if (rules === "apple" && seg.includes(":")) return "reserved-char";
  return null;
}

/** First reason `path` (already normalized) is illegal under `rules`, or null (design §3.11.4). */
export function illegalReason(path: string, rules: NameRules): IllegalReason | null {
  if (path === "") return "empty";
  for (const seg of segments(path)) {
    const r = illegalSegment(seg, rules);
    if (r) return r;
  }
  return null;
}

export function isIllegal(path: string, rules: NameRules): boolean {
  return illegalReason(path, rules) !== null;
}

function isEmojiCodePoint(cp: number): boolean {
  return (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x1f900 && cp <= 0x1f9ff);
}

/** Portability warnings only; never block sync (design §3.11.4). */
export function portabilityWarnings(path: string, rules: NameRules): PortabilityWarning[] {
  const out = new Set<PortabilityWarning>();
  for (const seg of segments(path)) {
    for (const ch of seg) if ("#^[]".includes(ch)) out.add("special-char");
    let dots = 0;
    for (const ch of seg) if (ch === ".") dots++;
    if (dots > 1) out.add("multiple-periods");
    if (rules === "android") {
      for (const ch of seg) if (isEmojiCodePoint(ch.codePointAt(0) ?? 0)) out.add("emoji");
    }
  }
  return [...out];
}

/**
 * Make `s` a segment that is legal on every platform (used for device names in conflict-copy names,
 * design §3.10.5). Forbidden and control characters become "-"; trailing dots and spaces are trimmed;
 * reserved names get a "_" suffix; the result is cut to `maxBytes` UTF-8 bytes; empty → `fallback`.
 */
export function sanitizeSegment(s: string, maxBytes = 64, fallback = "device"): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || WINDOWS_CHARS.includes(ch) || ch === "/") out += "-";
    else out += ch;
  }
  out = out.trim();
  const cut = (x: string): string => {
    let r = "";
    for (const ch of x) {
      if (utf8Length(r + ch) > maxBytes) break;
      r += ch;
    }
    return r;
  };
  out = cut(out);
  while (out.endsWith(".") || out.endsWith(" ")) out = out.slice(0, -1);
  if (out === "" || out === "." || out === "..") return fallback;
  const dot = out.indexOf(".");
  const head = dot < 0 ? out : out.slice(0, dot);
  if (RESERVED.has(head.toLowerCase())) out = cut(head + "_" + out.slice(head.length));
  return out;
}

export { utf8Length };
