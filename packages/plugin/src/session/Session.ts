// The plugin's sync session: one active remote profile → its state DB, adapter, keyring and engine
// (design §1.1, §3.17, UX-D1). Obsidian-independent so it can be tested with fakes and a real server;
// the plugin passes the Obsidian-backed LocalFs, HttpClient, WsFactory and StateStore opener.

import { adapterStateStoreOver } from "@shuttle/protocol";
import type {
  Clock, DebugInfo, DeviceSettings, Disposable, EngineStatus, GuardChoice, GuardEvent, HttpClient, Keyring, LocalFs, LogEntry,
  StateStore, VaultInfo, WsFactory,
} from "@shuttle/protocol";
import { ServerAdapter } from "@shuttle/adapter-server";
import { SxKeyring, fromB64u, fromCache, isCryptoError, type CachedSecrets, type VaultInfo as CryptoVaultInfo } from "@shuttle/crypto";
import { ENGINE_VERSION, createEngine, type ShuttleEngine } from "@shuttle/engine";
import { PLUGIN_ID, PLUGIN_VERSION, STARTUP_INFO_TIMEOUT_MS } from "../constants";
import type { DeviceStore, Profile } from "../store/localStore";
import { hostLabel } from "../util/url";
import type { PluginScheduler } from "../platform/timers";

export interface SessionDeps {
  store: DeviceStore;
  fs: LocalFs;
  http: HttpClient;
  ws: WsFactory;
  clock: Clock;
  scheduler: PluginScheduler;
  /** Open the state DB of a profile (plugin: IdbStateStore `shuttle/<appId>/<profileId>`). */
  openState(profileId: string): Promise<StateStore>;
  /** `client.platform` sent to the server. */
  platformName: string;
  os?: "windows" | "macos" | "linux";
  /** Default device name (design UX-D2) when the device never chose one. */
  defaultDeviceName: string;
  /** Engine option overrides (tests: manual loop, self-test stub). */
  engineOverrides?: Parameters<typeof createEngine>[1];
}

export type KeyringSource = "verified" | "offline" | "none" | "locked-rotated";

export interface SessionEvents {
  status(s: EngineStatus | null): void;
  log(e: LogEntry): void;
  guard(g: GuardEvent): void;
}

type Listener<K extends keyof SessionEvents> = SessionEvents[K];

/** Build a keyring from cached VMKs (design §4.5.3 "from cache"), verifying against the live vault-info when reachable. */
export async function keyringFromCache(
  cache: CachedSecrets | null,
  getInfo: () => Promise<VaultInfo | null>,
  o: { seen: ReturnType<ReturnType<DeviceStore["seenStore"]>["load"]>; ring: { activeKv: number; metaPadBucket: number } | null; timeoutMs: number; onInfo?(info: VaultInfo): void },
): Promise<{ ring: Keyring | null; source: KeyringSource }> {
  if (!cache) return { ring: null, source: "none" };
  let info: VaultInfo | null = null;
  try {
    info = await withTimeout(getInfo(), o.timeoutMs);
  } catch {
    info = null; // unreachable: fall back to the cached parameters below
  }
  if (info) {
    o.onInfo?.(info);
    try {
      const r = await fromCache(cache, info as unknown as CryptoVaultInfo, o.seen);
      return { ring: r.ring as unknown as Keyring, source: "verified" };
    } catch (e) {
      if (isCryptoError(e) && e.code === "Locked") return { ring: null, source: "locked-rotated" };
      // Tampered or rolled back: start with the cached keys anyway; the engine checks the vault-info
      // MAC on connect, marks the vault tampered and stops (design §4.5.3), with the reason in status.
    }
  }
  const vmks = new Map<number, Uint8Array>();
  for (const [kv, v] of Object.entries(cache.kvs)) vmks.set(Number(kv), fromB64u(v));
  const activeKv = o.ring?.activeKv ?? Math.max(...vmks.keys());
  if (!vmks.has(activeKv) || !vmks.has(1)) return { ring: null, source: "none" };
  try {
    const ring = await SxKeyring.fromVmks(cache.vaultId, vmks, activeKv, o.ring ? { metaPadBucket: o.ring.metaPadBucket } : {});
    return { ring: ring as unknown as Keyring, source: "offline" };
  } catch {
    return { ring: null, source: "none" };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(h); resolve(v); }, (e: unknown) => { clearTimeout(h); reject(e); });
  });
}

/** Ordered URL list for the adapter (UX-D1): `auto` = all in order, pinned = that one. */
export function urlsOf(p: Profile): string[] {
  if (p.endpointMode === "auto") return p.endpoints.map((e) => e.url);
  const e = p.endpoints[p.endpointMode];
  return e ? [e.url] : p.endpoints.map((x) => x.url);
}

export class Session {
  engine: ShuttleEngine | null = null;
  adapter: ServerAdapter | null = null;
  profile: Profile | null = null;
  keySource: KeyringSource = "none";
  private state: StateStore | null = null;
  private subs: Disposable[] = [];
  private readonly listeners: { [K in keyof SessionEvents]: Set<Listener<K>> } = { status: new Set(), log: new Set(), guard: new Set() };
  private starting: Promise<void> | null = null;
  private generation = 0;
  private logTotal = 0;

  constructor(readonly d: SessionDeps) {}

  on<K extends keyof SessionEvents>(ev: K, cb: SessionEvents[K]): Disposable {
    const set = this.listeners[ev] as Set<SessionEvents[K]>;
    set.add(cb);
    return { dispose: () => { set.delete(cb); } };
  }

  private emit<K extends keyof SessionEvents>(ev: K, ...args: Parameters<SessionEvents[K]>): void {
    for (const cb of this.listeners[ev] as Set<(...a: Parameters<SessionEvents[K]>) => void>) {
      try {
        cb(...args);
      } catch { /* a UI listener must not break the engine */ }
    }
  }

  get running(): boolean {
    return this.engine !== null;
  }

  status(): EngineStatus | null {
    return this.engine?.status() ?? null;
  }

  /** Device settings: stored per device, platform defaults otherwise (design §3.17). */
  deviceSettings(): Partial<DeviceSettings> {
    const s = this.d.store.settings();
    return { ...s, deviceName: typeof s.deviceName === "string" && s.deviceName.trim() ? s.deviceName : this.d.defaultDeviceName };
  }

  /** Start syncing the profile (no-op when it is already running). */
  start(profile: Profile, o: { paused?: boolean } = {}): Promise<void> {
    if (this.starting) return this.starting;
    if (this.engine && this.profile?.id === profile.id) return Promise.resolve();
    const p = (async () => {
      if (this.engine) await this.stop();
      await this.startInner(profile, o);
    })().finally(() => { this.starting = null; });
    this.starting = p;
    return p;
  }

  private async startInner(profile: Profile, o: { paused?: boolean }): Promise<void> {
    const gen = ++this.generation;
    const d = this.d;
    const auth = d.store.auth(profile.id);
    if (!auth) throw new Error("this remote has no credentials on this device; set it up again");
    const state = await d.openState(profile.id);
    if (gen !== this.generation) { await state.close(); return; }
    const settings = this.deviceSettings();
    const adapter = new ServerAdapter({
      config: { urls: urlsOf(profile), vaultId: profile.vaultId, deviceId: auth.deviceId },
      token: () => d.store.auth(profile.id)?.token ?? null,
      http: d.http, ws: d.ws, clock: d.clock, scheduler: d.scheduler,
      client: { name: settings.deviceName ?? d.defaultDeviceName, platform: d.platformName, version: PLUGIN_VERSION, role: "plugin" },
      state: adapterStateStoreOver(state), allowHttp: profile.allowHttp,
    });
    const seenStore = d.store.seenStore(profile.vaultId);
    const k = await keyringFromCache(d.store.keys(profile.vaultId), async () => (await adapter.getVaultInfo())?.info ?? null, {
      seen: seenStore.load(), ring: d.store.ring(profile.vaultId), timeoutMs: STARTUP_INFO_TIMEOUT_MS,
      onInfo: (info) => d.store.saveRing(profile.vaultId, { activeKv: info.activeKv, metaPadBucket: info.params.metaPadBucket }),
    });
    if (gen !== this.generation) { await state.close(); await adapter.close().catch(() => undefined); return; }
    const engine = createEngine({
      fs: d.fs, state, remote: adapter, keyring: k.ring, clock: d.clock, scheduler: d.scheduler,
      adapterState: adapterStateStoreOver(state),
    }, {
      settings, pluginId: PLUGIN_ID,
      ...(d.os ? { os: d.os } : {}),
      local: d.store.localRecordStore(profile.id),
      seen: seenStore,
      onKeysUnlocked: (cache) => { d.store.saveKeys(cache as CachedSecrets); },
      onKeysDropped: () => { d.store.dropKeys(profile.vaultId); },
      host: hostLabel(urlsOf(profile)[0]),
      ...(d.engineOverrides ?? {}),
    });
    this.logTotal = 0;
    this.subs = [
      engine.on("status", (s) => this.emit("status", s)),
      engine.on("log", (e) => { this.logTotal++; this.emit("log", e); }),
      engine.on("guard", (g) => this.emit("guard", g)),
    ];
    this.engine = engine;
    this.adapter = adapter;
    this.state = state;
    this.profile = profile;
    this.keySource = k.source;
    await engine.start();
    if (o.paused) engine.pause();
    this.emit("status", engine.status());
  }

  /** Stop the engine and release the DB and sockets. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.generation++;
    const engine = this.engine;
    const adapter = this.adapter;
    const state = this.state;
    this.engine = null;
    this.adapter = null;
    this.state = null;
    for (const s of this.subs) s.dispose();
    this.subs = [];
    try {
      await engine?.stop();
    } finally {
      await adapter?.close().catch(() => undefined);
      await state?.close().catch(() => undefined);
      this.emit("status", null);
    }
  }

  pause(): void { this.engine?.pause(); }
  resume(): void { this.engine?.resume(); }
  kick(reason = "user"): void { this.engine?.kick(reason); }
  onVisibility(visible: boolean): void { this.engine?.onVisibility(visible); }
  answerGuard(id: string, choice: GuardChoice): void { this.engine?.answerGuard(id, choice); }
  openGuards(): GuardEvent[] {
    return this.engine ? this.engine.guards.list().map((g) => ({ id: g.id, kind: g.kind, n: g.n, sample: [...g.sample] })) : [];
  }
  logEntries(): LogEntry[] { return this.engine ? [...this.engine.log.entries()] : []; }
  /** design §5.3.1: the ring buffer has dropped entries. */
  logWrapped(): boolean { return this.engine ? this.logTotal > this.engine.log.capacity : false; }
  debugInfo(): DebugInfo | null { return this.engine?.debugInfo() ?? null; }

  async unlock(passphrase: string): Promise<void> {
    if (!this.engine) throw new Error("not running");
    await this.engine.unlock(passphrase);
    this.keySource = "verified";
    this.emit("status", this.engine.status());
  }

  async lock(): Promise<void> {
    await this.engine?.lock();
    this.keySource = "none";
    if (this.engine) this.emit("status", this.engine.status());
  }

  async updateSettings(patch: Partial<DeviceSettings>): Promise<void> {
    this.d.store.saveSettings({ ...this.d.store.settings(), ...patch });
    await this.engine?.updateSettings(patch);
  }

  /** design §5.4 E7: re-check every file (full scan with hashing). */
  rebuildLocal(): void {
    this.engine?.requestScan("full");
    this.engine?.kick("user");
  }

  static readonly engineVersion = ENGINE_VERSION;
}
