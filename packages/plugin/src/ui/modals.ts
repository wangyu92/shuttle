// Small modals: confirm, unlock (§5.6.4), guard prompts (§5.6.5), text preview with Copy (§5.4.3).
// DOM through createEl/setText only (design §5.11).

import { Modal, Notice, Setting, type App } from "obsidian";
import { isRemoteError, type GuardChoice, type GuardEvent } from "@shuttle/protocol";
import { t } from "../i18n";

export async function copyText(text: string, okKey: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(t(okKey), 3000);
  } catch {
    new Notice(t("notice.copyFailed"), 4000);
  }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private readonly o: { title: string; body: string; confirm: string; warning?: boolean; onConfirm: () => void | Promise<void> }) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText(this.o.title);
    this.contentEl.createEl("p", { text: this.o.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("btn.cancel")).onClick(() => this.close()))
      .addButton((b) => {
        b.setButtonText(this.o.confirm).onClick(async () => {
          this.close();
          await this.o.onConfirm();
        });
        if (this.o.warning) b.setWarning(); else b.setCta();
      });
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export class TextPreviewModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly text: string, private readonly okKey: string) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText(this.title);
    const pre = this.contentEl.createEl("pre", { cls: "shuttle-preview" });
    pre.setText(this.text);
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("btn.close")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t("btn.copy")).setCta().onClick(() => { void copyText(this.text, this.okKey); }));
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

export class UnlockModal extends Modal {
  constructor(app: App, private readonly vaultName: string, private readonly unlock: (pass: string) => Promise<void>) {
    super(app);
  }
  override onOpen(): void {
    this.titleEl.setText(t("unlock.title", { vaultName: this.vaultName }));
    this.contentEl.createEl("p", { text: t("unlock.bodyMissing") });
    let pass = "";
    const msg = this.contentEl.createDiv({ cls: "shuttle-msg" });
    new Setting(this.contentEl).setName(t("wiz.unlock.pw")).addText((x) => {
      x.inputEl.type = "password";
      x.inputEl.autocomplete = "current-password";
      x.onChange((v) => { pass = v; });
      window.setTimeout(() => x.inputEl.focus(), 0);
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("btn.later")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t("btn.unlock")).setCta().onClick(async () => {
        if (!pass) return;
        b.setDisabled(true);
        msg.setText(t("wiz.unlock.deriving"));
        msg.removeClass("shuttle-error");
        try {
          await this.unlock(pass);
          pass = "";
          this.close();
        } catch (e) {
          msg.setText(isWrongPass(e) ? t("err.pwWrong") : isRemoteError(e) ? t("reason.unreachable") : t("err.keyCheck"));
          msg.addClass("shuttle-error");
        } finally {
          b.setDisabled(false);
        }
      }));
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

function isWrongPass(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "WrongPassphrase";
}

interface GuardText { title: string; body: string; buttons: Array<[string, GuardChoice | null, boolean]> }

/** design §5.6.5 per guard kind. `null` choice = close without answering. */
export function guardText(g: GuardEvent): GuardText {
  const n = g.n;
  const keep: [string, GuardChoice, boolean] = [t("btn.keepPaused"), "pause", false];
  switch (g.kind) {
    case "massDeleteRemote":
      return { title: t("guard.delIn.title", { n }), body: t("guard.delIn.body", { n }), buttons: [keep, [t("btn.applyDeletions"), "apply", true]] };
    case "massDeleteLocal":
      return { title: t("guard.delOut.title", { n }), body: t("guard.delOut.body", { n }), buttons: [keep, [t("btn.applyDeletions"), "apply", true]] };
    case "emptyVault":
      return { title: t("guard.empty.title"), body: t("guard.empty.body"), buttons: [keep, [t("btn.rescan"), "apply", false]] };
    case "massConflict":
      return { title: t("guard.conflict.title", { n }), body: t("guard.conflict.body", { n }), buttons: [keep, [t("btn.continue"), "apply", true]] };
    case "rollback":
      return { title: t("guard.rollback.title"), body: t("guard.rollback.body"), buttons: [keep, [t("btn.acceptRestore"), "accept", true]] };
    case "tampered":
      return { title: t("guard.tampered.title"), body: t("guard.tampered.body"), buttons: [[t("btn.close"), null, false]] };
    case "integrity":
      return { title: t("guard.integrity.title", { n }), body: t("guard.integrity.body"), buttons: [[t("btn.close"), null, false]] };
    default:
      return { title: t("guard.epoch.title"), body: t("guard.epoch.body"), buttons: [[t("btn.ok"), null, false]] };
  }
}

export class GuardModal extends Modal {
  constructor(app: App, private readonly g: GuardEvent, private readonly answer: (choice: GuardChoice) => void) {
    super(app);
  }
  override onOpen(): void {
    const gt = guardText(this.g);
    this.titleEl.setText(gt.title);
    this.contentEl.createEl("p", { text: gt.body });
    if (this.g.sample.length) {
      const ul = this.contentEl.createEl("ul", { cls: "shuttle-guard-sample" });
      for (const p of this.g.sample.slice(0, 50)) ul.createEl("li", { text: p });
      if (this.g.n > this.g.sample.length) this.contentEl.createEl("p", { text: t("guard.more", { k: this.g.n - Math.min(50, this.g.sample.length) }), cls: "setting-item-description" });
    }
    const row = new Setting(this.contentEl);
    for (const [label, choice, warn] of gt.buttons) {
      row.addButton((b) => {
        b.setButtonText(label).onClick(() => {
          this.close();
          if (choice) this.answer(choice);
        });
        if (warn) b.setWarning();
      });
    }
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
