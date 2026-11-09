// The StateStore contract as a reusable suite (protocol state.ts). Ported from the MemStateStore tests
// in @shuttle/testkit so SqliteStateStore and MemStateStore are held to the same behavior.
import { describe, expect, it } from "vitest";
import { STATE_SCHEMA_VERSION, adapterStateStoreOver, isStateStoreError } from "@shuttle/protocol";
import type { FileEntry, NewOp, RemoteHead, StateStore } from "@shuttle/protocol";
import { Prng, compareKeys } from "@shuttle/testkit";

export function entry(fileId: string, path: string, o: Partial<FileEntry> = {}): FileEntry {
  return { fileId, path, foldKey: path.toLowerCase(), scope: "active", kind: "note", obs: null, synced: null, updatedAt: 1, ...o };
}
export function op(fileId: string, o: Partial<NewOp> = {}): NewOp {
  return { kind: "put", fileId, path: `${fileId}.md`, base: null, state: "queued", attempts: 0, nextAttemptAt: 0, createdAt: 1, ...o };
}
export function head(fileId: string, seq: number, deleted = false, pathKey = `pk-${fileId}`): RemoteHead {
  return {
    fileId, seq, base: null, pathKey, path: `${fileId}.md`, deleted, size: 1, mtime: 1,
    contentHash: null, chunkSizes: [1], blobs: [], kv: 1, deviceId: "dev", ts: 1,
  };
}

/** Committed contents of one store in key order (assertions only). */
async function all(s: StateStore, name: "files" | "meta" | "journal"): Promise<unknown[]> {
  return s.tx([name], (tx) => (tx[name] as { getAll(): Promise<unknown[]> }).getAll(), "readonly");
}

export function stateStoreContract(label: string, make: () => Promise<StateStore> | StateStore): void {
  describe(`${label}: StateStore contract`, () => {
    it("commits all writes of a transaction together", async () => {
      const s = await make();
      expect(s.schemaVersion).toBe(STATE_SCHEMA_VERSION);
      await s.tx(["files", "meta"], async (tx) => {
        await tx.files.put(entry("a", "A.md"));
        await tx.meta.put({ k: "cursor", v: 7 });
      });
      const got = await s.tx(["files", "meta"], async (tx) => [await tx.files.get("a"), await tx.meta.get("cursor")], "readonly");
      expect(got[0]).toMatchObject({ fileId: "a", path: "A.md" });
      expect(got[1]).toEqual({ k: "cursor", v: 7 });
      await s.close();
    });

    it("rolls back everything when fn throws", async () => {
      const s = await make();
      await expect(s.tx(["files"], async (tx) => {
        await tx.files.put(entry("a", "A.md"));
        throw new Error("boom");
      })).rejects.toThrow("boom");
      expect(await all(s, "files")).toEqual([]);
      await s.close();
    });

    it("reads inside a transaction see its own writes and deletes", async () => {
      const s = await make();
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
      expect((await all(s, "files")).map((e) => (e as FileEntry).fileId)).toEqual(["d"]);
      await s.close();
    });

    it("only the named stores are reachable; readonly refuses writes", async () => {
      const s = await make();
      await expect(s.tx(["files"], async (tx) => tx.meta.get("cursor"))).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "NOT_IN_SCOPE"));
      await expect(s.tx(["meta"], async (tx) => tx.meta.put({ k: "x", v: 1 }), "readonly")).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "READONLY"));
      await s.close();
    });

    it("enforces the unique files.path index and dooms the transaction", async () => {
      const s = await make();
      await s.tx(["files"], async (tx) => { await tx.files.put(entry("a", "A.md")); });
      await expect(s.tx(["files"], async (tx) => {
        await tx.files.put(entry("z", "Z.md"));
        try { await tx.files.put(entry("b", "A.md")); } catch { /* swallowed: the tx is still doomed */ }
      })).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CONSTRAINT"));
      expect(await all(s, "files")).toHaveLength(1);
      await s.tx(["files"], async (tx) => {
        await tx.files.put(entry("a", "A.md", { updatedAt: 2 }));
        await tx.files.put(entry("a", "A2.md"));
        await tx.files.put(entry("b", "A.md"));
      });
      expect(await all(s, "files")).toHaveLength(2);
      await s.close();
    });

    it("autoIncrements journal.opSeq and never reuses a key", async () => {
      const s = await make();
      const k1 = await s.tx(["journal"], (tx) => tx.journal.put(op("f1")));
      await expect(s.tx(["journal"], async (tx) => { await tx.journal.put(op("f2")); throw new Error("x"); })).rejects.toThrow();
      const k3 = await s.tx(["journal"], (tx) => tx.journal.put(op("f3")));
      expect(k1).toBe(1);
      expect(k3).toBe(3);
      expect(((await all(s, "journal")) as Array<{ opSeq: number }>).map((o) => o.opSeq)).toEqual([1, 3]);
      await s.close();
    });

    it("queries indexes with ranges, direction and limit", async () => {
      const s = await make();
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
      await s.close();
    });

    it("orders mixed key types and non-BMP strings like IndexedDB", async () => {
      const s = await make();
      // UTF-16 code-unit order: U+FF01 (0xFF01) sorts after an astral char (surrogate 0xD83D…).
      const keys = ["b", "a", "！", "\u{1F600}", "aa", "B"];
      await s.tx(["meta"], async (tx) => {
        for (const k of keys) await tx.meta.put({ k, v: 1 });
      });
      const got = await s.tx(["meta"], (tx) => tx.meta.getAllKeys(), "readonly");
      expect(got).toEqual([...keys].sort(compareKeys));
      await s.tx(["history"], async (tx) => {
        for (const seq of [10, 2, 33, 1.5]) {
          await tx.history.put({ seq, fileId: "f", kind: "put", base: null, pathKey: "p", rc: "note", kv: 1, meta: "m", blobs: [], ts: 1, deviceId: "d" } as never);
        }
      });
      expect(await s.tx(["history"], (tx) => tx.history.getAllKeys(), "readonly")).toEqual([1.5, 2, 10, 33]);
      await s.close();
    });

    it("stores structured clones, including binary fields", async () => {
      const s = await make();
      const e = entry("a", "A.md");
      const bytes = new Uint8Array([1, 2, 0, 255]);
      await s.tx(["files", "bases"], async (tx) => { await tx.files.put(e); await tx.bases.put({ fileId: "a", version: 1, hash: "h", bytes }); });
      e.path = "mutated";
      bytes[0] = 9;
      const got = await s.tx(["files", "bases"], async (tx) => [await tx.files.get("a"), await tx.bases.get("a")] as const, "readonly");
      expect(got[0]?.path).toBe("A.md");
      expect(got[1]?.bytes).toBeInstanceOf(Uint8Array);
      expect([...(got[1]?.bytes ?? [])]).toEqual([1, 2, 0, 255]);
      const empty = await s.tx(["staging"], async (tx) => { await tx.staging.put({ opSeq: 4, bytes: new Uint8Array(0) }); return tx.staging.get(4); });
      expect(empty?.bytes).toBeInstanceOf(Uint8Array);
      expect(empty?.bytes.length).toBe(0);
      await s.close();
    });

    it("serializes transactions", async () => {
      const s = await make();
      const order: string[] = [];
      await Promise.all([
        s.tx(["meta"], async (tx) => { order.push("a1"); await tx.meta.put({ k: "x", v: 1 }); await Promise.resolve(); order.push("a2"); }),
        s.tx(["meta"], async (tx) => { order.push("b1"); expect((await tx.meta.get("x"))?.v).toBe(1); order.push("b2"); }),
      ]);
      expect(order).toEqual(["a1", "a2", "b1", "b2"]);
      await s.close();
    });

    it("backs an AdapterStateStore", async () => {
      const s = await make();
      const a = adapterStateStoreOver(s);
      expect(await a.get("cursor")).toBeUndefined();
      await a.put("cursor", { seq: 4 });
      expect(await a.get("cursor")).toEqual({ seq: 4 });
      await a.delete("cursor");
      expect(await a.get("cursor")).toBeUndefined();
      await s.close();
    });

    it("operations after fn resolved are refused (awaiting outside the transaction)", async () => {
      const s = await make();
      let leaked: (() => Promise<unknown>) | null = null;
      await s.tx(["meta"], async (tx) => { leaked = () => tx.meta.put({ k: "late", v: 1 }); });
      await expect(leaked!()).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CLOSED"));
      await s.close();
    });

    it("destroy() closes the store", async () => {
      const s = await make();
      await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); });
      await s.destroy();
      await expect(s.tx(["meta"], async () => 1)).rejects.toSatisfy((e: unknown) => isStateStoreError(e));
    });

    it("equality queries equal a brute-force scan across random commits, aborts, deletes and clears", async () => {
      const r = new Prng("state-contract-index");
      const s = await make();
      const model = new Map<string, RemoteHead>();
      for (let round = 0; round < 40; round++) {
        const pending = new Map(model);
        const abort = r.bool(0.15);
        await s.tx(["remote"], async (tx) => {
          for (let i = 0; i < 1 + r.int(10); i++) {
            const id = `f${r.int(30)}`;
            const roll = r.float();
            if (roll < 0.6) {
              const h = head(id, r.int(1000), r.bool(0.3), `pk${r.int(6)}`);
              await tx.remote.put(h);
              pending.set(id, h);
            } else if (roll < 0.95) {
              await tx.remote.delete(id);
              pending.delete(id);
            } else {
              await tx.remote.clear();
              pending.clear();
            }
            const pk = `pk${r.int(6)}`;
            const want = [...pending.values()].filter((h) => h.pathKey === pk).map((h) => h.fileId).sort(compareKeys);
            expect((await tx.remote.getAll({ index: "pathKey", only: pk })).map((h) => h.fileId)).toEqual(want);
            expect(await tx.remote.count({ index: "deleted", only: true })).toBe([...pending.values()].filter((h) => h.deleted).length);
          }
          if (abort) throw new Error("abort");
        }).catch((e: unknown) => {
          if (!(e instanceof Error && e.message === "abort")) throw e;
        });
        if (!abort) {
          model.clear();
          for (const [k, v] of pending) model.set(k, v);
        }
        const got = await s.tx(["remote"], async (tx) => ({
          del: (await tx.remote.getAll({ index: "deleted", only: true })).map((h) => h.fileId),
          live: (await tx.remote.getAll({ index: "deleted", only: false, direction: "prev" })).map((h) => h.fileId),
          byKey: await tx.remote.getAll({ only: "f7" }),
        }), "readonly");
        const sorted = [...model.values()].sort((a, b) => compareKeys(a.fileId, b.fileId));
        expect(got.del).toEqual(sorted.filter((h) => h.deleted).map((h) => h.fileId));
        expect(got.live).toEqual(sorted.filter((h) => !h.deleted).map((h) => h.fileId).reverse());
        expect(got.byKey.map((h) => h.fileId)).toEqual(model.has("f7") ? ["f7"] : []);
      }
      await s.close();
    });

    it("an unknown index is refused", async () => {
      const s = await make();
      await expect(s.tx(["remote"], (tx) => tx.remote.getAll({ index: "nope", only: 1 }), "readonly"))
        .rejects.toSatisfy((e: unknown) => isStateStoreError(e, "NOT_IN_SCOPE"));
      await s.close();
    });
  });
}
