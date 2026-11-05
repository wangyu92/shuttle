// M20 goldens (design §10.2, I9): packages/spike/src/probes/dmp-goldens.json must equal what Node
// computes with diff-match-patch and the §3.10.2 parameters. Regenerate with
//   SHUTTLE_UPDATE_GOLDENS=1 node_modules/.bin/vitest run packages/testkit/dmpGoldens.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeGoldens, DMP_CASES } from "../spike/src/probes/dmp-cases.js";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../spike/src/probes/dmp-goldens.json");

describe("DMP golden files (M20)", () => {
  it("dmp-goldens.json equals the Node output", () => {
    const text = JSON.stringify(computeGoldens(), null, 1) + "\n";
    if (process.env.SHUTTLE_UPDATE_GOLDENS === "1" || !existsSync(file)) writeFileSync(file, text);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("cases cover Korean, NFD, CRLF+BOM, surrogate pairs, an overlap and a medium note", () => {
    const g = computeGoldens();
    expect(g.map((x) => x.name)).toEqual(DMP_CASES.map((c) => c.name));
    const nfd = DMP_CASES.find((c) => c.name === "nfd-hangul")!;
    expect(nfd.base).not.toBe(nfd.base.normalize("NFC"));
    expect(DMP_CASES.find((c) => c.name === "crlf-bom")!.base.startsWith("﻿")).toBe(true);
    expect(g.find((x) => x.name === "korean-lines")!.merged).toBe("오늘은 날씨가 아주 좋다.\n산책을 했다.\n저녁은 된장찌개.\n메모: 장보기\n");
  });
});
