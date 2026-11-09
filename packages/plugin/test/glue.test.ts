// Platform glue and pure UI logic: requestUrl HttpClient, WebSocket factory, scheduler cleanup,
// localStorage records, status icon states (§5.2.1), notice gating (§5.9), guard texts (§5.6.5),
// debug info redaction (§5.4.3), keyring from cache (startup paths).
import { describe, expect, it, vi } from "vitest";
import { createVault, rotateKey } from "@shuttle/crypto";
import type { DebugInfo, EngineStatus, GuardEvent, LogEntry, VaultInfo } from "@shuttle/protocol";
import { assertNoSecrets as scanNoSecrets } from "@shuttle/testkit";
import { HttpTimeoutError, requestUrlHttpClient, type RequestUrlFn } from "../src/platform/http";
import { browserWsFactory, type BrowserWebSocket, type WebSocketCtor } from "../src/platform/ws";
import { PluginScheduler } from "../src/platform/timers";
import { DeviceStore, LS, MemKv, remoteProfileId } from "../src/store/localStore";
import { SyncingDebounce, deriveUiState, uiView, type UiState } from "../src/ui/status";
import { ErrorNoticeGate, ERROR_NOTICE_EVERY_MS, firstSyncDone } from "../src/ui/notices";
import { guardText } from "../src/ui/modals";
import { copyLog, debugText, logLine } from "../src/ui/format";
import { keyringFromCache, urlsOf } from "../src/session/Session";
import { mmss } from "../src/ui/AddDeviceModal";
import { humanSize } from "../src/ui/Wizard";

const st = (o: Partial<EngineStatus>): EngineStatus => ({ status: "synced", pendingUp: 0, pendingDown: 0, failed: 0, locked: false, readOnly: false, ...o });

describe("requestUrl HttpClient", () => {
  it("passes content type separately, lowercases response headers, never throws on 4xx", async () => {
    const seen: Array<Parameters<RequestUrlFn>[0]> = [];
    const fn: RequestUrlFn = async (p) => { seen.push(p); return { status: 404, headers: { "Content-Type": "application/json", ETag: "x" }, arrayBuffer: new TextEncoder().encode("{}").buffer }; };
    const res = await requestUrlHttpClient(fn).request({ url: "https://sync.example.com/v1/x", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: "{}", timeoutMs: 1000 });
    expect(seen[0]).toMatchObject({ method: "POST", contentType: "application/json", throw: false, headers: { Authorization: "Bearer t" } });
    expect(seen[0]?.headers?.["Content-Type"]).toBeUndefined();
    expect(res).toMatchObject({ status: 404, headers: { "content-type": "application/json", etag: "x" } });
  });

  it("times out (requestUrl cannot be aborted) and redacts error text", async () => {
    vi.useFakeTimers();
    try {
      const never: RequestUrlFn = () => new Promise(() => undefined);
      const p = requestUrlHttpClient(never).request({ url: "https://sync.example.com", method: "GET", timeoutMs: 3000 });
      const done = expect(p).rejects.toBeInstanceOf(HttpTimeoutError);
      await vi.advanceTimersByTimeAsync(3001);
      await done;
    } finally {
      vi.useRealTimers();
    }
    const tok = "sxd_" + "B".repeat(43);
    const failing: RequestUrlFn = async () => { throw new Error(`net::ERR_FAILED Authorization: Bearer ${tok}`); };
    const e = await requestUrlHttpClient(failing).request({ url: "https://sync.example.com", method: "GET", timeoutMs: 1000 }).catch((x: Error) => x);
    expect((e as Error).message).not.toContain(tok);
  });
});

describe("browser WebSocket factory", () => {
  it("forwards events and decodes binary frames as text", () => {
    let sock!: BrowserWebSocket & { sent: string[]; args: unknown[] };
    const Ctor = function (this: unknown, url: string, protocols: string[]) {
      sock = { readyState: 1, protocol: "shuttle.1", binaryType: "blob", onopen: null, onmessage: null, onclose: null, onerror: null, sent: [], args: [url, protocols], send(d: string) { this.sent.push(d); }, close() {} };
      return sock;
    } as unknown as WebSocketCtor;
    const ws = browserWsFactory(Ctor)("wss://sync.example.com/v1/ws", ["shuttle.1"]);
    expect(sock.binaryType).toBe("arraybuffer");
    expect(sock.args).toEqual(["wss://sync.example.com/v1/ws", ["shuttle.1"]]);
    const got: string[] = [];
    ws.onmessage = (ev) => got.push(ev.data);
    let closed: { code: number } | null = null;
    ws.onclose = (ev) => { closed = ev; };
    sock.onmessage?.({ data: "text" });
    sock.onmessage?.({ data: new TextEncoder().encode("bin").buffer });
    sock.onclose?.({ code: 4401, reason: "x" });
    ws.send("hi");
    expect(got).toEqual(["text", "bin"]);
    expect(closed).toMatchObject({ code: 4401 });
    expect(sock.sent).toEqual(["hi"]);
    expect(ws.protocol).toBe("shuttle.1");
  });
});

describe("PluginScheduler", () => {
  it("dispose() clears every pending timer", async () => {
    const s = new PluginScheduler();
    let fired = 0;
    s.setTimer(10, () => fired++);
    const h = s.setTimer(10, () => fired++);
    s.clearTimer(h);
    expect(s.pending).toBe(1);
    s.dispose();
    expect(s.pending).toBe(0);
    s.setTimer(0, () => fired++);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(0);
  });
});

describe("DeviceStore (localStorage records, design §4.10.1)", () => {
  it("round-trips profiles, auth, keys, seen and the local record under the documented keys", async () => {
    const kv = new MemKv();
    const s = new DeviceStore(kv);
    const id = await remoteProfileId("shuttle-server", "vault1");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await remoteProfileId("shuttle-server", "vault1")).toBe(id);
    s.saveProfile({ id, adapterType: "shuttle-server", vaultId: "vault1", vaultName: "Notes", endpoints: [{ url: "https://sync.example.com", label: "Public" }], endpointMode: "auto", allowHttp: false, createdAt: 1 });
    s.setActive(id);
    s.saveAuth(id, { token: "sxd_x", deviceId: "dev1" });
    s.saveKeys({ vaultId: "vault1", kvs: { 1: "k1" } });
    s.seenStore("vault1").save({ epoch: 1, infoRev: 2, activeKv: 1, maxSeq: 5 });
    s.localRecordStore(id).save({ deviceId: "d", dbEpoch: "e", remoteProfileId: "", everSynced: true, pendingOps: [] });
    expect(s.activeProfile()?.vaultName).toBe("Notes");
    expect(kv.m.has(`shuttle:v1:profile:${id}:auth`)).toBe(true);
    expect(kv.m.has("shuttle:v1:vault:vault1:keys")).toBe(true);
    expect(s.keys("vault1")).toEqual({ vaultId: "vault1", kvs: { 1: "k1" } });
    expect(s.keys("other")).toBeNull();
    expect(s.seenStore("vault1").load()).toEqual({ epoch: 1, infoRev: 2, activeKv: 1, maxSeq: 5 });
    expect(s.localRecordStore(id).load()?.remoteProfileId).toBe(id);
    s.dropKeys("vault1");
    expect(s.keys("vault1")).toBeNull();
    s.forgetAll();
    expect([...kv.m.keys()]).toEqual([]);
  });

  it("ignores malformed values", () => {
    const kv = new MemKv();
    kv.save(LS.profiles, [{ id: 1 }, "x", { id: "a", vaultId: "v", endpoints: [] }]);
    kv.save(LS.keys("v"), { vaultId: "v", kvs: { abc: 1 } });
    const s = new DeviceStore(kv);
    expect(s.profiles()).toEqual([]);
    expect(s.keys("v")).toBeNull();
    expect(urlsOf({ id: "a", adapterType: "shuttle-server", vaultId: "v", vaultName: "v", endpoints: [{ url: "u1", label: "" }, { url: "u2", label: "" }], endpointMode: 1, allowHttp: false, createdAt: 0 })).toEqual(["u2"]);
  });
});

describe("status icon (design §5.2.1)", () => {
  it("follows the priority table", () => {
    expect(deriveUiState({ configured: false, status: st({ status: "error" }), keysMissing: false, guardOpen: false })).toBe("notConfigured");
    expect(deriveUiState({ configured: true, status: null, keysMissing: true, guardOpen: false })).toBe("locked");
    expect(deriveUiState({ configured: true, status: st({ status: "paused", locked: true }), keysMissing: false, guardOpen: false })).toBe("locked");
    expect(deriveUiState({ configured: true, status: st({ status: "error" }), keysMissing: false, guardOpen: false })).toBe("error");
    expect(deriveUiState({ configured: true, status: st({ status: "disconnected" }), keysMissing: false, guardOpen: false })).toBe("disconnected");
    expect(deriveUiState({ configured: true, status: st({ status: "paused" }), keysMissing: false, guardOpen: false })).toBe("paused");
    expect(deriveUiState({ configured: true, status: st({ status: "syncing" }), keysMissing: false, guardOpen: false })).toBe("syncing");
    expect(deriveUiState({ configured: true, status: st({}), keysMissing: false, guardOpen: false })).toBe("synced");
    const v = uiView({ configured: true, status: st({ status: "syncing", pendingUp: 3, pendingDown: 1 }), keysMissing: false, guardOpen: false });
    expect(v).toMatchObject({ icon: "refresh-cw", colorVar: "--color-purple", spin: true, tooltip: "Syncing: 3 to upload, 1 to download." });
    expect(uiView({ configured: true, status: st({ status: "paused" }), keysMissing: false, guardOpen: true }).tooltip).toBe("Paused: waiting for your decision.");
    expect(uiView({ configured: true, status: st({ status: "error", reason: "REVOKED" }), keysMissing: false, guardOpen: false }).tooltip).toContain("removed from the server");
  });

  it("shows syncing only after 400 ms and goes back to synced at once", () => {
    vi.useFakeTimers();
    try {
      const shown: UiState[] = [];
      const d = new SyncingDebounce(400, (s) => shown.push(s));
      d.push("synced");
      d.push("syncing");
      vi.advanceTimersByTime(300);
      d.push("synced"); // short burst: never shown
      vi.advanceTimersByTime(500);
      d.push("syncing");
      vi.advanceTimersByTime(401);
      d.push("synced");
      expect(shown).toEqual(["synced", "syncing", "synced"]);
      d.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notices (design §5.9)", () => {
  it("shows an error notice on transition only, once per kind per 10 minutes", () => {
    const g = new ErrorNoticeGate();
    expect(g.next(st({ status: "disconnected" }), 0)).toBeNull();
    expect(g.next(st({ status: "error", reason: "QUOTA" }), 1)).toBe("QUOTA");
    expect(g.next(st({ status: "error", reason: "QUOTA" }), 2)).toBeNull();
    expect(g.next(st({}), 3)).toBeNull();
    expect(g.next(st({ status: "error", reason: "QUOTA" }), 4)).toBeNull();
    expect(g.next(st({}), 5)).toBeNull();
    expect(g.next(st({ status: "error", reason: "QUOTA" }), 1 + ERROR_NOTICE_EVERY_MS)).toBe("QUOTA");
    expect(firstSyncDone(st({}), false)).toBe(true);
    expect(firstSyncDone(st({ pendingDown: 2 }), false)).toBe(false);
    expect(firstSyncDone(st({}), true)).toBe(false);
  });
});

describe("guard prompts (design §5.6.5)", () => {
  it("maps each guard kind to the engine's choices", () => {
    const g = (kind: GuardEvent["kind"]): GuardEvent => ({ id: "g", kind, n: 30, sample: ["a.md"] });
    expect(guardText(g("massDeleteLocal")).buttons.map((b) => b[1])).toEqual(["pause", "apply"]);
    expect(guardText(g("massDeleteRemote")).title).toBe("Delete 30 files on this device?");
    expect(guardText(g("rollback")).buttons.map((b) => b[1])).toEqual(["pause", "accept"]);
    expect(guardText(g("tampered")).buttons.map((b) => b[1])).toEqual([null]);
    expect(guardText(g("emptyVault")).buttons.map((b) => b[1])).toEqual(["pause", "apply"]);
  });
});

describe("log and debug info text (design §5.3.5, §5.4.3)", () => {
  const token = "sxd_" + "Q".repeat(43);
  const log: LogEntry[] = [
    { ts: Date.UTC(2026, 10, 5, 5, 30, 1), level: "info", cat: "network", key: "log.connecting", params: {} },
    { ts: Date.UTC(2026, 10, 5, 5, 30, 4), level: "error", cat: "error", key: "log.pushFailed", params: { error: `Authorization: Bearer ${token}` }, path: "Daily/2026-11-05.md" },
  ];
  it("formats log lines with paths and redacted parameters", () => {
    expect(logLine(log[0]!)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}\[network\] Connecting to server$/);
    const text = copyLog(log, Date.UTC(2026, 10, 5, 6));
    expect(text).toContain("Daily/2026-11-05.md");
    expect(text).not.toContain(token);
  });
  it("never contains the token, full ids or the passphrase", () => {
    const debug = {
      engineVersion: "0.1.0", schemaVersion: 1, platform: "desktop",
      remote: { kind: "shuttle-server", capabilities: null, host: "sync.example.com" }, cursor: 42,
      indexByScope: { active: 10 }, journalByState: {}, batchesByState: {}, applyQueue: 0, intents: 0, quarantined: 0,
      lastErrors: { network: "log.unableToConnect" }, filterFingerprint: "abcdef0123", budgets: { up: 4 },
    } as DebugInfo;
    const vaultId = "q3mYabcdefghijklmnoW1A";
    const deviceId = "Ab3defghijklmnopqrs9xQ";
    const text = debugText({
      now: Date.now(), pluginVersion: "0.1.0", obsidianVersion: "1.10.0", platform: "linux", configDir: ".obsidian",
      hostUrl: "https://sync.example.com", endpointIndex: 0, endpointCount: 1, endpointMode: "auto", vaultId, deviceName: "Mac", deviceId,
      status: st({}), debug, log, includeLog: true, secrets: [token],
    });
    expect(text).toContain("Vault: id q3mY…W1A");
    expect(text).toContain("Cursor: 42");
    scanNoSecrets(text, [{ name: "token", value: token }, { name: "vaultId", value: vaultId }, { name: "deviceId", value: deviceId }]);
  });
});

describe("keyring at startup (design §4.5.3 from cache)", () => {
  it("verifies against the live vault-info, falls back offline, and reports a rotated key as locked", async () => {
    const made = await createVault("correct horse battery staple", { kdf: { iter: 310_000 } as never });
    const info = made.info as unknown as VaultInfo;
    const ring = { activeKv: info.activeKv, metaPadBucket: info.params.metaPadBucket };
    const ok = await keyringFromCache(made.cache, async () => info, { seen: null, ring, timeoutMs: 1000 });
    expect(ok.source).toBe("verified");
    expect(ok.ring).not.toBeNull();
    const offline = await keyringFromCache(made.cache, async () => { throw new Error("offline"); }, { seen: null, ring, timeoutMs: 1000 });
    expect(offline.source).toBe("offline");
    const rot = await rotateKey(made.ring, made.info, "correct horse battery staple", "correct horse battery staple");
    const rotated = rot.info as unknown as VaultInfo;
    expect(rotated.activeKv).toBe(2);
    const locked = await keyringFromCache(made.cache, async () => rotated, { seen: null, ring, timeoutMs: 1000 });
    expect(locked).toEqual({ ring: null, source: "locked-rotated" });
    expect(await keyringFromCache(null, async () => info, { seen: null, ring, timeoutMs: 1000 })).toEqual({ ring: null, source: "none" });
  }, 60_000);
});

describe("small formatters", () => {
  it("formats countdowns and sizes", () => {
    expect(mmss(900_000)).toBe("15:00");
    expect(mmss(61_001)).toBe("1:02");
    expect(mmss(-5)).toBe("0:00");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(250 * 1024 * 1024)).toBe("250 MB");
  });
});
