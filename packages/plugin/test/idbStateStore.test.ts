// IdbStateStore against the in-memory IndexedDB of fakeIdb.ts: the StateStore contract (ported from
// the shared contract suite of the headless SqliteStateStore, so all three stores agree) plus the
// IndexedDB-specific parts: boolean index encoding, schema refusal, persistence across reopen.
import { describe, expect, it } from "vitest";
import { STATE_SCHEMA_VERSION, adapterStateStoreOver, isStateStoreError } from "@shuttle/protocol";
import type { FileEntry, NewOp, RemoteHead, StateStore } from "@shuttle/protocol";
import { Prng, compareKeys } from "@shuttle/testkit";
import { IdbStateStore, idbName } from "../src/state/IdbStateStore";
import { FakeIndexedDb, fakeIdbEnv } from "./fakeIdb";

function entry(fileId: string, path: string, o: Partial<FileEntry> = {}): FileEntry {
  return { fileId, path, foldKey: path.toLowerCase(), scope: "active", kind: "note", obs: null, synced: null, updatedAt: 1, ...o };
}
function op(fileId: string, o: Partial<NewOp> = {}): NewOp {
  return { kind: "put", fileId, path: `${fileId}.md`, base: null, state: "queued", attempts: 0, nextAttemptAt: 0, createdAt: 1, ...o };
}
function head(fileId: string, seq: number, deleted = false, pathKey = `pk-${fileId}`): RemoteHead {
  return {
    fileId, seq, base: null, pathKey, path: `${fileId}.md`, deleted, size: 1, mtime: 1,
    contentHash: null, chunkSizes: [1], blobs: [], kv: 1, deviceId: "dev", ts: 1,
  };
}
async function all(s: StateStore, name: "files" | "meta" | "journal"): Promise<unknown[]> {
  return s.tx([name], (tx) => (tx[name] as { getAll(): Promise<unknown[]> }).getAll(), "readonly");
}
const make = (): Promise<IdbStateStore> => IdbStateStore.open("test", fakeIdbEnv());

describe("IdbStateStore: StateStore contract", () => {
  it("commits all writes of a transaction together", async () => {
    const s = await make();
    expect(s.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    await s.tx(["files", "meta"], async (tx) => {
      await tx.files.put(entry("a", "A.md"));
      await tx.meta.put({ k: "cursor", v: 7 });
    });
    const got = await s.tx(["files", "meta"], async (tx) => [await tx.files.get("a"), await tx.meta.get("cursor")], "readonly");
    expect(got[0]).toEqual(entry("a", "A.md"));
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

  it("assigns journal.opSeq and never reuses a key within a session", async () => {
    const s = await make();
    const k1 = await s.tx(["journal"], (tx) => tx.journal.put(op("f1")));
    await expect(s.tx(["journal"], async (tx) => { await tx.journal.put(op("f2")); throw new Error("x"); })).rejects.toThrow();
    const k3 = await s.tx(["journal"], (tx) => tx.journal.put(op("f3")));
    expect(k1).toBe(1);
    expect(k3).toBe(3);
    expect(((await all(s, "journal")) as Array<{ opSeq: number }>).map((o) => o.opSeq)).toEqual([1, 3]);
    const explicit = await s.tx(["journal"], (tx) => tx.journal.put({ ...op("f4"), opSeq: 10 }));
    expect(explicit).toBe(10);
    expect(await s.tx(["journal"], (tx) => tx.journal.put(op("f5")))).toBe(11);
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
      expect(await tx.applyQueue.getAll({ index: "seq", lower: 9, upper: 1 })).toEqual([]);
    }, "readonly");
    await s.close();
  });

  it("orders mixed key types and non-BMP strings like IndexedDB", async () => {
    const s = await make();
    const keys = ["b", "a", "！", "\u{1F600}", "aa", "B"];
    await s.tx(["meta"], async (tx) => {
      for (const k of keys) await tx.meta.put({ k, v: 1 });
    });
    expect(await s.tx(["meta"], (tx) => tx.meta.getAllKeys(), "readonly")).toEqual([...keys].sort(compareKeys));
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

  it("operations after fn resolved are refused", async () => {
    const s = await make();
    let leaked: (() => Promise<unknown>) | null = null;
    await s.tx(["meta"], async (tx) => { leaked = () => tx.meta.put({ k: "late", v: 1 }); });
    await expect(leaked!()).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CLOSED"));
    await s.close();
  });

  it("destroy() closes the store and deletes the database", async () => {
    const env = fakeIdbEnv();
    const s = await IdbStateStore.open("gone", env);
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); });
    await s.destroy();
    await expect(s.tx(["meta"], async () => 1)).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CLOSED"));
    expect(env.fake.dbs.has("gone")).toBe(false);
  });

  it("equality queries equal a brute-force scan across random commits, aborts, deletes and clears", async () => {
    const r = new Prng("idb-contract-index");
    const s = await make();
    const model = new Map<string, RemoteHead>();
    for (let round = 0; round < 25; round++) {
      const pending = new Map(model);
      const abort = r.bool(0.15);
      await s.tx(["remote"], async (tx) => {
        for (let i = 0; i < 1 + r.int(8); i++) {
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

describe("IdbStateStore: IndexedDB specifics", () => {
  it("names the database shuttle/<appId>/<remoteProfileId> (design §3.3.1)", () => {
    expect(idbName("app1", "0123456789abcdef")).toBe("shuttle/app1/0123456789abcdef");
  });

  it("keeps data across close and reopen, and continues opSeq after the largest stored key", async () => {
    const env = fakeIdbEnv();
    const a = await IdbStateStore.open("v", env);
    await a.tx(["journal", "remote"], async (tx) => {
      await tx.journal.put(op("f1"));
      await tx.journal.put(op("f2"));
      await tx.remote.put(head("h", 3, true));
    });
    await a.close();
    const b = await IdbStateStore.open("v", env);
    expect(await b.tx(["journal"], (tx) => tx.journal.put(op("f3")))).toBe(3);
    const h = await b.tx(["remote"], (tx) => tx.remote.get("h"), "readonly");
    expect(h).toEqual(head("h", 3, true));
    expect(Object.keys(h ?? {}).some((k) => k.startsWith("_sx_"))).toBe(false);
    await b.close();
  });

  it("after a reopen, an update of an existing op does not let a new op overwrite a stored one", async () => {
    const env = fakeIdbEnv();
    const a = await IdbStateStore.open("reuse", env);
    await a.tx(["journal"], async (tx) => { for (const f of ["f1", "f2", "f3"]) await tx.journal.put(op(f)); });
    await a.close();
    const b = await IdbStateStore.open("reuse", env);
    await b.tx(["journal"], (tx) => tx.journal.put({ ...op("f1", { state: "sent" }), opSeq: 1 }));
    expect(await b.tx(["journal"], (tx) => tx.journal.put(op("new")))).toBe(4);
    const rows = await b.tx(["journal"], (tx) => tx.journal.getAll(), "readonly");
    expect(rows.map((o) => [o.opSeq, o.fileId, o.state])).toEqual([[1, "f1", "sent"], [2, "f2", "queued"], [3, "f3", "queued"], [4, "new", "queued"]]);
    await b.close();
  });

  it("stores boolean index values as 0/1 shadow fields (IndexedDB cannot index booleans)", async () => {
    const env = fakeIdbEnv();
    const s = await IdbStateStore.open("bool", env);
    await s.tx(["remote"], async (tx) => { await tx.remote.put(head("a", 1, true)); await tx.remote.put(head("b", 2, false)); });
    const raw = [...(env.fake.dbs.get("bool")?.stores.get("remote")?.rows.values() ?? [])].map((r) => r.value as Record<string, unknown>);
    expect(raw.map((v) => v["_sx_deleted"]).sort()).toEqual([0, 1]);
    expect(await s.tx(["remote"], (tx) => tx.remote.getByIndex("deleted", false), "readonly")).toMatchObject({ fileId: "b" });
    await s.close();
  });

  it("refuses a database written by a newer schema", async () => {
    const idb = new FakeIndexedDb();
    idb.dbs.set("new", { version: STATE_SCHEMA_VERSION + 1, stores: new Map() });
    await expect(IdbStateStore.open("new", fakeIdbEnv(idb))).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "NEWER_SCHEMA"));
  });

  it("refuses keys that are not strings or finite numbers", async () => {
    const s = await make();
    await expect(s.tx(["meta"], (tx) => tx.meta.put({ k: undefined as unknown as string, v: 1 }))).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "INVALID_KEY"));
    await s.close();
  });

  it("runs the engine's state preparation on a fresh database", async () => {
    const { prepareState } = await import("@shuttle/engine");
    const s = await make();
    const prep = await prepareState(s, { newDbEpoch: () => "epoch-1" });
    expect(prep.dbEpoch).toBe("epoch-1");
    expect(await s.tx(["meta"], (tx) => tx.meta.get("schemaVersion"), "readonly")).toEqual({ k: "schemaVersion", v: STATE_SCHEMA_VERSION });
    await s.close();
  });
});
