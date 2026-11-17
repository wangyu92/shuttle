// Progress notice for larger transfers (phones have no status bar).
import { describe, expect, it } from "vitest";
import { Notice } from "./obsidian-stub";
import type { EngineStatus } from "@shuttle/protocol";
import { PROGRESS_DELAY_MS, SyncProgress, progressText } from "../src/ui/progress";

const st = (status: EngineStatus["status"], down: number, up = 0): EngineStatus =>
  ({ status, pendingUp: up, pendingDown: down, failed: 0, locked: false, readOnly: false });

describe("progress notice", () => {
  it("text only for a backlog of 10 or more while syncing", () => {
    expect(progressText(st("syncing", 9))).toBeNull();
    expect(progressText(st("syncing", 34))).toContain("34");
    expect(progressText(st("syncing", 5, 6))).toContain("6");
    expect(progressText(st("synced", 0))).toBeNull();
    expect(progressText(null)).toBeNull();
  });

  it("appears after the delay, updates, and closes with done", () => {
    let now = 0;
    const p = new SyncProgress(() => now);
    const shown = Notice.shown.length;
    p.update(st("syncing", 40));
    expect(Notice.shown.length).toBe(shown);
    now += PROGRESS_DELAY_MS;
    p.update(st("syncing", 30));
    expect(Notice.shown.at(-1)).toContain("30");
    p.update(st("syncing", 12));
    expect(Notice.shown.at(-1)).toContain("12");
    const hidden = Notice.hidden;
    p.update(st("synced", 0));
    expect(Notice.hidden).toBe(hidden + 1);
    expect(Notice.shown.at(-1)).toContain("all files synced");
  });

  it("a short burst never shows a notice", () => {
    let now = 0;
    const p = new SyncProgress(() => now);
    const shown = Notice.shown.length;
    p.update(st("syncing", 15));
    now += 500;
    p.update(st("synced", 0));
    expect(Notice.shown.length).toBe(shown);
  });
});
