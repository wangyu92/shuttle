// design §3.5 rename pairing vs the periodic fast scan (§3.14). A move reported as delete + create
// (watchers that report in pieces) is held by the event queue until its create arrives. A scan that
// lands in between saw the old path missing and the new path untracked, and pushed a delete plus a
// create (headless rename.e2e under load). The scan now pairs them by size and hash.
import { describe, expect, it } from "vitest";
import { drainMicrotasks } from "@shuttle/testkit";
import { Node, makeWorld, serverMap, syncAll } from "./engineHarness";

describe("scan between a move's delete and its create", () => {
  it("pairs the move: one rename, no delete, same fileId", async () => {
    const w = await makeWorld("scan-rename");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "notes/x.md": "the moved note\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    const before = w.server.inspect().heads.find((r) => r.kind === "put")!.fileId;
    // The watcher reported the delete (held for pairing); the create has not been reported yet.
    a.fs.external.remove("notes/x.md");
    a.fs.seed({ "archive/x.md": "the moved note\n" });
    await drainMicrotasks();
    expect(a.engine.events.pendingDeletes).toBe(1);
    // The periodic fast scan runs now.
    a.engine.requestScan("fast");
    await a.engine.runOnce();
    await syncAll([a, b]);
    expect(w.server.inspect().log.filter((r) => r.kind === "del")).toEqual([]);
    const heads = w.server.inspect().heads.filter((r) => r.kind === "put");
    expect(heads.length).toBe(1);
    expect(heads[0]!.fileId).toBe(before);
    expect([...(await serverMap(w)).keys()]).toEqual(["archive/x.md"]);
    expect(b.fs.readText("archive/x.md")).toBe("the moved note\n");
    expect(b.fs.exists("notes/x.md")).toBe(false);
  });

  it("a real delete (no partner) still goes out once the hold expires", async () => {
    const w = await makeWorld("scan-delete");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "notes/x.md": "gone\n" });
    await a.start();
    await b.start();
    await syncAll([a, b]);
    a.fs.external.remove("notes/x.md");
    await drainMicrotasks();
    a.engine.requestScan("fast");
    await a.engine.runOnce();
    await syncAll([a, b]);
    expect(w.server.inspect().log.filter((r) => r.kind === "del").length).toBe(1);
    expect(b.fs.exists("notes/x.md")).toBe(false);
  });
});
