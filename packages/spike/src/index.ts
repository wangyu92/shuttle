// Shuttle Spike: throwaway Obsidian plugin that runs the P0 mobile/plugin probes (design §7.9, §10.2).
// Install only in a scratch test vault. Results go to _shuttle-spike/results-<device>-<yyyymmdd-hhmm>.md.
import { type Events, ItemView, Notice, Platform, Plugin, TFile, type WorkspaceLeaf, normalizePath, requestUrl } from "obsidian";
import { katProbe } from "./probes/crypto-kat.js";
import { cryptoProbes } from "./probes/crypto.js";
import { platformProbes } from "./probes/platform.js";
import { M8Recorder, serverProbes } from "./probes/server.js";
import { crashCleanup, storageProbes } from "./probes/storage.js";
import { deviceInfo, renderNote } from "./report.js";
import type { Ctx, Probe, ProbeOutcome, ProbeResult, RecorderState, SpikeSettings } from "./types.js";
import { SpikeSettingTab, askModal, confirmModal, copyText, typeToConfirmModal } from "./ui.js";
import { errMsg, now, randomBytes, round, slug, stamp, toHex } from "./util.js";

export const PACKAGE_NAME = "@shuttle/spike";

const RESULTS_DIR = "_shuttle-spike";
const TMP_DIR = `${RESULTS_DIR}/tmp`;
const VIEW_TYPE = "shuttle-spike-view";
/** Heavy probes run with a plain confirm only in a vault that looks like a scratch vault (F4). */
const SCRATCH_VAULT_RE = /test|sandbox|scratch|spike/i;
const MAX_SCRATCH_FILES = 500;
const LS = { session: "shuttle-spike-session", unload: "shuttle-spike-unload", m12: "shuttle-spike-m12" } as const;

const DEFAULT_SETTINGS: SpikeSettings = {
  // §2.8.10 / §10.2 M4: the DSM reverse-proxy rule listens on 6984.
  serverUrl: "",
  deviceName: "",
  m7IdleMinutes: 10,
  postResults: false,
};

interface StoredData {
  settings?: Partial<SpikeSettings>;
  reloadMarker?: { ts: number; loadedAt: number } | null;
}

class SpikeView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly state: RecorderState) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Shuttle spike";
  }
  override getIcon(): string {
    return this.state.viewIcon;
  }
  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "M23 probe view. The tab icon should change while the probe runs." });
  }
}

export default class ShuttleSpikePlugin extends Plugin {
  override settings: SpikeSettings = { ...DEFAULT_SETTINGS };
  readonly results = new Map<string, ProbeResult>();
  private sessionStamp = stamp(new Date());
  private sessionId = toHex(randomBytes(6));
  private ribbon: HTMLElement | null = null;
  private m8 = new M8Recorder();
  private busy = false;
  private stored: StoredData = {};
  private progressNotice: Notice | null = null;
  state: RecorderState = {
    lifecycle: [],
    rawEvents: [],
    protocolHits: [],
    previousSession: null,
    previousUnload: null,
    previousM12: null,
    loadedAt: Date.now(),
    reloadMarker: null,
    viewIcon: "flask-conical",
  };

  override async onload(): Promise<void> {
    this.stored = ((await this.loadData()) as StoredData | null) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...(this.stored.settings ?? {}) };

    // Recorders: read the previous launch's markers before overwriting them (M12, M21).
    this.state.previousSession = this.app.loadLocalStorage(LS.session);
    this.state.previousUnload = this.app.loadLocalStorage(LS.unload);
    this.state.previousM12 = this.app.loadLocalStorage(LS.m12);
    this.app.saveLocalStorage(LS.session, { id: this.sessionId, start: Date.now() });

    // M9 lifecycle events.
    const rec = (type: string, detail?: string) => {
      this.state.lifecycle.push({ t: Date.now(), type, ...(detail ? { detail } : {}) });
      if (this.state.lifecycle.length > 500) this.state.lifecycle.shift();
    };
    this.registerDomEvent(document, "visibilitychange", () => rec("visibilitychange", document.visibilityState));
    for (const t of ["freeze", "resume"]) this.registerDomEvent(document, t as keyof DocumentEventMap, () => rec(t));
    for (const t of ["pagehide", "pageshow", "blur", "focus", "online", "offline"]) {
      this.registerDomEvent(window, t as keyof WindowEventMap, () => rec(t));
    }

    // M13 raw events.
    this.registerEvent(
      // "raw" is undocumented: it reports adapter-level changes, including the config dir.
      (this.app.vault as unknown as Events).on("raw", (path: unknown) => {
        this.state.rawEvents.push({ t: Date.now(), path: String(path) });
        if (this.state.rawEvents.length > 2000) this.state.rawEvents.shift();
      }),
    );

    // M19 protocol handlers.
    for (const action of ["shuttle-enroll", "shuttle-pair"]) {
      this.registerObsidianProtocolHandler(action, (params) => {
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(params)) p[k] = String(v);
        this.state.protocolHits.push({ t: Date.now(), action, params: p });
        new Notice(`Shuttle spike: obsidian://${action} received`);
      });
    }

    this.registerView(VIEW_TYPE, (leaf) => new SpikeView(leaf, this.state));
    this.ribbon = this.addRibbonIcon("flask-conical", "Shuttle spike: run all safe probes", () => void this.runAllSafe());
    this.addSettingTab(new SpikeSettingTab(this.app, this));

    for (const p of this.probes()) {
      this.addCommand({
        id: `probe-${p.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: `${p.id}: ${p.title}${p.safe ? "" : p.confirm ? " (heavy, asks first)" : " (interactive)"}`,
        callback: () => void this.runOne(p),
      });
    }
    this.addCommand({ id: "run-all-safe", name: "Run all safe probes", callback: () => void this.runAllSafe() });
    this.addCommand({
      id: "crypto-selftest-bench",
      name: "Crypto self-test and benchmark (P0-C1..C11)",
      callback: () => void this.runList(this.probes().filter((p) => p.safe && (p.id.includes("P0-C") || /^M[123]\b/.test(p.id)))),
    });
    this.addCommand({ id: "copy-results", name: "Copy results", callback: () => void this.copyResults() });
    this.addCommand({ id: "m8-disarm", name: "M8: disarm background recorder", callback: () => this.m8.disarm() });

    // M24-reload: the marker survives app:reload in data.json.
    const marker = this.stored.reloadMarker;
    if (marker?.ts) {
      const dt = Date.now() - marker.ts;
      this.stored.reloadMarker = null;
      await this.saveData(this.stored);
      if (dt < 120_000) {
        this.app.workspace.onLayoutReady(() =>
          this.recordLater("M24-reload", "app:reload: does it reload plugins?", {
            status: "pass",
            summary: `plugin reloaded ${round(dt / 1000, 1)} s after app:reload`,
            data: { dtMs: dt },
          }),
        );
      }
    }

    this.app.workspace.onLayoutReady(() => {
      const n = this.app.vault.getFiles().length;
      if (n > MAX_SCRATCH_FILES) new Notice(`Shuttle spike: this vault has ${n} files. The spike belongs in a scratch TEST vault only.`, 10000);
      // A crash or OS kill skips the probes' finally blocks (M15/M16 measure exactly that): clean up here.
      void crashCleanup(this.app, TMP_DIR)
        .then((done) => {
          if (done.length) {
            this.recordLater("cleanup", "Leftovers from a previous session removed at start", {
              status: "info",
              summary: done.join("; "),
              data: { cleaned: done },
            });
          }
        })
        .catch((e: unknown) => new Notice(`Shuttle spike: start-up cleanup failed: ${errMsg(e)}`));
    });
  }

  override onunload(): void {
    this.m8.disarm();
    try {
      this.app.saveLocalStorage(LS.unload, { id: this.sessionId, ts: Date.now() });
    } catch (e) {
      try {
        window.localStorage.setItem(LS.unload, JSON.stringify({ id: this.sessionId, ts: Date.now(), error: errMsg(e) }));
      } catch {
        /* nothing else to do */
      }
    }
  }

  async saveSettings(): Promise<void> {
    this.stored.settings = this.settings;
    await this.saveData(this.stored);
  }

  defaultDeviceName(): string {
    // UX-D2 platform defaults.
    if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
    if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows PC";
    return "Linux";
  }

  private deviceName(): string {
    return this.settings.deviceName || this.defaultDeviceName();
  }

  resultPath(): string {
    return normalizePath(`${RESULTS_DIR}/results-${slug(this.deviceName())}-${this.sessionStamp}.md`);
  }

  private enrollUri(): string {
    return `obsidian://shuttle-enroll?probe=${this.sessionId}`;
  }

  private probes(): Probe[] {
    return [
      ...cryptoProbes.slice(0, 1),
      katProbe,
      ...cryptoProbes.slice(1),
      ...serverProbes,
      ...storageProbes,
      ...platformProbes({
        openSpikeView: async () => {
          const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
          await leaf.setViewState({ type: VIEW_TYPE, active: true });
          await this.app.workspace.revealLeaf(leaf);
          return leaf;
        },
        ribbonEl: () => this.ribbon,
        m8: this.m8,
        recordLater: (id, title, o) => this.recordLater(id, title, o),
        setReloadMarker: async (v) => {
          this.stored.reloadMarker = (v ?? null) as { ts: number; loadedAt: number } | null;
          await this.saveData(this.stored);
        },
        enrollUri: () => this.enrollUri(),
      }),
    ];
  }

  private ctx(batch: boolean): Ctx {
    return {
      app: this.app,
      settings: this.settings,
      batch,
      tmpDir: TMP_DIR,
      state: this.state,
      progress: (msg) => {
        if (!this.progressNotice) this.progressNotice = new Notice(msg, 0);
        else this.progressNotice.setMessage(msg);
      },
      confirm: (t, b) => confirmModal(this.app, t, b),
      ask: (q, o) => (batch ? Promise.resolve(null) : askModal(this.app, q, o)),
      ensureFolder: (p) => this.ensureFolder(p),
    };
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!(await this.app.vault.adapter.exists(p))) {
        try {
          await this.app.vault.createFolder(p);
        } catch {
          await this.app.vault.adapter.mkdir(p);
        }
      }
    }
  }

  private async execute(p: Probe, batch: boolean): Promise<ProbeResult | null> {
    if (p.confirm && batch) return null; // heavy probes never run unattended
    if (p.confirm) {
      const n = this.app.vault.getFiles().length;
      const name = this.app.vault.getName();
      const scratch = n <= MAX_SCRATCH_FILES && SCRATCH_VAULT_RE.test(name);
      const body = `${p.confirm}\nThis vault ("${name}") has ${n} files. Continue only if this is a throwaway TEST vault. If this vault is synced, every write reaches your other devices.`;
      const ok = scratch
        ? await confirmModal(this.app, `${p.id}: ${p.title}`, body)
        : await typeToConfirmModal(
            this.app,
            `${p.id}: ${p.title}`,
            `${body}\nREFUSED by default: the vault has more than ${MAX_SCRATCH_FILES} files or its name does not contain test, sandbox, scratch or spike.`,
            name,
          );
      if (!ok) return null;
    }
    const t0 = now();
    let o: ProbeOutcome;
    try {
      o = await p.run(this.ctx(batch));
    } catch (e) {
      o = { status: "error", summary: errMsg(e) };
    }
    const r: ProbeResult = { id: p.id, title: p.title, ...o, ms: round(now() - t0), at: new Date().toISOString() };
    this.results.set(p.id, r);
    return r;
  }

  private async runOne(p: Probe): Promise<void> {
    if (this.busy) {
      new Notice("Shuttle spike: a probe is already running");
      return;
    }
    this.busy = true;
    try {
      const r = await this.execute(p, false);
      if (r) {
        await this.writeNote();
        new Notice(`${r.id}: ${r.status.toUpperCase()}: ${r.summary}`, 8000);
      }
    } finally {
      this.busy = false;
      this.hideProgress();
    }
  }

  async runAllSafe(): Promise<void> {
    await this.runList(this.probes().filter((p) => p.safe));
  }

  private async runList(list: Probe[]): Promise<void> {
    if (this.busy) {
      new Notice("Shuttle spike: a probe is already running");
      return;
    }
    this.busy = true;
    const counts: Record<string, number> = {};
    const skippedServer: string[] = [];
    try {
      for (const [i, p] of list.entries()) {
        this.ctx(true).progress(`Shuttle spike ${i + 1}/${list.length}: ${p.id}`);
        const r = await this.execute(p, true);
        if (r) counts[r.status] = (counts[r.status] ?? 0) + 1;
        if (r?.status === "skipped" && p.needsServer) skippedServer.push(p.id);
        await this.writeNote();
      }
      const skippedNote = skippedServer.length ? ` SERVER PROBES SKIPPED (${skippedServer.join(", ")}): ${this.settings.serverUrl} unreachable.` : "";
      new Notice(`Shuttle spike: ${list.length} probes done (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}).${skippedNote} See ${this.resultPath()}`, skippedServer.length ? 20000 : 10000);
    } finally {
      this.busy = false;
      this.hideProgress();
    }
  }

  private hideProgress(): void {
    this.progressNotice?.hide();
    this.progressNotice = null;
  }

  recordLater(id: string, title: string, o: ProbeOutcome): void {
    this.results.set(id, { id, title, ...o, ms: 0, at: new Date().toISOString() });
    new Notice(`${id}: ${o.status.toUpperCase()}: ${o.summary}`, 10000);
    void this.writeNote();
  }

  private renderAll(): { md: string; json: string } {
    const device = deviceInfo(this.deviceName());
    const results = [...this.results.values()];
    return { md: renderNote(device, results, this.enrollUri()), json: JSON.stringify({ device, results }) };
  }

  private async writeNote(): Promise<void> {
    try {
      await this.ensureFolder(RESULTS_DIR);
      const path = this.resultPath();
      const { md, json } = this.renderAll();
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, md);
      else await this.app.vault.create(path, md);
      if (this.settings.postResults) {
        requestUrl({
          url: this.settings.serverUrl.replace(/\/+$/, "") + "/v1/dev/spike",
          method: "POST",
          contentType: "application/json",
          body: json,
          throw: false,
        }).catch(() => {});
      }
    } catch (e) {
      new Notice(`Shuttle spike: could not write results note: ${errMsg(e)}`);
    }
  }

  async copyResults(): Promise<void> {
    if (this.results.size === 0) {
      new Notice("Shuttle spike: no results yet");
      return;
    }
    const { md } = this.renderAll();
    await copyText(this.app, md);
  }
}
