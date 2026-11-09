// Unit tests: health model and exit codes (design §6.1.9), prodGuard (§7.8), headless.json validation
// (§6.1.11), secrets permissions (§4.12.1), log redaction (§6.1.10), watchdog decision and graceful
// stop (§6.1.7), pairing crypto (§4.12.2), control socket (§6.1.8), watcher folder moves (§6.1.4).
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineStatus, LocalEvent } from "@shuttle/protocol";
import { HealthClock, computeHealth, type HealthInputs } from "../src/health";
import { ProdGuardError, checkPaths, checkServerUrls, protectedPrefixes } from "../src/prodGuard";
import { ConfigError, defaultConfig, deviceSettingsOf, scanIntervalMs, validateConfig } from "../src/config";
import { SECRETS_FORMAT, SecretsError, readSecrets, writeSecrets, type HeadlessSecrets } from "../src/secrets";
import { addSecret, clearSecretsForTests, memoryLogger, redact } from "../src/log";
import { Supervisor, isStalled } from "../src/supervisor";
import { PairingError, parsePairingLink, sealPairingEnvelope, startPairing, waitForEnvelope } from "../src/pair";
import { ControlServer } from "../src/control/ControlServer";
import { ControlClient, ControlUnreachable } from "../src/control/ControlClient";
import { NodeLocalFs } from "../src/NodeLocalFs";
import { Watcher } from "../src/watch/Watcher";
import { removeDir, tempDir, waitFor } from "./tmp";

let dir = "";
beforeAll(async () => { dir = await tempDir("unit"); });
afterAll(async () => { await removeDir(dir); });

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const okEngine: EngineStatus = { status: "synced", pendingUp: 0, pendingDown: 0, failed: 0, locked: false, readOnly: false };

function inputs(o: Partial<HealthInputs> = {}): HealthInputs {
  return {
    now: NOW, engine: okEngine, mode: "bidirectional", version: "0.1.0", connected: true, connectedSince: NOW - MIN, disconnectedSince: null,
    serverHeadSeq: 10, serverHeadSeqAt: NOW, cursor: 10, cursorAt: NOW, lagSince: null, lastPullOkAt: NOW, lastCommitOkAt: NOW,
    pendingUpSince: null, deferred: 0, deferredHourAgo: null, quarantined: 0, failedErrors: [],
    watcher: { mode: "hybrid", degraded: false, missedByWatcher: 0, lastScanAt: NOW - 1000, lastScanMs: 5 },
    pollIntervalSec: 30, startedAt: NOW - 10 * MIN, guards: [], loopHeartbeatAt: NOW, startupFailure: null, ...o,
  };
}

describe("health (design §6.1.9)", () => {
  it("ok when nothing is wrong", () => {
    expect(computeHealth(inputs())).toMatchObject({ status: "ok", exitCode: 0, reasons: [], lagSeq: 0 });
  });
  it.each([
    ["disconnected 5 min", { connected: false, disconnectedSince: NOW - 5 * MIN }, "degraded", 0],
    ["disconnected 11 min", { connected: false, disconnectedSince: NOW - 11 * MIN }, "down", 1],
    ["lag for 11 min", { serverHeadSeq: 20, lagSince: NOW - 11 * MIN }, "down", 1],
    ["lag for 2 min", { serverHeadSeq: 20, lagSince: NOW - 2 * MIN }, "ok", 0],
    ["uploads stuck 16 min", { engine: { ...okEngine, status: "syncing", pendingUp: 3 }, pendingUpSince: NOW - 16 * MIN, lastCommitOkAt: NOW - 20 * MIN }, "down", 1],
    ["scan stale", { watcher: { mode: "hybrid", degraded: false, missedByWatcher: 0, lastScanAt: NOW - 200_000, lastScanMs: 5 } }, "down", 1],
    ["watcher on poll fallback", { watcher: { mode: "poll", degraded: true, missedByWatcher: 3, lastScanAt: NOW, lastScanMs: 5 } }, "degraded", 0],
    ["failed ops", { engine: { ...okEngine, failed: 2 }, failedErrors: ["NETWORK"] }, "degraded", 0],
    ["failed ops for quota", { engine: { ...okEngine, failed: 1 }, failedErrors: ["QUOTA: over"] }, "down", 4],
    ["quarantined", { quarantined: 1 }, "degraded", 0],
    ["deferred grew", { deferred: 80, deferredHourAgo: 10 }, "degraded", 0],
    ["pending guard", { guards: [{ id: "g1-massDeleteLocal", kind: "massDeleteLocal", n: 300, sample: [] }] }, "down", 4],
    ["locked", { engine: { ...okEngine, status: "paused", locked: true, reason: "locked" } }, "down", 4],
    ["revoked", { engine: { ...okEngine, status: "error", reason: "AUTH" } }, "down", 4],
    ["engine error", { engine: { ...okEngine, status: "error", reason: "NETWORK" } }, "down", 1],
    ["empty vault at startup", { startupFailure: { emptyVault: true, text: "vault is empty" } }, "down", 4],
    ["temp dir unusable at startup", { startupFailure: { emptyVault: false, text: "temp dir" } }, "down", 1],
  ] as Array<[string, Partial<HealthInputs>, string, number]>)("%s → %s (exit %i)", (_n, o, status, code) => {
    const h = computeHealth(inputs(o));
    expect(h.status).toBe(status);
    expect(h.exitCode).toBe(code);
  });
  it("HealthClock tracks since-when values", () => {
    const c = new HealthClock(NOW);
    expect(c.disconnectedSince).toBe(NOW);
    c.observe(NOW + 1, { connected: true, lagSeq: 2, pendingUp: 1, deferred: 0 });
    expect(c.disconnectedSince).toBeNull();
    expect(c.lagSince).toBe(NOW + 1);
    c.observe(NOW + 2, { connected: true, lagSeq: 3, pendingUp: 1, deferred: 0 });
    expect(c.lagSince).toBe(NOW + 1);
    c.observe(NOW + 3, { connected: false, lagSeq: 0, pendingUp: 0, deferred: 0 });
    expect([c.disconnectedSince, c.lagSince, c.pendingUpSince]).toEqual([NOW + 3, null, null]);
    let r = c.observe(NOW + 30 * MIN, { connected: true, lagSeq: 0, pendingUp: 0, deferred: 5 });
    expect(r.deferredHourAgo).toBeNull();
    r = c.observe(NOW + 60 * MIN, { connected: true, lagSeq: 0, pendingUp: 0, deferred: 70 });
    expect(r.deferredHourAgo).toBe(0);
  });
});

describe("prodGuard (design §7.8)", () => {
  const env = (o: Record<string, string> = {}) => ({ HOME: path.join(dir, "fakehome"), ...o });
  it("refuses $HOME/Obsidian and listed prefixes without SHUTTLE_PROD=1", async () => {
    expect(() => checkPaths([path.join(dir, "fakehome/Obsidian/vault/x")], env())).toThrow(ProdGuardError);
    expect(() => checkPaths([path.join(dir, "elsewhere")], env())).not.toThrow();
    expect(() => checkPaths([path.join(dir, "prod/data")], env({ SHUTTLE_PROD_PREFIXES: path.join(dir, "prod") }))).toThrow(/production path/);
    const list = path.join(dir, "prefixes.txt");
    await writeFile(list, `# production\n${path.join(dir, "listed")}\n`);
    expect(() => checkPaths([path.join(dir, "listed/vault")], env({ SHUTTLE_PROD_PREFIXES_FILE: list }))).toThrow(ProdGuardError);
    expect(() => checkPaths([path.join(dir, "listed/vault")], env({ SHUTTLE_PROD_PREFIXES_FILE: list, SHUTTLE_PROD: "1" }))).not.toThrow();
    expect(() => protectedPrefixes(env({ SHUTTLE_PROD_PREFIXES_FILE: path.join(dir, "missing.txt") }))).toThrow(ProdGuardError);
    // A symlink into a protected prefix is resolved.
    await mkdir(path.join(dir, "fakehome/Obsidian/real"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(dir, "fakehome/Obsidian/real"), path.join(dir, "alias"));
    expect(() => checkPaths([path.join(dir, "alias/sub")], env())).toThrow(ProdGuardError);
    try { checkPaths([path.join(dir, "alias")], env()); } catch (e) { expect((e as ProdGuardError).exitCode).toBe(9); }
  });
  it("with SHUTTLE_PROD=1 refuses loopback and dev-port servers", () => {
    expect(() => checkServerUrls(["http://127.0.0.1:8787"], { SHUTTLE_PROD: "1" })).toThrow(ProdGuardError);
    expect(() => checkServerUrls(["http://localhost:9000"], { SHUTTLE_PROD: "1" })).toThrow(ProdGuardError);
    expect(() => checkServerUrls(["https://sync.example.com:8788"], { SHUTTLE_PROD: "1" })).toThrow(ProdGuardError);
    expect(() => checkServerUrls(["https://sync.example.com"], { SHUTTLE_PROD: "1" })).not.toThrow();
    expect(() => checkServerUrls(["http://127.0.0.1:8787"], {})).not.toThrow();
  });
});

describe("headless.json (design §6.1.11)", () => {
  const base = () => defaultConfig({ vaultPath: "/data/vault", tmpPath: "/data/.shuttle-tmp", urls: ["https://sync.example.com"], vaultId: "v1", deviceName: "mirror", mode: "push-only" });
  it("accepts the design's defaults and maps them to engine settings", () => {
    const c = validateConfig(JSON.parse(JSON.stringify(base())), {});
    const s = deviceSettingsOf(c);
    expect(Object.values(s.configCategories ?? {}).every((x) => x === false)).toBe(true);   // {} = all off
    expect(s).toMatchObject({ mode: "push-only", conflictMode: "conflictFile", deleteMode: "delete", maxFileBytes: 209_715_200 });
    expect(scanIntervalMs(c)).toBe(30_000);
    expect(scanIntervalMs({ ...c, watch: { mode: "chokidar", pollIntervalSec: 30 } })).toBe(600_000);
  });
  it("the shipped example config validates", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path.join(__dirname, "../deploy/headless.example.json"), "utf8")) as unknown;
    expect(validateConfig(raw, { SHUTTLE_PROD: "1" }).mode).toBe("push-only");
  });
  it("rejects bad values, secrets and onTrip apply in production", () => {
    expect(() => validateConfig({ ...base(), mode: "sideways" }, {})).toThrow(ConfigError);
    expect(() => validateConfig({ ...base(), remote: { ...base().remote, token: "sxd_abc" } }, {})).toThrow(/secrets do not belong/);
    expect(() => validateConfig({ ...base(), guards: { onTrip: "apply" } }, { SHUTTLE_PROD: "1" })).toThrow(/refused/);
    expect(() => validateConfig({ ...base(), guards: { onTrip: "apply" } }, {})).not.toThrow();
    expect(() => validateConfig({ ...base(), configCategories: { nope: true } }, {})).toThrow(/unknown category/);
    expect(() => validateConfig({ ...base(), watch: { mode: "hybrid", pollIntervalSec: 0 } }, {})).toThrow(ConfigError);
  });
});

describe("secrets (design §4.12.1)", () => {
  const sample = (): HeadlessSecrets => ({
    format: SECRETS_FORMAT, v: 1, vaultId: "vault", deviceId: "dev", serverUrls: ["https://sync.example.com"],
    token: "sxd_" + "A".repeat(40), keys: { "1": "k".repeat(43) }, seen: null,
  });
  it("writes 0600 in a 0700 dir and refuses group/world access (exit 3)", async () => {
    const f = path.join(dir, "st/secret/secrets.json");
    writeSecrets(f, sample());
    expect(readSecrets(f).token).toBe(sample().token);
    await chmod(f, 0o644);
    expect(() => readSecrets(f)).toThrow(/permissions too open \(0644\); expected 0600/);
    try { readSecrets(f); } catch (e) { expect((e as SecretsError).exitCode).toBe(3); }
    await chmod(f, 0o600);
    await chmod(path.dirname(f), 0o755);
    expect(() => readSecrets(f)).toThrow(/directory permissions too open/);
    await chmod(path.dirname(f), 0o700);
    expect(() => readSecrets(path.join(dir, "nope/secret/secrets.json"))).toThrow(SecretsError);
  });
});

describe("log (design §6.1.10)", () => {
  it("redacts tokens, codes and registered secrets; JSON lines and text format", () => {
    clearSecretsForTests();
    addSecret("my-vmk-material-1234");
    expect(redact("token sxd_abcdefghijklmnopqrstuvwx and SXE-123-abc and SXK-x-y and my-vmk-material-1234"))
      .toBe("token sxd_[redacted] and SXE-[redacted] and SXK-[redacted] and [redacted]");
    const l = memoryLogger();
    l.info("network", "connected", { path: "a.md", n: 2 });
    l.engine({ ts: 1, level: "error", cat: "error", key: "log.error", params: { error: "x" }, path: "b.md" });
    const lines = l.lines.map((x) => JSON.parse(x) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ level: "info", cat: "network", msg: "connected", path: "a.md", n: 2 });
    expect(lines[1]).toMatchObject({ level: "error", cat: "error", msg: "log.error", path: "b.md" });
    const t = memoryLogger("text");
    t.warn("watcher", "polling only");
    expect(t.lines[0]).toMatch(/WARN\s+\[watcher\] polling only/);
    clearSecretsForTests();
  });
});

describe("supervisor (design §6.1.7)", () => {
  it("decides stalls only when not paused", () => {
    expect(isStalled({ now: 1_000_000, heartbeatAt: 0, stallSec: 600, paused: false })).toBe(true);
    expect(isStalled({ now: 1_000_000, heartbeatAt: 0, stallSec: 600, paused: true })).toBe(false);
    expect(isStalled({ now: 500_000, heartbeatAt: 0, stallSec: 600, paused: false })).toBe(false);
  });
  it("watchdog exits 1 on a stall; terminate() stops gracefully with exit 0", async () => {
    const exits: number[] = [];
    const log = memoryLogger();
    const s = new Supervisor({ log, stallSec: 1, heartbeat: () => 0, paused: () => false, now: () => 10_000, checkMs: 20,
      shutdown: async () => undefined, installProcessHandlers: false, exit: (c) => exits.push(c) });
    s.start();
    await waitFor(() => exits.length > 0, 5000, 10, "watchdog exit");
    s.stop();
    expect(exits[0]).toBe(1);
    expect(log.lines.some((l) => l.includes("sync loop stalled"))).toBe(true);
    const exits2: number[] = [];
    const s2 = new Supervisor({ log, stallSec: 600, heartbeat: () => Date.now(), paused: () => false, shutdown: async () => undefined,
      installProcessHandlers: false, exit: (c) => exits2.push(c) });
    await s2.terminate("SIGTERM");
    expect(exits2).toEqual([0]);
  });
});

describe("pairing crypto (design §4.12.2)", () => {
  it("round-trips, binds the vault and refuses other sessions' envelopes", async () => {
    const sess = await startPairing("vault-1");
    const link = parsePairingLink(sess.link);
    expect(link).toEqual({ vaultId: "vault-1", pairId: sess.pairId, pkH: sess.pkH });
    expect(sess.link).not.toMatch(/keys|vmk/i);
    const payload = { vaultId: "vault-1", keys: { "1": "a".repeat(43) }, infoRev: 3 };
    const body = await sealPairingEnvelope(link, payload);
    expect(await sess.open(body)).toEqual(payload);
    // Sealed to another session's public key: does not decrypt.
    const other = await startPairing("vault-1");
    await expect(other.open(body)).rejects.toMatchObject({ reason: "decrypt" });
    // Right key, payload naming another vault.
    const wrongVault = await sealPairingEnvelope(link, { ...payload, vaultId: "vault-2" });
    await expect(sess.open(wrongVault)).rejects.toMatchObject({ reason: "vault" });
    await expect(sess.open("not json")).rejects.toBeInstanceOf(PairingError);
    // Tampered ciphertext.
    const t = JSON.parse(body) as { ct: string };
    t.ct = (t.ct[0] === "A" ? "B" : "A") + t.ct.slice(1);
    await expect(sess.open(JSON.stringify(t))).rejects.toMatchObject({ reason: "decrypt" });
  });
  it("waitForEnvelope polls until an answer or the timeout", async () => {
    let n = 0;
    const got = await waitForEnvelope({ pairingTake: async () => (++n >= 3 ? "{}" : null) }, "p", { timeoutMs: 5000, intervalMs: 1 });
    expect(got).toBe("{}");
    await expect(waitForEnvelope({ pairingTake: async () => null }, "p", { timeoutMs: 20, intervalMs: 5 })).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("control socket (design §6.1.8)", () => {
  it("serves status, guards and actions over a 0600 unix socket", async () => {
    const sock = path.join(dir, "c.sock");
    const calls: string[] = [];
    const srv = new ControlServer(sock, {
      status: () => ({ s: 1 }), health: () => ({ status: "ok" }), guards: () => [{ id: "g1", kind: "massDeleteLocal" }], debug: () => ({ token: "sxd_" + "Z".repeat(30) }),
      answerGuard: (id, choice) => { calls.push(`${id}:${choice}`); return id === "g1"; },
      pause: () => calls.push("pause"), resume: () => calls.push("resume"), kick: () => calls.push("kick"), rescan: () => calls.push("rescan"),
    });
    await srv.start();
    const { stat } = await import("node:fs/promises");
    expect((await stat(sock)).mode & 0o777).toBe(0o600);
    const c = new ControlClient(sock);
    expect((await c.get("/health")).data).toEqual({ status: "ok" });
    expect((await c.get("/debug")).data).toEqual({ token: "sxd_[redacted]" });
    expect((await c.post("/guards/g1", { choice: "apply" })).status).toBe(200);
    expect((await c.post("/guards/g9", { choice: "apply" })).status).toBe(404);
    expect((await c.post("/guards/g1", { choice: "nope" })).status).toBe(400);
    for (const p of ["/pause", "/resume", "/kick", "/rescan"]) expect((await c.post(p)).status).toBe(200);
    expect(calls).toEqual(["g1:apply", "g9:apply", "pause", "resume", "kick", "rescan"]);
    await srv.stop();
    await expect(c.get("/health")).rejects.toBeInstanceOf(ControlUnreachable);
  });
});

describe("watcher folder moves (design §6.1.4, I18)", () => {
  it("a folder moved inside the vault is one folder rename (same inode), never delete + create", async () => {
    const vault = path.join(dir, "wv");
    await mkdir(path.join(vault, "src/sub"), { recursive: true });
    await writeFile(path.join(vault, "src/sub/a.md"), "a");
    const fs = new NodeLocalFs({ root: vault, tmpDir: path.join(dir, "wtmp") });
    const events: LocalEvent[] = [];
    fs.onEvent((e) => events.push(e));
    const w = new Watcher({ fs, mode: "hybrid", probe: { maxUserWatches: async () => 1_000_000, usedWatches: async () => 0 } });
    await w.start();
    await new Promise((r) => setTimeout(r, 100));             // inode bookkeeping is async
    await rename(path.join(vault, "src"), path.join(vault, "dst"));
    await waitFor(() => events.some((e) => e.t === "rename"), 10_000, 20, "folder rename");
    await new Promise((r) => setTimeout(r, 1000));            // past the folder-delete hold
    expect(events.filter((e) => e.t === "rename")).toEqual([{ t: "rename", from: "src", to: "dst", kind: "folder" }]);
    expect(events.filter((e) => e.t === "delete")).toEqual([]);
    // The subtree is watched under its new name.
    await writeFile(path.join(vault, "dst/sub/b.md"), "b");
    await waitFor(() => events.some((e) => (e.t === "create" || e.t === "modify") && e.path === "dst/sub/b.md"), 10_000, 20, "event under new name");
    // Moved out of the vault: a folder delete after the hold.
    await rename(path.join(vault, "dst"), path.join(dir, "outside"));
    await waitFor(() => events.some((e) => e.t === "delete" && e.path === "dst"), 10_000, 20, "folder delete");
    w.stop();
  });
});
