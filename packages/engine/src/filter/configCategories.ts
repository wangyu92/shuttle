// configDir file → config sync category (design §3.12). Pure. The mapping is SHUTTLE's own.
// Every category follows its per-device toggle. `community-plugin*` (the enabled-plugin list and the
// plugin folders) default to off and are turned on per device (lead decision D16, was v2).

import type { ConfigCategory, LocalPlatform } from "@shuttle/protocol";

export const CONFIG_CATEGORIES: readonly ConfigCategory[] = [
  "app", "appearance", "appearance-data", "hotkey", "core-plugin", "core-plugin-data", "community-plugin", "community-plugin-data",
];

/** Categories a device may sync (all of them since D16; the name is kept for callers). */
export const V1_CONFIG_CATEGORIES: ReadonlySet<ConfigCategory> = new Set<ConfigCategory>(CONFIG_CATEGORIES);

export const DEFAULT_CONFIG_CATEGORIES: Readonly<Record<ConfigCategory, boolean>> = Object.freeze({
  "app": true, "appearance": true, "appearance-data": true, "hotkey": true, "core-plugin": true, "core-plugin-data": true,
  "community-plugin": false, "community-plugin-data": false,
});

/** Default plugin id of SHUTTLE itself (its own folder under plugins/ is never synced). */
export const DEFAULT_PLUGIN_ID = "shuttle";

const NEVER_FILES = new Set(["workspace.json", "workspace-mobile.json", "workspaces.json"]);
const FIXED: Readonly<Record<string, ConfigCategory>> = {
  "app.json": "app", "types.json": "app",
  "appearance.json": "appearance",
  "hotkeys.json": "hotkey",
  "core-plugins.json": "core-plugin", "core-plugins-migration.json": "core-plugin",
  "community-plugins.json": "community-plugin",
};

/**
 * Category of `rel`, a path relative to configDir (no leading '/'), or 'never'.
 * `pluginId` is SHUTTLE's own id: its folder is 'never'.
 */
export function configCategoryOf(rel: string, pluginId: string = DEFAULT_PLUGIN_ID): ConfigCategory | 'never' {
  if (rel.length === 0) return "never";
  const segs = rel.split("/");
  const first = segs[0] ?? "";
  if (segs.length === 1) {
    if (NEVER_FILES.has(first) || first === "cache") return "never";
    const fixed = FIXED[first];
    if (fixed) return fixed;
    return first.toLowerCase().endsWith(".json") ? "core-plugin-data" : "never";
  }
  if (first === "cache") return "never";
  if (first === "themes" || first === "snippets") return "appearance-data";
  if (first === "plugins") {
    const id = segs[1] ?? "";
    if (id === "" || id === pluginId || segs.length < 3) return "never";
    return "community-plugin-data";
  }
  return "never";
}

/** design §3.12: whether a category is synced on a v1 device with these toggles. */
export function categoryEnabled(cat: ConfigCategory, toggles: Readonly<Partial<Record<ConfigCategory, boolean>>>): boolean {
  if (!V1_CONFIG_CATEGORIES.has(cat)) return false;
  return toggles[cat] ?? DEFAULT_CONFIG_CATEGORIES[cat];
}

/**
 * Separate size cap for config files on mobile (design §3.11.2, pain 19). 32 MiB since D16: plugin
 * bundles such as Excalidraw's main.js are several MiB and must reach phones whole.
 */
export const MOBILE_CONFIG_MAX_BYTES = 32 * 1024 * 1024;

export function isMobile(p: LocalPlatform): boolean {
  return p === "ios" || p === "android";
}

/** Reload classification of one applied config file (design §3.12 reload table). */
export interface ReloadClass { needsReload: boolean; forceQuitOnMobile: boolean }

export function reloadClassOf(rel: string, pluginId: string = DEFAULT_PLUGIN_ID): ReloadClass {
  const cat = configCategoryOf(rel, pluginId);
  if (cat === "community-plugin" || cat === "community-plugin-data") return { needsReload: true, forceQuitOnMobile: true };
  if (cat === "appearance-data") return { needsReload: true, forceQuitOnMobile: false };
  if (rel === "graph.json" || rel === "core-plugins.json" || rel === "core-plugins-migration.json") return { needsReload: true, forceQuitOnMobile: false };
  // appearance.json: theme and snippet lists need a reload, other fields hot-reload. The engine sees the
  // path only, so it reports a reload (a needless prompt is harmless; a missed reload leaves stale UI).
  if (rel === "appearance.json") return { needsReload: true, forceQuitOnMobile: false };
  return { needsReload: false, forceQuitOnMobile: false };
}
