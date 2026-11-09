// Journal and op runner behaviour (design §3.7: coalescing I4, frozen batches and replay I3,
// CONFLICT / PATH_TAKEN routing, MISSING_BLOB, KEY_VERSION, backoff).
import { opsDigestPreimage, remoteError, type CommitRequest } from "@shuttle/protocol";
import { MemStateStore } from "@shuttle/testkit";
import { describe, expect, it } from "vitest";
import { Journal, backoffDelay } from "../src/index";
import { Device, bigBytes, makeWorld, recordsOf, serverMap, sortedEntries, type World } from "./harness";

function edit(w: World, d: Device, path: string, content: string | Uint8Array): void {
  w.clock.tick(1000);
  d.fs.external.write(path, content, { mtime: w.clock.now() });
}

describe("Journal (I4)", () => {
  it("coalesces a new change into the non-frozen op and waits behind a frozen one", async () => {
    let t = 1000;
    const store = new MemStateStore();
    const j = new Journal({ state: store, now: () => t++ });
    const f = "a".repeat(32);
    const r1 = await j.enqueue({ kind: "put", fileId: f, path: "a.md", base: 3 });
    expect(r1.t).toBe("queued");
    const r2 = await j.enqueue({ kind: "put", fileId: f, path: "b.md", base: 3 });
    expect(r2).toEqual({ t: "replaced", opSeq: (r1 as { opSeq: number }).opSeq });
    const r3 = await j.enqueue({ kind: "delete", fileId: f, path: "b.md", base: 3 });
    expect(r3.t).toBe("replaced");
    let ops = await j.ops();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "delete", path: "b.md", state: "queued" });
    // Archives never take the put/delete slot.
    await j.enqueue({ kind: "archive", fileId: f, path: "b.md", base: 3, staged: new Uint8Array([1]) });
    expect(await j.ops()).toHaveLength(2);
    // Freeze the delete; a new change now waits.
    await store.tx(["journal"], async (tx) => {
      const op = (await tx.journal.getAll()).find((o) => o.kind === "delete")!;
      await tx.journal.put({ ...op, state: "sent", batchId: "b-1" });
    });
    expect(await j.isFrozen(f)).toBe(true);
    expect((await j.enqueue({ kind: "put", fileId: f, path: "c.md", base: 3 })).t).toBe("waiting");
    expect(await j.cancel(f)).toBe(false);
    expect(j.takeWaiting(f)).toBe(true);
    ops = await j.ops();
    expect(ops.filter((o) => o.kind !== "archive")).toHaveLength(1);
  });

  it("a repeated identical request keeps the op's progress", async () => {
    const store = new MemStateStore();
    const j = new Journal({ state: store, now: () => 1 });
    const f = "b".repeat(32);
    const r = await j.enqueue({ kind: "put", fileId: f, path: "a.md", base: 1, hash: "h1" });
    await store.tx(["journal"], async (tx) => {
      const op = (await tx.journal.get((r as { opSeq: number }).opSeq))!;
      await tx.journal.put({ ...op, state: "ready", contentHash: "h1" });
    });
    await j.enqueue({ kind: "put", fileId: f, path: "a.md", base: 1, hash: "h1" });
    expect((await j.ops())[0]!.state).toBe("ready");
    await j.enqueue({ kind: "put", fileId: f, path: "a.md", base: 1, hash: "h2" });
    expect((await j.ops())[0]!.state).toBe("queued");
  });

  it("backoff grows 1 s → 5 min with ±20 % jitter", () => {
    expect(backoffDelay(1, () => 0.5)).toBe(1000);
    expect(backoffDelay(2, () => 0.5)).toBe(2000);
    expect(backoffDelay(30, () => 0.5)).toBe(300_000);
    expect(backoffDelay(1, () => 0)).toBe(800);
    expect(backoffDelay(1, () => 0.999999)).toBeLessThanOrEqual(1200);
  });
});

describe("OpRunner", () => {
  it("I3: a lost commit response is resent with the same cid and identical headers; one record per op", async () => {
    const w = await makeWorld("replay");
    const a = new Device(w, { name: "alpha" });
    await a.start();
    const seen = new Map<string, string[]>();
    w.server.onCall = (c) => {
      if (c.method !== "commit") return;
      const req = c.args[0] as CommitRequest;
      seen.set(req.cid, [...(seen.get(req.cid) ?? []), opsDigestPreimage(req.ops)]);
    };
    w.server.injectFault({ method: "commit", when: "after", times: 4, device: a.deviceId });
    edit(w, a, "x.md", "one\n");
    edit(w, a, "big.bin", bigBytes("big"));
    await a.sync();
    expect(recordsOf(w)).toHaveLength(2);
    expect(seen.size).toBe(1);
    const [preimages] = [...seen.values()];
    expect(preimages!.length).toBe(5);
    expect(new Set(preimages).size).toBe(1);
    expect(w.server.stats.replays).toBeGreaterThanOrEqual(4);
    expect(sortedEntries(await a.diskMap())).toEqual(sortedEntries(await serverMap(w)));
  });

  it("network errors back off and the same batch is resent later", async () => {
    const w = await makeWorld("netfail");
    const a = new Device(w, { name: "alpha" });
    await a.start();
    w.server.injectFault({ method: "commit", when: "before", times: 2, device: a.deviceId });
    edit(w, a, "x.md", "one\n");
    const t0 = w.clock.now();
    await a.sync();
    expect(recordsOf(w)).toHaveLength(1);
    expect(w.clock.now() - t0).toBeGreaterThanOrEqual(1000);   // waited for the backoff
  });

  it("CONFLICT re-plans with the newer head; PATH_TAKEN leads to P1 (keep both, never the same path again)", async () => {
    const w = await makeWorld("pathtaken");
    const a = new Device(w, { name: "alpha" });
    const b = new Device(w, { name: "beta" });
    await a.start();
    await b.start();
    // b does not see a's head before pushing its own create of the same path.
    w.server.pauseFeed();
    edit(w, a, "same.md", "alpha\n");
    await a.sync(3);
    edit(w, b, "same.md", "beta\n");
    await b.sync(3);
    w.server.resumeFeed();
    for (let i = 0; i < 3; i++) { await a.sync(); await b.sync(); }
    expect(b.logs.some((l) => l.key === "log.pathTaken")).toBe(true);
    const puts = recordsOf(w, (r) => r.kind === "put");
    const pathKeys = puts.map((r) => r.pathKey);
    expect(new Set(pathKeys).size).toBe(pathKeys.length);   // no create was retried at the taken path
    const texts = [...a.fs.files().values()].map((v) => new TextDecoder().decode(v)).sort();
    expect(texts).toEqual(["alpha\n", "beta\n"]);
    expect(sortedEntries(await a.diskMap())).toEqual(sortedEntries(await b.diskMap()));
  });

  it("MISSING_BLOB: uploads again and resends the same batch", async () => {
    const w = await makeWorld("missing");
    const a = new Device(w, { name: "alpha" });
    await a.start();
    let dropped = false;
    const cids: string[] = [];
    w.server.onCall = (c) => {
      if (c.method !== "commit") return;
      const req = c.args[0] as CommitRequest;
      cids.push(req.cid);
      if (dropped) return;
      const op = req.ops[0];
      if (op && op.op === "put" && op.blobs.length > 0) {
        (w.server as unknown as { blobs: Map<string, Uint8Array> }).blobs.delete(op.blobs[0]!);
        dropped = true;
      }
    };
    edit(w, a, "big.bin", bigBytes("mb"));
    await a.sync();
    expect(dropped).toBe(true);
    expect(cids.length).toBe(2);
    expect(new Set(cids).size).toBe(1);
    expect(w.server.inspect().blobIds.length).toBeGreaterThan(1);
    expect(recordsOf(w)).toHaveLength(1);
    expect(sortedEntries(await a.diskMap())).toEqual(sortedEntries(await serverMap(w)));
  });

  it("KEY_VERSION re-queues the ops (never lost) and reports it", async () => {
    const w = await makeWorld("kv");
    const a = new Device(w, { name: "alpha" });
    await a.start();
    let kv = 0;
    (a.runner as unknown as { d: { onKeyVersion?: () => void } }).d.onKeyVersion = () => { kv++; };
    // Make the server answer KEY_VERSION once by raising its active kv, then restore it.
    const info = w.server.inspect().info!;
    const etag = w.server.inspect().infoEtag!;
    const boot = w.server.adapter("bootstrapdev0000000000");
    await boot.connect();
    const raised = await boot.updateVaultInfo({ ...info, activeKv: 2, infoRev: info.infoRev + 1 }, etag);
    edit(w, a, "x.md", "one\n");
    await a.sync(2);
    expect(kv).toBeGreaterThanOrEqual(1);
    expect((await a.journal.ops()).length).toBe(1);
    expect(recordsOf(w)).toHaveLength(0);
    await boot.updateVaultInfo({ ...info, activeKv: 1, infoRev: info.infoRev + 2 }, raised.etag);
    a.runner.keyVersionResolved();
    await a.sync();
    expect(recordsOf(w)).toHaveLength(1);
  });

  it("an op whose file vanished before upload is dropped and the delete is planned instead", async () => {
    const w = await makeWorld("vanish");
    const a = new Device(w, { name: "alpha" });
    await a.start();
    edit(w, a, "v.md", "one\n");
    await a.sync();
    edit(w, a, "v.md", "two\n");
    // Reconcile enqueues the edit; the file disappears before the runner reads it.
    await a.reconcileAll();
    expect((await a.journal.ops()).length).toBe(1);
    a.fs.external.remove("v.md");
    await a.sync();
    expect(recordsOf(w).map((r) => r.kind)).toEqual(["put", "del"]);
    void remoteError;
  });
});
