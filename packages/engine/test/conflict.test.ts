// I10 conflict copy content (design §3.10.5, §3.18): copy = the detecting device's content, original =
// the remote head's content, and the copy is written before the original is overwritten.

import { describe, expect, it } from "vitest";
import type { World } from "./harness";
import { Node, makeWorld, serverMap, sortedEntries, syncAll } from "./engineHarness";

function edit(w: World, n: Node, path: string, content: string | Uint8Array, mtimeOffset = 0): void {
  w.clock.tick(1000);
  n.fs.external.write(path, content, { mtime: w.clock.now() + mtimeOffset });
  n.engine.requestScan();
}

const copyPaths = (n: Node): string[] => [...n.fs.files().keys()].filter((p) => p.includes("Conflicted copy"));

/** Index of the first fs op that puts bytes at `pred` paths (write, or a rename onto them). */
function firstPut(n: Node, pred: (p: string) => boolean, from = 0): number {
  return n.fsOps.findIndex((o, i) => i >= from && (o.op === "write" || o.op === "rename") && pred(o.path));
}

async function conflicted(seed: string, mode: "merge" | "conflictFile", path: string, va: string, vb: string) {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha", settings: { conflictMode: mode } });
  const b = new Node(w, { name: "beta", settings: { conflictMode: mode } });
  await a.start();
  await b.start();
  edit(w, a, path, "same line\n");
  await syncAll([a, b]);
  edit(w, a, path, va);
  edit(w, b, path, vb);
  await a.sync();
  b.fsOps.length = 0;
  await b.sync();
  await syncAll([a, b]);
  return { w, a, b };
}

describe("I10 conflict copy content", () => {
  it("overlapping note edits: copy holds the detecting device's text, original the remote's", async () => {
    const { w, a, b } = await conflicted("i10-note", "merge", "n.md", "alpha line\n", "beta line\n");
    const copies = copyPaths(b);
    expect(copies.length).toBe(1);
    expect(copies[0]).toContain("Conflicted copy beta");
    expect(b.fs.readText(copies[0]!)).toBe("beta line\n");
    expect(b.fs.readText("n.md")).toBe("alpha line\n");
    // Copy first: B's bytes are at the copy path before the original receives the remote bytes.
    const copyAt = firstPut(b, (p) => p.includes("Conflicted copy"));
    const origAt = b.fsOps.findIndex((o, i) => i > copyAt && o.op === "write" && o.path === "n.md");
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(origAt).toBeGreaterThan(copyAt);
    expect(sortedEntries(await a.diskMap())).toEqual(sortedEntries(await serverMap(w)));
    expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(await serverMap(w)));
  });

  it("conflictFile mode: any both-changed file keeps both, detecting device's bytes in the copy", async () => {
    const { a, b } = await conflicted("i10-file", "conflictFile", "doc.txt", "from alpha\n", "from beta\n");
    const copies = copyPaths(b);
    expect(copies.length).toBe(1);
    expect(b.fs.readText(copies[0]!)).toBe("from beta\n");
    expect(b.fs.readText("doc.txt")).toBe("from alpha\n");
    expect(a.fs.readText(copies[0]!)).toBe("from beta\n");
  });
});
