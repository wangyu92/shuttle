// Ingest, integrity and snapshot resync (design §3.8.1, §3.8.6, §4.9.1, §4.14; I2, I13, I21, I30).
import type { VersionRecord } from "@shuttle/protocol";
import { describe, expect, it } from "vitest";
import { readMeta } from "../src/index";
import { Device, bigBytes, makeWorld, recordsOf, serverMap, sortedEntries, type World } from "./harness";

function edit(w: World, d: Device, path: string, content: string | Uint8Array): void {
  w.clock.tick(1000);
  d.fs.external.write(path, content, { mtime: w.clock.now() });
}

function serverLog(w: World): Map<number, VersionRecord> {
  return (w.server as unknown as { log: Map<number, VersionRecord> }).log;
}

async function pair(seed: string): Promise<{ w: World; a: Device; b: Device }> {
  const w = await makeWorld(seed);
  const a = new Device(w, { name: "alpha" });
  const b = new Device(w, { name: "beta" });
  await a.start();
  await b.start();
  return { w, a, b };
}

describe("ingest integrity (design §4.9.1, §4.14)", () => {
  it("a tampered record is quarantined: hold set, local copy untouched, cursor advances", async () => {
    const { w, a, b } = await pair("tamper");
    edit(w, a, "t.md", "v1\n");
    await a.sync();
    await b.sync();
    expect(b.fs.readText("t.md")).toBe("v1\n");
    b.sub?.close();
    edit(w, a, "t.md", "v2\n");
    await a.sync(3);
    const rec = recordsOf(w).at(-1)!;
    const log = serverLog(w);
    const bad = { ...rec, meta: rec.meta.slice(0, -4) + (rec.meta.endsWith("AAAA") ? "BBBB" : "AAAA") };
    log.set(rec.seq, bad);
    b.sub = b.remote.subscribe((await readMeta(b.store, "cursor")) ?? 0, b.ingest);
    await w.server.settle();
    await b.sync();
    expect(b.fs.readText("t.md")).toBe("v1\n");
    const e = b.index.byPath("t.md")!;
    expect(e.integrityHold).toBe(true);
    const integ = await b.store.tx(["integrity"], (tx) => tx.integrity.getAll(), "readonly");
    expect(integ.map((q) => q.seq)).toEqual([rec.seq]);
    expect(await readMeta(b.store, "cursor")).toBeGreaterThanOrEqual(rec.seq);
    expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "commit")).toHaveLength(0);
  });

  it("a replayed create over an existing head is rejected before decryption (stage freshness)", async () => {
    const { w, a, b } = await pair("replaycreate");
    edit(w, a, "r.md", "v1\n");
    await a.sync();
    await b.sync();
    b.sub?.close();
    edit(w, a, "r.md", "v2\n");
    await a.sync(3);
    const rec = recordsOf(w).at(-1)!;
    serverLog(w).set(rec.seq, { ...rec, base: null });
    b.sub = b.remote.subscribe((await readMeta(b.store, "cursor")) ?? 0, b.ingest);
    await w.server.settle();
    await b.sync();
    const integ = await b.store.tx(["integrity"], (tx) => tx.integrity.getAll(), "readonly");
    expect(integ[0]).toMatchObject({ seq: rec.seq, stage: "freshness" });
    expect(b.fs.readText("r.md")).toBe("v1\n");
  });
});

describe("apply gates", () => {
  it("I13: a remote file in an excluded folder is never downloaded", async () => {
    const w = await makeWorld("excluded");
    // a has no exclusion for this path; b's (default) scope function excludes `excluded/`.
    const a = new Device(w, { name: "alpha", scope: (p) => (p.split("/").some((x) => x.startsWith(".")) ? "ignored" : "active") });
    const b = new Device(w, { name: "beta" });
    await a.start();
    await b.start();
    a.fs.external.write("excluded/x.bin", bigBytes("x"));
    edit(w, a, "keep.md", "keep\n");
    await a.sync();
    const before = w.server.calls.filter((c) => c.device === b.deviceId && c.method === "getBlob").length;
    await b.sync();
    expect(b.fs.exists("excluded/x.bin")).toBe(false);
    expect(b.fs.readText("keep.md")).toBe("keep\n");
    expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "getBlob").length).toBe(before);
    const deferred = await b.store.tx(["deferred"], (tx) => tx.deferred.getAll(), "readonly");
    expect(deferred.map((x) => x.path)).toEqual(["excluded/x.bin"]);
  });

  it("design §3.8.3: a mass remote delete is held until confirmed", async () => {
    const { w, a, b } = await pair("massdel");
    for (let i = 0; i < 30; i++) a.fs.external.write(`m/f${i}.md`, `file ${i}\n`);
    await a.sync();
    await b.sync();
    expect(b.fs.files().size).toBe(30);
    for (let i = 0; i < 30; i++) a.fs.external.remove(`m/f${i}.md`);
    await a.sync();
    await b.sync();
    expect(b.fs.files().size).toBe(30);
    expect(b.logs.some((l) => l.key === "log.massDeleteRemotePaused")).toBe(true);
    expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "commit")).toHaveLength(0);
    (b.applier as unknown as { d: { confirmMassDelete: () => boolean } }).d.confirmMassDelete = () => true;
    await b.sync();
    expect(b.fs.files().size).toBe(0);
    expect(b.fs.trash.length).toBe(30);
  });
});

describe("snapshot resync (design §3.8.6, I21)", () => {
  it("an expired cursor resyncs from the snapshot; purged tombstones delete via S8 (trash)", async () => {
    const { w, a, b } = await pair("resync");
    edit(w, a, "keep.md", "keep\n");
    edit(w, a, "gone.md", "gone\n");
    await a.sync();
    await b.sync();
    // b goes offline; a deletes one file and edits the other; the server purges history.
    b.sub?.close();
    await b.remote.close();
    a.fs.external.remove("gone.md");
    edit(w, a, "keep.md", "keep v2\n");
    edit(w, a, "new.md", "new\n");
    await a.sync();
    w.server.expire(w.server.headSeq);
    expect(w.server.minSeq).toBeGreaterThan(0);
    await b.restart();
    await w.server.settle();
    expect(b.snapshotRequired).toBe(1);
    const r = await b.ingest.snapshotResync("snapshotResync");
    expect(r.purged.length).toBe(1);
    b.ctx = { mode: "snapshotResync" };
    await b.sync();
    b.ctx = { mode: "incremental" };
    expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(await serverMap(w)));
    expect(b.fs.trash.map((t) => t.path)).toContain("gone.md");
    expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "commit")).toHaveLength(0);
    // The cursor now continues live from the snapshot.
    b.sub?.close();
    b.sub = b.remote.subscribe((await readMeta(b.store, "cursor")) ?? 0, b.ingest);
    edit(w, a, "after.md", "after\n");
    await a.sync();
    await b.sync();
    expect(b.fs.readText("after.md")).toBe("after\n");
  });
});

describe("torn writes (design §3.8.4 S9, I30)", () => {
  it("a write torn by a crash is rewritten from the remote head on restart and never pushed", async () => {
    const { w, a, b } = await pair("torn");
    edit(w, a, "doc.md", "version one\n");
    await a.sync();
    await b.sync();
    edit(w, a, "doc.md", "version two, longer\n");
    await a.sync();
    // Crash right after the intent is persisted, before the write; then tear the file by hand.
    const origCrash = (b as unknown as { hooks: { crashPoint: (n: string) => void } }).hooks;
    const prev = origCrash.crashPoint;
    origCrash.crashPoint = (name: string) => {
      if (name === "apply:intent") {
        b.fs.external.write("doc.md", "version t");     // half-written bytes
        b.crash(name);
      }
      prev(name);
    };
    await w.server.settle();
    await expect(b.sync()).rejects.toThrow();
    origCrash.crashPoint = prev;
    expect(b.fs.readText("doc.md")).toBe("version t");
    await b.restart();
    expect(b.fs.readText("doc.md")).toBe("version two, longer\n");
    await b.sync();
    expect(b.fs.readText("doc.md")).toBe("version two, longer\n");
    expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "commit")).toHaveLength(0);
    expect(await b.store.tx(["intents"], (tx) => tx.intents.getAll(), "readonly")).toEqual([]);
  });

  it("reconcile treats a torn file as an engine write (reapply), not as a user edit", async () => {
    const { w, a, b } = await pair("torn2");
    edit(w, a, "doc.md", "one\n");
    await a.sync();
    await b.sync();
    const e = b.index.byPath("doc.md")!;
    const R = b.index.remote.byFileId(e.fileId)!;
    await b.intents.put({ path: "doc.md", fileId: e.fileId, preHash: "0".repeat(64), targetHash: R.contentHash });
    edit(w, b, "doc.md", "garbage");
    await b.sync();
    expect(b.fs.readText("doc.md")).toBe("one\n");
    expect(w.server.calls.filter((c) => c.device === b.deviceId && c.method === "commit")).toHaveLength(0);
  });
});
