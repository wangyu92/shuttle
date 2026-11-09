// Platform interfaces injected into the engine (design §3, §3.2, §3.14, §3.15).
// Types only. The plugin provides Obsidian-backed implementations, the headless client Node ones,
// and @shuttle/testkit deterministic in-memory fakes.

/** Returned by event registrations (design §3.2 `onEvent`, §3.17 `on`). */
export interface Disposable { dispose(): void }

// ---------- LocalFs (design §3.2) ----------

export interface LocalStat {
  path: string; kind: 'file' | 'folder'; size: number; mtime: number; ctime: number; ino?: number; ctimeMs?: number;
}

export type LocalEvent =
  | { t: 'create' | 'modify'; path: string; stat?: LocalStat }
  | { t: 'delete'; path: string; kind?: 'file' | 'folder' }
  | { t: 'rename'; from: string; to: string; kind?: 'file' | 'folder' }
  | { t: 'raw'; path: string }        // config dir; plugin uses vault.on('raw')
  | { t: 'rescan-hint' };

export type LocalPlatform = 'desktop' | 'ios' | 'android' | 'node';
export type RemoveMode = 'trash' | 'delete';

export interface LocalFs {
  readonly platform: LocalPlatform;
  readonly caseInsensitive: boolean;          // macOS/iOS/Windows: true
  readonly configDir: string;                  // vault.configDir, never hard-coded
  /** Batches of stats; paths NFC-normalized. */
  listAll(opts: { includeConfigDir: boolean }): AsyncIterable<LocalStat[]>;
  stat(path: string): Promise<LocalStat | null>;
  /** Whole file (mobile has no range read). */
  read(path: string): Promise<Uint8Array>;
  /** Plugin: vault.process(). `fn` returning null aborts; resolves false when aborted. */
  processText?(path: string, fn: (current: string) => string | null): Promise<boolean>;
  /** MUST be crash-atomic where the platform allows (temp file + rename, design §3.2); write intents cover the rest (§3.8.4). */
  write(path: string, data: Uint8Array, opts: { mtime: number; ctime?: number }): Promise<LocalStat>;
  writeChunked?(path: string, chunks: AsyncIterable<Uint8Array>, opts: { mtime: number }): Promise<LocalStat>;
  /** MUST create missing parent folders (design §3.2, S21). No link rewriting. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string, mode: RemoveMode): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rmdirIfEmpty(path: string): Promise<boolean>;
  onEvent(cb: (e: LocalEvent) => void): Disposable;
}

/**
 * Error codes LocalFs implementations attach as `code` on thrown errors, so the engine can tell
 * a vanished file from a full disk without platform-specific parsing.
 */
export type LocalFsErrorCode = 'ENOENT' | 'EEXIST' | 'ENOSPC' | 'EACCES' | 'EISDIR' | 'ENOTDIR' | 'ENOTEMPTY' | 'EIO';

// ---------- Clock and Scheduler (design §3.14, §3.15; engine-spec §1 platform/) ----------

export interface Clock {
  /** Wall-clock milliseconds since the epoch (may jump; used for mtimes, ts and display). */
  now(): number;
  /** Monotonic milliseconds from an arbitrary origin (timeouts, debounce, backoff). Never decreases. */
  monotonic(): number;
}

/** Opaque timer handle. */
export type TimerHandle = number;

export interface Scheduler {
  /** Run `fn` once after `ms` monotonic milliseconds. */
  setTimer(ms: number, fn: () => void): TimerHandle;
  clearTimer(h: TimerHandle): void;
  /** Yield to the UI / event loop between batches (`scheduler.yield` if present, else setTimeout(0); design §3.15). */
  yieldToUi(): Promise<void>;
  /** Resolve when the host is idle (requestIdleCallback where present), or after at most `timeoutMs`. */
  idle(timeoutMs?: number): Promise<void>;
}
