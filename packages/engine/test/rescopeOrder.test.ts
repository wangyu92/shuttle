// Filter changes whose rescope runs later than the user's next actions (design §3.11, I12, lead
// decision D6). Sim seeds 151 and 200: a folder is re-included, the user deletes a file in it before the
// next loop runs; the rescope took the missing file for one that vanished while excluded and pulled it
// back (a ghost). Sim seed 2: the filter went A → B → A with a rename under B and a restart before the
// rescope; the stored fingerprint still matched A, the rescope never ran and the moved files were missing.
import { describe, expect, it } from "vitest";
import { Node, makeWorld, serverMap, syncAll } from "./engineHarness";

describe("rescope ordering", () => {
  it("a delete right after re-including a folder is pushed, never pulled back", async () => {
    const w = await makeWorld("rescope-delete");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "private/x.md": "kept\n", "private/y.md": "other\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    await a.engine.updateSettings({ excludedFolders: ["private"] });
    await syncAll([a, b]);
    await a.engine.updateSettings({ excludedFolders: [] });
    // The user deletes the file before alpha's loop runs again (no rescope yet).
    a.fs.external.remove("private/x.md");
    await syncAll([a, b]);
    expect(a.fs.exists("private/x.md")).toBe(false);
    expect(b.fs.exists("private/x.md")).toBe(false);
    expect(a.fs.readText("private/y.md")).toBe("other\n");
    expect(w.server.inspect().log.filter((r) => r.kind === "del").length).toBe(1);
  });

  it("a file that vanished while excluded is still pulled back on re-inclusion (D6)", async () => {
    const w = await makeWorld("rescope-vanished");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "private/x.md": "kept\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    await a.engine.updateSettings({ excludedFolders: ["private"] });
    await syncAll([a, b]);
    a.fs.external.remove("private/x.md");
    await syncAll([a, b]);
    await a.engine.updateSettings({ excludedFolders: [] });
    await syncAll([a, b]);
    expect(a.fs.readText("private/x.md")).toBe("kept\n");
    expect(w.server.inspect().log.filter((r) => r.kind === "del")).toEqual([]);
  });

  it("A → B → A with a restart before the rescope still runs it (rename made under B)", async () => {
    const w = await makeWorld("rescope-aba");
    const a = new Node(w, { name: "alpha", settings: { excludedFolders: ["private"] } });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "proj/f.md": "moved\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    await a.engine.updateSettings({ excludedFolders: [] });
    // Under B the user moves the file into private; alpha applies the rename to its index.
    a.fs.external.rename("proj/f.md", "private/f.md");
    await a.flushEvents();
    await a.engine.updateSettings({ excludedFolders: ["private"] });
    // The process dies before any loop ran the rescope (no push happened either).
    await a.restart();
    await syncAll([a, b], 60);
    // Every live head outside the excluded folder is on alpha (I7); the user's file stays where moved.
    const heads = await serverMap(w);
    for (const [p] of heads) if (!p.startsWith("private/")) expect(a.fs.exists(p), p).toBe(true);
    expect(a.fs.readText("private/f.md")).toBe("moved\n");
  });
});
