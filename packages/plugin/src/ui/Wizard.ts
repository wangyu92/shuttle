// Onboarding wizard, server only (design §5.5): step 2a server connection (§5.5.3), step 3 choose or
// create the remote vault (§5.5.5), step 4 unlock (§5.5.6), then a short "Ready to sync" (§5.5.8)
// with Start syncing / Not now. Step 1 (remote type) is skipped: S3 is not wired into the plugin yet.
// Nothing is saved until the last step; Esc at any step cancels (a vault created on the way stays on
// the server, as §5.5.1 says).

import { Modal, Notice, Setting, type App } from "obsidian";
import type { AuthResponse, VaultSummary } from "@shuttle/protocol";
import { t } from "../i18n";
import { defaultEndpointLabel, hostLabel, normalizeServerUrl } from "../util/url";
import { normalizeEnrollCode, parseSetupInput, type EnrollLink } from "../util/enrollCode";
import {
  SetupError, classify, createRemoteVault, listVaults, probeEndpoints, signIn, unlockVault,
  type Connection, type SetupEnv, type SetupResult,
} from "../session/serverSetup";
import type { DeviceStore, Profile } from "../store/localStore";
import { commitSetup } from "../session/commit";

export interface WizardHost {
  env: SetupEnv;
  store: DeviceStore;
  /** Local vault name (default remote vault name, §5.5.5). */
  localVaultName: string;
  deviceName(): string;
  setDeviceName(name: string): Promise<void>;
  /** Start the engine on the new profile. */
  onDone(profile: Profile, startPaused: boolean): Promise<void>;
}

/** A form problem: shown as its own message, not as a setup failure. */
class InputError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = "InputError";
  }
}

type Step = "server" | "vault" | "unlock" | "ready";
const STEP_NO: Record<Step, number> = { server: 1, vault: 2, unlock: 3, ready: 4 };

interface Form {
  url: string; url2: string; allowHttp: boolean; method: "code" | "password"; code: string; user: string; pass: string; device: string;
}

export class ServerWizard extends Modal {
  private step: Step = "server";
  private busy = false;
  private f: Form;
  private conn: Connection | null = null;
  private endpoints: Array<{ url: string; label: string }> = [];
  private auth: (AuthResponse & { url: string }) | null = null;
  private vaults: VaultSummary[] | null = null;
  private chosen: VaultSummary | null = null;
  private result: SetupResult | null = null;
  private checklist: Array<{ ok: boolean | null; text: string }> = [];
  private error: string | null = null;

  constructor(app: App, private readonly host: WizardHost, prefill: EnrollLink | null = null) {
    super(app);
    this.f = {
      url: prefill?.server ?? "", url2: "", allowHttp: false, method: prefill?.code || !prefill ? "code" : "password",
      code: prefill?.code ?? "", user: "", pass: "", device: host.deviceName(),
    };
  }

  override onOpen(): void {
    this.modalEl.addClass("shuttle-wizard");
    this.render();
  }

  override onClose(): void {
    this.f.pass = "";
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    this.titleEl.setText(this.title());
    el.createDiv({ cls: "shuttle-step", text: t("wiz.step", { n: STEP_NO[this.step], total: 4 }) });
    if (this.step === "server") this.renderServer(el);
    else if (this.step === "vault") this.renderVault(el);
    else if (this.step === "unlock") this.renderUnlock(el);
    else this.renderReady(el);
    if (this.checklist.length) {
      const ul = el.createEl("ul", { cls: "shuttle-checklist" });
      for (const c of this.checklist) ul.createEl("li", { text: `${c.ok === null ? "…" : c.ok ? "✓" : "✗"} ${c.text}`, cls: c.ok === false ? "shuttle-error" : "" });
    }
    if (this.error) el.createDiv({ cls: "shuttle-msg shuttle-error", text: this.error });
  }

  private title(): string {
    switch (this.step) {
      case "server": return t("wiz.server.title");
      case "vault": return t("wiz.vault.title");
      case "unlock": return t("wiz.unlock.title", { vaultName: this.chosen?.name ?? "" });
      default: return t("wiz.ready.title");
    }
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.render();
    try {
      await fn();
    } catch (e) {
      if (e instanceof InputError) {
        this.error = t(e.key);
        return;
      }
      const se = e instanceof SetupError ? e : classify(e, "other");
      this.error = t(se.key, { url: this.f.url, host: hostLabel(this.conn?.urls[0]) ?? "", version: "?", status: "", s: 30, code: se.message, ...se.params });
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // ---------- step 2a (§5.5.3) ----------
  private renderServer(el: HTMLElement): void {
    el.createEl("p", { cls: "setting-item-description", text: t("wiz.privacy") });
    new Setting(el).setName(t("wiz.type.haveLink")).addText((x) => {
      x.setPlaceholder("obsidian://shuttle-enroll?… / SXE-…").onChange((v) => {
        const p = parseSetupInput(v);
        if (!p) return;
        if (p.server) this.f.url = p.server;
        if (p.code) { this.f.code = p.code; this.f.method = "code"; }
        this.render();
      });
    });
    new Setting(el).setName(t("wiz.server.url")).addText((x) => {
      x.setPlaceholder("https://sync.example.com").setValue(this.f.url).onChange((v) => { this.f.url = v; });
      x.inputEl.inputMode = "url";
      x.inputEl.autocapitalize = "off";
    });
    new Setting(el).setName(t("wiz.server.url2")).setDesc(t("wiz.server.moreHelp")).addText((x) => {
      x.setValue(this.f.url2).onChange((v) => { this.f.url2 = v; });
      x.inputEl.inputMode = "url";
      x.inputEl.autocapitalize = "off";
    });
    new Setting(el).setName(t("wiz.server.allowHttp")).addToggle((x) => x.setValue(this.f.allowHttp).onChange((v) => { this.f.allowHttp = v; }));
    new Setting(el).setName(t("wiz.server.method")).addDropdown((d) => d
      .addOption("code", t("wiz.server.code")).addOption("password", t("wiz.server.password"))
      .setValue(this.f.method).onChange((v) => { this.f.method = v === "password" ? "password" : "code"; this.render(); }));
    if (this.f.method === "code") {
      new Setting(el).setName(t("wiz.server.codeField")).addText((x) => {
        x.setPlaceholder("SXE-XXXX-XXXX-XXXX-XXXX-XXXX").setValue(this.f.code).onChange((v) => { this.f.code = v; });
        x.inputEl.autocapitalize = "characters";
      });
    } else {
      new Setting(el).setName(t("wiz.server.user")).addText((x) => {
        x.setValue(this.f.user).onChange((v) => { this.f.user = v; });
        x.inputEl.autocapitalize = "off";
      });
      new Setting(el).setName(t("wiz.server.pass")).addText((x) => {
        x.inputEl.type = "password";
        x.setValue(this.f.pass).onChange((v) => { this.f.pass = v; });
      });
    }
    new Setting(el).setName(t("wiz.deviceName")).addText((x) => x.setValue(this.f.device).onChange((v) => { this.f.device = v; }));
    this.footer(el, null, t("btn.connect"), () => this.connect());
  }

  private async connect(): Promise<void> {
    await this.run(async () => {
      const urls: Array<{ url: string; label: string; insecure: boolean }> = [];
      for (const raw of [this.f.url, this.f.url2]) {
        if (!raw.trim() && urls.length > 0) continue;
        const u = normalizeServerUrl(raw, { allowHttp: this.f.allowHttp });
        if (!u.ok) throw new InputError(u.error === "httpNotAllowed" ? "err.httpNotAllowed" : "err.urlInvalid");
        if (!urls.some((x) => x.url === u.url)) urls.push({ url: u.url, label: defaultEndpointLabel(u.url), insecure: u.insecure });
      }
      if (!this.f.device.trim()) throw new InputError("err.required");
      let method: { code: string } | { username: string; password: string };
      if (this.f.method === "code") {
        const c = normalizeEnrollCode(this.f.code);
        if (!c) throw new InputError("err.codeFormat");
        method = { code: c };
      } else {
        if (!this.f.user.trim() || !this.f.pass) throw new InputError("err.required");
        method = { username: this.f.user.trim(), password: this.f.pass };
      }
      this.checklist = urls.map((u) => ({ ok: null, text: t("wiz.check.reach", { url: u.url }) }));
      this.render();
      const reach = await probeEndpoints(this.host.env, urls.map((u) => u.url));
      this.checklist = reach.map((r, i) => {
        const label = urls[i]?.label ?? "";
        if (r.ok) return { ok: true, text: t("wiz.check.reached", { label, ms: r.ms, version: r.version }) };
        return { ok: false, text: t(`err.${r.error}`, { url: r.url, host: hostLabel(r.url) ?? "", ...r.params }) };
      });
      if (urls.some((u) => u.insecure)) this.checklist.push({ ok: null, text: t("wiz.server.insecure") });
      if (!reach.some((r) => r.ok)) {
        this.render();
        const first = reach[0];
        throw new SetupError(first && !first.ok ? first.error : "unreachable", first && !first.ok ? first.params : {});
      }
      for (let i = 0; i < reach.length; i++) if (!reach[i]?.ok) this.checklist.push({ ok: null, text: t("wiz.server.partial", { label: urls[i]?.label ?? "" }) });
      this.checklist.push({ ok: null, text: t("wiz.check.auth") });
      this.render();
      const conn: Connection = { urls: urls.map((u) => u.url), allowHttp: this.f.allowHttp };
      const auth = await signIn(this.host.env, conn, method, this.f.device.trim());
      this.f.pass = "";
      this.checklist[this.checklist.length - 1] = { ok: true, text: t("wiz.check.signedIn") };
      await this.host.setDeviceName(this.f.device.trim());
      this.conn = conn;
      this.endpoints = urls.map((u) => ({ url: u.url, label: u.label }));
      this.auth = auth;
      this.vaults = null;
      this.step = "vault";
      this.checklist = [];
      void this.loadVaults();
    });
  }

  // ---------- step 3 (§5.5.5) ----------
  private async loadVaults(): Promise<void> {
    await this.run(async () => {
      if (!this.conn || !this.auth) return;
      this.vaults = await listVaults(this.host.env, this.conn, this.auth.token);
    });
  }

  private renderVault(el: HTMLElement): void {
    if (this.vaults === null) {
      el.createEl("p", { text: "…" });
    } else if (this.vaults.length === 0) {
      el.createEl("p", { text: t("wiz.vault.none") });
    } else {
      for (const v of this.vaults) {
        new Setting(el).setName(v.name).setDesc(t("wiz.vault.meta", { date: new Date(v.createdAt).toLocaleDateString(), size: humanSize(v.usage.liveBytes) }))
          .addButton((b) => b.setButtonText(t("btn.connect")).setDisabled(this.busy).onClick(() => {
            this.chosen = v;
            this.step = "unlock";
            this.error = null;
            this.render();
          }));
      }
    }
    new Setting(el).setHeading().setName(t("btn.createVault"));
    el.createEl("p", { cls: "setting-item-description", text: t("wiz.vault.pwHelp") });
    let name = this.host.localVaultName;
    let pw = "";
    let pw2 = "";
    let ack = false;
    new Setting(el).setName(t("wiz.vault.name")).addText((x) => x.setValue(name).onChange((v) => { name = v; }));
    new Setting(el).setName(t("wiz.vault.pw")).addText((x) => { x.inputEl.type = "password"; x.inputEl.autocomplete = "new-password"; x.onChange((v) => { pw = v; }); });
    new Setting(el).setName(t("wiz.vault.pw2")).addText((x) => { x.inputEl.type = "password"; x.inputEl.autocomplete = "new-password"; x.onChange((v) => { pw2 = v; }); });
    new Setting(el).setName(t("wiz.vault.ack")).addToggle((x) => x.onChange((v) => { ack = v; }));
    this.footer(el, () => { this.step = "server"; this.render(); }, t("btn.create"), () => this.run(async () => {
      if (!this.conn || !this.auth) return;
      if (!name.trim()) throw new InputError("err.required");
      if (pw !== pw2) throw new InputError("err.pwMismatch");
      if ([...pw.normalize("NFKC")].length < 10) throw new SetupError("pwShort");
      if (!ack) throw new InputError("err.ackRequired");
      this.checklist = [{ ok: null, text: t("wiz.vault.creating") }];
      this.render();
      const made = await createRemoteVault(this.host.env, this.conn, this.auth.token, name.trim(), pw);
      pw = pw2 = "";
      this.checklist = [];
      this.result = this.resultOf(made.vaultId, name.trim(), made.cache, made.info);
      this.step = "ready";
    }));
  }

  // ---------- step 4 (§5.5.6) ----------
  private renderUnlock(el: HTMLElement): void {
    let pass = "";
    new Setting(el).setName(t("wiz.unlock.pw")).addText((x) => {
      x.inputEl.type = "password";
      x.inputEl.autocomplete = "current-password";
      x.onChange((v) => { pass = v; });
      window.setTimeout(() => x.inputEl.focus(), 0);
    });
    this.footer(el, () => { this.step = "vault"; this.error = null; this.render(); }, t("btn.unlock"), () => this.run(async () => {
      if (!this.conn || !this.auth || !this.chosen || !pass) return;
      this.checklist = [{ ok: null, text: t("wiz.unlock.deriving") }];
      this.render();
      try {
        const seen = this.host.store.seenStore(this.chosen.vaultId).load();
        const u = await unlockVault(this.host.env, this.conn, this.auth.token, this.chosen.vaultId, pass, seen);
        this.result = this.resultOf(this.chosen.vaultId, this.chosen.name, u.cache, u.info);
        this.step = "ready";
      } finally {
        pass = "";
        this.checklist = [];
      }
    }));
  }

  // ---------- §5.5.8 (minimal) ----------
  private renderReady(el: HTMLElement): void {
    const r = this.result;
    if (!r) return;
    el.createEl("p", { text: t("wiz.ready.summary", { vaultName: r.vaultName, hostLabel: hostLabel(r.endpoints[0]?.url) ?? "", deviceName: this.host.deviceName() }) });
    const s = new Setting(el);
    s.addButton((b) => b.setButtonText(t("btn.notNow")).setDisabled(this.busy).onClick(() => this.finish(true)));
    s.addButton((b) => b.setButtonText(t("btn.startSyncing")).setCta().setDisabled(this.busy).onClick(() => this.finish(false)));
  }

  private async finish(paused: boolean): Promise<void> {
    await this.run(async () => {
      if (!this.result) return;
      const profile = await commitSetup(this.host.store, this.result, Date.now());
      this.result = null;
      this.close();
      await this.host.onDone(profile, paused);
      if (!paused) new Notice(t("notice.syncStarted"), 5000);
    });
  }

  private resultOf(vaultId: string, vaultName: string, cache: SetupResult["cache"], info: SetupResult["info"]): SetupResult {
    const a = this.auth as AuthResponse & { url: string };
    return {
      vaultId, vaultName, endpoints: this.endpoints, allowHttp: this.conn?.allowHttp ?? false, cache, info,
      auth: { token: a.token, deviceId: a.deviceId, username: a.user.username, owner: a.user.role === "owner" },
    };
  }

  private footer(el: HTMLElement, back: (() => void) | null, primary: string, onPrimary: () => void | Promise<void>): void {
    const s = new Setting(el);
    s.addButton((b) => b.setButtonText(t("btn.cancel")).setDisabled(this.busy).onClick(() => this.close()));
    if (back) s.addButton((b) => b.setButtonText(t("btn.back")).setDisabled(this.busy).onClick(back));
    s.addButton((b) => b.setButtonText(primary).setCta().setDisabled(this.busy).onClick(() => { void onPrimary(); }));
  }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
