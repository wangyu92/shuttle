// inotify budget check (design §6.1.4), at startup and hourly: count the directories the watcher would
// watch (D, pruned like the scan), read max_user_watches, sum the visible `inotify wd:` lines in
// /proc/<pid>/fdinfo/* (a lower bound inside a container), and require D * 2 + 1024 <= max_user_watches.
// Raising the limit is a user decision (design §10.1), never automatic.

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { NodeLocalFs } from "../NodeLocalFs";

export interface InotifyBudget {
  ok: boolean;
  dirs: number;
  maxUserWatches: number | null;
  /** Watches visible in /proc (lower bound). */
  used: number;
  reason?: string;
}

/** Injectable /proc readers (tests use tiny budgets). */
export interface InotifyProbe {
  maxUserWatches(): Promise<number | null>;
  usedWatches(): Promise<number>;
}

export const procProbe: InotifyProbe = {
  async maxUserWatches() {
    try {
      const n = Number((await fsp.readFile("/proc/sys/fs/inotify/max_user_watches", "utf8")).trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  },
  async usedWatches() {
    let used = 0;
    let pids: string[] = [];
    try {
      pids = (await fsp.readdir("/proc")).filter((p) => /^\d+$/.test(p));
    } catch {
      return 0;
    }
    for (const pid of pids) {
      let fds: string[] = [];
      try {
        fds = await fsp.readdir(path.join("/proc", pid, "fdinfo"));
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const t = await fsp.readFile(path.join("/proc", pid, "fdinfo", fd), "utf8");
          if (!t.includes("inotify wd:")) continue;
          for (const line of t.split("\n")) if (line.startsWith("inotify wd:")) used++;
        } catch {
          /* raced with fd close */
        }
      }
    }
    return used;
  },
};

/** Directories the watcher would watch (root included). */
export async function countWatchedDirs(fs: NodeLocalFs, o: { includeConfigDir: boolean; prune?: (rel: string) => boolean }): Promise<number> {
  let n = 0;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: fs.root, rel: "" }];
  const cfg = fs.configDir;
  while (stack.length > 0) {
    const d = stack.pop() as { abs: string; rel: string };
    n++;
    let ents: import("node:fs").Dirent[];
    try {
      ents = await fsp.readdir(d.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const rel = (d.rel ? `${d.rel}/${e.name}` : e.name).normalize("NFC");
      const isCfg = rel === cfg || rel.startsWith(cfg + "/");
      if (isCfg && !o.includeConfigDir) continue;
      if (!isCfg && !cfg.startsWith(rel + "/") && rel.split("/").some((s) => s.startsWith("."))) continue;
      if (o.prune?.(rel)) continue;
      stack.push({ abs: path.join(d.abs, e.name), rel });
    }
  }
  return n;
}

export async function inotifyBudget(fs: NodeLocalFs, o: { includeConfigDir: boolean; prune?: (rel: string) => boolean; probe?: InotifyProbe }): Promise<InotifyBudget> {
  const probe = o.probe ?? procProbe;
  const dirs = await countWatchedDirs(fs, o);
  const max = await probe.maxUserWatches();
  const used = await probe.usedWatches();
  if (max === null) return { ok: true, dirs, maxUserWatches: null, used, reason: "max_user_watches unreadable (not Linux?)" };
  // design §6.1.4: D*2 + 1024 <= max. Watches already in use by visible processes count as well
  // (a lower bound in a container): adding D more must still fit.
  if (dirs * 2 + 1024 > max) return { ok: false, dirs, maxUserWatches: max, used, reason: "D*2+1024 > max_user_watches" };
  if (used + dirs + 256 > max) return { ok: false, dirs, maxUserWatches: max, used, reason: "watches in use + D > max_user_watches" };
  return { ok: true, dirs, maxUserWatches: max, used };
}
