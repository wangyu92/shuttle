// I25 scope stability (design §3.18): on mobile, files > maxFileBytes are never read; oversize remote
// files are never downloaded; the skip is logged once per session (design §3.11.2).

import { describe, expect, it } from "vitest";
import { Prng } from "@shuttle/testkit";
import { Node, makeWorld, syncAll } from "./engineHarness";

describe("I25 oversize files", () => {
  it("a mobile device never reads or downloads a file above its cap", async () => {
    const w = await makeWorld("oversize");
    const desk = new Node(w, { name: "desk" });
    const phone = new Node(w, { name: "phone", platform: "ios", settings: { maxFileBytes: 20_000 } });
    const big = new Prng("big").bytes(30_000);
    phone.fs.seed({ "local-big.bin": big, "small.md": "small\n" });
    desk.fs.seed({ "remote-big.bin": big });
    await desk.start();
    await phone.start();
    await syncAll([desk, phone]);
    await syncAll([phone, desk]);
    expect(phone.ops("read").filter((p) => p.endsWith("big.bin"))).toEqual([]);
    expect(phone.ops("write").filter((p) => p.endsWith("big.bin"))).toEqual([]);
    expect(phone.fs.exists("remote-big.bin")).toBe(false);
    expect(desk.fs.readText("small.md")).toBe("small\n");
    expect(desk.fs.exists("local-big.bin")).toBe(false);
    expect(phone.engine.index.byPath("local-big.bin")?.scope).toBe("oversize");
    const logs = phone.engine.log.entries().filter((e) => e.key === "log.skippedTooLarge");
    expect(logs.map((l) => l.path).sort()).toEqual(["local-big.bin", "remote-big.bin"]);
    // Again: still never read, and not logged again in this session.
    phone.engine.requestScan("full");
    await phone.sync();
    expect(phone.ops("read").filter((p) => p.endsWith("big.bin"))).toEqual([]);
    expect(phone.engine.log.entries().filter((e) => e.key === "log.skippedTooLarge").length).toBe(2);
  });
});
