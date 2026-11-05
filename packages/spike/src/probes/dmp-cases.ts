// M20 (design §10.2, I9): diff-match-patch merge golden cases. The same module computes the goldens on
// Node (packages/testkit/dmpGoldens.test.ts writes and checks dmp-goldens.json) and on devices (the
// spike compares its output with the bundled JSON byte for byte). Parameters and merge3 follow §3.10.2.
import DiffMatchPatch from "diff-match-patch";

export interface DmpCase {
  name: string;
  base: string;
  local: string;
  remote: string;
}

export interface DmpGolden {
  name: string;
  diffs: [number, string][];
  patchText: string;
  merged: string;
  clean: boolean;
  results: boolean[];
}

export function newDmp(): DiffMatchPatch {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1.0;
  dmp.Diff_EditCost = 4;
  dmp.Match_Threshold = 0.5;
  dmp.Match_Distance = 1000;
  dmp.Patch_DeleteThreshold = 0.5;
  dmp.Patch_Margin = 4;
  return dmp;
}

const NFD_DIARY = "오늘의 일기\n산책을 했다.\n".normalize("NFD");

function medium(): DmpCase {
  // Deterministic ~8 KB note with edits spread over it (exercises bisect and patch splitting).
  const lines: string[] = [];
  for (let i = 0; i < 160; i++) lines.push(`- ${i}: 항목 ${i} item ${(i * 7919) % 1000} lorem ipsum dolor`);
  const base = `# 긴 노트\r\n\r\n${lines.join("\r\n")}\r\n`;
  const local = base.replace("항목 10 ", "항목 10 (수정) ").replace("item 997", "item 997 local").replace("- 150:", "- 150 (local):");
  const remote = base.replace("항목 80 ", "항목 80 remote ").replace("\r\n- 159:", "\r\n- 158.5: 끼워 넣은 줄\r\n- 159:");
  return { name: "medium-8k-crlf", base, local, remote };
}

export const DMP_CASES: DmpCase[] = [
  {
    name: "korean-lines",
    base: "오늘은 날씨가 좋다.\n산책을 했다.\n저녁은 김치찌개.\n",
    local: "오늘은 날씨가 아주 좋다.\n산책을 했다.\n저녁은 김치찌개.\n",
    remote: "오늘은 날씨가 좋다.\n산책을 했다.\n저녁은 된장찌개.\n메모: 장보기\n",
  },
  {
    name: "nfd-hangul",
    base: NFD_DIARY,
    local: NFD_DIARY.replace("산책".normalize("NFD"), "긴 산책".normalize("NFD")),
    remote: `${NFD_DIARY}${"비가 왔다.\n".normalize("NFD")}`,
  },
  {
    name: "crlf-bom",
    base: "﻿# Title\r\nline one\r\nline two\r\nline three\r\n",
    local: "﻿# Title\r\nline one (local)\r\nline two\r\nline three\r\n",
    remote: "﻿# Title\r\nline one\r\nline two\r\nline three (remote)\r\n",
  },
  {
    name: "emoji-surrogates",
    base: "a😀b 🇰🇷 c\n",
    local: "a😁b 🇰🇷 c\n",
    remote: "a😀b 🇰🇷 c d\n",
  },
  {
    name: "overlap-same-word",
    base: "The quick brown fox jumps over the lazy dog.\n",
    local: "The quick red fox jumps over the lazy dog.\n",
    remote: "The quick green fox jumps over the lazy dog.\n",
  },
  {
    name: "delete-vs-edit",
    base: "## 할일\n- 우유 사기\n- 빵 사기\n- 계란 사기\n",
    local: "## 할일\n- 우유 사기\n- 계란 사기\n",
    remote: "## 할일\n- 우유 사기\n- 빵 두 개 사기\n- 계란 사기\n",
  },
  medium(),
];

/** merge3 from §3.10.2 (strictOverlap off), plus the intermediate values the goldens pin. */
export function computeGolden(c: DmpCase, dmp: DiffMatchPatch = newDmp()): DmpGolden {
  const diffs = dmp.diff_main(c.base, c.local);
  const patches = dmp.patch_make(c.base, diffs);
  // diff-match-patch 1.0.5 can split a surrogate pair; patch_toText then throws URIError (encodeURI).
  // The golden records the error name only, since messages differ between JS engines.
  let patchText: string;
  try {
    patchText = dmp.patch_toText(patches);
  } catch (e) {
    patchText = `ERROR ${e instanceof Error ? e.name : "unknown"}`;
  }
  let merged: string;
  let results: boolean[];
  if (c.local === c.remote) [merged, results] = [c.remote, []];
  else if (c.base === c.local) [merged, results] = [c.remote, []];
  else if (c.base === c.remote) [merged, results] = [c.local, []];
  else [merged, results] = dmp.patch_apply(patches, c.remote);
  return { name: c.name, diffs: diffs.map(([op, t]) => [op, t]), patchText, merged, clean: results.every(Boolean), results };
}

export function computeGoldens(): DmpGolden[] {
  return DMP_CASES.map((c) => computeGolden(c));
}
