// MemStateStore: the StateStore contract (protocol state.ts) and crash injection (ops-spec §3).
import { describe, expect, it } from "vitest";
import { STATE_SCHEMA_VERSION, adapterStateStoreOver, isStateStoreError } from "@shuttle/protocol";
import type { FileEntry, NewOp, RemoteHead } from "@shuttle/protocol";
import { MemStateStore, compareKeys } from "../src/index";

function entry(fileId: string, path: string, o: Partial<FileEntry> = {}): FileEntry {
  return { fileId, path, foldKey: path.toLowerCase(), scope: "active", kind: "note", obs: null, synced: null, updatedAt: 1, ...o };
}
function op(fileId: string, o: Partial<NewOp> = {}): NewOp {
  return { kind: "put", fileId, path: `${fileId}.md`, base: null, state: "queued", attempts: 0, nextAttemptAt: 0, createdAt: 1, ...o };
}
function head(fileId: string, seq: number, deleted = false): RemoteHead {
  return {
    fileId, seq, base: null, pathKey: `pk-${fileId}`, path: `${fileId}.md`, deleted, size: 1, mtime: 1,
    contentHash: null, chunkSizes: [1], blobs: [], kv: 1, deviceId: "dev", ts: 1,
  };
}

describe("MemStateStore transactions", () => {
  it("commits all writes of a transaction together", async () => {
    const s = new MemStateStore();
    expect(s.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    await s.tx(["files", "meta"], async (tx) => {
      await tx.files.put(entry("a", "A.md"));
      await tx.meta.put({ k: "cursor", v: 7 });
    });
    const got = await s.tx(["files", "meta"], async (tx) => [await tx.files.get("a"), await tx.meta.get("cursor")], "readonly");
    expect(got[0]).toMatchObject({ fileId: "a", path: "A.md" });
    expect(got[1]).toEqual({ k: "cursor", v: 7 });
  });

  it("rolls back everything when fn throws", async () => {
    const s = new MemStateStore();
    await expect(s.tx(["files"], async (tx) => {
      await tx.files.put(entry("a", "A.md"));
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(s.dump().files).toEqual([]);
  });

  it("reads inside a transaction see its own writes and deletes", async () => {
    const s = new MemStateStore();
    await s.tx(["files"], async (tx) => { await tx.files.put(entry("a", "A.md")); await tx.files.put(entry("b", "B.md")); });
    await s.tx(["files"], async (tx) => {
      await tx.files.delete("a");
      await tx.files.put(entry("c", "C.md"));
      expect(await tx.files.get("a")).toBeUndefined();
      expect((await tx.files.getAll()).map((e) => e.fileId)).toEqual(["b", "c"]);
      await tx.files.clear();
      expect(await tx.files.count()).toBe(0);
      await tx.files.put(entry("d", "D.md"));
    });
    expect(s.dump().files.map((e) => (e as FileEntry).fileId)).toEqual(["d"]);
  });

  it("only the named stores are reachable; readonly refuses writes", async () => {
    const s = new MemStateStore();
    await expect(s.tx(["files"], async (tx) => tx.meta.get("cursor"))).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "NOT_IN_SCOPE"));
    await expect(s.tx(["meta"], async (tx) => tx.meta.put({ k: "x", v: 1 }), "readonly")).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "READONLY"));
  });

  it("enforces the unique files.path index and dooms the transaction", async () => {
    const s = new MemStateStore();
    await s.tx(["files"], async (tx) => { await tx.files.put(entry("a", "A.md")); });
    await expect(s.tx(["files"], async (tx) => {
      await tx.files.put(entry("z", "Z.md"));
      try { await tx.files.put(entry("b", "A.md")); } catch { /* swallowed: the tx is still doomed */ }
    })).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CONSTRAINT"));
    expect(s.dump().files).toHaveLength(1);
    // re-putting the same key with the same path is fine; moving the holder away frees the path
    await s.tx(["files"], async (tx) => {
      await tx.files.put(entry("a", "A.md", { updatedAt: 2 }));
      await tx.files.put(entry("a", "A2.md"));
      await tx.files.put(entry("b", "A.md"));
    });
    expect(s.dump().files).toHaveLength(2);
  });

  it("autoIncrements journal.opSeq and never reuses a key", async () => {
    const s = new MemStateStore();
    const k1 = await s.tx(["journal"], (tx) => tx.journal.put(op("f1")));
    await expect(s.tx(["journal"], async (tx) => { await tx.journal.put(op("f2")); throw new Error("x"); })).rejects.toThrow();
    const k3 = await s.tx(["journal"], (tx) => tx.journal.put(op("f3")));
    expect(k1).toBe(1);
    expect(k3).toBe(3);
    expect((s.dump().journal as Array<{ opSeq: number }>).map((o) => o.opSeq)).toEqual([1, 3]);
  });

  it("queries indexes with ranges, direction and limit", async () => {
    const s = new MemStateStore();
    await s.tx(["remote", "applyQueue"], async (tx) => {
      await tx.remote.put(head("c", 30, true));
      await tx.remote.put(head("a", 10));
      await tx.remote.put(head("b", 20, true));
      for (const [f, seq] of [["x", 5], ["y", 1], ["z", 9]] as const) await tx.applyQueue.put({ fileId: f, seq, enqueuedAt: 0, attempts: 0 });
    });
    await s.tx(["remote", "applyQueue"], async (tx) => {
      expect((await tx.remote.getAll({ index: "deleted", only: true })).map((h) => h.fileId)).toEqual(["b", "c"]);
      expect((await tx.remote.getByIndex("pathKey", "pk-a"))?.fileId).toBe("a");
      expect((await tx.applyQueue.getAll({ index: "seq" })).map((e) => e.seq)).toEqual([1, 5, 9]);
      expect((await tx.applyQueue.getAll({ index: "seq", lower: 1, lowerOpen: true, direction: "prev", limit: 1 })).map((e) => e.seq)).toEqual([9]);
      expect(await tx.applyQueue.getAllKeys({ upper: "y" })).toEqual(["x", "y"]);
      expect(await tx.applyQueue.count({ index: "seq", upper: 5 })).toBe(2);
    }, "readonly");
  });

  it("stores structured clones", async () => {
    const s = new MemStateStore();
    const e = entry("a", "A.md");
    const bytes = new Uint8Array([1, 2]);
    await s.tx(["files", "bases"], async (tx) => { await tx.files.put(e); await tx.bases.put({ fileId: "a", version: 1, hash: "h", bytes }); });
    e.path = "mutated";
    bytes[0] = 9;
    const got = await s.tx(["files", "bases"], async (tx) => [await tx.files.get("a"), await tx.bases.get("a")] as const, "readonly");
    expect(got[0]?.path).toBe("A.md");
    expect([...(got[1]?.bytes ?? [])]).toEqual([1, 2]);
  });

  it("serializes transactions", async () => {
    const s = new MemStateStore();
    const order: string[] = [];
    await Promise.all([
      s.tx(["meta"], async (tx) => { order.push("a1"); await tx.meta.put({ k: "x", v: 1 }); await new Promise((r) => setTimeout(r, 5)); order.push("a2"); }),
      s.tx(["meta"], async (tx) => { order.push("b1"); expect((await tx.meta.get("x"))?.v).toBe(1); order.push("b2"); }),
    ]);
    expect(order).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("orders keys like IndexedDB", () => {
    const xs = ["b", 2, true, "a", 10, false];
    expect([...xs].sort(compareKeys)).toEqual([false, true, 2, 10, "a", "b"]);
  });

  it("backs an AdapterStateStore", async () => {
    const s = new MemStateStore();
    const a = adapterStateStoreOver(s);
    expect(await a.get("cursor")).toBeUndefined();
    await a.put("cursor", { seq: 4 });
    expect(await a.get("cursor")).toEqual({ seq: 4 });
    await a.delete("cursor");
    expect(await a.get("cursor")).toBeUndefined();
  });
});

describe("MemStateStore crash injection", () => {
  it("crash() drops the in-flight transaction; reopen() sees only committed data", async () => {
    const s = new MemStateStore();
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "cursor", v: 1 }); });
    const inflight = s.tx(["meta"], async (tx) => {
      await tx.meta.put({ k: "cursor", v: 2 });
      s.crash();
      await tx.meta.put({ k: "other", v: 3 });
    });
    await expect(inflight).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CRASHED"));
    await expect(s.tx(["meta"], async () => 1)).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CRASHED"));
    const s2 = s.reopen();
    expect(s2.dump().meta).toEqual([{ k: "cursor", v: 1 }]);
    await s2.tx(["meta"], async (tx) => { await tx.meta.put({ k: "cursor", v: 5 }); });
    expect(s2.dump().meta).toEqual([{ k: "cursor", v: 5 }]);
  });

  it("injectCommitFault crashes or fails the n-th next commit", async () => {
    const s = new MemStateStore();
    s.injectCommitFault("fail");
    await expect(s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); })).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "COMMIT_FAILED"));
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "b", v: 1 }); });
    s.injectCommitFault("crash", 1);
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "c", v: 1 }); });
    await expect(s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "d", v: 1 }); })).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CRASHED"));
    expect(s.reopen().dump().meta.map((m) => (m as { k: string }).k)).toEqual(["b", "c"]);
  });

  it("beforeCommit can veto a commit; readonly transactions are not commits", async () => {
    const seen: number[] = [];
    const s = new MemStateStore(undefined, { beforeCommit: (i) => { seen.push(i.writes); if (i.writes > 1) throw new Error("veto"); } });
    await s.tx(["meta"], async (tx) => tx.meta.get("x"), "readonly");
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); });
    await expect(s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "b", v: 1 }); await tx.meta.put({ k: "c", v: 1 }); })).rejects.toThrow("veto");
    expect(seen).toEqual([1, 2]);
    expect(s.dump().meta).toHaveLength(1);
  });

  it("evict() wipes everything; destroy() closes", async () => {
    const s = new MemStateStore();
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); });
    s.evict();
    const s2 = s.reopen();
    expect(s2.dump().meta).toEqual([]);
    await s2.destroy();
    await expect(s2.tx(["meta"], async () => 1)).rejects.toSatisfy((e: unknown) => isStateStoreError(e));
  });

  it("operations after fn resolved are refused (awaiting outside the transaction)", async () => {
    const s = new MemStateStore();
    let leaked: (() => Promise<unknown>) | null = null;
    await s.tx(["meta"], async (tx) => { leaked = () => tx.meta.put({ k: "late", v: 1 }); });
    await expect(leaked!()).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CLOSED"));
  });
});
