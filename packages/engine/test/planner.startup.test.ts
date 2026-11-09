// I11 startup deviation (design §3.10.6, §3.18): a locally created note meeting a different remote at the
// same path keeps both, except the empty/prefix ADOPT refinement (template notes).

import { describe, expect, it } from "vitest";
import { decide, type PlanInput } from "../src/index";
import { Node, makeWorld, syncAll } from "./engineHarness";

async function meet(seed: string, local: string, remote: string) {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  a.fs.seed({ "Daily/2026-11-09.md": remote });
  await a.start();
  await a.sync();
  const b = new Node(w, { name: "beta" });
  b.fs.seed({ "Daily/2026-11-09.md": local });
  await b.start();
  await syncAll([b, a]);
  return { w, a, b };
}

describe("I11 startup deviation", () => {
  it("different content at the same path keeps both", async () => {
    const { a, b } = await meet("i11-both", "beta wrote this\n", "alpha wrote that\n");
    const files = [...b.fs.files().entries()].map(([p, v]) => [p, new TextDecoder().decode(v)] as const);
    expect(files.map((f) => f[1]).sort()).toEqual(["alpha wrote that\n", "beta wrote this\n"]);
    expect(b.fs.readText("Daily/2026-11-09.md")).toBe("alpha wrote that\n");
    expect([...a.fs.files().keys()].sort()).toEqual([...b.fs.files().keys()].sort());
  });

  it("an empty local note adopts the remote", async () => {
    const { b } = await meet("i11-empty", "", "alpha wrote that\n");
    expect([...b.fs.files().keys()]).toEqual(["Daily/2026-11-09.md"]);
    expect(b.fs.readText("Daily/2026-11-09.md")).toBe("alpha wrote that\n");
  });

  it("a local template that is a prefix of the remote adopts the remote", async () => {
    const { b } = await meet("i11-prefix", "# Daily\n", "# Daily\nwent for a walk\n");
    expect([...b.fs.files().keys()]).toEqual(["Daily/2026-11-09.md"]);
    expect(b.fs.readText("Daily/2026-11-09.md")).toBe("# Daily\nwent for a walk\n");
  });

  it("table: no-base rows never drop either side", () => {
    const R = { fileId: "b".repeat(32), seq: 3, base: null, pathKey: "pk", path: "n.md", deleted: false, size: 1, mtime: 1, contentHash: "r",
      chunkSizes: [], blobs: [], kv: 1, deviceId: "d", ts: 1 };
    for (const kind of ["note", "attachment", "other"] as const) {
      const i: PlanInput = { L: { path: "n.md", hash: "l", size: 1, mtime: 1 }, entry: null, R, path: "n.md", scope: "active", kind,
        configJson: false, conflictMode: "merge", ctx: { mode: "incremental" } };
      const a = decide(i);
      expect(a.type, kind).toBe("KEEP_BOTH");
      if (a.type === "KEEP_BOTH") expect(a.allowTemplateAdopt).toBe(kind === "note");
    }
  });
});
