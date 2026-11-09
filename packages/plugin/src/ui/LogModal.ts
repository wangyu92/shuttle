// Activity log (design §5.3), minimal: newest entries last, live updates while open, Copy, the
// "not persisted" footer and the "older entries removed" banner. Renders at most the last 500 rows
// (the full ring buffer of 2,000 is still copied); a virtualized list is later work.

import { Modal, Setting, type App } from "obsidian";
import type { Disposable, LogEntry } from "@shuttle/protocol";
import { t } from "../i18n";
import { copyLog, localTime, logMessage } from "./format";
import { copyText } from "./modals";

export const LOG_RENDER_MAX = 500;

export interface LogSource {
  entries(): LogEntry[];
  wrapped(): boolean;
  onEntry(cb: (e: LogEntry) => void): Disposable;
}

export class LogModal extends Modal {
  private sub: Disposable | null = null;
  private list: HTMLElement | null = null;
  private rows = 0;

  constructor(app: App, private readonly src: LogSource) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("shuttle-log-modal");
    this.titleEl.setText(t("log.title"));
    if (this.src.wrapped()) this.contentEl.createDiv({ cls: "shuttle-banner", text: t("log.truncated") });
    new Setting(this.contentEl).addButton((b) => b.setButtonText(t("btn.copy")).onClick(() => {
      void copyText(copyLog(this.src.entries(), Date.now()), "notice.logCopied");
    }));
    this.list = this.contentEl.createDiv({ cls: "shuttle-log-list" });
    const all = this.src.entries();
    if (all.length === 0) this.list.createDiv({ cls: "shuttle-log-empty", text: t("log.empty") });
    for (const e of all.slice(-LOG_RENDER_MAX)) this.row(e);
    this.contentEl.createDiv({ cls: "setting-item-description", text: t("log.notPersisted") });
    this.sub = this.src.onEntry((e) => {
      if (this.rows === 0) this.list?.empty();
      this.row(e);
      if (this.rows > LOG_RENDER_MAX) {
        this.list?.firstElementChild?.remove();
        this.rows--;
      }
    });
    this.scrollToEnd();
  }

  private row(e: LogEntry): void {
    if (!this.list) return;
    const r = this.list.createDiv({ cls: `shuttle-log-row shuttle-log-${e.level}` });
    r.createSpan({ cls: "shuttle-log-time", text: localTime(e.ts) });
    r.createSpan({ cls: "shuttle-log-cat", text: e.cat });
    r.createSpan({ cls: "shuttle-log-msg", text: logMessage(e) });
    if (e.path) r.createSpan({ cls: "shuttle-log-path", text: e.path });
    this.rows++;
    this.scrollToEnd();
  }

  private scrollToEnd(): void {
    if (this.list) this.list.scrollTop = this.list.scrollHeight;
  }

  override onClose(): void {
    this.sub?.dispose();
    this.sub = null;
    this.list = null;
    this.rows = 0;
    this.contentEl.empty();
  }
}
