// Modals and the settings tab.
import { type App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ShuttleSpikePlugin from "./index.js";

export function confirmModal(app: App, title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = new Modal(app);
    m.titleEl.setText(title);
    for (const line of body.split("\n")) m.contentEl.createEl("p", { text: line });
    new Setting(m.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => m.close()))
      .addButton((b) =>
        b.setButtonText("Run").setWarning().onClick(() => {
          done = true;
          resolve(true);
          m.close();
        }),
      );
    m.onClose = () => {
      if (!done) resolve(false);
    };
    m.open();
  });
}

/** Resolves true only when the user types `expected` exactly and presses Run. */
export function typeToConfirmModal(app: App, title: string, body: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let typed = "";
    const m = new Modal(app);
    m.titleEl.setText(title);
    for (const line of body.split("\n")) m.contentEl.createEl("p", { text: line });
    new Setting(m.contentEl).setName(`Type the vault name "${expected}" to run anyway`).addText((t) => t.onChange((v) => (typed = v)));
    new Setting(m.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => m.close()))
      .addButton((b) =>
        b.setButtonText("Run").setWarning().onClick(() => {
          if (typed !== expected) {
            new Notice("Shuttle spike: the vault name does not match");
            return;
          }
          done = true;
          resolve(true);
          m.close();
        }),
      );
    m.onClose = () => {
      if (!done) resolve(false);
    };
    m.open();
  });
}

export function askModal(app: App, question: string, options: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const m = new Modal(app);
    m.titleEl.setText("Shuttle spike");
    m.contentEl.createEl("p", { text: question });
    const s = new Setting(m.contentEl);
    for (const o of options) {
      s.addButton((b) =>
        b.setButtonText(o).onClick(() => {
          answer = o;
          m.close();
        }),
      );
    }
    m.onClose = () => resolve(answer);
    m.open();
  });
}

export function textModal(app: App, title: string, text: string): void {
  const m = new Modal(app);
  m.titleEl.setText(title);
  const ta = m.contentEl.createEl("textarea", { cls: "shuttle-spike-textarea" });
  ta.value = text;
  ta.readOnly = true;
  m.open();
  ta.select();
}

export async function copyText(app: App, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice("Shuttle spike: results copied");
  } catch {
    textModal(app, "Copy the results (clipboard blocked)", text);
  }
}

export class SpikeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ShuttleSpikePlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      cls: "shuttle-spike-warning",
      text: "Throwaway test plugin. Install only in a scratch test vault, never in a real vault.",
    });
    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Used by M4 to M8. Probes are skipped when GET /v1/health does not answer within 3 s.")
      .addText((t) =>
        t.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
          this.plugin.settings.serverUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Device name")
      .setDesc(`Used in the results file name. Empty = platform default (${this.plugin.defaultDeviceName()}).`)
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (v) => {
          this.plugin.settings.deviceName = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("M7 idle hold (minutes)")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.m7IdleMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.m7IdleMinutes = n;
            await this.plugin.saveSettings();
          }
        }),
      );
    new Setting(containerEl)
      .setName("Post results to the server")
      .setDesc("Best effort POST /v1/dev/spike after each write (the P0 stub does not have this route yet).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.postResults).onChange(async (v) => {
          this.plugin.settings.postResults = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Results")
      .setDesc(`${this.plugin.results.size} probe results this session. Note: ${this.plugin.resultPath()}`)
      .addButton((b) => b.setButtonText("Copy results").setCta().onClick(() => void this.plugin.copyResults()))
      .addButton((b) => b.setButtonText("Run all safe probes").onClick(() => void this.plugin.runAllSafe()));
  }
}
