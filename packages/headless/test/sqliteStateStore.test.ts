// SqliteStateStore (design §6.1.5): the shared StateStore contract on :memory: and on a real file,
// MemStateStore under the same suite (parity), plus durability, layout refusal and backups.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isStateStoreError } from "@shuttle/protocol";
import { MemStateStore } from "@shuttle/testkit";
import { SqliteStateStore, decodeValue, encodeValue } from "../src/state/SqliteStateStore";
import { entry, op, stateStoreContract } from "./stateContract";
import { removeDir, tempDir } from "./tmp";

let dir = "";
let n = 0;
beforeAll(async () => { dir = await tempDir("sql"); });
afterAll(async () => { await removeDir(dir); });

stateStoreContract("MemStateStore", () => new MemStateStore());
stateStoreContract("SqliteStateStore :memory:", () => SqliteStateStore.open(":memory:"));
// synchronous=NORMAL here: FULL fsyncs every commit (~100 ms on the NAS); the durability tests below use FULL.
stateStoreContract("SqliteStateStore file", () => SqliteStateStore.open(path.join(dir, `c${++n}.db`), { synchronous: "normal" }));

// FULL fsyncs cost ~100 ms each on the NAS and far more while the whole suite runs, so these get 60 s.
describe("SqliteStateStore durability", { timeout: 60_000 }, () => {
  it("committed data survives close and reopen; the opSeq counter continues", async () => {
    const f = path.join(dir, "reopen.db");
    const s = SqliteStateStore.open(f);
    await s.tx(["files", "journal", "bases"], async (tx) => {
      await tx.files.put(entry("a", "Ä/b.md"));
      await tx.journal.put(op("a"));
      await tx.bases.put({ fileId: "a", version: 3, hash: "h", bytes: new Uint8Array(70_000).fill(7) });
    });
    await s.close();
    const s2 = SqliteStateStore.open(f);
    const got = await s2.tx(["files", "bases"], async (tx) => [await tx.files.getByIndex("path", "Ä/b.md"), await tx.bases.get("a")] as const, "readonly");
    expect(got[0]?.fileId).toBe("a");
    expect(got[1]?.bytes.length).toBe(70_000);
    expect(await s2.tx(["journal"], (tx) => tx.journal.put(op("b")))).toBe(2);
    await s2.close();
  });

  it("abandon() mid-transaction (process death) loses only the uncommitted transaction", async () => {
    const f = path.join(dir, "abandon.db");
    const s = SqliteStateStore.open(f);
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "cursor", v: 1 }); });
    const inflight = s.tx(["meta"], async (tx) => {
      await tx.meta.put({ k: "cursor", v: 2 });
      s.abandon();
      await tx.meta.put({ k: "other", v: 3 });
    });
    await expect(inflight).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CRASHED"));
    await expect(s.tx(["meta"], async () => 1)).rejects.toSatisfy((e: unknown) => isStateStoreError(e, "CRASHED"));
    const s2 = SqliteStateStore.open(f);
    expect(await s2.tx(["meta"], (tx) => tx.meta.getAll(), "readonly")).toEqual([{ k: "cursor", v: 1 }]);
    await s2.close();
  });

  it("beforeCommit can veto a commit", async () => {
    const s = SqliteStateStore.open(":memory:", { beforeCommit: (i) => { if (i.writes > 1) throw new Error("veto"); } });
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); });
    await expect(s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "b", v: 1 }); await tx.meta.put({ k: "c", v: 1 }); })).rejects.toThrow("veto");
    expect(await s.tx(["meta"], (tx) => tx.meta.count(), "readonly")).toBe(1);
    await s.close();
  });

  it("refuses a newer table layout and reports a newer meta.schemaVersion", async () => {
    const f = path.join(dir, "newer.db");
    const s = SqliteStateStore.open(f);
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "schemaVersion", v: 99 }); });
    await s.close();
    const s2 = SqliteStateStore.open(f);
    expect(s2.schemaVersion).toBe(99);
    await s2.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(f);
    raw.exec("PRAGMA user_version = 7");
    raw.close();
    expect(() => SqliteStateStore.open(f)).toThrow(/newer/);
  });

  it("destroy() removes the database files", async () => {
    const f = path.join(dir, "gone.db");
    const s = SqliteStateStore.open(f);
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "a", v: 1 }); });
    await s.destroy();
    expect((await readdir(dir)).filter((x) => x.startsWith("gone.db"))).toEqual([]);
  });

  it("backup() writes VACUUM INTO copies and keeps three", async () => {
    const f = path.join(dir, "bk.db");
    const bdir = path.join(dir, "backup");
    const s = SqliteStateStore.open(f);
    await s.tx(["meta"], async (tx) => { await tx.meta.put({ k: "cursor", v: 42 }); });
    const days = [new Date(2026, 10, 1), new Date(2026, 10, 2), new Date(2026, 10, 3), new Date(2026, 10, 4)];
    for (const d of days) expect(await s.backup(bdir, d)).not.toBeNull();
    expect(await s.backup(bdir, days[3])).toBeNull();
    expect((await readdir(bdir)).sort()).toEqual(["state-20261102.db", "state-20261103.db", "state-20261104.db"]);
    const copy = SqliteStateStore.open(path.join(bdir, "state-20261104.db"));
    expect((await copy.tx(["meta"], (tx) => tx.meta.get("cursor"), "readonly"))?.v).toBe(42);
    await copy.close();
    await s.close();
  });

  it("value codec keeps nested binaries and plain objects apart", () => {
    const v = { a: new Uint8Array([1, 2]), b: [{ c: new Uint8Array([3]) }], d: { "\u0000bin": "x" }, e: null };
    const { v: text, b } = encodeValue(v);
    const back = decodeValue(text, b) as typeof v;
    expect(back.a).toEqual(new Uint8Array([1, 2]));
    expect(back.b[0]?.c).toEqual(new Uint8Array([3]));
    expect(back.d).toEqual({ "\u0000bin": "x" });
    expect(back.e).toBeNull();
    expect(() => encodeValue({ x: new Uint32Array(1) })).toThrow();
  });

  it("10k files in one transaction plus 10k indexed lookups stay fast", async () => {
    const s = SqliteStateStore.open(path.join(dir, "perf.db"));
    const t0 = performance.now();
    await s.tx(["files"], async (tx) => {
      for (let i = 0; i < 10_000; i++) await tx.files.put(entry(`id${i}`, `n/${i}.md`, { scope: i % 10 === 0 ? "excluded" : "active" }));
    });
    await s.tx(["files"], async (tx) => {
      for (let i = 0; i < 10_000; i += 7) expect((await tx.files.getByIndex("path", `n/${i}.md`))?.fileId).toBe(`id${i}`);
    }, "readonly");
    expect(await s.tx(["files"], (tx) => tx.files.count({ index: "scope", only: "excluded" }), "readonly")).toBe(1000);
    expect(performance.now() - t0).toBeLessThan(30_000);
    await s.close();
  }, 60_000);
});
