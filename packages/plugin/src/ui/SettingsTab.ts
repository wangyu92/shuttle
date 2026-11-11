// Settings tab, minimal (design §5.4): A1 remote vault, A3 sync status, A5 device name, A6 conflict
// resolution, A9 activity log, A10 debug info, Add device, B selective sync, E9c lock, E10 reset.
// The status row updates in place on status events (never a full re-render, §5.4.2).

import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { DeviceSettings, Disposable, EngineStatus, SelectiveClass } from "@shuttle/protocol";
import { t } from "../i18n";
import type { Profile } from "../store/localStore";
import { hostLabel } from "../util/url";

export interface SettingsHost {
  profile(): Profile | null;
  running(): boolean;
  locked(): boolean;
  status(): EngineStatus | null;
  tooltip(): string;
  isOwner(): boolean;
  deviceSettings(): Partial<DeviceSettings>;
  updateSettings(patch: Partial<DeviceSettings>): Promise<void>;
  onStatus(cb: () => void): Disposable;
  openWizard(): void;
  disconnect(): void;
  pause(): void;
  resume(): void;
  syncNow(): void;
  openLog(): void;
  copyDebug(): void;
  addDevice(): void;
  lock(): void;
  unlock(): void;
  reset(): void;
}

const SELECTIVE: Array<[SelectiveClass, string, string]> = [
  ["images", "set.sel.images", "bmp, png, jpg, jpeg, gif, svg, webp, avif, heic, heif, tif, tiff, ico"],
  ["audio", "set.sel.audio", "mp3, wav, m4a, 3gp, flac, ogg, oga, opus, aac"],
  ["videos", "set.sel.videos", "mp4, webm, ogv, mov, mkv, m4v, avi"],
  ["pdfs", "set.sel.pdfs", "pdf"],
  ["other", "set.sel.other", "Any file that is not a note, image, audio, video or PDF."],
];

export class ShuttleSettingTab extends PluginSettingTab {
  private sub: Disposable | null = null;

  constructor(app: App, plugin: Plugin, private readonly host: SettingsHost) {
    super(app, plugin);
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    this.sub?.dispose();
    this.sub = null;
    const h = this.host;
    const p = h.profile();

    // A1
    const a1 = new Setting(el).setName(t("set.remote.name"));
    if (!p) {
      a1.setDesc(t("set.remote.none")).addButton((b) => b.setButtonText(t("btn.setUp")).setCta().onClick(() => h.openWizard()));
    } else {
      a1.setDesc(h.locked() ? t("set.remote.locked", { vaultName: p.vaultName }) : t("set.remote.connected", { vaultName: p.vaultName, hostLabel: hostLabel(p.endpoints[0]?.url) ?? "" }));
      if (h.locked()) a1.addButton((b) => b.setButtonText(t("btn.unlock")).setCta().onClick(() => h.unlock()));
      a1.addButton((b) => b.setButtonText(t("btn.disconnect")).onClick(() => h.disconnect()));
    }

    let a3Update: (() => void) | null = null;
    if (p) {
      // A3
      const a3 = new Setting(el).setName(t("set.status.name")).setDesc(h.tooltip());
      let pauseBtn: { setButtonText(s: string): unknown } | null = null;
      a3.addButton((b) => {
        pauseBtn = b;
        b.setButtonText(h.status()?.status === "paused" ? t("btn.resume") : t("btn.pause")).onClick(() => {
          if (h.status()?.status === "paused") h.resume(); else h.pause();
        });
      });
      a3.addButton((b) => b.setButtonText(t("btn.syncNow")).onClick(() => h.syncNow()));
      a3Update = () => {
        a3.setDesc(h.tooltip());
        pauseBtn?.setButtonText(h.status()?.status === "paused" ? t("btn.resume") : t("btn.pause"));
      };
    }
    // The structure above depends on the profile and the lock state: when either changes (setup
    // finished, Disconnect, Reset, unlock), render the tab again. Deferred, because status listeners
    // are being iterated when this runs and display() replaces this listener.
    const shown = this.shape();
    const sub = h.onStatus(() => {
      if (this.shape() === shown) { a3Update?.(); return; }
      setTimeout(() => { if (this.sub === sub) this.display(); }, 0);
    });
    this.sub = sub;

    const s = h.deviceSettings();
    // A5
    new Setting(el).setName(t("set.device.name")).setDesc(t("set.device.desc")).addText((x) => {
      x.setValue(s.deviceName ?? "");
      x.inputEl.maxLength = 40;
      x.inputEl.addEventListener("blur", () => {
        const v = x.getValue().trim();
        if (v && v !== h.deviceSettings().deviceName) void h.updateSettings({ deviceName: v });
      });
    });
    // A6
    new Setting(el).setName(t("set.conflict.name")).setDesc(t("set.conflict.desc")).addDropdown((d) => d
      .addOption("merge", t("set.conflict.merge")).addOption("conflictFile", t("set.conflict.file"))
      .setValue(s.conflictMode ?? "merge").onChange((v) => { void h.updateSettings({ conflictMode: v === "conflictFile" ? "conflictFile" : "merge" }); }));
    // A9, A10
    new Setting(el).setName(t("set.log.name")).setDesc(t("set.log.desc")).addButton((b) => b.setButtonText(t("btn.view")).onClick(() => h.openLog()));
    new Setting(el).setName(t("set.debug.name")).setDesc(t("set.debug.desc")).addButton((b) => b.setButtonText(t("btn.copyDebug")).onClick(() => h.copyDebug()));
    if (p && h.running() && h.isOwner()) {
      new Setting(el).setName(t("set.addDevice.name")).setDesc(t("set.addDevice.desc")).addButton((b) => b.setButtonText(t("btn.addDevice")).onClick(() => h.addDevice()));
    }

    // B
    new Setting(el).setHeading().setName(t("set.h.selective"));
    el.createEl("p", { cls: "setting-item-description", text: t("set.selective.desc") });
    for (const [cls, key, desc] of SELECTIVE) {
      new Setting(el).setName(t(key)).setDesc(desc).addToggle((x) => x
        .setValue(s.selective?.[cls] ?? true)
        .onChange((v) => {
          const cur = { ...{ images: true, audio: true, videos: true, pdfs: true, other: true }, ...(h.deviceSettings().selective ?? {}) };
          cur[cls] = v;
          void h.updateSettings({ selective: cur });
        }));
    }

    // E
    new Setting(el).setHeading().setName(t("set.h.advanced"));
    if (p && h.running() && !h.locked()) {
      new Setting(el).setName(t("set.lock.name")).setDesc(t("set.lock.desc")).addButton((b) => b.setButtonText(t("btn.lock")).onClick(() => h.lock()));
    }
    new Setting(el).setName(t("set.reset.name")).setDesc(t("set.reset.desc")).addButton((b) => b.setButtonText(t("btn.reset")).setWarning().onClick(() => h.reset()));
  }

  private shape(): string {
    const p = this.host.profile();
    return p ? `${p.id}|${this.host.locked() ? 1 : 0}|${this.host.running() ? 1 : 0}` : "";
  }

  override hide(): void {
    this.sub?.dispose();
    this.sub = null;
    this.containerEl.empty();
  }
}
