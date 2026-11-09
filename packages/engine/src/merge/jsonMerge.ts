// Config JSON merge (design §3.10.3, engine-spec §7.3, invariant I27). Pure.
//
// Rule: local top-level keys applied on top of the remote object ({...remote, ...local}); shallow;
// arrays are not merged; a key deleted locally comes back if the remote has it (Sync parity).
// Anything that is not a plain JSON object on both sides → null, and the caller falls back to LWW.

import { utf8DecodeStrict, utf8Encode } from "../util/bytes";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function tryParseJson(bytes: Uint8Array): { ok: true; value: JsonValue } | { ok: false } {
  const s = utf8DecodeStrict(bytes);
  if (s === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s) as JsonValue };
  } catch {
    return { ok: false };
  }
}

export function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Indentation of the first indented line ("\t", N spaces) or "" for single-line JSON. */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return "";
  const ws = m[1] as string;
  return ws[0] === "\t" ? "\t" : " ".repeat(ws.length);
}

export function encodeJson(v: JsonValue, indent: string, trailingNewline: boolean): Uint8Array {
  const s = indent === "" ? JSON.stringify(v) : JSON.stringify(v, null, indent);
  return utf8Encode(trailingNewline ? s + "\n" : s);
}

/**
 * Canonical form for "did the config really change" and echo matching (design §3.10.3). Sorted keys,
 * no whitespace. Unlike protocol canon() (§4.5.2, safe integers only) it accepts any JSON number,
 * serialized with JSON.stringify, because Obsidian settings contain floats.
 */
export function jsonCanon(v: JsonValue): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jsonCanon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + jsonCanon(v[k] as JsonValue)).join(",") + "}";
}

/** Canonical string of JSON bytes, or null when unparsable. */
export function canonOfBytes(bytes: Uint8Array): string | null {
  const p = tryParseJson(bytes);
  return p.ok ? jsonCanon(p.value) : null;
}

export interface JsonMergeResult {
  bytes: Uint8Array;
  /** Canonically equal to the remote: ADOPT instead of write + push (design §3.10.3). */
  equalsRemote: boolean;
  /** Canonically equal to the local file: nothing to write locally, only push. */
  equalsLocal: boolean;
}

export function mergeJson(localBytes: Uint8Array, remoteBytes: Uint8Array): JsonMergeResult | null {
  const l = tryParseJson(localBytes);
  const r = tryParseJson(remoteBytes);
  if (!l.ok || !r.ok || !isPlainObject(l.value) || !isPlainObject(r.value)) return null;
  // Null prototype: a "__proto__" key from JSON.parse is an own data key and must survive the merge
  // (assignment on a plain {} would set the prototype instead and drop the key; found by I27 props).
  const merged = Object.create(null) as Record<string, JsonValue>;
  for (const [k, v] of Object.entries(r.value)) merged[k] = v;
  for (const [k, v] of Object.entries(l.value)) merged[k] = v;
  const localText = utf8DecodeStrict(localBytes) ?? "";
  const bytes = encodeJson(merged, detectIndent(localText), localText.endsWith("\n"));
  const c = jsonCanon(merged);
  return { bytes, equalsRemote: c === jsonCanon(r.value), equalsLocal: c === jsonCanon(l.value) };
}
