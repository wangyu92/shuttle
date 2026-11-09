// Activity log (design §3.16): a ring buffer of 2,000 entries, not persisted. Entries are an i18n key
// plus params (rendered by the UI, design §5.13), never free text built from secrets.

import type { FileId, LogCategory, LogEntry, LogLevel } from "@shuttle/protocol";

export const LOG_CAPACITY = 2000;

/** Sync's own strings where they exist (engine-spec §13), keyed for i18n. */
export const LOG_KEYS = Object.freeze({
  connecting: "log.connecting",               // "Connecting to server"
  connected: "log.connectedDetecting",        // "Connected to server. Detecting changes..."
  fullySynced: "log.fullySynced",             // "Fully synced"
  disconnected: "log.disconnected",           // "Disconnected from server"
  connectFailed: "log.unableToConnect",       // "Unable to connect to server"
  authFailed: "log.failedToAuthenticate",     // "Failed to authenticate"
  illegalName: "log.illegalName",             // "Unable to download file with illegal name"
  tooLarge: "log.skippedTooLarge",            // "Skipped: file too large (X MB)"
  excluded: "log.skippedExcluded",            // "Skipped: excluded"
  emptyVault: "log.vaultLooksEmpty",          // "Vault folder looks empty or unmounted"
  massDelete: "log.pausedMassDeletion",       // "Paused: mass deletion"
  massConflict: "log.pausedMassConflict",
  rollback: "log.serverRollback",
  tampered: "log.vaultInfoTampered",
  locked: "log.locked",
  unlocked: "log.unlocked",
  paused: "log.paused",
  resumed: "log.resumed",
  epoch: "log.remoteRebuilt",
  integrity: "log.integrityHold",
  readOnly: "log.readOnlyUpdate",
  configApplied: "log.settingsChangedBySync",
  repair: "log.repairRequested",
  error: "log.unexpectedError",
});

export type LogParams = LogEntry["params"];

export interface LogInput {
  level?: LogLevel;
  cat: LogCategory;
  key: string;
  params?: LogParams;
  path?: string;
  fileId?: FileId;
  groupId?: string;
}

export class ActivityLog {
  private buf: LogEntry[] = [];
  private head = 0;
  private readonly listeners = new Set<(e: LogEntry) => void>();
  private readonly lastError = new Map<LogCategory, string>();

  constructor(private readonly now: () => number, readonly capacity = LOG_CAPACITY) {}

  add(i: LogInput): LogEntry {
    const level: LogLevel = i.level ?? (i.cat === "error" ? "error" : "info");
    const e: LogEntry = {
      ts: this.now(), level, cat: i.cat, key: i.key, params: { ...(i.params ?? {}) },
      ...(i.path !== undefined ? { path: i.path } : {}),
      ...(i.fileId !== undefined ? { fileId: i.fileId } : {}),
      ...(i.groupId !== undefined ? { groupId: i.groupId } : {}),
    };
    if (this.buf.length < this.capacity) this.buf.push(e);
    else {
      this.buf[this.head] = e;
      this.head = (this.head + 1) % this.capacity;
    }
    if (level === "error") this.lastError.set(i.cat, i.key);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A listener must never break the engine.
      }
    }
    return e;
  }

  /** Oldest first. */
  entries(): LogEntry[] {
    return this.buf.length < this.capacity ? [...this.buf] : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  get size(): number {
    return this.buf.length;
  }

  lastErrors(): Partial<Record<LogCategory, string>> {
    return Object.fromEntries(this.lastError) as Partial<Record<LogCategory, string>>;
  }

  onEntry(cb: (e: LogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
