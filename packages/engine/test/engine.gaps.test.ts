// Engine gaps closed in P1 part 2 (design §3.7.4, §3.10.1, §3.13, §3.15, §2.11, §4.5.3, §2.12 headOf),
// through createEngine() against FakeRemote. Fixtures only: no real hosts or users.

import { describe, expect, it } from "vitest";
import type { GuardEvent, VaultInfo, VersionRecord } from "@shuttle/protocol";
import { isRemoteError } from "@shuttle/protocol";
import { FakeClock, FakeKeyring, FakeRemoteServer, FakeScheduler, Prng } from "@shuttle/testkit";
import {
  BLOB_TIMEOUT_BASE_MS, METADATA_TIMEOUT_MS, MERGE_MAX_BYTES, blobTimeoutMs, merge3, withRequestTimeouts,
} from "../src/index";
import { sha256HexSync } from "./sha256";
import { Node, makeWorld, serverMap, sortedEntries, syncAll, type World } from "./engineHarness";

const PASS = "correct horse battery staple for alice";

function edit(w: World, n: Node, path: string, content: string | Uint8Array): void {
  w.clock.tick(1000);
  n.fs.external.write(path, content, { mtime: w.clock.now() });
  n.engine.requestScan();
}

async function pair(seed: string, o: { a?: ConstructorParameters<typeof Node>[1]; b?: ConstructorParameters<typeof Node>[1] } = {}) {
  const w = await makeWorld(seed);
  const a = new Node(w, o.a ?? { name: "alpha" });
  const b = new Node(w, o.b ?? { name: "beta" });
  await a.start();
  await b.start();
  return { w, a, b };
}

async function converged(w: World, ...ns: Node[]): Promise<void> {
  const remote = sortedEntries(await serverMap(w));
  for (const n of ns) expect(sortedEntries(await n.diskMap())).toEqual(remote);
}

const unlockWith = (w: World) => ({ unlock: async (p: string) => { if (p !== PASS) throw new Error("WrongPassphrase"); return { ring: w.ring }; } });

describe("conflict-loop fallback (design §3.10.1)", () => {
  it("CONFLICT results feed the tracker; once tripped the next resolution is a conflict copy, then it resets", async () => {
    const { w, a, b } = await pair("loop");
    edit(w, a, "doc.md", "line one\nline two\nline three\n");
    await syncAll([a, b]);
    const fileId = b.engine.index.byPath("doc.md")!.fileId;
    // Four earlier CONFLICTs inside the window (as a fast ping-pong would produce)...
    for (let i = 0; i < 4; i++) b.engine.conflictLoops.recordConflict(fileId);
    expect(b.engine.conflictLoops.tripped(fileId)).toBe(false);
    // ...and a fifth, real one: alpha commits while beta's feed is held, beta pushes on the old base.
    w.server.pauseFeed();
    edit(w, a, "doc.md", "line one EDITED BY ALPHA\nline two\nline three\n");
    await a.sync();
    edit(w, b, "doc.md", "line one\nline two\nline three EDITED BY BETA\n");
    await b.flushEvents();
    await b.engine.runOnce();
    expect(b.engine.conflictLoops.tripped(fileId)).toBe(true);
    w.server.resumeFeed();
    await syncAll([a, b]);
    // A clean dmp3 merge was possible, but the loop fallback made a conflict copy instead.
    const copies = [...b.fs.files().keys()].filter((p) => p.includes("Conflicted copy"));
    expect(copies.length).toBe(1);
    expect(b.engine.log.entries().some((e) => e.key === "log.conflictLoop")).toBe(true);
    expect(b.engine.conflictLoops.tripped(fileId)).toBe(false);
    await converged(w, a, b);
  });
});

describe("D2 merge cap and determinism", () => {
  it("merge3: inputs above MERGE_MAX_BYTES are unclean (tooLarge); Diff_Timeout 0 gives the same result twice", () => {
    const big = "x".repeat(MERGE_MAX_BYTES + 1);
    expect(merge3("a", big, "b")).toMatchObject({ clean: false, reason: "tooLarge" });
    // Multi-byte text: 400k UTF-16 units of a 3-byte character are 1.2 MB of UTF-8.
    const wide = "€".repeat(400_000);
    expect(merge3(wide, wide + "l", "r" + wide)).toMatchObject({ clean: false, reason: "tooLarge" });
    const base = Array.from({ length: 300 }, (_, i) => `row ${i}\n`).join("");
    const l = base.replace("row 10\n", "row 10 local\n");
    const r = base.replace("row 250\n", "row 250 remote\n");
    expect(merge3(base, l, r)).toEqual(merge3(base, l, r));
    expect(merge3(base, l, r).clean).toBe(true);
  });

  it("a note above the cap edited on both sides gets a conflict copy, never a merge", async () => {
    const { w, a, b } = await pair("d2-cap");
    const row = (i: number) => `row ${i} ${"lorem ipsum ".repeat(6)}\n`;
    const rows = Array.from({ length: 15_000 }, (_, i) => row(i));
    const base = rows.join("");
    expect(base.length).toBeGreaterThan(MERGE_MAX_BYTES);
    edit(w, a, "big.md", base);
    await syncAll([a, b]);
    w.server.pauseFeed();
    edit(w, a, "big.md", base.replace(row(3), "alpha was here\n"));
    await a.sync();
    edit(w, b, "big.md", base.replace(row(14_000), "beta was here\n"));
    await b.flushEvents();
    await b.engine.runOnce();
    w.server.resumeFeed();
    await syncAll([a, b]);
    expect([...b.fs.files().keys()].some((p) => p.includes("Conflicted copy"))).toBe(true);
    expect(b.engine.log.entries().some((e) => e.key === "log.mergeTooLarge")).toBe(true);
    await converged(w, a, b);
  }, 120_000);
});

describe("per-request timeouts (design §3.7.4)", () => {
  it("metadata 60 s, blobs 30 s + size / 64 KiB/s, on the injected scheduler; the timer is always cleared", async () => {
    const clock = new FakeClock();
    const sch = new FakeScheduler(clock);
    const server = new FakeRemoteServer({ clock });
    const raw = server.adapter("timeoutdev00000000000");
    const r = withRequestTimeouts(raw, sch);
    expect(r.kind).toBe(raw.kind);
    expect(r.capabilities).toBe(raw.capabilities);
    await r.connect();
    expect(sch.pending).toBe(0);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    server.onCall = async (c) => { if (c.method === "getVaultInfo" || c.method === "putBlob") await held; };
    const meta = r.getVaultInfo();
    const metaOut = meta.then(() => "ok", (e: unknown) => (isRemoteError(e, "TIMEOUT") && e.retryable ? "timeout" : "other"));
    await sch.advance(METADATA_TIMEOUT_MS - 1);
    let state = "pending";
    void metaOut.then((s) => { state = s; });
    await Promise.resolve();
    expect(state).toBe("pending");
    await sch.advance(2);
    expect(await metaOut).toBe("timeout");
    const size = 1024 * 1024;
    expect(blobTimeoutMs(size)).toBe(BLOB_TIMEOUT_BASE_MS + 16_000);
    const blob = r.putBlob("a".repeat(64), new Uint8Array(size)).then(() => "ok", (e: unknown) => (isRemoteError(e, "TIMEOUT") ? "timeout" : String(e)));
    let blobState = "pending";
    void blob.then((s) => { blobState = s; });
    await sch.advance(BLOB_TIMEOUT_BASE_MS + 15_000);
    expect(blobState).toBe("pending");
    await sch.advance(1001);
    expect(await blob).toBe("timeout");
    // The late completions are dropped silently (idempotent calls), and no timer is left behind.
    release();
    server.onCall = null;
    await server.settle();
    expect(sch.pending).toBe(0);
    expect(sch.errors).toEqual([]);
    await r.getVaultInfo();
    expect(sch.pending).toBe(0);
  });

  it("a commit that never answers times out, backs off, and the resend (same cid) is a replay", async () => {
    const { w, a } = await pair("timeout-commit");
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let hang = true;
    let entered = false;
    w.server.onCall = async (c) => { if (hang && c.method === "commit" && c.device === a.deviceId) { hang = false; entered = true; await held; } };
    edit(w, a, "t.md", "timeout\n");
    await a.flushEvents();
    const run = (async () => {
      for (let i = 0; i < 10 && !entered; i++) {
        await a.engine.runOnce();
        await w.server.settle();
      }
    })();
    for (let i = 0; i < 500 && !entered; i++) await new Promise((r) => setTimeout(r, 2));
    expect(entered).toBe(true);
    await a.scheduler.advance(METADATA_TIMEOUT_MS + 1);
    await run;
    expect(a.engine.log.lastErrors()).toBeDefined();
    expect(a.engine.status().pendingUp).toBe(1);
    // The held commit now reaches the server after all; the engine's resend replays the same cid.
    release();
    w.server.onCall = null;
    await w.server.settle();
    w.clock.tick(10 * 60 * 1000);
    await syncAll([a]);
    const recs = (w.server.inspect().log as VersionRecord[]).filter((x) => x.device === a.deviceId);
    expect(recs.length).toBe(1);
    expect(w.server.stats.replays).toBeGreaterThanOrEqual(1);
    expect(a.engine.status().pendingUp).toBe(0);
  });
});

describe("Locked (design §3.13)", () => {
  it("lock closes the feed; unlock resubscribes from the persisted cursor (no snapshot) and catches up", async () => {
    const w = await makeWorld("lock-feed");
    const a = new Node(w, { name: "alpha" });
    const beta = new Node(w, { name: "beta", opts: unlockWith(w) });
    await a.start();
    await beta.start();
    edit(w, a, "one.md", "one\n");
    await syncAll([a, beta]);
    await beta.engine.lock();
    expect(beta.engine.status()).toMatchObject({ status: "paused", reason: "locked", locked: true });
    const calls0 = w.server.calls.length;
    edit(w, a, "two.md", "two\n");
    await a.sync();
    await syncAll([beta], 4);
    expect(beta.fs.exists("two.md")).toBe(false);
    const after = w.server.calls.slice(calls0).filter((c) => c.device === beta.deviceId).map((c) => c.method);
    expect(after).not.toContain("subscribe");
    await beta.engine.unlock(PASS);
    await syncAll([a, beta]);
    expect(beta.fs.readText("two.md")).toBe("two\n");
    const methods = w.server.calls.slice(calls0).filter((c) => c.device === beta.deviceId).map((c) => c.method);
    expect(methods).toContain("subscribe");
    expect(methods).not.toContain("snapshot");
    await converged(w, a, beta);
  });

  it("locked mid-pass: the remaining keys are held (each reconciled at most once), no busy loop, planned after unlock", async () => {
    const w = await makeWorld("lock-spin");
    const a = new Node(w, { name: "alpha", opts: unlockWith(w) });
    const n = 40;
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`n/${String(i).padStart(2, "0")}.md`] = `note ${i}\n`;
    a.fs.seed(files);
    await a.start();
    let locked = false;
    a.fs.before((op, p) => {
      if (!locked && op === "read" && p === "n/05.md") {
        locked = true;
        void a.engine.lock();
      }
    });
    a.fsOps.length = 0;
    for (let i = 0; i < 10 && !locked; i++) {
      await a.engine.runOnce();
      await w.server.settle();
    }
    expect(locked).toBe(true);
    const reads = new Map<string, number>();
    for (const o of a.fsOps) if (o.op === "read") reads.set(o.path, (reads.get(o.path) ?? 0) + 1);
    for (const c of reads.values()) expect(c).toBeLessThanOrEqual(2);
    const before = a.fsOps.length;
    for (let i = 0; i < 5; i++) {
      const r = await a.engine.runOnce();
      expect(r.work).toBe(0);
    }
    expect(a.fsOps.length).toBe(before);
    expect(w.server.inspect().log.length).toBeLessThan(n);
    await a.engine.unlock(PASS);
    await a.sync();
    expect((await serverMap(w)).size).toBe(n);
  });
});

describe("blob request concurrency (design §3.15)", () => {
  async function peakOf(w: World, method: "putBlob" | "getBlob", run: () => Promise<void>): Promise<number> {
    let inflight = 0;
    let peak = 0;
    w.server.onCall = async (c) => {
      if (c.method !== method) return;
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
    };
    try {
      await run();
    } finally {
      w.server.onCall = null;
    }
    return peak;
  }

  it("desktop: up to 4 concurrent uploads and downloads, never more", async () => {
    const { w, a, b } = await pair("conc-desktop");
    edit(w, a, "big.bin", new Prng("big").bytes(300_000));
    const up = await peakOf(w, "putBlob", () => a.sync());
    expect(up).toBeGreaterThan(1);
    expect(up).toBeLessThanOrEqual(4);
    const down = await peakOf(w, "getBlob", () => syncAll([a, b]));
    expect(down).toBeGreaterThan(1);
    expect(down).toBeLessThanOrEqual(4);
    await converged(w, a, b);
  });

  it("after a failed blob the queued ones are not started (a dead remote fails fast, then backs off)", async () => {
    const { w, a } = await pair("conc-abort");
    edit(w, a, "big.bin", new Prng("abort").bytes(300_000));
    await a.flushEvents();
    w.server.injectFault({ method: "putBlob", device: a.deviceId });
    const puts = () => w.server.calls.filter((c) => c.device === a.deviceId && c.method === "putBlob").length;
    let during = -1;
    for (let i = 0; i < 10; i++) {
      const c0 = puts();
      await a.engine.runOnce();
      await w.server.settle();
      if ((await a.engine.journal.ops()).some((o) => o.lastError !== undefined)) {
        during = puts() - c0;
        break;
      }
    }
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThanOrEqual(5);
    w.clock.tick(10 * 60 * 1000);
    await a.sync();
    expect((await serverMap(w)).has("big.bin")).toBe(true);
  });

  it("mobile: at most 2", async () => {
    const w = await makeWorld("conc-mobile");
    const a = new Node(w, { name: "alpha", platform: "ios" });
    const b = new Node(w, { name: "beta", platform: "android" });
    await a.start();
    await b.start();
    edit(w, a, "big.bin", new Prng("big2").bytes(200_000));
    const up = await peakOf(w, "putBlob", () => a.sync());
    expect(up).toBe(2);
    const down = await peakOf(w, "getBlob", () => syncAll([a, b]));
    expect(down).toBe(2);
    await converged(w, a, b);
  });
});

describe("chunk cache (design §3.3.2, §3.15)", () => {
  it("desktop: a second download of the same content makes no blob request; node: disabled", async () => {
    const { w, a, b } = await pair("cache");
    edit(w, a, "pic.bin", new Prng("pic").bytes(80_000));
    await syncAll([a, b]);
    const R = b.engine.index.remote.byFileId(b.engine.index.byPath("pic.bin")!.fileId)!;
    const gets = () => w.server.calls.filter((c) => c.device === b.deviceId && c.method === "getBlob").length;
    const g0 = gets();
    const bytes = await b.engine.blobs.download(R, "attachment");
    expect(gets()).toBe(g0);
    expect(sha256HexSync(bytes)).toBe(R.contentHash);
    expect(b.engine.chunkCache.stats.hits).toBeGreaterThanOrEqual(R.blobs.length);
    expect(await b.engine.chunkCache.bytes()).toBeGreaterThan(0);

    const n = new Node(w, { name: "headless", platform: "node" });
    await n.start();
    await syncAll([n]);
    const Rn = n.engine.index.remote.byFileId(n.engine.index.byPath("pic.bin")!.fileId)!;
    const before = w.server.calls.filter((c) => c.device === n.deviceId && c.method === "getBlob").length;
    await n.engine.blobs.download(Rn, "attachment");
    const afterN = w.server.calls.filter((c) => c.device === n.deviceId && c.method === "getBlob").length;
    expect(afterN - before).toBe(Rn.blobs.length);
    expect(await n.engine.chunkCache.bytes()).toBe(0);
  });

  it("LRU eviction keeps the cache under its cap", async () => {
    const w = await makeWorld("cache-lru");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta", opts: { budgets: { chunkCacheBytes: 60_000 } } });
    await a.start();
    await b.start();
    for (let i = 0; i < 4; i++) edit(w, a, `f${i}.bin`, new Prng(`lru${i}`).bytes(40_000));
    await syncAll([a, b]);
    expect(await b.engine.chunkCache.bytes()).toBeLessThanOrEqual(60_000);
    expect(b.engine.chunkCache.stats.evictions).toBeGreaterThan(0);
    await converged(w, a, b);
  });
});

describe("vault-info refetch: welcome epoch (design §4.5.3, §2.11 step 5)", () => {
  async function rebuildElsewhere(w: World, o: { badMac?: boolean } = {}): Promise<void> {
    const info = w.server.inspect().info as VaultInfo;
    const next = { ...info, epoch: info.epoch + 1, infoRev: info.infoRev + 1 };
    const { infoMac: _m, ...unsigned } = next;
    next.infoMac = o.badMac ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" : await w.ring.macVaultInfo(unsigned as Parameters<typeof w.ring.macVaultInfo>[0]);
    w.server.rebuild(next);
  }

  it("a MAC'd newer epoch while connected: reconnect, epoch resync, nothing deleted (I28)", async () => {
    const { w, a, b } = await pair("refetch-ok");
    edit(w, a, "keep.md", "keep\n");
    await syncAll([a, b]);
    await rebuildElsewhere(w);
    await syncAll([a, b], 60);
    expect(a.engine.status().reason).not.toBe("tampered");
    expect(b.engine.status().reason).not.toBe("tampered");
    expect(a.fs.readText("keep.md")).toBe("keep\n");
    expect(b.fs.readText("keep.md")).toBe("keep\n");
    expect(a.fs.trash).toEqual([]);
    expect(b.fs.trash).toEqual([]);
    expect([...(await serverMap(w)).keys()]).toEqual(["keep.md"]);
  });

  it("a newer epoch whose vault-info MAC does not verify is tampering, not a rebuild", async () => {
    const { w, a, b } = await pair("refetch-bad");
    edit(w, a, "keep.md", "keep\n");
    await syncAll([a, b]);
    await rebuildElsewhere(w, { badMac: true });
    await syncAll([a, b], 20);
    expect(b.engine.status()).toMatchObject({ status: "error", reason: "tampered" });
    expect(w.server.inspect().log.length).toBe(0);
    expect(b.fs.readText("keep.md")).toBe("keep\n");
  });
});

describe("rebuild remote from this device (design §2.11, §5.6.9)", () => {
  it("precheck lists filtered files; rebuild re-uploads every file with the same fileId; others re-check, nothing deleted", async () => {
    const { w, a, b } = await pair("rebuild", { a: { name: "alpha", settings: { excludedFolders: ["Private"] } } });
    edit(w, b, "Private/secret.md", "only on beta\n");
    edit(w, b, "shared.md", "shared\n");
    edit(w, a, "mine.md", "mine\n");
    await syncAll([a, b]);
    const ids = new Map([...a.engine.index.all()].map((e) => [e.path, e.fileId]));
    const pre = a.engine.rebuildPrecheck();
    expect(pre.files).toBe(2);
    expect(pre.remoteOnly).toBeGreaterThanOrEqual(1);
    await expect(a.engine.rebuildRemote()).rejects.toMatchObject({ name: "RebuildNeedsConfirmation" });
    expect(w.server.inspect().epoch).toBe(1);
    await a.engine.rebuildRemote({ confirmFiltered: true });
    expect(w.server.inspect().epoch).toBe(2);
    const guards: GuardEvent[] = [];
    b.engine.on("guard", (g) => guards.push(g));
    await syncAll([a, b], 80);
    expect(a.engine.status().status).toBe("synced");
    // alpha's files are in the new epoch under their old fileIds; beta re-uploads what alpha lacks.
    const heads = w.server.inspect().heads;
    for (const [p, id] of ids) if (!p.startsWith("Private/")) expect(heads.some((h) => h.fileId === id), p).toBe(true);
    expect(b.fs.readText("Private/secret.md")).toBe("only on beta\n");
    expect([...(await serverMap(w)).keys()].sort()).toEqual(["Private/secret.md", "mine.md", "shared.md"]);
    expect(a.fs.trash).toEqual([]);
    expect(b.fs.trash).toEqual([]);
    expect((w.server.inspect().log as VersionRecord[]).filter((r) => r.kind === "del")).toEqual([]);
    expect([...a.fs.files().keys()].some((p) => p.includes("Conflicted copy"))).toBe(false);
    expect([...b.fs.files().keys()].some((p) => p.includes("Conflicted copy"))).toBe(false);
  });

  it("rollback guard 'rebuild': the server went back; this device's state becomes the remote", async () => {
    const { w, a, b } = await pair("rebuild-rollback");
    edit(w, a, "doc.md", "v1\n");
    await syncAll([a, b]);
    await b.engine.stop();
    edit(w, b, "doc.md", "v2 made on beta after the backup\n");
    b.ls.seen = { ...b.ls.seen!, maxSeq: w.server.inspect().headSeq + 5 };
    await b.restart();
    await syncAll([b]);
    expect(b.engine.status()).toMatchObject({ status: "paused", reason: "rollback" });
    const g = b.engine.guards.list().find((x) => x.kind === "rollback")!;
    b.engine.answerGuard(g.id, "rebuild");
    await b.engine.whenIdle();
    for (let i = 0; i < 20 && w.server.inspect().epoch === 1; i++) await new Promise((r) => setTimeout(r, 1));
    expect(w.server.inspect().epoch).toBe(2);
    await syncAll([a, b], 80);
    expect(a.fs.readText("doc.md")).toBe("v2 made on beta after the backup\n");
    expect(b.engine.status().status).toBe("synced");
    expect(a.fs.trash).toEqual([]);
    await converged(w, a, b);
  });
});

describe("outgoing mass-delete guard: deletes the pre-count did not foresee (design §3.13)", () => {
  it("allowPushDelete parks deletes above the threshold and raises massDeleteLocal; apply releases exactly those", async () => {
    const { w, a } = await pair("allow-del");
    const eng = a.engine as unknown as { allowPushDelete(id: string, p: string): boolean; deleteThreshold: number; deletesThisIteration: number };
    eng.deleteThreshold = 3;
    eng.deletesThisIteration = 0;
    const got = [0, 1, 2, 3, 4].map((i) => eng.allowPushDelete(`${"0".repeat(31)}${i}`, `d${i}.md`));
    expect(got).toEqual([true, true, true, false, false]);
    const g = a.engine.guards.list().find((x) => x.kind === "massDeleteLocal")!;
    expect(g).toBeDefined();
    expect(a.engine.status()).toMatchObject({ status: "paused", reason: "massDeleteLocal" });
    a.engine.answerGuard(g.id, "apply");
    eng.deletesThisIteration = 0;
    expect(eng.allowPushDelete(`${"0".repeat(31)}3`, "d3.md")).toBe(true);
    expect(eng.allowPushDelete(`${"0".repeat(31)}3`, "d3.md")).toBe(true);   // approval used once; counted normally after
    void w;
  });
});

describe("ChangeSink.headOf / liveHeadByPathKey after a restart (design §2.12)", () => {
  it("answers from persisted state with the exact head record; never a stale one after an own ack", async () => {
    const { w, a, b } = await pair("headof");
    edit(w, a, "h.md", "head one\n");
    await syncAll([a, b]);
    const id = b.engine.index.byPath("h.md")!.fileId;
    const serverHead = () => w.server.inspect().heads.find((h) => h.fileId === id)!;
    await b.restart();
    const got = b.engine.ingest.headOf(id);
    expect(got).toEqual(serverHead());
    expect(b.engine.ingest.liveHeadByPathKey(serverHead().pathKey)).toEqual(serverHead());
    // beta's own commit: right after the ack the mirrored head is newer than any raw record seen.
    w.server.pauseFeed();
    edit(w, b, "h.md", "head two by beta\n");
    await b.sync();
    const h2 = b.engine.ingest.headOf(id)!;
    expect(h2.seq).toBe(serverHead().seq);
    expect(h2.pathKey).toBe(serverHead().pathKey);
    expect(h2.kind).toBe("put");
    w.server.resumeFeed();
    await syncAll([a, b]);
    await b.restart();
    expect(b.engine.ingest.headOf(id)).toEqual(serverHead());
    expect(b.engine.ingest.headOf("f".repeat(32))).toBeNull();
    // A deleted file is no live head for its pathKey.
    const pk = serverHead().pathKey;
    a.fs.external.remove("h.md");
    a.engine.requestScan();
    await syncAll([a, b]);
    await b.restart();
    expect(b.engine.ingest.headOf(id)?.kind).toBe("del");
    expect(b.engine.ingest.liveHeadByPathKey(pk)).toBeNull();
  });
});

describe("FakeKeyring worlds (testkit, design §7)", () => {
  it("two devices converge on a FakeKeyring world; 1000 files sync without quadratic store costs", async () => {
    const w = await makeWorld("fake-ring", { fakeKeyring: true });
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) files[`d${i % 40}/n${i}.md`] = `note ${i}\n`;
    a.fs.seed(files);
    a.fs.seed({ "big.bin": new Prng("fr").bytes(60_000) });
    await a.start();
    await b.start();
    const t = performance.now();
    await syncAll([a, b], 200);
    expect((await serverMap(w)).size).toBe(1001);
    await converged(w, a, b);
    expect(performance.now() - t).toBeLessThan(240_000);
    edit(w, b, "d1/n1.md", "note 1 edited on beta\n");
    await syncAll([a, b]);
    expect(a.fs.readText("d1/n1.md")).toBe("note 1 edited on beta\n");
  }, 300_000);
});

describe("key rotation elsewhere → Locked, not tampered (design §3.13, §4.5.3)", () => {
  it("a vault-info whose active kv is not cached locks the engine and closes the feed; unlock with the new keys resumes", async () => {
    const w = await makeWorld("rotate", { fakeKeyring: true });
    const ring1 = w.ring as FakeKeyring;
    const ring2 = ring1.withKeys([1, 2]);
    const b = new Node(w, { name: "beta", opts: { unlock: async (p: string) => { if (p !== PASS) throw new Error("WrongPassphrase"); return { ring: ring2 }; } } });
    await b.start();
    edit(w, b, "x.md", "before rotation\n");
    await syncAll([b]);
    // Another device rotated the key: activeKv 2, MAC'd with K_info(2).
    const cur = w.server.inspect();
    const info = { ...(cur.info as VaultInfo), activeKv: 2, infoRev: (cur.info as VaultInfo).infoRev + 1 };
    const { infoMac: _m, ...unsigned } = info;
    info.infoMac = await ring2.macVaultInfo(unsigned as Parameters<typeof ring2.macVaultInfo>[0]);
    const raw = w.server.adapter("rotatordev00000000000");
    await raw.connect();
    const etag = (await raw.getVaultInfo())!.etag;
    await raw.updateVaultInfo(info, etag);
    await raw.close();
    await syncAll([b], 6);
    expect(b.engine.status()).toMatchObject({ locked: true, reason: "locked" });
    expect(b.engine.status().reason).not.toBe("tampered");
    edit(w, b, "x.md", "edited while locked\n");
    await syncAll([b], 4);
    expect(w.server.inspect().log.length).toBe(1);
    await b.engine.unlock(PASS);
    await syncAll([b]);
    expect(b.engine.status()).toMatchObject({ status: "synced", locked: false });
    const last = (w.server.inspect().log as VersionRecord[]).at(-1)!;
    expect(last.kv).toBe(2);
  });
});
