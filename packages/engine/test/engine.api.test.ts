// Public engine API (design §3.17): start/stop, pause/resume, lock/unlock, status and events,
// two-device convergence through createEngine, debug info and the activity log without secrets (H3).

import { afterAll, describe, expect, it } from "vitest";
import { assertNoSecrets } from "@shuttle/testkit";
import type { EngineStatus, LogEntry, VersionRecord } from "@shuttle/protocol";
import { Node, makeWorld, serverMap, sortedEntries, syncAll } from "./engineHarness";

const PASS = "correct horse battery staple for alice";
const captured: string[] = [];

/** The test VMK of makeWorld() (harness.ts): key bytes must never appear in any output (H3). */
const VMK = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);

afterAll(() => {
  assertNoSecrets(captured.join("\n"), [{ name: "passphrase", value: PASS }, { name: "vmk", value: VMK }]);
});

describe("engine API", () => {
  it("two devices converge through createEngine (I7)", async () => {
    const w = await makeWorld("api-converge");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "notes/one.md": "hello\n", "img/p.png": new Uint8Array([1, 2, 3]) });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(await a.diskMap()));
    expect(sortedEntries(await serverMap(w))).toEqual(sortedEntries(await a.diskMap()));
    expect(a.engine.status().status).toBe("synced");
    b.fs.external.write("notes/one.md", "hello\nfrom beta\n");
    b.engine.requestScan();
    await syncAll([a, b]);
    expect(a.fs.readText("notes/one.md")).toBe("hello\nfrom beta\n");
    captured.push(JSON.stringify(a.engine.log.entries()), JSON.stringify(a.engine.debugInfo()), JSON.stringify(a.engine.status()));
  });

  it("pause stops network work; resume continues", async () => {
    const w = await makeWorld("api-pause");
    const a = new Node(w, { name: "alpha" });
    await a.start();
    const statuses: EngineStatus[] = [];
    a.engine.on("status", (s) => statuses.push(s));
    a.engine.pause();
    expect(a.engine.status().status).toBe("paused");
    a.fs.external.write("x.md", "x");
    a.engine.requestScan();
    const r = await a.engine.runOnce();
    expect(r.ran).toBe(false);
    expect(w.server.inspect().log.length).toBe(0);
    a.engine.resume();
    await a.engine.whenConnected();
    await a.sync();
    expect((await serverMap(w)).size).toBe(1);
    expect(statuses.some((s) => s.status === "paused")).toBe(true);
  });

  it("Locked: no commits and no hashing; unlock resumes (design §3.13)", async () => {
    const w = await makeWorld("api-lock");
    const a = new Node(w, { name: "alpha", opts: { unlock: async (p) => { if (p !== PASS) throw new Error("WrongPassphrase"); return { ring: w.ring }; } } });
    await a.start();
    await a.engine.lock();
    expect(a.engine.status().locked).toBe(true);
    a.fs.external.write("l.md", "locked edit");
    a.engine.requestScan();
    a.fsOps.length = 0;
    await a.engine.runOnce();
    expect(a.ops("read")).toEqual([]);
    expect(w.server.inspect().log.length).toBe(0);
    await expect(a.engine.unlock("wrong")).rejects.toThrow();
    expect(a.engine.status().locked).toBe(true);
    await a.engine.unlock(PASS);
    a.engine.requestScan();
    await a.sync();
    expect([...(await serverMap(w)).keys()]).toEqual(["l.md"]);
    captured.push(JSON.stringify(a.engine.log.entries()), JSON.stringify(a.engine.debugInfo()));
  });

  it("log entries are key + params; debugInfo carries no credentials", async () => {
    const w = await makeWorld("api-debug");
    const a = new Node(w, { name: "alpha", opts: { host: "sync.example.com" } });
    const logs: LogEntry[] = [];
    a.fs.seed({ "a.md": "a" });
    await a.start();
    a.engine.on("log", (e) => logs.push(e));
    await a.sync();
    const di = a.engine.debugInfo();
    expect(di.remote.host).toBe("sync.example.com");
    expect(di.indexByScope.active).toBe(1);
    expect(di.filterFingerprint).toMatch(/^f1-/);
    expect(logs.some((l) => l.key === "log.fullySynced")).toBe(true);
    for (const l of a.engine.log.entries()) expect(typeof l.key).toBe("string");
    captured.push(JSON.stringify(di));
  });

  it("stop() is idempotent and leaves no timers running in manual mode", async () => {
    const w = await makeWorld("api-stop");
    const a = new Node(w, { name: "alpha" });
    await a.start();
    await a.engine.stop();
    await a.engine.stop();
    expect(a.engine.status().status).toBe("disconnected");
  });

  it("repair() re-commits the local content over a quarantined head (design §4.14)", async () => {
    const w = await makeWorld("api-repair");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "t.md": "v1\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    await b.engine.stop();
    w.clock.tick(1000);
    a.fs.external.write("t.md", "v2\n", { mtime: w.clock.now() });
    a.engine.requestScan();
    await a.sync();
    const log = (w.server as unknown as { log: Map<number, VersionRecord> }).log;
    const rec = [...log.values()].at(-1)!;
    log.set(rec.seq, { ...rec, meta: rec.meta.slice(0, -4) + (rec.meta.endsWith("AAAA") ? "BBBB" : "AAAA") });
    await b.restart();
    await syncAll([b]);
    const e = b.engine.index.byPath("t.md")!;
    expect(e.integrityHold).toBe(true);
    expect(b.engine.status()).toMatchObject({ status: "error", reason: "integrity" });
    expect(b.fs.readText("t.md")).toBe("v1\n");
    await b.engine.repair(e.fileId);
    await syncAll([b, a]);
    expect(b.engine.index.byPath("t.md")!.integrityHold).toBeFalsy();
    expect(a.fs.readText("t.md")).toBe("v1\n");
    expect(b.engine.status().status).toBe("synced");
    captured.push(JSON.stringify(b.engine.log.entries()), JSON.stringify(b.engine.debugInfo()));
  });

  it("v2 hooks: versions() lists history, deletedFiles() lists tombstones", async () => {
    const w = await makeWorld("api-v2");
    const a = new Node(w, { name: "alpha" });
    a.fs.seed({ "h.md": "one\n", "d.md": "bye\n" });
    await a.start();
    await a.sync();
    w.clock.tick(1000);
    a.fs.external.write("h.md", "two\n", { mtime: w.clock.now() });
    a.fs.external.remove("d.md");
    a.engine.requestScan();
    await a.sync();
    const id = a.engine.index.byPath("h.md")!.fileId;
    expect((await a.engine.versions(id)).length).toBe(2);
    expect(a.engine.deletedFiles().map((h) => h.path)).toEqual(["d.md"]);
  });
});
