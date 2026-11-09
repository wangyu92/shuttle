// Plain-text formats shared by the log view, Copy log and Copy debug info (design §5.3.5, §5.4.3).
// Pure. Every free-text parameter passes through redact(); ids are shortened.

import type { DebugInfo, EngineStatus, LogEntry } from "@shuttle/protocol";
import { t } from "../i18n";
import { redact, shortId } from "../util/redact";

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** `2026-11-05 14:30:01` in local time. */
export function localTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Offset like `+09:00`. */
export function tzOffset(ts: number): string {
  const m = -new Date(ts).getTimezoneOffset();
  const s = m >= 0 ? "+" : "-";
  return `${s}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
}

/** The rendered message of a log entry (params redacted). */
export function logMessage(e: LogEntry): string {
  const params: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(e.params)) params[k] = typeof v === "string" ? redact(v) : v;
  return t(e.key, params);
}

export function logLine(e: LogEntry): string {
  const cat = `[${e.cat}]`.padEnd(10, " ");
  return `${localTime(e.ts)}  ${cat}${logMessage(e)}${e.path ? `  ${e.path}` : ""}`;
}

export function copyLog(entries: readonly LogEntry[], now: number): string {
  return [`SHUTTLE sync log, copied ${localTime(now)} ${tzOffset(now)}`, ...entries.map(logLine)].join("\n");
}

export interface DebugContext {
  now: number;
  pluginVersion: string;
  obsidianVersion: string | null;
  platform: string;
  configDir: string;
  hostUrl: string | null;
  endpointIndex: number;
  endpointCount: number;
  endpointMode: "auto" | number;
  vaultId: string | null;
  deviceName: string;
  deviceId: string | null;
  status: EngineStatus | null;
  debug: DebugInfo | null;
  log: readonly LogEntry[];
  includeLog: boolean;
  /** Exact secrets that must never appear (token, passphrase if any is in memory). */
  secrets: readonly string[];
}

/** design §5.4.3 text (fields the plugin knows in v1; the rest are left out, not invented). */
export function debugText(c: DebugContext): string {
  const d = c.debug;
  const s = c.status;
  const caps = d?.remote.capabilities;
  const scopes = d ? Object.entries(d.indexByScope).map(([k, v]) => `${k} ${v}`).join(", ") : "-";
  const journal = d ? Object.entries(d.journalByState).map(([k, v]) => `${k} ${v}`).join(", ") || "empty" : "-";
  const errors = d ? Object.entries(d.lastErrors).map(([k, v]) => `${k} ${v}`).join("; ") || "-" : "-";
  const lines = [
    "SHUTTLE debug info",
    `Generated: ${localTime(c.now)} ${tzOffset(c.now)}`,
    `Plugin version: ${c.pluginVersion}${d ? ` (engine ${d.engineVersion}, schema ${d.schemaVersion})` : ""}`,
    `Obsidian version: ${c.obsidianVersion ?? "unknown"}`,
    `Platform: ${c.platform}`,
    `Config folder: ${c.configDir}`,
    `Remote type: SHUTTLE server`,
    `Host server: ${c.hostUrl ?? "-"} (endpoint ${c.endpointIndex + 1} of ${c.endpointCount}, mode ${c.endpointMode === "auto" ? "Automatic" : "Pinned"})`,
    caps ? `Capabilities: changeFeed=${caps.changeFeed} cas=${caps.cas} serverHistory=${caps.serverHistory ? "yes" : "no"} revocation=${caps.revocation ? "yes" : "no"} usage=${caps.usage}` : "Capabilities: -",
    `Vault: id ${shortId(c.vaultId)}`,
    `Device: name "${c.deviceName}", id ${shortId(c.deviceId)}`,
    s ? `Status: ${s.status}, pending up ${s.pendingUp}, down ${s.pendingDown}, failed ${s.failed}, locked ${s.locked ? "yes" : "no"}${s.reason ? `, reason ${s.reason}` : ""}` : "Status: not running",
    `Cursor: ${d?.cursor ?? "-"}`,
    `Index: ${scopes}`,
    `Journal: ${journal}, apply queue ${d?.applyQueue ?? 0}, intents ${d?.intents ?? 0}, quarantined ${d?.quarantined ?? 0}`,
    `Filters: fingerprint ${d?.filterFingerprint ? d.filterFingerprint.slice(0, 4) + "…" : "-"}`,
    `Budgets: ${d ? Object.entries(d.budgets).map(([k, v]) => `${k} ${v}`).join(", ") : "-"}`,
    `Last errors: ${errors}`,
  ];
  if (c.includeLog) {
    const recent = c.log.slice(-50);
    lines.push(`Recent log (last ${recent.length} entries):`, ...recent.map(logLine));
  }
  return redact(lines.join("\n"), c.secrets);
}
