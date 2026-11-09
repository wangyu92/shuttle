// I15 illegal names (design §3.11.4, §3.18): per-platform tables; a remote record with an illegal name is
// skipped with Sync's string and never crashes the loop; the rest keeps syncing.

import { describe, expect, it } from "vitest";
import { ILLEGAL_NAME_LOG, illegalReason, nameRulesFor, type NameRules } from "../src/index";
import { Node, makeWorld, syncAll } from "./engineHarness";

const TABLE: Array<[string, Record<NameRules, boolean>]> = [
  ["ok/name.md", { posix: false, windows: false, android: false, apple: false }],
  ["a:b.md", { posix: false, windows: true, android: true, apple: true }],
  ["a?b.md", { posix: false, windows: true, android: true, apple: false }],
  ["a|b.md", { posix: false, windows: true, android: true, apple: false }],
  ["trailing. /x.md", { posix: false, windows: true, android: true, apple: false }],
  ["dot./x.md", { posix: false, windows: true, android: true, apple: false }],
  ["CON.md", { posix: false, windows: true, android: true, apple: false }],
  ["lpt9.txt", { posix: false, windows: true, android: true, apple: false }],
  ["a/../b.md", { posix: true, windows: true, android: true, apple: true }],
  ["a//b.md", { posix: true, windows: true, android: true, apple: true }],
  ["ctl\u0001.md", { posix: true, windows: true, android: true, apple: true }],
  [`${"x".repeat(256)}.md`, { posix: true, windows: true, android: true, apple: true }],
];

describe("illegal names per platform (design §3.11.4)", () => {
  it("table", () => {
    for (const [p, want] of TABLE) {
      for (const r of ["posix", "windows", "android", "apple"] as const) expect(illegalReason(p, r) !== null, `${p} on ${r}`).toBe(want[r]);
    }
    expect(nameRulesFor("desktop", { os: "windows" })).toBe("windows");
    expect(nameRulesFor("ios")).toBe("apple");
    expect(nameRulesFor("android")).toBe("android");
    expect(nameRulesFor("node")).toBe("posix");
  });
});

describe("I15 illegal remote names never crash the loop", () => {
  for (const [os, platform] of [["windows", "desktop"], [undefined, "android"]] as const) {
    it(`skips with the Sync string on ${os ?? platform}`, async () => {
      const w = await makeWorld(`illegal-${platform}`);
      const a = new Node(w, { name: "linux" });
      const b = new Node(w, { name: "receiver", platform, ...(os ? { opts: { os } } : {}) });
      a.fs.seed({ "q/what?.md": "question\n", "a:b.md": "colon\n", "fine.md": "fine\n" });
      await a.start();
      await b.start();
      await syncAll([a, b]);
      expect(b.fs.readText("fine.md")).toBe("fine\n");
      expect(b.fs.exists("a:b.md")).toBe(false);
      expect(b.fs.exists("q/what?.md")).toBe(false);
      const skips = b.engine.log.entries().filter((e) => e.key === "log.illegalName");
      expect(skips.map((e) => e.path).sort()).toEqual(["a:b.md", "q/what?.md"]);
      for (const s of skips) expect(s.params["message"]).toBe(ILLEGAL_NAME_LOG);
      // The loop keeps working afterwards.
      w.clock.tick(1000);
      a.fs.external.write("fine.md", "fine again\n");
      a.engine.requestScan();
      await syncAll([a, b]);
      expect(b.fs.readText("fine.md")).toBe("fine again\n");
      expect(b.engine.status().status).toBe("synced");
    });
  }
});
