// MemStateStore committed indexes: equality queries resolve through the index maps (merged with the
// transaction overlay) and must give exactly what a full scan gives; large stores stay linear.
import { describe, expect, it } from "vitest";
import type { FileEntry, RemoteHead } from "@shuttle/protocol";
import { MemStateStore, Prng, compareKeys } from "../src/index";

function entry(fileId: string, path: string, scope: FileEntry["scope"] = "active"): FileEntry {
  return { fileId, path, foldKey: path.toLowerCase(), scope, kind: "note", obs: null, synced: null, updatedAt: 1 };
}
function head(fileId: string, seq: number, pathKey: string, deleted: boolean): RemoteHead {
  return {
    fileId, seq, base: null, pathKey, path: `${fileId}.md`, deleted, size: 1, mtime: 1,
    contentHash: null, chunkSizes: [], blobs: [], kv: 1, deviceId: "dev", ts: 1,
  };
}

describe("MemStateStore index maps", () => {
  it("equality queries equal a brute-force scan across random commits, overlays, deletes and clears", async () => {
    const r = new Prng("mem-index");
    const s = new MemStateStore();
    const model = new Map<string, RemoteHead>();
    for (let round = 0; round < 60; round++) {
      const pending = new Map(model);
      let cleared = false;
      const abort = r.bool(0.15);
      await s.tx(["remote"], async (tx) => {
        for (let i = 0; i < 1 + r.int(12); i++) {
          const id = `f${r.int(40)}`;
          const roll = r.float();
          if (roll < 0.6) {
            const h = head(id, r.int(1000), `pk${r.int(8)}`, r.bool(0.3));
            await tx.remote.put(h);
            pending.set(id, h);
          } else if (roll < 0.95) {
            await tx.remote.delete(id);
            pending.delete(id);
          } else {
            await tx.remote.clear();
            pending.clear();
            cleared = true;
          }
          // Reads inside the transaction see the overlay.
          const pk = `pk${r.int(8)}`;
          const want = [...pending.values()].filter((h) => h.pathKey === pk).map((h) => h.fileId).sort((a, b) => compareKeys(a, b));
          const got = (await tx.remote.getAll({ index: "pathKey", only: pk })).map((h) => h.fileId);
          expect(got).toEqual(want);
          expect(await tx.remote.count({ index: "deleted", only: true })).toBe([...pending.values()].filter((h) => h.deleted).length);
        }
        if (abort) throw new Error("abort");
      }).catch((e: unknown) => {
        if (!(e instanceof Error && e.message === "abort")) throw e;
      });
      void cleared;
      if (!abort) {
        model.clear();
        for (const [k, v] of pending) model.set(k, v);
      }
      const all = await s.tx(["remote"], async (tx) => ({
        del: (await tx.remote.getAll({ index: "deleted", only: true })).map((h) => h.fileId),
        live: (await tx.remote.getAll({ index: "deleted", only: false, direction: "prev" })).map((h) => h.fileId),
        one: await tx.remote.getByIndex("pathKey", "pk3"),
        byKey: await tx.remote.getAll({ only: "f7" }),
      }), "readonly");
      const sorted = [...model.values()].sort((a, b) => compareKeys(a.fileId, b.fileId));
      expect(all.del).toEqual(sorted.filter((h) => h.deleted).map((h) => h.fileId));
      expect(all.live).toEqual(sorted.filter((h) => !h.deleted).map((h) => h.fileId).reverse());
      expect(all.one?.fileId).toBe(sorted.find((h) => h.pathKey === "pk3")?.fileId);
      expect(all.byKey.map((h) => h.fileId)).toEqual(model.has("f7") ? ["f7"] : []);
    }
  });

  it("a unique index still rejects a clash after the old holder was moved in the same transaction", async () => {
    const s = new MemStateStore();
    await s.tx(["files"], async (tx) => {
      await tx.files.put(entry("a", "x.md"));
      await tx.files.put(entry("b", "y.md"));
    });
    await s.tx(["files"], async (tx) => {
      await tx.files.put(entry("a", "z.md"));     // frees x.md inside the overlay
      await tx.files.put(entry("b", "x.md"));     // allowed now
    });
    await expect(s.tx(["files"], async (tx) => { await tx.files.put(entry("c", "z.md")); })).rejects.toMatchObject({ code: "CONSTRAINT" });
    const got = await s.tx(["files"], (tx) => tx.files.getByIndex("path", "x.md"), "readonly");
    expect(got?.fileId).toBe("b");
  });

  it("10k entries in one transaction plus 10k indexed lookups stay fast (no per-put scan)", async () => {
    const s = new MemStateStore();
    const t0 = performance.now();
    await s.tx(["files"], async (tx) => {
      for (let i = 0; i < 10_000; i++) await tx.files.put(entry(`id${i}`, `n/${i}.md`, i % 10 === 0 ? "excluded" : "active"));
    });
    await s.tx(["files"], async (tx) => {
      for (let i = 0; i < 10_000; i++) expect((await tx.files.getByIndex("path", `n/${i}.md`))?.fileId).toBe(`id${i}`);
    }, "readonly");
    const n = await s.tx(["files"], (tx) => tx.files.count({ index: "scope", only: "excluded" }), "readonly");
    expect(n).toBe(1000);
    expect(performance.now() - t0).toBeLessThan(20_000);
  });
});
