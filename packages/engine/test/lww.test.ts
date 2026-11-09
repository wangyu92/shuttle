// I26 rejected server change (design §3.10.4, §3.18): both-changed LWW with an older remote mtime keeps
// local and pushes it, the remote content stays in history, and the log says "Rejected server change".

import { describe, expect, it } from "vitest";
import { Prng } from "@shuttle/testkit";
import { lwwDecide, MTIME_CLAMP_MS } from "../src/index";
import { contentOf, recordsOf } from "./harness";
import { Node, makeWorld, syncAll } from "./engineHarness";

const bytes = (s: string): Uint8Array => new Prng(s).bytes(9000);

describe("I26 LWW", () => {
  it("decision table", () => {
    expect(lwwDecide({ localMtime: 10, remoteMtime: 5, remoteTs: 5 }).winner).toBe("local");
    expect(lwwDecide({ localMtime: 5, remoteMtime: 10, remoteTs: 10 }).winner).toBe("remote");
    // future mtimes are clamped to ts + 24 h
    expect(lwwDecide({ localMtime: 1000, remoteMtime: 10 + 10 * MTIME_CLAMP_MS, remoteTs: 10 }).winner).toBe("local");
  });

  it("older remote mtime: local stays and is pushed, remote kept in history, log line", async () => {
    const w = await makeWorld("i26");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    await a.start();
    await b.start();
    a.fs.external.write("pic.png", bytes("v0"), { mtime: w.clock.now() });
    a.engine.requestScan();
    await syncAll([a, b]);
    w.clock.tick(1000);
    const t = w.clock.now();
    a.fs.external.write("pic.png", bytes("va"), { mtime: t });          // older
    b.fs.external.write("pic.png", bytes("vb"), { mtime: t + 60_000 }); // newer, detects the conflict
    a.engine.requestScan();
    b.engine.requestScan();
    await a.sync();
    await b.sync();
    await syncAll([a, b]);
    expect(b.fs.files().get("pic.png")).toEqual(bytes("vb"));
    expect(a.fs.files().get("pic.png")).toEqual(bytes("vb"));
    expect(b.engine.log.entries().some((e) => e.key === "log.rejectedServerChange" && e.path === "pic.png")).toBe(true);
    const puts = recordsOf(w, (r) => r.kind === "put");
    const contents = await Promise.all(puts.map((r) => contentOf(w, r)));
    expect(contents.some((c) => c.length === 9000 && c.every((x, i) => x === bytes("va")[i]))).toBe(true);
    expect(contents.some((c) => c.length === 9000 && c.every((x, i) => x === bytes("vb")[i]))).toBe(true);
  });
});
