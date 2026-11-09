// Engine public API and event payloads (design §3.13, §3.16, §3.17). Types only.
// They live here so the plugin, the headless client and the simulator can be written against the
// engine before it exists; @shuttle/engine implements `Engine` and re-exports these.

import type { Disposable, Clock, LocalFs, Scheduler } from "./platform";
import type { Keyring } from "./keyring";
import type { RemoteHead, Scope, StateStore } from "./state";
import type {
  AdapterStateStore, ConfigCategory, FileId, RemoteAdapter, RemoteCapabilities, RemoteErrorCode, Seq, VersionRecord,
} from "./types";

// ---------- settings (design §3.17) ----------

export type SyncMode = 'bidirectional' | 'push-only' | 'pull-only' | 'mirror-remote';
export type ConflictMode = 'merge' | 'conflictFile';
export type SelectiveClass = 'images' | 'audio' | 'videos' | 'pdfs' | 'other';

/** Per device, localStorage (never data.json). */
export interface DeviceSettings {
  deviceName: string;
  conflictMode: ConflictMode;
  selective: Record<SelectiveClass, boolean>;
  excludedFolders: string[];
  configCategories: Record<ConfigCategory, boolean>;
  maxFileBytes: number;
  deleteMode: 'trash' | 'delete';
  strictOverlap: boolean;
  mode: SyncMode;
}

// ---------- activity log (design §3.16) ----------

export type LogLevel = 'info' | 'error';
export type LogCategory = 'general' | 'error' | 'skipped' | 'merge' | 'network' | 'account';
/** i18n key + params, rendered by the UI (design §5.13). */
export interface LogEntry {
  ts: number; level: LogLevel; cat: LogCategory; key: string; params: Record<string, string | number | boolean | null>;
  path?: string; fileId?: FileId; groupId?: string;
}

// ---------- status (design §3.16) ----------

export type EngineStatusKind = 'synced' | 'syncing' | 'paused' | 'disconnected' | 'error';
export interface EngineStatus {
  status: EngineStatusKind;
  pendingUp: number; pendingDown: number; failed: number;
  locked: boolean; readOnly: boolean;
  /** Short machine-readable reason for `error`/`paused` (e.g. a RemoteErrorCode or guard kind). */
  reason?: RemoteErrorCode | GuardKind | (string & {});
}

// ---------- guards (design §3.13) ----------

export type GuardKind =
  | 'emptyVault' | 'massDeleteLocal' | 'massDeleteRemote' | 'massConflict' | 'rollback' | 'tampered' | 'integrity' | 'epoch';
export type GuardChoice = 'apply' | 'pause' | 'accept' | 'rebuild';
export interface GuardEvent { id: string; kind: GuardKind; n: number; sample: string[] }

// ---------- config sync (design §3.12) ----------

export interface ConfigAppliedEvent { categories: Set<ConfigCategory>; paths: string[]; needsReload: boolean; hot: string[] }

export interface EngineEventMap {
  status: EngineStatus;
  log: LogEntry;
  configApplied: ConfigAppliedEvent;
  guard: GuardEvent;
}
export type EngineEventName = keyof EngineEventMap;

// ---------- debug info (design §3.16) ----------

/** Never tokens, passphrase or keys. */
export interface DebugInfo {
  engineVersion: string; schemaVersion: number; platform: string;
  remote: { kind: string; capabilities: RemoteCapabilities | null; host: string | null };
  cursor: Seq | null;
  indexByScope: Partial<Record<Scope, number>>;
  journalByState: Record<string, number>; batchesByState: Record<string, number>;
  applyQueue: number; intents: number; quarantined: number;
  lastErrors: Partial<Record<LogCategory, string>>;
  filterFingerprint: string | null;
  budgets: Record<string, number>;
}

// ---------- the engine (design §3.17) ----------

export interface Engine {
  start(): Promise<void>;
  /** Unregister, finish the current transaction. */
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Drop cached keys, enter Locked (§4.11.7). */
  lock(): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  kick(reason: string): void;
  onVisibility(visible: boolean): void;
  /** Re-fingerprint filters, live (UX-D3). */
  updateSettings(patch: Partial<DeviceSettings>): Promise<void>;
  status(): EngineStatus;
  on<E extends EngineEventName>(ev: E, cb: (payload: EngineEventMap[E]) => void): Disposable;
  answerGuard(id: string, choice: GuardChoice): void;
  /** §4.14: re-commit local content with base = current head. */
  repair(fileId: FileId): Promise<void>;
  debugInfo(): DebugInfo;
  // v2 hooks backed by the v1 format:
  versions?(fileId: FileId): Promise<VersionRecord[]>;
  deletedFiles?(): RemoteHead[];
  restore?(fileId: FileId, version: Seq): Promise<void>;
}

/** Test hooks compiled out of release builds (design §3.1 testing/crashPoint.ts, ops-spec §3). */
export interface EngineHooks { crashPoint(name: string): void | Promise<void> }

/** Everything injected into `createEngine` (design §3: LocalFs, StateStore, RemoteAdapter, Keyring, Clock, Scheduler). */
export interface EngineDeps {
  fs: LocalFs;
  state: StateStore;
  remote: RemoteAdapter;
  /** null while Locked; the engine collects events but never seals, opens or commits. */
  keyring: Keyring | null;
  clock: Clock;
  scheduler: Scheduler;
  adapterState?: AdapterStateStore;
  hooks?: EngineHooks;
}
