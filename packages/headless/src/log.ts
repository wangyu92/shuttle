// JSON-lines logger (design §6.1.10): one object per line `{ts, level, cat, msg, path?, fileId?,
// groupId?, n?}` on stdout; `--log-format text` for people. Paths are logged in plaintext (the mirror
// holds plaintext anyway). Tokens, keys and passphrases are never logged; redact() is defense in depth
// for anything that slips through (device tokens `sxd_…`, enroll codes `SXE-…`, key drops `SXK-…`,
// and every secret registered at runtime with addSecret()).

import type { LogEntry } from "@shuttle/protocol";

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'text';

export interface LogLine {
  ts: number; level: LogLevel; cat: string; msg: string;
  path?: string; fileId?: string; groupId?: string; n?: number;
  [k: string]: unknown;
}

const TOKEN_RE = /sxd_[A-Za-z0-9_-]{8,}/g;
const CODE_RE = /SX[EK]-[A-Za-z0-9_-]+/g;

/** Values registered as secrets (token, key material); replaced wherever they appear. */
const secrets = new Set<string>();

/** Register a secret string (at least 6 characters) so redact() removes it from every log line. */
export function addSecret(s: string | null | undefined): void {
  if (s && s.length >= 6) secrets.add(s);
}

export function clearSecretsForTests(): void {
  secrets.clear();
}

export function redact(s: string): string {
  let out = s.replace(TOKEN_RE, "sxd_[redacted]").replace(CODE_RE, (m) => `${m.slice(0, 4)}[redacted]`);
  for (const x of secrets) if (out.includes(x)) out = out.split(x).join("[redacted]");
  return out;
}

export interface Logger {
  log(level: LogLevel, cat: string, msg: string, extra?: Partial<LogLine>): void;
  debug(cat: string, msg: string, extra?: Partial<LogLine>): void;
  info(cat: string, msg: string, extra?: Partial<LogLine>): void;
  warn(cat: string, msg: string, extra?: Partial<LogLine>): void;
  error(cat: string, msg: string, extra?: Partial<LogLine>): void;
  fatal(cat: string, msg: string, extra?: Partial<LogLine>): void;
  /** Engine activity log entry (design §3.16) as one line. */
  engine(e: LogEntry): void;
  /** Resolves when written lines are flushed (fatal exit path). */
  flush(): Promise<void>;
}

export interface LoggerOptions {
  format?: LogFormat;
  /** Line sink; default process.stdout. Receives the line without the trailing newline. */
  write?: (line: string) => void;
  now?: () => number;
  /** Drop levels below this one (default info). */
  minLevel?: LogLevel;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

function errText(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  return String(v);
}

export function createLogger(o: LoggerOptions = {}): Logger {
  const format = o.format ?? "json";
  const now = o.now ?? Date.now;
  const min = ORDER[o.minLevel ?? "info"];
  const write = o.write ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const emit = (line: LogLine): void => {
    if (ORDER[line.level] < min) return;
    let text: string;
    if (format === "json") {
      text = JSON.stringify(line, (_k, v: unknown) => (v instanceof Error ? errText(v) : typeof v === "bigint" ? String(v) : v));
    } else {
      const d = new Date(line.ts).toISOString().replace("T", " ").slice(0, 19);
      const parts = [d, line.level.toUpperCase().padEnd(5), `[${line.cat}]`, line.msg];
      if (line.path) parts.push(`(${line.path})`);
      if (line.n !== undefined) parts.push(`n=${line.n}`);
      text = parts.join(" ");
    }
    try { write(redact(text)); } catch { /* stdout closed: never throw from logging */ }
  };
  const log = (level: LogLevel, cat: string, msg: string, extra: Partial<LogLine> = {}): void => {
    const line: LogLine = { ts: now(), level, cat, msg };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && k !== "ts" && k !== "level") line[k] = v;
    emit(line);
  };
  return {
    log,
    debug: (c, m, e) => log("debug", c, m, e),
    info: (c, m, e) => log("info", c, m, e),
    warn: (c, m, e) => log("warn", c, m, e),
    error: (c, m, e) => log("error", c, m, e),
    fatal: (c, m, e) => log("fatal", c, m, e),
    engine: (e) => {
      const params = Object.keys(e.params).length ? e.params : undefined;
      const extra: Partial<LogLine> = {};
      if (e.path !== undefined) extra.path = e.path;
      if (e.fileId !== undefined) extra.fileId = e.fileId;
      if (e.groupId !== undefined) extra.groupId = e.groupId;
      if (params) {
        const n = (params as Record<string, unknown>)["n"];
        if (typeof n === "number") extra.n = n;
        extra["params"] = params;
      }
      log(e.level === "error" ? "error" : "info", e.cat, e.key, extra);
    },
    flush: () => new Promise<void>((resolve) => {
      if (o.write) return resolve();
      if (process.stdout.writableLength === 0) return resolve();
      process.stdout.write("", () => resolve());
    }),
  };
}

/** A logger that keeps lines in memory (tests, secret scans). */
export function memoryLogger(format: LogFormat = "json"): Logger & { lines: string[] } {
  const lines: string[] = [];
  const l = createLogger({ format, write: (s) => lines.push(s), minLevel: "debug" });
  return Object.assign(l, { lines });
}
