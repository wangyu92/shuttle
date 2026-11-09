// headless.json (design §6.1.11): schema and hand-written validation. No secrets live here; the token
// and key material are in secret/secrets.json (design §4.12.1).

import { readFileSync } from "node:fs";
import type { ConfigCategory, DeviceSettings, SyncMode } from "@shuttle/protocol";
import { DEFAULT_CONFIG_CATEGORIES } from "@shuttle/engine";
import type { WatchMode } from "./watch/Watcher";

export const CONFIG_SCHEMA = 1;
export const DEFAULT_MAX_FILE_BYTES = 209_715_200;
const MODES: readonly SyncMode[] = ["bidirectional", "push-only", "pull-only", "mirror-remote"];
const SELECTIVE = ["images", "audio", "videos", "pdfs", "other"] as const;

export interface HeadlessConfig {
  schema: 1;
  vaultPath: string;
  tmpPath: string;
  mode: SyncMode;
  remote: { type: "shuttle-server"; urls: string[]; vaultId: string; allowHttp?: boolean };
  device: { name: string };
  conflictMode: "conflictFile" | "merge";
  deleteMode: "delete" | "trash";
  /** {} = every category off: the mirror never syncs the config dir (design §6.1.11). */
  configCategories: Partial<Record<ConfigCategory, boolean>>;
  selective: Record<(typeof SELECTIVE)[number], boolean>;
  excludedFolders: string[];
  maxFileBytes: number;
  /** 'chokidar' is accepted as the design's name for watch-only mode. */
  watch: { mode: "hybrid" | "poll" | "chokidar" | "watch"; pollIntervalSec: number };
  guards: { onTrip: "pause" | "apply" };
  watchdog: { stallSec: number };
  maintenance: "auto" | "off";
  autoRepair: boolean;
  /** Engine config dir name in this vault (default `.obsidian`). */
  configDir?: string;
  /** State DB durability (design §6.1.5: full). `normal` is for tests and slow-fsync volumes. */
  stateSynchronous?: "full" | "normal";
}

export function defaultConfig(o: { vaultPath: string; tmpPath: string; urls: string[]; vaultId: string; deviceName: string; mode: SyncMode; allowHttp?: boolean }): HeadlessConfig {
  return {
    schema: 1, vaultPath: o.vaultPath, tmpPath: o.tmpPath, mode: o.mode,
    remote: { type: "shuttle-server", urls: [...o.urls], vaultId: o.vaultId, ...(o.allowHttp ? { allowHttp: true } : {}) },
    device: { name: o.deviceName }, conflictMode: "conflictFile", deleteMode: "delete", configCategories: {},
    selective: { images: true, audio: true, videos: true, pdfs: true, other: true }, excludedFolders: [],
    maxFileBytes: DEFAULT_MAX_FILE_BYTES, watch: { mode: "hybrid", pollIntervalSec: 30 }, guards: { onTrip: "pause" },
    watchdog: { stallSec: 600 }, maintenance: "auto", autoRepair: false,
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`headless.json: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Validate a parsed headless.json. `env.SHUTTLE_PROD === '1'` refuses `guards.onTrip: apply` (design §6.1.8). */
export function validateConfig(raw: unknown, env: { SHUTTLE_PROD?: string | undefined } = process.env): HeadlessConfig {
  const p: string[] = [];
  if (!isObj(raw)) throw new ConfigError(["not an object"]);
  if (raw["schema"] !== CONFIG_SCHEMA) p.push(`schema must be ${CONFIG_SCHEMA}`);
  if (!isStr(raw["vaultPath"])) p.push("vaultPath missing");
  if (!isStr(raw["tmpPath"])) p.push("tmpPath missing");
  if (!MODES.includes(raw["mode"] as SyncMode)) p.push(`mode must be one of ${MODES.join(", ")}`);
  const remote = raw["remote"];
  if (!isObj(remote)) p.push("remote missing");
  else {
    if (remote["type"] !== "shuttle-server") p.push("remote.type must be shuttle-server (S3 is not supported by headless v1)");
    if (!Array.isArray(remote["urls"]) || remote["urls"].length === 0 || !remote["urls"].every(isStr)) p.push("remote.urls must be a non-empty list");
    else for (const u of remote["urls"] as string[]) { try { new URL(u); } catch { p.push(`remote.urls: invalid URL`); } }
    if (!isStr(remote["vaultId"])) p.push("remote.vaultId missing");
    if (remote["allowHttp"] !== undefined && typeof remote["allowHttp"] !== "boolean") p.push("remote.allowHttp must be boolean");
    for (const k of Object.keys(remote)) if (/token|secret|password|key/i.test(k) && k !== "vaultId") p.push(`remote.${k}: secrets do not belong in headless.json`);
  }
  if (!isObj(raw["device"]) || !isStr(raw["device"]["name"])) p.push("device.name missing");
  if (raw["conflictMode"] !== "conflictFile" && raw["conflictMode"] !== "merge") p.push("conflictMode must be conflictFile or merge");
  if (raw["deleteMode"] !== "delete" && raw["deleteMode"] !== "trash") p.push("deleteMode must be delete or trash");
  const cc = raw["configCategories"];
  if (!isObj(cc)) p.push("configCategories must be an object");
  else for (const [k, v] of Object.entries(cc)) {
    if (!(k in DEFAULT_CONFIG_CATEGORIES)) p.push(`configCategories.${k}: unknown category`);
    if (typeof v !== "boolean") p.push(`configCategories.${k} must be boolean`);
  }
  const sel = raw["selective"];
  if (!isObj(sel)) p.push("selective must be an object");
  else for (const k of SELECTIVE) if (typeof sel[k] !== "boolean") p.push(`selective.${k} must be boolean`);
  if (!Array.isArray(raw["excludedFolders"]) || !(raw["excludedFolders"] as unknown[]).every((x) => typeof x === "string")) p.push("excludedFolders must be a list of strings");
  const mfb = raw["maxFileBytes"];
  if (typeof mfb !== "number" || !Number.isInteger(mfb) || mfb <= 0) p.push("maxFileBytes must be a positive integer");
  const w = raw["watch"];
  if (!isObj(w)) p.push("watch missing");
  else {
    if (!["hybrid", "poll", "chokidar", "watch"].includes(w["mode"] as string)) p.push("watch.mode must be hybrid, poll or chokidar");
    const s = w["pollIntervalSec"];
    if (typeof s !== "number" || !(s >= 1 && s <= 3600)) p.push("watch.pollIntervalSec must be 1..3600");
  }
  const g = raw["guards"];
  if (!isObj(g) || (g["onTrip"] !== "pause" && g["onTrip"] !== "apply")) p.push("guards.onTrip must be pause or apply");
  else if (g["onTrip"] === "apply" && env.SHUTTLE_PROD === "1") p.push("guards.onTrip apply is refused when SHUTTLE_PROD=1");
  const wd = raw["watchdog"];
  if (!isObj(wd) || typeof wd["stallSec"] !== "number" || !(wd["stallSec"] >= 30)) p.push("watchdog.stallSec must be >= 30");
  if (raw["maintenance"] !== undefined && raw["maintenance"] !== "auto" && raw["maintenance"] !== "off") p.push("maintenance must be auto or off");
  if (raw["autoRepair"] !== undefined && typeof raw["autoRepair"] !== "boolean") p.push("autoRepair must be boolean");
  if (raw["configDir"] !== undefined && !isStr(raw["configDir"])) p.push("configDir must be a string");
  if (raw["stateSynchronous"] !== undefined && raw["stateSynchronous"] !== "full" && raw["stateSynchronous"] !== "normal") p.push("stateSynchronous must be full or normal");
  if (p.length) throw new ConfigError(p);
  const out = { ...raw } as unknown as HeadlessConfig;
  out.maintenance ??= "auto";
  out.autoRepair ??= false;
  return out;
}

export function loadConfig(file: string, env: { SHUTTLE_PROD?: string | undefined } = process.env): HeadlessConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError([`cannot read ${file}: ${(e as { code?: string }).code ?? "error"}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(["not valid JSON"]);
  }
  return validateConfig(raw, env);
}

export function watchModeOf(c: HeadlessConfig): WatchMode {
  return c.watch.mode === "chokidar" || c.watch.mode === "watch" ? "watch" : c.watch.mode;
}

/** Engine DeviceSettings from headless.json. Every config category the file omits is OFF. */
export function deviceSettingsOf(c: HeadlessConfig): Partial<DeviceSettings> {
  const cats = {} as Record<ConfigCategory, boolean>;
  for (const k of Object.keys(DEFAULT_CONFIG_CATEGORIES) as ConfigCategory[]) cats[k] = c.configCategories[k] === true;
  return {
    deviceName: c.device.name, conflictMode: c.conflictMode, selective: { ...c.selective }, excludedFolders: [...c.excludedFolders],
    configCategories: cats, maxFileBytes: c.maxFileBytes, deleteMode: c.deleteMode, mode: c.mode,
  };
}

/** Engine periodic scan interval (ms) for the watch mode (design §6.1.4: safety scan 10 min for watch-only). */
export function scanIntervalMs(c: HeadlessConfig): number {
  return watchModeOf(c) === "watch" ? 10 * 60 * 1000 : c.watch.pollIntervalSec * 1000;
}
