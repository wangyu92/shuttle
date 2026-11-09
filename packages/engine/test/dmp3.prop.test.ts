// Property tests for merge3 (design §7.3, I9; the strict check of the task's KNOWN RISK).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { merge3 } from "../src/index";

const strict = { strictOverlap: true };
const RUNS = 150;

/** A line-level edit script: for each base line keep / delete / replace, plus inserts after it. */
type Op = { kind: "keep" | "del" | "rep"; ins: number };
const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom("keep", "keep", "keep", "del", "rep") as fc.Arbitrary<Op["kind"]>,
  ins: fc.constantFrom(0, 0, 0, 1, 2),
});

function apply(base: string[], ops: Op[], tag: string): string[] {
  const out: string[] = [];
  let n = 0;
  base.forEach((l, i) => {
    const op = ops[i] ?? { kind: "keep", ins: 0 };
    if (op.kind === "keep") out.push(l);
    else if (op.kind === "rep") out.push(`${tag}${n++}`);
    for (let k = 0; k < op.ins; k++) out.push(`${tag}${n++}`);
  });
  return out;
}

const text = (lines: string[]): string => lines.map((l) => l + "\n").join("");
const linesOf = (s: string): string[] => s.split("\n").filter((x) => x !== "");

const scenario = fc.integer({ min: 1, max: 9 }).chain((n) =>
  fc.tuple(fc.constant(Array.from({ length: n }, (_, i) => `b${i}`)), fc.array(opArb, { minLength: n, maxLength: n }), fc.array(opArb, { minLength: n, maxLength: n })),
);

describe("merge3 properties", () => {
  it("no side's edit is lost: a clean merge keeps every added line and exactly the lines both kept", () => {
    fc.assert(fc.property(scenario, ([base, lo, ro]) => {
      const L = apply(base, lo, "L");
      const R = apply(base, ro, "R");
      const r = merge3(text(base), text(L), text(R), strict);
      if (!r.clean) return; // conflict copy: both versions survive as files
      const got = linesOf(r.text);
      for (const x of [...L, ...R]) if (!x.startsWith("b")) expect(got).toContain(x);
      for (const b of base) expect(got.includes(b)).toBe(L.includes(b) && R.includes(b));
      // no duplication of any line
      expect(new Set(got).size).toBe(got.length);
    }), { numRuns: RUNS });
  });

  it("edits separated by an untouched line merge cleanly most of the time", () => {
    let clean = 0;
    let total = 0;
    fc.assert(fc.property(fc.integer({ min: 4, max: 9 }), fc.nat(), (n, seed) => {
      const base = Array.from({ length: n }, (_, i) => `line ${i} of the note`);
      const li = seed % Math.floor(n / 2);
      const ri = li + 2 + (seed % Math.max(1, n - li - 2));
      if (ri >= n) return;
      const L = base.map((l, i) => (i === li ? l + " (local edit)" : l));
      const R = base.map((l, i) => (i === ri ? "remote: " + l : l));
      const r = merge3(text(base), text(L), text(R), strict);
      total++;
      if (r.clean) {
        clean++;
        expect(r.text).toBe(text(base.map((l, i) => (i === li ? L[i]! : i === ri ? R[i]! : l))));
      }
    }), { numRuns: RUNS });
    expect(clean).toBe(total);
  });

  it("deterministic and idempotent", () => {
    const s = fc.string({ maxLength: 40, unit: fc.constantFrom("a", "b", "\n", " ", "한", "😀", "\r") });
    fc.assert(fc.property(s, s, s, (b, l, r) => {
      const m1 = merge3(b, l, r, strict);
      const m2 = merge3(b, l, r, strict);
      expect(m2).toEqual(m1);
      if (!m1.clean) return;
      // merging again with the result on either side changes nothing
      expect(merge3(b, m1.text, m1.text, strict).text).toBe(m1.text);
      expect(merge3(r, m1.text, r, strict).text).toBe(m1.text);
      expect(merge3(l, l, m1.text, strict).text).toBe(m1.text);
    }), { numRuns: RUNS });
  });

  it("parity mode can lose an edit that strict mode catches (the known DMP risk)", () => {
    // Search the same line scenarios with strictOverlap off; record whether parity ever reports a
    // clean merge that drops a line. Strict mode must never do so (first property).
    let parityLoss: string | null = null;
    fc.assert(fc.property(scenario, ([base, lo, ro]) => {
      const L = apply(base, lo, "L");
      const R = apply(base, ro, "R");
      const r = merge3(text(base), text(L), text(R), { strictOverlap: false });
      if (!r.clean || parityLoss) return;
      const got = linesOf(r.text);
      const lost = [...L, ...R].filter((x) => !x.startsWith("b") && !got.includes(x));
      const dup = new Set(got).size !== got.length;
      if (lost.length || dup) parityLoss = JSON.stringify({ base, L, R, got });
    }), { numRuns: 400, seed: 7 });
    expect(parityLoss).not.toBeNull();
  });
});
