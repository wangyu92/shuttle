// PathFilter.scope(path, size?) (design §3.11). Pure: settings in, Scope out, in the design's order.
// Filters never delete anything: they only decide what the engine looks at (I12). Changing any input
// changes fingerprint(); the engine then re-evaluates every entry's scope (design §3.11).

import type { ConfigCategory, LocalPlatform, Scope, SelectiveClass } from "@shuttle/protocol";
import { foldKey, normalizePath, segments } from "../path/normalize";
import { isIllegal, type NameRules } from "../path/illegal";
import { fileClassOf, DEFAULT_SELECTIVE } from "./fileTypes";
import { isEngineInternalName, isTempName } from "./tempFiles";
import {
  DEFAULT_CONFIG_CATEGORIES, DEFAULT_PLUGIN_ID, MOBILE_CONFIG_MAX_BYTES, categoryEnabled, configCategoryOf, isMobile,
} from "./configCategories";

export interface FilterSettings {
  configDir: string;
  /** SHUTTLE's own plugin id (its folder under `<configDir>/plugins/` is ignored). */
  pluginId: string;
  platform: LocalPlatform;
  /** Filename rules of this device's filesystem (path/illegal.ts nameRulesFor). */
  nameRules: NameRules;
  /** Case-insensitive filesystem: excluded-folder prefixes compare case-folded. */
  caseInsensitive: boolean;
  excludedFolders: readonly string[];
  selective: Readonly<Record<SelectiveClass, boolean>>;
  configCategories: Readonly<Partial<Record<ConfigCategory, boolean>>>;
  maxFileBytes: number;
}

/** Desktop/Node 200 MiB, mobile 50 MiB (design §3.11.2). */
export function defaultMaxFileBytes(p: LocalPlatform): number {
  return (isMobile(p) ? 50 : 200) * 1024 * 1024;
}

/**
 * design §3.11.3: normalized folder paths; empty entries, duplicates and folders at or under configDir
 * are dropped (config categories govern those).
 */
export function normalizeExcludedFolders(list: readonly string[], configDir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cfg = foldKey(normalizePath(configDir));
  for (const raw of list) {
    const p = normalizePath(raw);
    if (p.length === 0) continue;
    const fk = foldKey(p);
    if (fk === cfg || fk.startsWith(cfg + "/")) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.sort();
}

export class PathFilter {
  readonly s: FilterSettings;
  private readonly cfg: string;
  private readonly cfgFold: string;
  private readonly excluded: string[];
  private readonly fp: string;

  constructor(s: FilterSettings) {
    this.cfg = normalizePath(s.configDir);
    this.cfgFold = foldKey(this.cfg);
    const excluded = normalizeExcludedFolders(s.excludedFolders, this.cfg);
    this.s = { ...s, excludedFolders: excluded };
    this.excluded = excluded.map((f) => (s.caseInsensitive ? foldKey(f) : f) + "/");
    this.fp = fingerprintOf(this.s);
  }

  /** Stable fingerprint of every filter input (design §3.11; stored in meta.filterFingerprint). */
  fingerprint(): string {
    return this.fp;
  }

  /** Path relative to configDir, or null when `path` is not under it. */
  configRel(path: string): string | null {
    const fk = foldKey(path);
    if (fk === this.cfgFold) return "";
    if (!fk.startsWith(this.cfgFold + "/")) return null;
    return path.slice(this.cfg.length + 1);
  }

  /** Config category of a path under configDir (null outside configDir or for 'never'). */
  categoryOf(path: string): ConfigCategory | null {
    const rel = this.configRel(path);
    if (rel === null) return null;
    const c = configCategoryOf(rel, this.s.pluginId);
    return c === "never" ? null : c;
  }

  scope(rawPath: string, size?: number): Scope {
    const path = normalizePath(rawPath);
    const segs = segments(path);
    const name = segs[segs.length - 1] ?? "";
    // 1. engine-internal
    if (isEngineInternalName(name)) return "ignored";
    const rel = this.configRel(path);
    // 2. dot segments (except a first segment equal to configDir), .nomedia
    const cfgSegs = rel === null ? 0 : segments(this.cfg).length;
    for (let i = 0; i < segs.length; i++) {
      if (i < cfgSegs) continue;
      if ((segs[i] ?? "").startsWith(".")) return "ignored";
    }
    if (name === ".nomedia") return "ignored";
    // 3. own plugin data
    if (rel !== null) {
      const own = `plugins/${this.s.pluginId}`;
      if (rel === own || rel.startsWith(own + "/")) return "ignored";
    }
    // 4. temp files
    if (isTempName(name)) return "ignored";
    if (rel !== null) {
      // 5. config scope
      const cat = configCategoryOf(rel, this.s.pluginId);
      if (cat === "never" || !categoryEnabled(cat, this.s.configCategories)) return "excluded";
      if (isIllegal(path, this.s.nameRules)) return "illegal";
      if (size !== undefined && isMobile(this.s.platform) && size > MOBILE_CONFIG_MAX_BYTES) return "oversize";
      if (size !== undefined && size > this.s.maxFileBytes) return "oversize";
      return "active";
    }
    // 6. excluded folders (prefix + '/')
    const cmp = this.s.caseInsensitive ? foldKey(path) : path;
    for (const f of this.excluded) if (cmp.startsWith(f)) return "excluded";
    // 7. selective types
    const cls = fileClassOf(path);
    if (cls !== "notes" && !(this.s.selective[cls] ?? DEFAULT_SELECTIVE[cls])) return "excluded";
    // 8. illegal on this platform
    if (isIllegal(path, this.s.nameRules)) return "illegal";
    // 9. size cap
    if (size !== undefined && size > this.s.maxFileBytes) return "oversize";
    return "active";
  }
}

/** Deterministic string hash (FNV-1a, two 32-bit lanes) of the canonical filter settings. */
export function fingerprintOf(s: FilterSettings): string {
  const cats: Record<string, boolean> = {};
  for (const k of Object.keys(DEFAULT_CONFIG_CATEGORIES).sort()) cats[k] = categoryEnabled(k as ConfigCategory, s.configCategories);
  const sel: Record<string, boolean> = {};
  for (const k of Object.keys(DEFAULT_SELECTIVE).sort()) sel[k] = s.selective[k as SelectiveClass] ?? true;
  const text = JSON.stringify({
    v: 1, cfg: normalizePath(s.configDir), pid: s.pluginId, pf: s.platform, nr: s.nameRules, ci: s.caseInsensitive,
    ex: normalizeExcludedFolders(s.excludedFolders, s.configDir), sel, cats, max: s.maxFileBytes,
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return "f1-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export { DEFAULT_PLUGIN_ID };
