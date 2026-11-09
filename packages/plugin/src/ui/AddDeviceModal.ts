// Add another device (design §5.5.9): a one-time enrollment code (POST /v1/enroll-codes, 15 min) shown
// as text and link with Copy buttons and a countdown; the device list is polled every 3 s and the
// modal closes 2 s after a new device joins. The QR code of the design needs a bundled QR encoder,
// which the dev plugin does not have yet (open issue). Second part: "Add server mirror" seals the key
// bundle to a headless pairing link (design §4.12.2).

import { Modal, Notice, Setting, type App } from "obsidian";
import { isRemoteError, type AdapterDevice, type RemoteAdapter } from "@shuttle/protocol";
import type { CachedSecrets } from "@shuttle/crypto";
import { DEVICE_POLL_MS, ENROLL_CODE_TTL_SEC } from "../constants";
import { t } from "../i18n";
import { parsePairLink, payloadOf, sealPairingEnvelope } from "../session/pairing";
import { ConfirmModal, copyText } from "./modals";

export interface AddDeviceHost {
  adapter: Pick<RemoteAdapter, "createEnrollCode" | "listDevices" | "getVaultInfo" | "pairingPut">;
  vaultName: string;
  keys(): CachedSecrets | null;
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class AddDeviceModal extends Modal {
  private timers: number[] = [];
  private known: Set<string> | null = null;
  private closed = false;

  constructor(app: App, private readonly host: AddDeviceHost, private readonly mirrorLink: string | null = null) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t("dev.add.title"));
    const codeBox = this.contentEl.createDiv({ cls: "shuttle-enroll" });
    if (this.mirrorLink === null) void this.newCode(codeBox);
    new Setting(this.contentEl).setHeading().setName(t("btn.addMirror"));
    let link = this.mirrorLink ?? "";
    new Setting(this.contentEl).setName(t("dev.mirror.link")).addText((x) => x.setValue(link).onChange((v) => { link = v; }))
      .addButton((b) => b.setButtonText(t("btn.giveKey")).onClick(() => this.giveKey(link)));
  }

  private async newCode(box: HTMLElement): Promise<void> {
    box.empty();
    box.createEl("p", { text: "…" });
    if (!this.host.adapter.createEnrollCode) return;
    let r: { code: string; expiresAt: number; link: string };
    try {
      r = await this.host.adapter.createEnrollCode(ENROLL_CODE_TTL_SEC);
    } catch (e) {
      box.empty();
      box.createEl("p", { cls: "shuttle-error", text: isRemoteError(e) && e.code === "FORBIDDEN" ? t("err.notOwner") : t("err.unknown", { code: isRemoteError(e) ? e.code : "?" }) });
      return;
    }
    if (this.closed) return;
    box.empty();
    box.createEl("p", { text: t("dev.add.steps") });
    box.createDiv({ cls: "shuttle-code", text: r.code });
    const exp = box.createDiv({ cls: "setting-item-description" });
    new Setting(box)
      .addButton((b) => b.setButtonText(t("btn.copyLink")).onClick(() => { void copyText(r.link, "notice.copied"); }))
      .addButton((b) => b.setButtonText(t("btn.copyCode")).onClick(() => { void copyText(r.code, "notice.copied"); }));
    const tick = (): void => {
      const left = r.expiresAt - Date.now();
      if (left <= 0) {
        exp.setText(t("dev.add.expired"));
        this.clearTimers();
        new Setting(box).addButton((b) => b.setButtonText(t("btn.newCode")).setCta().onClick(() => { void this.newCode(box); }));
        return;
      }
      exp.setText(t("dev.add.expires", { mmss: mmss(left) }));
    };
    tick();
    this.clearTimers();
    this.timers.push(window.setInterval(tick, 1000));
    if (this.host.adapter.listDevices) {
      this.known = new Set((await this.host.adapter.listDevices().catch(() => [] as AdapterDevice[])).map((d) => d.deviceId));
      this.timers.push(window.setInterval(() => { void this.poll(); }, DEVICE_POLL_MS));
    }
  }

  private async poll(): Promise<void> {
    if (!this.known || !this.host.adapter.listDevices) return;
    const list = await this.host.adapter.listDevices().catch(() => null);
    if (!list || this.closed) return;
    const fresh = list.find((d) => !this.known?.has(d.deviceId) && !d.revoked);
    if (!fresh) return;
    this.known.add(fresh.deviceId);
    new Notice(t("dev.add.joined", { name: fresh.name }), 4000);
    this.clearTimers();
    this.timers.push(window.setTimeout(() => this.close(), 2000));
  }

  private giveKey(raw: string): void {
    let link;
    try {
      link = parsePairLink(raw);
    } catch {
      new Notice(t("err.unknown", { code: "pairing link" }), 5000);
      return;
    }
    const keys = this.host.keys();
    if (!keys || keys.vaultId !== link.vaultId) {
      new Notice(t("err.keyCheck"), 6000);
      return;
    }
    new ConfirmModal(this.app, {
      title: t("btn.addMirror"), body: t("dev.mirror.confirm", { vaultName: this.host.vaultName }), confirm: t("btn.giveKey"), warning: true,
      onConfirm: async () => {
        try {
          const got = await this.host.adapter.getVaultInfo();
          if (!got) throw new Error("no vault-info");
          const env = await sealPairingEnvelope(link, payloadOf(keys, got.info.infoRev));
          if (!this.host.adapter.pairingPut) throw new Error("pairing is not supported by this remote");
          await this.host.adapter.pairingPut(link.pairId, env);
          new Notice(t("dev.mirror.done"), 6000);
        } catch (e) {
          new Notice(t("err.unknown", { code: isRemoteError(e) ? e.code : e instanceof Error ? e.message : "?" }), 8000);
        }
      },
    }).open();
  }

  private clearTimers(): void {
    for (const h of this.timers) { window.clearInterval(h); window.clearTimeout(h); }
    this.timers = [];
  }

  override onClose(): void {
    this.closed = true;
    this.clearTimers();
    this.contentEl.empty();
  }
}
