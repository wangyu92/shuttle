// Engine fixes of P1 part 3 (lead decisions D5 and D6, 클로드 제안(미승인)): notes open in an editor go
// through processText (design §3.10.2, §3.8.4 S20), push-only status settles (design §3.17), remote
// moves into a folder this device excludes (D6), torn-write repair stays bounded (D5) and the
// rollbackAck hello field (design §2.6.1).

import { describe, expect, it } from "vitest";
import { Node, makeWorld, syncAll } from "./engineHarness";

describe("editorHasOpen → processText (design §3.10.2, S20)", () => {
  it("a remote change to a note open in the editor is applied through processText", async () => {
    const w = await makeWorld("editor-open");
    const open = new Set<string>(["n.md"]);
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta", opts: { editorHasOpen: (p) => open.has(p) } });
    a.fs.seed({ "n.md": "one\n", "closed.md": "x\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    const writesBefore = b.ops("write").length;
    w.clock.tick(1000);
    a.fs.external.write("n.md", "one\ntwo\n", { mtime: w.clock.now() });
    a.fs.external.write("closed.md", "x\ny\n", { mtime: w.clock.now() });
    a.engine.requestScan();
    await syncAll([a, b]);
    expect(b.fs.readText("n.md")).toBe("one\ntwo\n");
    expect(b.fs.readText("closed.md")).toBe("x\ny\n");
    expect(b.ops("processText")).toEqual(["n.md"]);
    expect(b.ops("write").slice(writesBefore)).toEqual(["closed.md"]);
  });

  it("without the hook every apply is an atomic write", async () => {
    const w = await makeWorld("editor-none");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "n.md": "one\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    w.clock.tick(1000);
    a.fs.external.write("n.md", "one\ntwo\n", { mtime: w.clock.now() });
    a.engine.requestScan();
    await syncAll([a, b]);
    expect(b.fs.readText("n.md")).toBe("one\ntwo\n");
    expect(b.ops("processText")).toEqual([]);
  });
});

describe("push-only status (design §3.17)", () => {
  it("records stay queued, the cursor advances, and status settles at synced", async () => {
    const w = await makeWorld("push-only");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta", settings: { mode: "push-only" } });
    a.fs.seed({ "n.md": "from alpha\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    expect(b.fs.exists("n.md")).toBe(false);
    const s = b.engine.status();
    expect(s.pendingDown).toBeGreaterThan(0);
    expect(s.status).toBe("synced");
  });
});

describe("D6: remote move into a folder this device excludes", () => {
  it("an unchanged copy is removed; re-including pulls it back; no delete is ever pushed", async () => {
    const w = await makeWorld("d6-unchanged");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta", settings: { excludedFolders: ["private"] } });
    a.fs.seed({ "a.md": "moving\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    a.fs.external.rename("a.md", "private/a.md");
    a.engine.requestScan();
    await syncAll([a, b]);
    expect(b.fs.exists("a.md")).toBe(false);
    expect(b.fs.exists("private/a.md")).toBe(false);
    await b.engine.updateSettings({ excludedFolders: [] });
    await syncAll([a, b]);
    expect(b.fs.readText("private/a.md")).toBe("moving\n");
    expect(w.server.inspect().log.filter((r) => r.kind === "del")).toEqual([]);
  });

  it("a locally changed copy stays at the old path as a new file (I6)", async () => {
    const w = await makeWorld("d6-changed");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta", settings: { excludedFolders: ["private"] } });
    a.fs.seed({ "a.md": "moving\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    w.clock.tick(1000);
    b.fs.external.write("a.md", "moving\nbeta's edit\n", { mtime: w.clock.now() });
    a.fs.external.rename("a.md", "private/a.md");
    a.engine.requestScan();
    await syncAll([a]);
    await syncAll([a, b]);
    // beta's edit is somewhere on alpha (the moved file merged, or a new file at the old path).
    const holders = [...a.fs.files().entries()].filter(([, bytes]) => new TextDecoder().decode(bytes).includes("beta's edit"));
    expect(holders.length).toBeGreaterThan(0);
    expect(w.server.inspect().log.filter((r) => r.kind === "del")).toEqual([]);
  });
});

describe("rollbackAck (design §2.6.1)", () => {
  it("helloContext carries no ack before any restore", async () => {
    const w = await makeWorld("hello-ctx");
    const a = new Node(w, { name: "alpha" });
    await a.start();
    await a.sync();
    const h = a.engine.helloContext();
    expect(h.rollbackAck).toBeNull();
    expect(typeof h.epoch).toBe("number");
  });
});
