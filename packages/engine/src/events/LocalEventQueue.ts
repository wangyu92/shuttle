// Local event handling (design §3.5; engine-spec §3.5): per-path debounce with max wait, delete+create
// pairing, folder expansion, configDir raw events, rescan hints. Timers come from the injected
// Scheduler and time from the Clock (monotonic), so tests drive it with FakeScheduler.advance().
//
// The queue never touches the index or the disk except through its deps: it turns events into
// `markDirty` calls and rename requests. The rename rule itself (§3.6.1) is reconcile/LocalRenames.ts.

import type { Clock, FileEntry, FileId, LocalEvent, LocalStat, Scheduler, TimerHandle } from "@shuttle/protocol";
import { isUnder, normalizePath, rebase } from "../path/normalize";
import type { DirtyKey, DirtyReason } from "../types";
import { uuidV4 } from "../util/uuid";
import { DEFAULT_EVENT_TIMINGS, type EventTimings } from "./timing";

export interface EventSink {
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  /** Apply the §3.6.1 rename rule (LocalRenames.rename). */
  rename(from: string, to: string, groupId?: string): void | Promise<void>;
  scheduleScan(mode: 'fast' | 'full'): void;
  /** Errors from async pairing work, never thrown into the platform's event callback. */
  onError?(e: unknown): void;
}

export interface EventIndexView {
  byPath(path: string): FileEntry | null;
  entriesUnder(folder: string): FileEntry[];
}

export interface LocalEventQueueDeps {
  clock: Pick<Clock, "monotonic">;
  scheduler: Pick<Scheduler, "setTimer" | "clearTimer">;
  configDir: string;
  index: EventIndexView;
  sink: EventSink;
  /** Stat for create events that carry none. */
  stat(path: string): Promise<LocalStat | null>;
  /** Hash a file now (bypasses debounce for delete+create pairing); null when unreadable. */
  hashNow(path: string): Promise<string | null>;
  timings?: Partial<EventTimings>;
  newGroupId?: () => string;
}

interface Pending { firstAt: number; timer: TimerHandle; raw: boolean }
interface PendingDelete { path: string; fileId: FileId; size: number; hash: string; timer: TimerHandle }

export class LocalEventQueue {
  private readonly t: EventTimings;
  private debounced = new Map<string, Pending>();
  private deletes = new Map<string, PendingDelete>();
  private stopped = false;
  /** In-flight async pairing work, so tests and shutdown can wait for it. */
  private work = new Set<Promise<void>>();

  constructor(private readonly d: LocalEventQueueDeps) {
    this.t = { ...DEFAULT_EVENT_TIMINGS, ...stripUndefined(d.timings ?? {}) };
  }

  /** Entry point; safe to register directly as the LocalFs.onEvent callback. Never throws. */
  handle(e: LocalEvent): void {
    if (this.stopped) return;
    try {
      switch (e.t) {
        case "modify": this.debounce(normalizePath(e.path), false); break;
        case "create": this.onCreate(normalizePath(e.path), e.stat); break;
        case "delete": this.onDelete(normalizePath(e.path), e.kind); break;
        case "rename": this.onRename(normalizePath(e.from), normalizePath(e.to), e.kind); break;
        case "raw": {
          const p = normalizePath(e.path);
          if (isUnder(p, this.d.configDir) || p === this.d.configDir) this.debounce(p, true);
          break;
        }
        case "rescan-hint": this.d.sink.scheduleScan("fast"); break;
      }
    } catch (err) {
      this.d.sink.onError?.(err);
    }
  }

  /** Flush every pending debounce and delete hold now (shutdown, tests). */
  flushAll(): void {
    for (const p of [...this.debounced.keys()]) this.flushPath(p);
    for (const k of [...this.deletes.keys()]) this.expireDelete(k);
  }

  /** Wait for async pairing work started by create events. */
  async idle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  stop(): void {
    this.stopped = true;
    for (const p of this.debounced.values()) this.d.scheduler.clearTimer(p.timer);
    for (const p of this.deletes.values()) this.d.scheduler.clearTimer(p.timer);
    this.debounced.clear();
    this.deletes.clear();
  }

  get pendingPaths(): number {
    return this.debounced.size;
  }

  get pendingDeletes(): number {
    return this.deletes.size;
  }

  // ---------- debounce ----------

  private debounce(path: string, raw: boolean): void {
    const now = this.d.clock.monotonic();
    const cur = this.debounced.get(path);
    const settle = raw ? this.t.rawDebounceMs : this.t.settleMs;
    const firstAt = cur?.firstAt ?? now;
    if (cur) this.d.scheduler.clearTimer(cur.timer);
    const left = this.t.maxWaitMs - (now - firstAt);
    if (left <= 0) {
      this.debounced.delete(path);
      this.emitDirty(path);
      return;
    }
    const timer = this.d.scheduler.setTimer(Math.min(settle, left), () => this.flushPath(path));
    this.debounced.set(path, { firstAt, timer, raw });
  }

  private flushPath(path: string): void {
    const cur = this.debounced.get(path);
    if (!cur) return;
    this.d.scheduler.clearTimer(cur.timer);
    this.debounced.delete(path);
    this.emitDirty(path);
  }

  private cancelDebounce(path: string): boolean {
    const cur = this.debounced.get(path);
    if (!cur) return false;
    this.d.scheduler.clearTimer(cur.timer);
    this.debounced.delete(path);
    return true;
  }

  private emitDirty(path: string): void {
    const e = this.d.index.byPath(path);
    this.d.sink.markDirty(e ? { fileId: e.fileId, path } : { path }, "event");
  }

  // ---------- create + delete pairing ----------

  private onCreate(path: string, stat: LocalStat | undefined): void {
    if (this.deletes.size === 0) {
      this.debounce(path, false);
      return;
    }
    const job = (async () => {
      const st = stat ?? (await this.d.stat(path));
      const size = st?.kind === "file" ? st.size : null;
      const candidates = size === null ? [] : [...this.deletes.values()].filter((x) => x.size === size && x.path !== path);
      if (candidates.length) {
        const h = await this.d.hashNow(path);
        const hit = h === null ? undefined : candidates.find((x) => x.hash === h && this.deletes.get(x.path) === x);
        if (hit) {
          this.d.scheduler.clearTimer(hit.timer);
          this.deletes.delete(hit.path);
          this.cancelDebounce(hit.path);
          await this.d.sink.rename(hit.path, path);
          return;
        }
      }
      this.debounce(path, false);
    })().catch((err) => {
      this.d.sink.onError?.(err);
      this.debounce(path, false);
    });
    this.track(job);
  }

  private onDelete(path: string, kind: 'file' | 'folder' | undefined): void {
    const isFolder = kind === "folder" || (kind === undefined && !this.d.index.byPath(path) && this.d.index.entriesUnder(path).length > 0);
    if (isFolder) {
      // [pain 14]: some platforms report only the folder.
      for (const e of this.d.index.entriesUnder(path)) {
        this.cancelDebounce(e.path);
        this.d.sink.markDirty({ fileId: e.fileId, path: e.path }, "missing");
      }
      return;
    }
    this.cancelDebounce(path);
    const e = this.d.index.byPath(path);
    if (e?.obs?.hash) {
      const prev = this.deletes.get(path);
      if (prev) this.d.scheduler.clearTimer(prev.timer);
      const timer = this.d.scheduler.setTimer(this.t.deleteHoldMs, () => this.expireDelete(path));
      this.deletes.set(path, { path, fileId: e.fileId, size: e.obs.size, hash: e.obs.hash, timer });
      return;
    }
    this.d.sink.markDirty(e ? { fileId: e.fileId, path } : { path }, "missing");
  }

  private expireDelete(path: string): void {
    const p = this.deletes.get(path);
    if (!p) return;
    this.d.scheduler.clearTimer(p.timer);
    this.deletes.delete(path);
    this.d.sink.markDirty({ fileId: p.fileId, path }, "missing");
  }

  // ---------- renames ----------

  private onRename(from: string, to: string, kind: 'file' | 'folder' | undefined): void {
    if (from === to) return;
    const isFolder = kind === "folder" || (kind === undefined && !this.d.index.byPath(from) && this.d.index.entriesUnder(from).length > 0);
    if (isFolder) {
      const groupId = (this.d.newGroupId ?? uuidV4)();
      const job = (async () => {
        for (const e of this.d.index.entriesUnder(from)) {
          const dest = rebase(e.path, from, to);
          if (this.cancelDebounce(e.path)) this.debounce(dest, false);
          await this.d.sink.rename(e.path, dest, groupId);
        }
      })().catch((err) => this.d.sink.onError?.(err));
      this.track(job);
      return;
    }
    const hadPending = this.cancelDebounce(from);
    const job = Promise.resolve(this.d.sink.rename(from, to)).then(() => {
      if (hadPending) this.debounce(to, false);
    }).catch((err) => this.d.sink.onError?.(err));
    this.track(job);
  }

  private track(p: Promise<void>): void {
    this.work.add(p);
    void p.finally(() => this.work.delete(p));
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
