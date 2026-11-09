// File kind → merge strategy, and the LWW decision (design §3.10.1, §3.10.4; engine-spec §7.1, §7.4).
// Pure. Execution (archive upload, pull, conflict-copy write) belongs to the op runner / applier (part 2).

import type { ConflictMode, FileKind, RetentionClass } from "@shuttle/protocol";
import { extname, foldKey, isUnder } from "../path/normalize";

const ATTACHMENT_EXT = new Set([
  "bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "heic", "heif", "tif", "tiff", "ico",
  "mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus", "aac",
  "mp4", "webm", "ogv", "mov", "mkv", "m4v", "avi",
  "pdf",
]);

export function isUnderConfigDir(path: string, configDir: string): boolean {
  return isUnder(foldKey(path), foldKey(configDir));
}

/**
 * Merge kind (design §3.10.1): `config` under configDir, `note` for `.md`, `attachment` for the
 * selective-sync media classes (§3.11.1), `other` for the rest (canvas, base, unknown types).
 */
export function kindOf(path: string, configDir: string): FileKind {
  if (isUnderConfigDir(path, configDir)) return "config";
  const ext = extname(path).toLowerCase();
  if (ext === "md") return "note";
  if (ATTACHMENT_EXT.has(ext)) return "attachment";
  return "other";
}

/** `*.json` under configDir: merged with mergeJson (design §3.10.1). */
export function isConfigJson(path: string, configDir: string): boolean {
  return isUnderConfigDir(path, configDir) && extname(path).toLowerCase() === "json";
}

/** Retention class `rc` (design §2.4): config under configDir; note = md, canvas, base; else attachment. */
export function retentionClassOf(path: string, configDir: string): RetentionClass {
  if (isUnderConfigDir(path, configDir)) return "config";
  const ext = extname(path).toLowerCase();
  return ext === "md" || ext === "canvas" || ext === "base" ? "note" : "attachment";
}

export type MergeStrategy = 'dmp3' | 'json' | 'lww' | 'conflictCopy';

export interface StrategyInput {
  kind: FileKind;
  configJson: boolean;
  conflictMode: ConflictMode;
  /** Conflict-loop fallback tripped for this file (design §3.10.1; merge/Oscillation.ts). */
  conflictLoop?: boolean;
}

/** design §3.10.1 policy table. */
export function strategyFor(i: StrategyInput): MergeStrategy {
  if (i.conflictLoop) return "conflictCopy";
  if (i.configJson) return "json";
  if (i.kind === "note") return i.conflictMode === "merge" ? "dmp3" : "conflictCopy";
  return i.conflictMode === "merge" ? "lww" : "conflictCopy";
}

/** Future-mtime clamp window (design §3.10.4). */
export const MTIME_CLAMP_MS = 24 * 60 * 60 * 1000;

export interface LwwInput { localMtime: number; remoteMtime: number; remoteTs: number }
export interface LwwDecision {
  winner: 'local' | 'remote';
  /** At least one mtime was more than 24 h past the server time and was clamped (log a clock warning). */
  clockWarning: boolean;
  localMtime: number; remoteMtime: number;
}

/**
 * LWW by mtime (design §3.10.4). Remote wins ties. Remote wins → archive local first, then PULL
 * (fallback conflict copy if archiving fails, X5). Local wins → log "Rejected server change" and
 * PUSH_PUT(base = R.seq).
 */
export function lwwDecide(i: LwwInput): LwwDecision {
  const cap = i.remoteTs + MTIME_CLAMP_MS;
  let clockWarning = false;
  let l = i.localMtime;
  let r = i.remoteMtime;
  if (l > cap) { l = i.remoteTs; clockWarning = true; }
  if (r > cap) { r = i.remoteTs; clockWarning = true; }
  return { winner: r >= l ? "remote" : "local", clockWarning, localMtime: l, remoteMtime: r };
}

/**
 * design §3.10.6 refinement: a locally created note that is empty, or whose whitespace-trimmed text
 * is a prefix of the remote text (template-created), is replaced by the remote silently.
 */
export function isTemplatePrefix(localText: string, remoteText: string): boolean {
  const t = localText.trim();
  return t === "" || remoteText.trimStart().startsWith(t);
}
