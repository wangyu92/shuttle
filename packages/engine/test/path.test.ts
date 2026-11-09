import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  basename, dirname, extname, foldKey, illegalReason, isUnder, join, nameRulesFor, normalizePath, portabilityWarnings, rebase,
  sanitizeSegment, stem,
} from "../src/index";

describe("normalizePath / foldKey (design §2.3)", () => {
  it("NFC-normalizes and strips outer slashes, nothing else", () => {
    const nfd = "한글 노트.md".normalize("NFD");
    expect(nfd).not.toBe("한글 노트.md");
    expect(normalizePath(nfd)).toBe("한글 노트.md");
    expect(normalizePath("/a/b.md/")).toBe("a/b.md");
    expect(normalizePath("a//b")).toBe("a//b"); // not rewritten: illegal() reports it
    expect(normalizePath("a/./b")).toBe("a/./b");
  });

  it("foldKey is equal for case variants and normalization forms", () => {
    expect(foldKey("Notes/Ä.md")).toBe(foldKey("notes/ä.MD"));
  });

  it("path helpers", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(extname("a/b.tar.gz")).toBe("gz");
    expect(extname("a/.env")).toBe("");
    expect(extname("a/name.")).toBe("");
    expect(stem("a/b.tar.gz")).toBe("b.tar");
    expect(stem("a/README")).toBe("README");
    expect(join("", "a", "b")).toBe("a/b");
    expect(isUnder("a/b/c", "a")).toBe(true);
    expect(isUnder("ab/c", "a")).toBe(false);
    expect(isUnder("a", "a")).toBe(false);
    expect(rebase("a/b/c.md", "a/b", "x")).toBe("x/c.md");
    expect(() => rebase("q.md", "a", "b")).toThrow();
  });

  const segChar = fc.constantFrom("a", "B", "é", "é", "한", "가", "ǅ", "ß", "İ", "Σ", "ς", "😀", " ", "-", ".", "Ꞁ", "𞤀");
  const seg = fc.array(segChar, { minLength: 1, maxLength: 6 }).map((x) => x.join(""));
  const path = fc.array(seg, { minLength: 1, maxLength: 4 }).map((x) => x.join("/"));

  it("property: normalize is idempotent, foldKey is case- and form-insensitive", () => {
    fc.assert(fc.property(path, (p) => {
      const n = normalizePath(p);
      expect(normalizePath(n)).toBe(n);
      expect(normalizePath(p.normalize("NFD"))).toBe(n);
      expect(foldKey(p.toUpperCase())).toBe(foldKey(p.toUpperCase().toLowerCase()));
      expect(foldKey(p)).toBe(foldKey(p.normalize("NFD")));
      expect(foldKey(foldKey(p))).toBe(foldKey(p));
    }), { numRuns: 300 });
  });

  it("property: illegal rules are consistent under normalization", () => {
    fc.assert(fc.property(path, fc.constantFrom("windows", "android", "apple", "posix") as fc.Arbitrary<"windows">, (p, rules) => {
      expect(illegalReason(normalizePath(p), rules)).toBe(illegalReason(normalizePath(p.normalize("NFD")), rules));
    }), { numRuns: 200 });
  });
});

describe("illegal names (design §3.11.4, I15)", () => {
  const table: Array<[string, "windows" | "android" | "apple" | "posix", string | null]> = [
    ["a/b.md", "posix", null],
    ["", "posix", "empty"],
    ["a//b", "posix", "empty"],
    ["a/./b", "posix", "dot-segment"],
    ["a/../b", "windows", "dot-segment"],
    ["a\u0000b", "posix", "control-char"],
    ["tab\there", "apple", "control-char"],
    ["x".repeat(256), "posix", "segment-too-long"],
    ["한".repeat(85) + ".md", "posix", "segment-too-long"], // 85*3 + 3 = 258 UTF-8 bytes
    ["what?.md", "windows", "reserved-char"],
    ["what?.md", "posix", null],
    ["a:b.md", "apple", "reserved-char"],
    ["a:b.md", "android", "reserved-char"],
    ["a:b.md", "posix", null],
    ["trailing.", "windows", "trailing-dot-space"],
    ["trailing ", "android", "trailing-dot-space"],
    ["CON.md", "windows", "reserved-name"],
    ["lpt9.txt", "android", "reserved-name"],
    ["console.md", "windows", null],
    ["CON.md", "posix", null],
  ];
  it.each(table)("%j under %s → %s", (p, rules, want) => {
    expect(illegalReason(p, rules)).toBe(want);
  });

  it("platform mapping", () => {
    expect(nameRulesFor("ios")).toBe("apple");
    expect(nameRulesFor("android")).toBe("android");
    expect(nameRulesFor("desktop", { os: "windows" })).toBe("windows");
    expect(nameRulesFor("desktop", { os: "macos" })).toBe("apple");
    expect(nameRulesFor("node")).toBe("posix");
  });

  it("portability warnings never block", () => {
    expect(portabilityWarnings("a#b.md", "posix")).toEqual(["special-char"]);
    expect(portabilityWarnings("a.b.md", "posix")).toEqual(["multiple-periods"]);
    expect(portabilityWarnings("😀.md", "android")).toEqual(["emoji"]);
    expect(portabilityWarnings("😀.md", "posix")).toEqual([]);
  });

  it("sanitizeSegment yields a segment legal everywhere", () => {
    expect(sanitizeSegment("alice's Mac: \"pro\"")).toBe("alice's Mac- -pro-");
    expect(sanitizeSegment("  ")).toBe("device");
    expect(sanitizeSegment("phone...")).toBe("phone");
    expect(sanitizeSegment("CON")).toBe("CON_");
    expect(sanitizeSegment("con.x")).toBe("con_.x");
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (s) => {
      const out = sanitizeSegment(s);
      for (const rules of ["windows", "android", "apple", "posix"] as const) expect(illegalReason(out, rules)).toBeNull();
    }), { numRuns: 300 });
  });
});
