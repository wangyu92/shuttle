// Lead decision D8 (클로드 제안(미승인)): merge writes and pull applies go through a same-folder temp
// file and a rename over the target, so the pre-merge file survives until the merged bytes are durable
// (design §3.2 "temp file + rename", §3.8.4, §3.18 I6). Sim seeds 730 and 634 lost a user edit when a
// torn merge write destroyed the note and the state store (the only other copy) was then evicted.
import { describe, expect, it } from "vitest";
import { MemLocalFs } from "@shuttle/testkit";
import { REPLACE_TEMP_PREFIX, isReplaceTemp, replaceFile } from "../src/index";
import { Crash } from "./harness";
import { Node, isCrashLike, makeWorld, syncAll } from "./engineHarness";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of the note\n`);
const BASE = lines(12).join("");
const REMOTE_EDIT = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; return l.join(""); })();
const LOCAL_EDIT = (() => { const l = lines(12); l[9] = "line 9 tok-B ON BETA\n"; return l.join(""); })();

describe("D8 atomic replace", () => {
  it("torn merge write, process dies, state store evicted: both edits survive", async () => {
    const w = await makeWorld("d8-evict");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "doc.md": BASE });
    await a.start(); await b.start();
    await syncAll([a, b]);
    w.clock.tick(1000);
    a.fs.external.write("doc.md", REMOTE_EDIT, { mtime: w.clock.now() });
    a.engine.requestScan();
    await a.sync();
    w.clock.tick(1000);
    b.fs.seed({ "doc.md": LOCAL_EDIT }, { mtime: w.clock.now() });
    let tornPath = "";
    b.fs.tearNextWrite({
      path: "doc.md", fraction: 0.4,
      onTear: (p) => { tornPath = p; b.crashed = true; b.store.crash(); throw new Crash("torn write"); },
    });
    b.engine.requestScan();
    await syncAll([b]).catch((e: unknown) => { if (!isCrashLike(e)) throw e; });
    expect(b.fs.torn.length).toBe(1);
    expect(isReplaceTemp(tornPath)).toBe(true);
    // The note was never touched: it still holds the unpushed local edit.
    expect(b.fs.readText("doc.md")).toBe(LOCAL_EDIT);
    // iOS-style eviction: the state store (staged merge, intents, bases) is gone.
    await b.restart({ wipeState: true });
    await syncAll([a, b], 80);
    const texts = (n: Node) => [...n.fs.files().values()].map((x) => new TextDecoder().decode(x)).join("|");
    for (const n of [a, b]) {
      expect(texts(n), `${n.o.name} keeps beta's edit`).toContain("tok-B");
      expect(texts(n), `${n.o.name} keeps alpha's edit`).toContain("tok-A");
    }
    // The temp left by the tear is swept by the startup scan.
    expect([...b.fs.files().keys()].filter(isReplaceTemp)).toEqual([]);
  });

  it("replaceFile never removes the target first; a failed rename leaves it whole", async () => {
    const fs = new MemLocalFs();
    await fs.write("n.md", new TextEncoder().encode("old\n"), { mtime: 1 });
    fs.failNext("rename", "EIO");
    await expect(replaceFile(fs, "n.md", new TextEncoder().encode("new\n"), { mtime: 2 })).rejects.toThrow();
    expect(fs.readText("n.md")).toBe("old\n");
    expect([...fs.files().keys()]).toEqual(["n.md"]);
    const st = await replaceFile(fs, "n.md", new TextEncoder().encode("new\n"), { mtime: 3 });
    expect(fs.readText("n.md")).toBe("new\n");
    expect(st.size).toBe(4);
    expect([...fs.files().keys()]).toEqual(["n.md"]);
  });

  it("only a rename from a replace temp may overwrite an existing file", async () => {
    const fs = new MemLocalFs();
    await fs.write("a.md", new TextEncoder().encode("a\n"), { mtime: 1 });
    await fs.write("b.md", new TextEncoder().encode("b\n"), { mtime: 1 });
    await expect(fs.rename("a.md", "b.md")).rejects.toMatchObject({ code: "EEXIST" });
    await fs.write(`${REPLACE_TEMP_PREFIX}x`, new TextEncoder().encode("t\n"), { mtime: 1 });
    await fs.rename(`${REPLACE_TEMP_PREFIX}x`, "b.md");
    expect(fs.readText("b.md")).toBe("t\n");
  });
});
