// I19 case-only rename keeps the fileId on case-insensitive and case-sensitive filesystems (design §3.9).

import { describe, expect, it } from "vitest";
import { Node, makeWorld, syncAll } from "./engineHarness";

describe("I19 case-only rename", () => {
  for (const ci of [true, false]) {
    it(`keeps the fileId (${ci ? "case-insensitive" : "case-sensitive"} sender)`, async () => {
      const w = await makeWorld(`case-${ci}`);
      const a = new Node(w, { name: "alpha", caseInsensitive: ci });
      const b = new Node(w, { name: "beta", caseInsensitive: !ci });
      a.fs.seed({ "Notes/Daily.md": "today\n" });
      await a.start();
      await b.start();
      await syncAll([a, b]);
      const id = a.engine.index.byPath("Notes/Daily.md")!.fileId;
      a.fs.external.rename("Notes/Daily.md", "Notes/daily.md");
      a.engine.requestScan();
      await a.engine.runOnce();
      await syncAll([a, b]);
      expect(a.engine.index.byPath("Notes/daily.md")?.fileId).toBe(id);
      expect(b.engine.index.byPath("Notes/daily.md")?.fileId).toBe(id);
      expect([...b.fs.files().keys()]).toEqual(["Notes/daily.md"]);
      expect(w.server.inspect().log.filter((r) => r.kind === "del")).toEqual([]);
      const live = w.server.inspect().heads.filter((r) => r.kind === "put");
      expect(live.map((r) => r.fileId)).toEqual([id]);
    });
  }
});
