// SHUTTLE Obsidian plugin entry (design §5). Development build: server remote only.
//
// Load order (design §5.10, §5.11): onload registers the status icon, commands, settings tab and
// protocol handlers and does no file or network I/O; everything else (data.json check, LocalFs
// events, the state DB, the engine) starts in workspace.onLayoutReady. onunload stops the engine without waiting for it,
// because a force-quit on mobile never runs onunload anyway (P0 M21).

import { Menu, Notice, Platform, Plugin, requestUrl, type ObsidianProtocolData } from "obsidian";
import type { DeviceSettings, EngineStatus, GuardEvent, LogEntry } from "@shuttle/protocol";
import { DATA_JSON, PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { t } from "./i18n";
import { requestUrlHttpClient, type RequestUrlFn } from "./platform/http";
import { browserWsFactory, type WebSocketCtor } from "./platform/ws";
import { PluginScheduler, pluginClock } from "./platform/timers";
import { ObsidianLocalFs, type FileManagerLike, type VaultLike } from "./platform/ObsidianLocalFs";
import { registerVisibilityHooks } from "./platform/visibility";
import { IdbStateStore, idbName } from "./state/IdbStateStore";
import { DeviceStore, LS, MemKv, type KvStore, type Profile } from "./store/localStore";
import { Session } from "./session/Session";
import type { SetupEnv } from "./session/serverSetup";
import { caseInsensitive, defaultDeviceName, localPlatform, osOf, platformName, type PlatformInfo } from "./util/platformInfo";
import { assertNoSecrets } from "./util/redact";
import { fromParams } from "./util/enrollCode";
import { StatusIcon } from "./ui/StatusIcon";
import { uiView, type UiView } from "./ui/status";
import { LogModal } from "./ui/LogModal";
import { ConfirmModal, GuardModal, TextPreviewModal, UnlockModal } from "./ui/modals";
import { ServerWizard } from "./ui/Wizard";
import { AddDeviceModal } from "./ui/AddDeviceModal";
import { ShuttleSettingTab } from "./ui/SettingsTab";
import { ErrorNoticeGate, firstSyncDone } from "./ui/notices";
import { debugText } from "./ui/format";
import { reasonText } from "./ui/status";

export const PACKAGE_NAME = "shuttle";

export default class ShuttlePlugin extends Plugin {
  store!: DeviceStore;
  session: Session | null = null;
  private scheduler = new PluginScheduler();
  private fs: ObsidianLocalFs | null = null;
  private icon: StatusIcon | null = null;
  private platform!: PlatformInfo;
  private errorGate = new ErrorNoticeGate();
  private openGuards = new Set<string>();
  private statusListeners = new Set<() => void>();
  private layoutReady = false;
  private unloaded = false;

  override async onload(): Promise<void> {
    this.platform = {
      isIos: Platform.isIosApp, isAndroid: Platform.isAndroidApp, isMobile: Platform.isMobile, isTablet: Platform.isTablet,
      isMacOS: Platform.isMacOS, isWin: Platform.isWin, isLinux: Platform.isLinux,
    };
    this.store = new DeviceStore(this.kvStore());

    // Status icon (UX-D4): status bar on desktop, ribbon on mobile.
    if (Platform.isMobile) {
      const el = this.addRibbonIcon("cloud-off", t("app.name"), (ev) => this.showMenu(ev));
      this.icon = new StatusIcon(el);
    } else {
      const el = this.addStatusBarItem();
      el.addClass("mod-clickable");
      this.registerDomEvent(el, "click", (ev) => this.showMenu(ev));
      this.icon = new StatusIcon(el);
    }
    this.refreshIcon();

    this.addSettingTab(new ShuttleSettingTab(this.app, this, {
      profile: () => this.store.activeProfile(),
      running: () => !!this.session?.running,
      locked: () => this.isLocked(),
      status: () => this.session?.status() ?? null,
      tooltip: () => this.view().tooltip,
      isOwner: () => { const p = this.store.activeProfile(); return !!p && this.store.auth(p.id)?.owner !== false; },
      deviceSettings: () => this.deviceSettings(),
      updateSettings: (patch) => this.updateSettings(patch),
      onStatus: (cb) => { this.statusListeners.add(cb); return { dispose: () => { this.statusListeners.delete(cb); } }; },
      openWizard: () => this.openWizard(),
      disconnect: () => this.confirmDisconnect(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      syncNow: () => this.session?.kick("user"),
      openLog: () => this.openLog(),
      copyDebug: () => this.copyDebug(),
      addDevice: () => this.addDevice(null),
      lock: () => { void this.session?.lock(); },
      unlock: () => this.openUnlock(),
      reset: () => this.confirmReset(),
    }));
    this.registerCommands();

    this.registerObsidianProtocolHandler("shuttle-enroll", (p: ObsidianProtocolData) => {
      this.openWizard(fromParams(p as unknown as Record<string, string>));
    });
    this.registerObsidianProtocolHandler("shuttle-pair", (p: ObsidianProtocolData) => {
      const q = new URLSearchParams(Object.entries(p).filter(([k]) => k !== "action") as Array<[string, string]>);
      this.addDevice(`obsidian://shuttle-pair?${q.toString()}`);
    });

    this.app.workspace.onLayoutReady(() => { void this.afterLayout(); });
  }

  override onunload(): void {
    this.unloaded = true;
    this.icon?.dispose();
    const s = this.session;
    this.session = null;
    const sched = this.scheduler;
    void (s ? s.stop() : Promise.resolve()).catch(() => undefined).finally(() => sched.dispose());
    this.fs?.dispose();
  }

  // ---------------- startup ----------------

  private kvStore(): KvStore {
    const app = this.app as unknown as { loadLocalStorage?: (k: string) => unknown; saveLocalStorage?: (k: string, v: unknown) => void };
    if (typeof app.loadLocalStorage !== "function" || typeof app.saveLocalStorage !== "function") return new MemKv();
    return { load: (k) => app.loadLocalStorage!(k), save: (k, v) => app.saveLocalStorage!(k, v ?? null) };
  }

  private async afterLayout(): Promise<void> {
    if (this.unloaded) return;
    this.layoutReady = true;
    // data.json holds only {schema: 1} (UX-D6); other sync tools never carry SHUTTLE state.
    // Checked here, not in onload, so plugin load does no file I/O (design §5.10).
    const data: unknown = await this.loadData();
    if (!data || (data as { schema?: unknown }).schema !== DATA_JSON.schema || Object.keys(data as object).length !== 1) {
      assertNoSecrets(DATA_JSON);
      await this.saveData({ ...DATA_JSON });
    }
    const vault = this.app.vault as unknown as VaultLike;
    this.fs = new ObsidianLocalFs({
      vault, fileManager: this.app.fileManager as unknown as FileManagerLike,
      platform: localPlatform(this.platform), caseInsensitive: caseInsensitive(this.platform),
    });
    const appId = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
    const os = osOf(this.platform);
    this.session = new Session({
      store: this.store, fs: this.fs,
      http: requestUrlHttpClient(requestUrl as unknown as RequestUrlFn),
      ws: browserWsFactory(window.WebSocket as unknown as WebSocketCtor),
      clock: pluginClock, scheduler: this.scheduler,
      openState: (profileId) => IdbStateStore.open(idbName(appId, profileId)),
      platformName: platformName(this.platform), defaultDeviceName: defaultDeviceName(this.platform),
      ...(os ? { os } : {}),
    });
    this.session.on("status", (s) => this.onStatus(s));
    this.session.on("guard", (g) => this.onGuard(g));
    this.session.on("log", (e) => this.onLog(e));
    registerVisibilityHooks((target, type, cb) => this.registerDomEvent(target as Document, type as "visibilitychange", cb), document, window,
      (visible) => this.session?.onVisibility(visible));

    const p = this.store.activeProfile();
    if (p) await this.startProfile(p, false);
    else if (!this.store.flag(LS.welcomed)) {
      this.store.setFlag(LS.welcomed, true);
      const n = new Notice(t("notice.welcome"), 10_000);
      n.noticeEl.addEventListener("click", () => this.openWizard());
    }
    this.refreshIcon();
  }

  private async startProfile(p: Profile, paused: boolean): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.start(p, { paused });
    } catch (e) {
      new Notice(t("notice.error", { reason: e instanceof Error ? e.message : String(e) }), 10_000);
      return;
    }
    if (this.isLocked()) {
      const n = new Notice(t("notice.locked", { vaultName: p.vaultName }), 0);
      n.noticeEl.addEventListener("click", () => { n.hide(); this.openUnlock(); });
    }
    this.refreshIcon();
  }

  // ---------------- state and events ----------------

  private isLocked(): boolean {
    const s = this.session?.status();
    if (s) return s.locked;
    const p = this.store.activeProfile();
    return !!p && !this.store.keys(p.vaultId);
  }

  private view(): UiView {
    const p = this.store.activeProfile();
    return uiView({
      configured: !!p, status: this.session?.status() ?? null,
      keysMissing: !!p && !this.store.keys(p.vaultId), guardOpen: this.openGuards.size > 0,
    });
  }

  private refreshIcon(): void {
    this.icon?.render(this.view());
    for (const cb of this.statusListeners) cb();
  }

  private onStatus(s: EngineStatus | null): void {
    this.refreshIcon();
    const reason = this.errorGate.next(s, Date.now());
    if (reason) {
      const n = new Notice(t("notice.error", { reason: reasonText(reason) }), 10_000);
      n.noticeEl.addEventListener("click", () => this.openLog());
    }
    const p = this.session?.profile;
    if (p && firstSyncDone(s, this.store.flag(LS.firstSync(p.id)))) {
      this.store.setFlag(LS.firstSync(p.id), true);
      const files = this.session?.debugInfo()?.indexByScope.active ?? 0;
      new Notice(t("notice.firstSyncDone", { n: files }), 5000);
    }
  }

  private onGuard(g: GuardEvent): void {
    this.openGuards.add(g.id);
    this.refreshIcon();
    new GuardModal(this.app, g, (choice) => {
      this.openGuards.delete(g.id);
      this.session?.answerGuard(g.id, choice);
      this.refreshIcon();
    }).open();
  }

  private onLog(_e: LogEntry): void {
    // The log view subscribes itself; nothing to do here in v1.
  }

  // ---------------- actions ----------------

  private deviceSettings(): Partial<DeviceSettings> {
    const s = this.store.settings();
    return { ...s, deviceName: s.deviceName?.trim() ? s.deviceName : defaultDeviceName(this.platform) };
  }

  private async updateSettings(patch: Partial<DeviceSettings>): Promise<void> {
    if (this.session) await this.session.updateSettings(patch);
    else this.store.saveSettings({ ...this.store.settings(), ...patch });
  }

  private pause(): void {
    this.session?.pause();
    new Notice(t("notice.paused"), 3000);
    this.refreshIcon();
  }

  private resume(): void {
    // design §5.2.2: Resume from a guard pause re-opens the guard instead.
    const g = this.session?.openGuards()[0];
    if (g) {
      this.onGuard(g);
      return;
    }
    this.session?.resume();
    new Notice(t("notice.resumed"), 3000);
    this.refreshIcon();
  }

  openWizard(prefill: ReturnType<typeof fromParams> | null = null): void {
    if (!this.layoutReady || !this.session) {
      new Notice(t("notice.openSettingsManually"), 4000);
      return;
    }
    const env: SetupEnv = {
      http: requestUrlHttpClient(requestUrl as unknown as RequestUrlFn), scheduler: this.scheduler, now: () => Date.now(),
      client: { name: this.deviceSettings().deviceName ?? "device", platform: platformName(this.platform), version: PLUGIN_VERSION },
    };
    new ServerWizard(this.app, {
      env, store: this.store, localVaultName: this.app.vault.getName(),
      deviceName: () => this.deviceSettings().deviceName ?? defaultDeviceName(this.platform),
      setDeviceName: (name) => this.updateSettings({ deviceName: name }),
      onDone: async (profile, paused) => {
        await this.session?.stop();
        await this.startProfile(profile, paused);
      },
    }, prefill).open();
  }

  private openUnlock(): void {
    const p = this.store.activeProfile();
    if (!p || !this.session?.running) {
      if (p) new Notice(t("notice.openSettingsManually"), 4000);
      return;
    }
    new UnlockModal(this.app, p.vaultName, async (pass) => {
      await this.session?.unlock(pass);
      this.refreshIcon();
    }).open();
  }

  private openLog(): void {
    const s = this.session;
    new LogModal(this.app, {
      entries: () => s?.logEntries() ?? [],
      wrapped: () => s?.logWrapped() ?? false,
      onEntry: (cb) => s ? s.on("log", cb) : { dispose: () => undefined },
    }).open();
  }

  private copyDebug(): void {
    const s = this.session;
    const p = this.store.activeProfile();
    const auth = p ? this.store.auth(p.id) : null;
    const endpoint = s?.adapter?.endpoint ?? p?.endpoints[0]?.url ?? null;
    const text = debugText({
      now: Date.now(), pluginVersion: PLUGIN_VERSION, obsidianVersion: (this.app as unknown as { appVersion?: string }).appVersion ?? null,
      platform: `${platformName(this.platform)}${this.platform.isMobile ? (this.platform.isTablet ? ", tablet" : ", phone") : ""}`,
      configDir: this.app.vault.configDir, hostUrl: endpoint,
      endpointIndex: Math.max(0, p?.endpoints.findIndex((e) => e.url === endpoint) ?? 0), endpointCount: p?.endpoints.length ?? 0,
      endpointMode: p?.endpointMode ?? "auto", vaultId: p?.vaultId ?? null, deviceName: this.deviceSettings().deviceName ?? "",
      deviceId: auth?.deviceId ?? null, status: s?.status() ?? null, debug: s?.debugInfo() ?? null, log: s?.logEntries() ?? [],
      includeLog: true, secrets: auth ? [auth.token] : [],
    });
    new TextPreviewModal(this.app, t("debug.title"), text, "notice.debugCopied").open();
  }

  private addDevice(mirrorLink: string | null): void {
    const s = this.session;
    const p = this.store.activeProfile();
    if (!s?.adapter || !p) {
      new Notice(t("status.notConfigured"), 5000);
      return;
    }
    new AddDeviceModal(this.app, { adapter: s.adapter, vaultName: p.vaultName, keys: () => this.store.keys(p.vaultId) }, mirrorLink).open();
  }

  private confirmDisconnect(): void {
    const p = this.store.activeProfile();
    if (!p) return;
    new ConfirmModal(this.app, {
      title: t("disc.title", { vaultName: p.vaultName }), body: t("disc.body"), confirm: t("btn.disconnect"), warning: true,
      onConfirm: async () => {
        // design §5.4 A1: stop, clear the active pointer; keep the profile record and the local DB.
        await this.session?.stop();
        this.store.setActive(null);
        this.refreshIcon();
      },
    }).open();
  }

  private confirmReset(): void {
    new ConfirmModal(this.app, {
      title: t("reset.title"), body: t("reset.body"), confirm: t("btn.reset").replace("…", ""), warning: true,
      onConfirm: async () => {
        await this.session?.stop();
        this.store.forgetAll();
        this.refreshIcon();
      },
    }).open();
  }

  private showMenu(ev: MouseEvent): void {
    const m = new Menu();
    const v = this.view();
    const later = ` ${t("menu.suffixLater")}`;
    if (v.state === "notConfigured") {
      m.addItem((i) => i.setTitle(t("menu.setUp")).setIcon("plug").onClick(() => this.openWizard()));
      m.addItem((i) => i.setTitle(t("menu.openLog")).setIcon("align-left").onClick(() => this.openLog()));
      m.addItem((i) => i.setTitle(t("menu.copyDebug")).setIcon("clipboard-copy").onClick(() => this.copyDebug()));
      m.showAtMouseEvent(ev);
      return;
    }
    const paused = this.session?.status()?.status === "paused" && !this.isLocked();
    m.addItem((i) => i.setTitle(paused ? t("menu.resume") : t("menu.pause")).setIcon(paused ? "circle-play" : "circle-pause")
      .setDisabled(!this.session?.running || this.isLocked()).onClick(() => (paused ? this.resume() : this.pause())));
    m.addItem((i) => i.setTitle(t("menu.versionHistory") + later).setIcon("history").setDisabled(true));
    m.addItem((i) => i.setTitle(t("menu.openLog")).setIcon("align-left").onClick(() => this.openLog()));
    m.addItem((i) => i.setTitle(t("menu.deletedFiles") + later).setIcon("trash-2").setDisabled(true));
    m.addItem((i) => i.setTitle(t("menu.settings")).setIcon("cog").onClick(() => this.openSettings()));
    m.addSeparator();
    if (v.state === "locked") m.addItem((i) => i.setTitle(t("menu.unlock")).setIcon("lock-open").onClick(() => this.openUnlock()));
    else m.addItem((i) => i.setTitle(t("menu.syncNow")).setIcon("refresh-cw").setDisabled(!this.session?.running || paused).onClick(() => this.session?.kick("user")));
    m.addItem((i) => i.setTitle(t("menu.copyDebug")).setIcon("clipboard-copy").onClick(() => this.copyDebug()));
    m.showAtMouseEvent(ev);
  }

  private openSettings(): void {
    // design §5.2.2 item 5: private API with a fallback notice.
    const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    if (setting && typeof setting.open === "function" && typeof setting.openTabById === "function") {
      setting.open();
      setting.openTabById(PLUGIN_ID);
    } else new Notice(t("notice.openSettingsManually"), 4000);
  }

  private registerCommands(): void {
    const running = (): boolean => !!this.session?.running;
    const paused = (): boolean => this.session?.status()?.status === "paused";
    this.addCommand({ id: "open-log", name: t("cmd.openLog"), callback: () => this.openLog() });
    this.addCommand({ id: "pause", name: t("cmd.pause"), checkCallback: (c) => { if (!running() || paused()) return false; if (!c) this.pause(); return true; } });
    this.addCommand({ id: "resume", name: t("cmd.resume"), checkCallback: (c) => { if (!running() || !paused() || this.isLocked()) return false; if (!c) this.resume(); return true; } });
    this.addCommand({ id: "toggle-pause", name: t("cmd.togglePause"), checkCallback: (c) => { if (!running() || this.isLocked()) return false; if (!c) (paused() ? this.resume() : this.pause()); return true; } });
    this.addCommand({ id: "sync-now", name: t("cmd.syncNow"), checkCallback: (c) => { if (!running() || paused() || this.isLocked()) return false; if (!c) this.session?.kick("user"); return true; } });
    this.addCommand({ id: "open-settings", name: t("cmd.settings"), callback: () => this.openSettings() });
    this.addCommand({ id: "set-up", name: t("cmd.setUp"), callback: () => this.openWizard() });
    this.addCommand({ id: "unlock", name: t("cmd.unlock"), checkCallback: (c) => { if (!running() || !this.isLocked()) return false; if (!c) this.openUnlock(); return true; } });
    this.addCommand({ id: "copy-debug", name: t("cmd.copyDebug"), callback: () => this.copyDebug() });
    this.addCommand({ id: "add-device", name: t("cmd.addDevice"), checkCallback: (c) => { if (!running() || !this.session?.adapter) return false; if (!c) this.addDevice(null); return true; } });
    this.addCommand({ id: "rebuild-local", name: t("cmd.rebuildLocal"), checkCallback: (c) => { if (!running()) return false; if (!c) this.session?.rebuildLocal(); return true; } });
  }
}
