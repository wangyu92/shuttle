// Filesystem watcher for the headless client (design §6.1.4). Watchers only produce hints; correctness
// comes from the engine's periodic stat scan with the fast path (§3.4.1).
//
// design §6.1.4 names chokidar. Shuttle adds no npm dependencies, so this is node:fs.watch, one
// non-recursive watcher per directory (inotify on Linux), with the same pruning as the scan: `.git`,
// `.trash`, `.claude` and every other dot directory are never watched (so the inotify budget counts
// only vault directories and git operations cause no event storms). Node's own `recursive: true`
// cannot prune, which is why it is not used.
//
// Modes: 'hybrid' (default: watcher + engine scan every pollIntervalSec), 'poll' (scan only),
// 'watch' (alias 'chokidar' in config: watcher + slow safety scan). Fallback to 'poll' when the
// inotify budget check fails, on ENOSPC, on more than 3 watcher errors in 10 minutes, or after misses
// in 3 consecutive scans (passive miss detection: changes a scan found that the watcher never reported).
// Every callback is wrapped; nothing thrown here reaches the process.

import { watch as fsWatch, promises as fsp, type FSWatcher } from "node:fs";
import path from "node:path";
import type { LocalEvent } from "@shuttle/protocol";
import type { Logger } from "../log";
import type { NodeLocalFs, ScanReport } from "../NodeLocalFs";
import { inotifyBudget, type InotifyBudget, type InotifyProbe } from "./inotifyBudget";

export type WatchMode = 'hybrid' | 'poll' | 'watch';

export interface WatcherStats {
  mode: WatchMode;
  configuredMode: WatchMode;
  degraded: boolean;
  degradedReason: string | null;
  dirs: number;
  events: number;
  errors: number;
  missedByWatcher: number;
  missStreak: number;
  lastScanAt: number;
  lastScanMs: number;
  budget: InotifyBudget | null;
}

export interface WatcherOptions {
  fs: NodeLocalFs;
  mode: WatchMode;
  log?: Logger;
  includeConfigDir?: () => boolean;
  /** Extra pruning (excluded folders need no watch). */
  prune?: (relDir: string) => boolean;
  probe?: InotifyProbe;
  /** Grace after a scan before unreported changes count as misses (watcher latency). */
  missGraceMs?: number;
  now?: () => number;
  /** Test hook: events are observed but not delivered (design §7.7 "watcher delivery disabled"). */
  deliver?: boolean;
  /** Budget recheck interval (design §6.1.4: hourly). 0 disables. */
  budgetRecheckMs?: number;
}

const ERROR_WINDOW_MS = 10 * 60 * 1000;
const MAX_ERRORS = 3;
const MISS_STREAK_LIMIT = 3;
/** How long a vanished folder waits for its inode to reappear elsewhere (a move). */
const FOLDER_MOVE_HOLD_MS = 700;

export class Watcher {
  private readonly o: WatcherOptions;
  private readonly watchers = new Map<string, FSWatcher>();   // NFC dir rel ("" = root) → watcher
  private readonly diskDirs = new Map<string, string>();      // NFC dir rel → absolute disk path
  private readonly dirIno = new Map<string, number>();        // NFC dir rel → inode (folder renames keep it)
  /** Watched directories that vanished: held briefly so a move (same inode elsewhere) becomes one rename. */
  private readonly goneDirs = new Map<number, { rel: string; timer: NodeJS.Timeout }>();
  /** Old paths of folders just reported as renamed: their own "gone" event is dropped. */
  private readonly movedAway = new Map<string, number>();
  private readonly reported = new Map<string, number>();      // NFC path → last event time
  private errorTimes: number[] = [];
  private scanSub: { dispose(): void } | null = null;
  private budgetTimer: NodeJS.Timeout | null = null;
  private running = false;
  deliver: boolean;
  readonly stats: WatcherStats;

  constructor(o: WatcherOptions) {
    this.o = o;
    this.deliver = o.deliver ?? true;
    this.stats = {
      mode: o.mode, configuredMode: o.mode, degraded: false, degradedReason: null, dirs: 0, events: 0, errors: 0,
      missedByWatcher: 0, missStreak: 0, lastScanAt: 0, lastScanMs: 0, budget: null,
    };
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.scanSub = this.o.fs.onScan((r) => this.onScan(r));
    if (this.stats.mode === "poll") return;
    await this.checkBudget();
    if ((this.stats.mode as WatchMode) === "poll") return;
    await this.watchTree("");
    const every = this.o.budgetRecheckMs ?? 60 * 60 * 1000;
    if (every > 0) {
      this.budgetTimer = setInterval(() => { void this.checkBudget().catch(() => undefined); }, every);
      this.budgetTimer.unref();
    }
  }

  stop(): void {
    this.running = false;
    this.scanSub?.dispose();
    this.scanSub = null;
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    this.budgetTimer = null;
    this.closeAll();
  }

  private closeAll(): void {
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();
    this.diskDirs.clear();
    this.dirIno.clear();
    for (const g of this.goneDirs.values()) clearTimeout(g.timer);
    this.goneDirs.clear();
    this.stats.dirs = 0;
  }

  /** Switch to scan-only mode for good (until restart): budget, ENOSPC, errors or repeated misses. */
  fallBackToPoll(reason: string): void {
    if (this.stats.mode === "poll") return;
    this.stats.mode = "poll";
    this.stats.degraded = true;
    this.stats.degradedReason = reason;
    this.closeAll();
    this.o.log?.warn("watcher", `watcher: ${reason}; polling only`);
    this.emit({ t: "rescan-hint" });
  }

  private async checkBudget(): Promise<void> {
    if (this.stats.mode === "poll") return;
    const b = await inotifyBudget(this.o.fs, {
      includeConfigDir: this.o.includeConfigDir?.() ?? false,
      ...(this.o.prune ? { prune: this.o.prune } : {}),
      ...(this.o.probe ? { probe: this.o.probe } : {}),
    }).catch(() => null);
    this.stats.budget = b;
    if (b && !b.ok) this.fallBackToPoll(`inotify budget exhausted (${b.dirs} directories, max_user_watches ${b.maxUserWatches})`);
  }

  private shouldPrune(rel: string): boolean {
    if (rel === "") return false;
    const cfg = this.o.fs.configDir;
    const isCfg = rel === cfg || rel.startsWith(cfg + "/");
    const segs = rel.split("/");
    if (isCfg) {
      if (!(this.o.includeConfigDir?.() ?? false)) return true;
      if (segs.slice(cfg.split("/").length).some((s) => s.startsWith("."))) return true;
    } else if (!cfg.startsWith(rel + "/") && segs.some((s) => s.startsWith("."))) return true;
    return this.o.prune?.(rel) ?? false;
  }

  /** Watch `rel` and every directory under it (pruned like the scan). */
  private async watchTree(rel: string): Promise<void> {
    const stack = [rel];
    while (stack.length > 0 && this.running && this.stats.mode !== "poll") {
      const dir = stack.pop() as string;
      if (this.watchers.has(dir) || this.shouldPrune(dir)) continue;
      const abs = dir === "" ? this.o.fs.root : await this.o.fs.resolve(dir);
      if (abs === null) continue;
      if (!this.addWatcher(dir, abs)) return;
      let names: import("node:fs").Dirent[];
      try {
        names = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of names) {
        if (!d.isDirectory()) continue;
        const child = (dir ? `${dir}/${d.name}` : d.name).normalize("NFC");
        stack.push(child);
      }
    }
  }

  private addWatcher(dir: string, abs: string): boolean {
    let w: FSWatcher;
    try {
      w = fsWatch(abs, { persistent: false }, (type, name) => {
        try {
          if (typeof name === "string" && name.length > 0) this.onRaw(dir, abs, type, name);
          else this.emit({ t: "rescan-hint" });
        } catch (err) {
          this.o.log?.error("watcher", "watcher callback failed", { err: String(err) });
        }
      });
    } catch (err) {
      this.onError(err);
      return this.stats.mode !== "poll";
    }
    w.on("error", (err) => {
      try { this.onError(err); } catch { /* never throw */ }
    });
    this.watchers.set(dir, w);
    this.diskDirs.set(dir, abs);
    void fsp.lstat(abs).then((st) => { if (this.watchers.get(dir) === w) this.dirIno.set(dir, st.ino); }, () => undefined);
    this.stats.dirs = this.watchers.size;
    return true;
  }

  private onError(err: unknown): void {
    this.stats.errors++;
    const code = (err as { code?: string } | null)?.code;
    this.o.log?.warn("watcher", "watcher error", { err: code ?? String(err) });
    if (code === "ENOSPC") {
      this.fallBackToPoll("inotify watch limit reached (ENOSPC)");
      return;
    }
    const t = this.now();
    this.errorTimes = this.errorTimes.filter((x) => t - x < ERROR_WINDOW_MS);
    this.errorTimes.push(t);
    if (this.errorTimes.length > MAX_ERRORS) {
      this.fallBackToPoll(`${this.errorTimes.length} watcher errors in 10 min`);
      return;
    }
    this.emit({ t: "rescan-hint" });
  }

  private onRaw(dir: string, absDir: string, type: string, name: string): void {
    this.stats.events++;
    const rel = (dir ? `${dir}/${name}` : name).normalize("NFC");
    this.reported.set(rel, this.now());
    const abs = path.join(absDir, name);
    void (async () => {
      // inotify's move/delete-self event of a watched directory arrives with the directory's own name;
      // the parent's watcher reports the move. Drop it when the directory is gone or is another inode.
      if (name === path.basename(absDir) && dir !== "") {
        const self = await fsp.lstat(absDir).catch(() => null);
        if (!self || self.ino !== this.dirIno.get(dir)) return;
      }
      await this.classify(rel, abs, type);
    })().catch((err: unknown) => {
      this.o.log?.error("watcher", "watcher event failed", { err: String(err) });
      this.emit({ t: "rescan-hint" });
    });
  }

  private async classify(rel: string, abs: string, type: string): Promise<void> {
    let st: import("node:fs").Stats | null = null;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      const c = (err as { code?: string }).code;
      if (c !== "ENOENT" && c !== "ENOTDIR") {
        this.emit({ t: "rescan-hint" });
        return;
      }
    }
    if (st === null) {
      // Gone: a file delete, a folder delete, or the first half of a rename (files: paired by hash, I18).
      const moved = this.movedAway.get(rel);
      if (moved !== undefined && this.now() - moved < 5000) {
        this.movedAway.delete(rel);
        return;
      }
      const wasDir = this.watchers.has(rel);
      if (wasDir) {
        const ino = this.dirIno.get(rel);
        this.unwatchTree(rel);
        if (this.isIgnored(rel)) return;
        if (ino !== undefined) {
          // Hold the folder delete: a directory with the same inode appearing elsewhere is a move.
          const timer = setTimeout(() => {
            this.goneDirs.delete(ino);
            this.emit({ t: "delete", path: rel, kind: "folder" });
          }, FOLDER_MOVE_HOLD_MS);
          timer.unref();
          this.goneDirs.set(ino, { rel, timer });
          return;
        }
        this.emit({ t: "delete", path: rel, kind: "folder" });
        return;
      }
      if (this.isIgnored(rel)) return;
      this.emit({ t: "delete", path: rel });
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (this.watchers.has(rel)) return;
      // A folder move inside the vault keeps the inode: report one folder rename (the engine moves
      // every entry under it, keeping fileIds), never a delete + create of each file.
      const gone = this.goneDirs.get(st.ino);
      let from: string | null = null;
      if (gone) {
        clearTimeout(gone.timer);
        this.goneDirs.delete(st.ino);
        from = gone.rel;
      } else {
        for (const [d, ino] of this.dirIno) if (ino === st.ino && d !== rel) { from = d; break; }
        if (from !== null) {
          this.unwatchTree(from);
          this.movedAway.set(from, this.now());
        }
      }
      if (!this.shouldPrune(rel)) await this.watchTree(rel);
      if (from !== null && !this.isIgnored(from) && !this.isIgnored(rel)) {
        this.emit({ t: "rename", from, to: rel, kind: "folder" });
        return;
      }
      // Files may have landed before the watch existed (mv of a folder into the vault).
      if (from !== null) this.emit({ t: "delete", path: from, kind: "folder" });
      if (!this.isIgnored(rel)) this.emit({ t: "rescan-hint" });
      return;
    }
    if (!st.isFile() || this.isIgnored(rel)) return;
    this.emit({ t: type === "rename" ? "create" : "modify", path: rel });
  }

  private unwatchTree(rel: string): void {
    for (const [d, w] of [...this.watchers]) {
      if (d === rel || d.startsWith(rel + "/")) {
        try { w.close(); } catch { /* ignore */ }
        this.watchers.delete(d);
        this.diskDirs.delete(d);
        this.dirIno.delete(d);
      }
    }
    this.stats.dirs = this.watchers.size;
  }

  /** Paths in pruned directories never produce events (dot dirs, configDir unless synced). */
  private isIgnored(rel: string): boolean {
    const i = rel.lastIndexOf("/");
    const parent = i < 0 ? "" : rel.slice(0, i);
    if (parent !== "" && this.shouldPrune(parent)) return true;
    const name = i < 0 ? rel : rel.slice(i + 1);
    if (name.startsWith(".") && rel !== this.o.fs.configDir) return true;
    return false;
  }

  private emit(e: LocalEvent): void {
    if (!this.deliver) return;
    if (e.t === "create" || e.t === "modify") {
      const cfg = this.o.fs.configDir;
      if (e.path === cfg || e.path.startsWith(cfg + "/")) {
        this.o.fs.emit({ t: "raw", path: e.path });
        return;
      }
    }
    this.o.fs.emit(e);
  }

  /** Passive miss detection (design §6.1.4), after a grace period for in-flight events. */
  private onScan(r: ScanReport): void {
    this.stats.lastScanAt = r.at + r.ms;
    this.stats.lastScanMs = r.ms;
    const watching = this.stats.mode !== "poll" && this.running;
    if (!watching || r.changes === null) {
      this.pruneReported(r.at);
      return;
    }
    const since = r.at - 60_000;
    const evaluate = (): void => {
      if (!this.running || this.stats.mode === "poll") return;
      let missed = 0;
      for (const p of r.changes ?? []) {
        if (this.isIgnored(p)) continue;
        if (!this.wasReported(p, since)) missed++;
      }
      this.stats.missedByWatcher += missed;
      this.stats.missStreak = missed > 0 ? this.stats.missStreak + 1 : 0;
      if (missed > 0) this.o.log?.info("watcher", "scan found changes the watcher did not report", { n: missed });
      if (this.stats.missStreak >= MISS_STREAK_LIMIT) this.fallBackToPoll(`watcher missed changes in ${MISS_STREAK_LIMIT} consecutive scans`);
      this.pruneReported(r.at);
    };
    const grace = this.o.missGraceMs ?? 1500;
    if (grace <= 0) evaluate();
    else setTimeout(evaluate, grace).unref();
  }

  /** A path counts as reported when it, or a folder above it (folder create, move, delete), had an event. */
  private wasReported(p: string, since: number): boolean {
    let cur = p;
    for (;;) {
      const t = this.reported.get(cur);
      if (t !== undefined && t >= since) return true;
      const i = cur.lastIndexOf("/");
      if (i < 0) return false;
      cur = cur.slice(0, i);
    }
  }

  private pruneReported(scanAt: number): void {
    const cutoff = scanAt - 120_000;
    for (const [p, t] of this.reported) if (t < cutoff) this.reported.delete(p);
  }
}
