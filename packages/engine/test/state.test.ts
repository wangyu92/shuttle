import type { FileEntry, RemoteHead } from "@shuttle/protocol";
import { isStateStoreError, STATE_SCHEMA_VERSION } from "@shuttle/protocol";
import { MemStateData, MemStateStore } from "@shuttle/testkit";
import { describe, expect, it } from "vitest";
import {
  adoptInIndex, classifyStartup, FileIndex, foldKey, mirrorPendingOp, PENDING_OPS_CAP, prepareState, readMeta, unmirrorPendingOp, writeMeta,
} from "../src/index";

const F = "a".repeat(32);
const G = "b".repeat(32);
const now = () => 1000;

function head(o: Partial<RemoteHead> & { fileId: string; seq: number }): RemoteHead {
  return { base: null, pathKey: "pk-" + (o.path ?? "x.md"), path: "x.md", deleted: false, size: 1, mtime: 1, contentHash: "h", chunkSizes: [], blobs: [], kv: 1, deviceId: "d", ts: 1, ...o };
}

describe("prepareState (design §3.3.1)", () => {
  it("initialises a fresh DB once and keeps its dbEpoch", async () => {
    const s = new MemStateStore();
    const a = await prepareState(s, { newDbEpoch: () => "E1" });
    expect(a).toEqual({ created: true, dbEpoch: "E1", migratedFrom: null });
    const b = await prepareState(s, { newDbEpoch: () => "E2" });
    expect(b).toEqual({ created: false, dbEpoch: "E1", migratedFrom: null });
    expect(await readMeta(s, "schemaVersion")).toBe(STATE_SCHEMA_VERSION);
  });

  it("refuses a newer stored schema", async () => {
    const s = new MemStateStore();
    await writeMeta(s, "schemaVersion", STATE_SCHEMA_VERSION + 1);
    await expect(prepareState(s, { newDbEpoch: () => "E" })).rejects.toSatisfy((e) => isStateStoreError(e, "NEWER_SCHEMA"));
    const t = new MemStateStore(new MemStateData(), { schemaVersion: STATE_SCHEMA_VERSION + 1 });
    await expect(prepareState(t, { newDbEpoch: () => "E" })).rejects.toSatisfy((e) => isStateStoreError(e, "NEWER_SCHEMA"));
  });

  it("runs forward migrations in order", async () => {
    const s = new MemStateStore();
    await writeMeta(s, "schemaVersion", 1);
    await writeMeta(s, "dbEpoch", "E");
    const ran: number[] = [];
    const r = await prepareState(s, {
      newDbEpoch: () => "X", codeVersion: 3,
      migrations: [{ to: 3, run: async () => { ran.push(3); } }, { to: 2, run: async () => { ran.push(2); } }],
    });
    expect(ran).toEqual([2, 3]);
    expect(r.migratedFrom).toBe(1);
    expect(await readMeta(s, "schemaVersion")).toBe(3);
  });
});

describe("eviction detection (design §3.3.5)", () => {
  it("four-row table", () => {
    expect(classifyStartup(null, null)).toBe("fresh");
    expect(classifyStartup(null, "E")).toBe("adoptIdb");
    expect(classifyStartup({ dbEpoch: "E", everSynced: true }, "E")).toBe("normal");
    expect(classifyStartup({ dbEpoch: "E", everSynced: true }, null)).toBe("evicted");
    expect(classifyStartup({ dbEpoch: "E", everSynced: true }, "F")).toBe("evicted");
    expect(classifyStartup({ dbEpoch: "E", everSynced: false }, null)).toBe("fresh");
  });

  it("pendingOps mirror is capped at 500 and keyed by fileId", () => {
    let list = mirrorPendingOp([], { fileId: F, kind: "put", toPath: "a.md" });
    list = mirrorPendingOp(list, { fileId: F, kind: "delete" });
    expect(list).toEqual([{ fileId: F, kind: "delete" }]);
    for (let i = 0; i < 600; i++) list = mirrorPendingOp(list, { fileId: String(i).padStart(32, "0"), kind: "put" });
    expect(list.length).toBe(PENDING_OPS_CAP);
    expect(unmirrorPendingOp(list, list[0]!.fileId).length).toBe(PENDING_OPS_CAP - 1);
  });
});

describe("FileIndex (design §3.3.3, §3.6.3)", () => {
  const mk = (path: string, fileId = F): Parameters<FileIndex["createEntry"]>[0] => ({ fileId, path, scope: "active", kind: "note", obs: { mtime: 1, size: 1, hash: "h" } });

  it("write-through and reload", async () => {
    const s = new MemStateStore();
    const ix = await FileIndex.load(s, now);
    await ix.createEntry(mk("A/Note.md"));
    await ix.upsertRemote(head({ fileId: G, seq: 3, path: "B.md" }));
    const ix2 = await FileIndex.load(s, now);
    expect(ix2.byPath("A/Note.md")?.foldKey).toBe("a/note.md");
    expect(ix2.byFoldKey("a/note.md").map((e) => e.fileId)).toEqual([F]);
    expect(ix2.remote.liveByFoldKey("b.md")?.seq).toBe(3);
  });

  it("case-sensitive platforms hold two entries per foldKey", async () => {
    const ix = await FileIndex.load(new MemStateStore(), now);
    await ix.createEntry(mk("Note.md", F));
    await ix.createEntry(mk("note.md", G));
    expect(ix.byFoldKey(foldKey("NOTE.md")).length).toBe(2);
  });

  it("a failed transaction leaves memory unchanged (rollback)", async () => {
    const s = new MemStateStore();
    const ix = await FileIndex.load(s, now);
    await ix.createEntry(mk("a.md"));
    s.injectCommitFault("fail");
    await expect(ix.setPath(F, "b.md")).rejects.toBeTruthy();
    expect(ix.byPath("a.md")?.fileId).toBe(F);
    expect(ix.byPath("b.md")).toBeNull();
    await expect(ix.write([], async (w) => {
      await w.putEntry({ ...ix.byFileId(F)!, path: "c.md" });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(ix.byPath("c.md")).toBeNull();
    expect((await FileIndex.load(s, now)).byPath("a.md")?.fileId).toBe(F);
  });

  it("unique path: a second entry at a held path throws CONSTRAINT and changes nothing", async () => {
    const ix = await FileIndex.load(new MemStateStore(), now);
    await ix.createEntry(mk("a.md", F));
    await expect(ix.createEntry(mk("a.md", G))).rejects.toSatisfy((e) => isStateStoreError(e, "CONSTRAINT"));
    expect(ix.byFileId(G)).toBeNull();
  });

  it("reads inside a write see the transaction's own writes", async () => {
    const ix = await FileIndex.load(new MemStateStore(), now);
    await ix.createEntry(mk("a.md"));
    await ix.write([], async (w) => {
      const e = w.entry(F)!;
      await w.putEntry({ ...e, path: "b.md" });
      expect(w.entryByPath("a.md")).toBeNull();
      expect(w.entryByPath("b.md")?.fileId).toBe(F);
      expect(ix.byPath("a.md")?.fileId).toBe(F); // committed view unchanged until commit
    });
    expect(ix.byPath("b.md")?.fileId).toBe(F);
    expect(ix.byPath("a.md")).toBeNull();
  });

  it("remote heads keep the maximum seq (S12)", async () => {
    const s = new MemStateStore();
    const ix = await FileIndex.load(s, now);
    expect(await ix.upsertRemote(head({ fileId: G, seq: 5 }))).toBe(true);
    expect(await ix.upsertRemote(head({ fileId: G, seq: 4, path: "old.md" }))).toBe(false);
    expect(await ix.upsertRemote(head({ fileId: G, seq: 5, path: "same.md" }))).toBe(false);
    expect(ix.remote.byFileId(G)?.seq).toBe(5);
    expect(await ix.upsertRemote(head({ fileId: G, seq: 7, path: "y.md", deleted: true, contentHash: null }))).toBe(true);
    expect(ix.remote.liveByFoldKey("x.md")).toBeNull();
    expect(ix.remote.tombstoneByFoldKey("y.md")?.seq).toBe(7);
    expect(ix.remote.headForFoldKey("y.md")?.deleted).toBe(true);
    const ix2 = await FileIndex.load(s, now);
    expect(ix2.remote.byFileId(G)?.seq).toBe(7);
  });

  it("entriesUnder, counts, forget removes the base too", async () => {
    const s = new MemStateStore();
    const ix = await FileIndex.load(s, now);
    await ix.createEntry(mk("d/a.md", F));
    await ix.createEntry({ ...mk("d/sub/b.png", G), scope: "excluded", kind: "attachment" });
    await s.tx(["bases"], (tx) => tx.bases.put({ fileId: F, version: 1, hash: "h", bytes: new Uint8Array([1]) }));
    expect(ix.entriesUnder("d").length).toBe(2);
    expect(ix.entriesUnder("d/sub").map((e) => e.fileId)).toEqual([G]);
    expect(ix.countByScope()).toEqual({ active: 1, excluded: 1 });
    expect(ix.activeCount()).toBe(1);
    await ix.forget(F);
    expect(ix.byFileId(F)).toBeNull();
    expect(await s.tx(["bases"], (tx) => tx.bases.get(F), "readonly")).toBeUndefined();
  });

  it("returned entries are copies", async () => {
    const ix = await FileIndex.load(new MemStateStore(), now);
    await ix.createEntry(mk("a.md"));
    const e = ix.byPath("a.md") as FileEntry;
    e.path = "mutated";
    expect(ix.byPath("a.md")?.path).toBe("a.md");
  });

  it("adoptInIndex replaces our entry with the remote fileId in one transaction", async () => {
    const s = new MemStateStore();
    const ix = await FileIndex.load(s, now);
    await ix.createEntry(mk("x.md", F));
    const R = head({ fileId: G, seq: 9, path: "x.md", contentHash: "h" });
    await ix.upsertRemote(R);
    const e = await adoptInIndex(ix, { R, L: { path: "x.md", hash: "h", size: 1, mtime: 1 }, replaces: F, kind: "note", now: 5, baseBytes: new Uint8Array([7]) });
    expect(e.synced).toEqual({ version: 9, path: "x.md", hash: "h", size: 1, mtime: 1, hasBase: true });
    expect(ix.byFileId(F)).toBeNull();
    expect(ix.byPath("x.md")?.fileId).toBe(G);
    expect((await s.tx(["bases"], (tx) => tx.bases.get(G), "readonly"))?.version).toBe(9);
    await expect(adoptInIndex(ix, { R: { ...R, contentHash: "other" }, L: { path: "x.md", hash: "h", size: 1, mtime: 1 }, kind: "note", now: 5 })).rejects.toThrow();
  });
});
