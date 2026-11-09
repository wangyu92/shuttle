import { describe, expect, it } from "vitest";
import { applyDisjoint, diffHunks, hunksCollide, isWellFormedUtf16, merge3 } from "../src/index";

const strict = { strictOverlap: true };
const parity = { strictOverlap: false };

describe("merge3 identities (I9)", () => {
  it("shortcuts", () => {
    expect(merge3("b", "b", "r")).toEqual({ text: "r", clean: true });
    expect(merge3("b", "l", "b")).toEqual({ text: "l", clean: true });
    expect(merge3("b", "x", "x")).toEqual({ text: "x", clean: true });
  });
});

// Golden outputs: the same strings must come out on every platform (design §7.2 I9, M20).
const GOLDEN: Array<{ name: string; base: string; local: string; remote: string; text: string }> = [
  { name: "separate lines", base: "a\nb\nc\n", local: "a\nB\nc\n", remote: "a\nb\nc\nd\n", text: "a\nB\nc\nd\n" },
  {
    name: "CJK", base: "안녕 세계\n둘째 줄\n", local: "안녕 우주\n둘째 줄\n", remote: "안녕 세계\n둘째 줄\n셋째 줄\n",
    text: "안녕 우주\n둘째 줄\n셋째 줄\n",
  },
  {
    name: "emoji and CRLF", base: "title\r\n\r\nbody one\r\nbody two\r\n", local: "😀 title\r\n\r\nbody one\r\nbody two\r\n",
    remote: "title\r\n\r\nbody one\r\nbody two changed\r\n", text: "😀 title\r\n\r\nbody one\r\nbody two changed\r\n",
  },
  {
    name: "words in different paragraphs", base: "# Plan\n\nWe ship on Monday.\n\nNotes go here.\n",
    local: "# Plan\n\nWe ship on Tuesday.\n\nNotes go here.\n", remote: "# Plan\n\nWe ship on Monday.\n\nNotes go here, alice.\n",
    text: "# Plan\n\nWe ship on Tuesday.\n\nNotes go here, alice.\n",
  },
];

describe("merge3 golden (I9)", () => {
  it.each(GOLDEN)("$name", ({ base, local, remote, text }) => {
    const r = merge3(base, local, remote, strict);
    expect(r).toEqual({ text, clean: true });
    expect(merge3(base, local, remote, parity)).toEqual({ text, clean: true });
  });
});

describe("strictOverlap (클로드 제안(미승인): strictOverlap conservative)", () => {
  it("both sides edit the same word → not clean", () => {
    const r = merge3("The quick brown fox\n", "The quick red fox\n", "The quick blue fox\n", strict);
    expect(r.clean).toBe(false);
  });

  it("local deletes a line that remote edited → not clean in strict mode", () => {
    const base = "line1\nline2\nline3\n";
    const r = merge3(base, "line1\nline3\n", "line1\nline2 edited\nline3\n", strict);
    expect(r.clean).toBe(false);
    expect(r.reason).toBe("overlap");
  });

  it("adjacent edits (touching ranges) are a conflict", () => {
    const r = merge3("abcdef\n", "abXdef\n", "abcYef\n", strict);
    expect(r.clean).toBe(false);
  });

  it("two inserts at the same offset are a conflict", () => {
    const r = merge3("a\nc\n", "a\nL\nc\n", "a\nR\nc\n", strict);
    expect(r.clean).toBe(false);
  });

  it("duplicated text from fuzzy patching is caught", () => {
    // Both sides insert the same paragraph at different places; DMP replays local's copy onto a
    // remote that already moved text around. The exact-merge check rejects any duplicate.
    const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
    const local = "one\nshared\ntwo\nthree\nfour\nfive\nsix\nseven\n";
    const remote = "one\ntwo\nthree\nfour\nfive\nshared\nsix\nseven\n";
    const r = merge3(base, local, remote, strict);
    if (r.clean) expect(r.text).toBe("one\nshared\ntwo\nthree\nfour\nfive\nshared\nsix\nseven\n");
  });

  it("regression: a case where parity DMP reports clean but garbles both sides", () => {
    const t = (xs: string[]) => xs.map((x) => x + "\n").join("");
    const base = t(["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
    const local = t(["L0", "L1", "b2", "L2", "L3", "L4", "b4", "b5", "b6", "L5", "L6", "b8", "L7"]);
    const remote = t(["b0", "b1", "R0", "R1", "b3", "b4", "R2", "b5", "R3", "R4", "R5", "R6", "b8"]);
    const p = merge3(base, local, remote, parity);
    expect(p.clean).toBe(true);                 // DMP alone says clean ...
    expect(p.text.split("\n")).not.toContain("L3"); // ... yet local's line L3 is gone
    expect(merge3(base, local, remote, strict).clean).toBe(false);
  });

  it("parity mode keeps the design's DMP behaviour", () => {
    const base = "line1\nline2\nline3\n";
    const r = merge3(base, "line1\nline3\n", "line1\nline2 edited\nline3\n", parity);
    expect(typeof r.clean).toBe("boolean");
  });
});

describe("hunk helpers", () => {
  it("diffHunks in base coordinates", () => {
    expect(diffHunks("abcdef", "abXdef")).toEqual([{ start: 2, end: 3, text: "X" }]);
    expect(diffHunks("abc", "abcd")).toEqual([{ start: 3, end: 3, text: "d" }]);
  });
  it("collision uses closed intervals; identical hunks do not collide", () => {
    expect(hunksCollide([{ start: 2, end: 3, text: "X" }], [{ start: 3, end: 4, text: "Y" }])).toBe(true);
    expect(hunksCollide([{ start: 2, end: 3, text: "X" }], [{ start: 5, end: 6, text: "Y" }])).toBe(false);
    expect(hunksCollide([{ start: 2, end: 3, text: "X" }], [{ start: 2, end: 3, text: "X" }])).toBe(false);
  });
  it("applyDisjoint", () => {
    expect(applyDisjoint("abcdef", [{ start: 0, end: 1, text: "A" }], [{ start: 4, end: 6, text: "" }])).toBe("Abcd");
  });
  it("isWellFormedUtf16", () => {
    expect(isWellFormedUtf16("a😀b")).toBe(true);
    expect(isWellFormedUtf16("a\ud83d")).toBe(false);
    expect(isWellFormedUtf16("\ude00a")).toBe(false);
  });
});
