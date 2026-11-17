// Progress notice for larger transfers: phones show no status bar and a ribbon tooltip cannot be
// hovered, so while at least PROGRESS_MIN files are waiting a sticky notice shows how many are left.
// It appears only after the backlog has lasted PROGRESS_DELAY_MS (no flicker for a few notes) and
// closes with a short "done" once nothing is pending.

import { Notice } from "obsidian";
import type { EngineStatus } from "@shuttle/protocol";
import { t } from "../i18n";

export const PROGRESS_MIN = 10;
export const PROGRESS_DELAY_MS = 1500;

/** Text for the notice, or null when no notice should be shown. Pure. */
export function progressText(s: EngineStatus | null): string | null {
  if (!s || s.status !== "syncing") return null;
  const total = s.pendingUp + s.pendingDown;
  if (total < PROGRESS_MIN) return null;
  if (s.pendingUp === 0) return t("progress.down", { down: s.pendingDown });
  if (s.pendingDown === 0) return t("progress.up", { up: s.pendingUp });
  return t("progress.both", { down: s.pendingDown, up: s.pendingUp });
}

export class SyncProgress {
  private notice: Notice | null = null;
  private since: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  update(s: EngineStatus | null): void {
    const text = progressText(s);
    if (text === null) {
      this.since = null;
      if (this.notice) {
        this.notice.hide();
        this.notice = null;
        if (s?.status === "synced") new Notice(t("progress.done"), 3000);
      }
      return;
    }
    this.since ??= this.now();
    if (!this.notice && this.now() - this.since < PROGRESS_DELAY_MS) return;
    if (!this.notice) this.notice = new Notice(text, 0);
    else this.notice.setMessage(text);
  }

  dispose(): void {
    this.notice?.hide();
    this.notice = null;
  }
}
