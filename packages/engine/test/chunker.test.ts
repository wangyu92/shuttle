import { Prng } from "@shuttle/testkit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chunkSizes, chunkViews, EMPTY_SHA256, planContent, sha256Hex, utf8Encode, validateChunkerParams } from "../src/index";

const P = { min: 64, avg: 256, max: 1024 };

function gearFrom(seed: string): Uint32Array {
  const r = new Prng(seed);
  const g = new Uint32Array(256);
  for (let i = 0; i < 256; i++) g[i] = r.u32();
  return g;
}
const gear = gearFrom("gear");

describe("sha256Hex (design §2.3.1)", () => {
  it("matches the FIPS 180-2 vectors", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
    expect(await sha256Hex(utf8Encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("FastCDC fastcdc-k1 (design ID-3)", () => {
  it("golden boundaries for a seeded gear and seeded data (format contract)", () => {
    const data = new Prng("data").bytes(8192);
    expect(chunkSizes(data, gear, P)).toEqual(GOLDEN);
  });

  it("golden boundaries with the production parameters", () => {
    const data = new Prng("big").bytes(3 * 1024 * 1024 + 12345);
    expect(chunkSizes(data, gear)).toEqual(GOLDEN_DEFAULT);
  });

  it("files up to min are one chunk; empty → no chunks", () => {
    expect(chunkSizes(new Uint8Array(0), gear, P)).toEqual([]);
    expect(chunkSizes(new Uint8Array(64), gear, P)).toEqual([64]);
    expect(chunkSizes(new Uint8Array(10), gear, P)).toEqual([10]);
  });

  it("a constant run cuts at max", () => {
    const s = chunkSizes(new Uint8Array(3000), gear, P);
    expect(s.reduce((a, b) => a + b, 0)).toBe(3000);
    for (const x of s.slice(0, -1)) expect(x).toBeGreaterThanOrEqual(P.min);
  });

  it("rejects bad parameters and gear tables", () => {
    expect(() => validateChunkerParams({ min: 64, avg: 300, max: 1024 })).toThrow();
    expect(() => validateChunkerParams({ min: 512, avg: 256, max: 1024 })).toThrow();
    expect(() => chunkSizes(new Uint8Array(10), new Uint32Array(10), P)).toThrow();
  });

  it("property: sizes cover the input; all but the last are within [min, max]", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 6000 }), (buf) => {
      const s = chunkSizes(buf, gear, P);
      expect(s.reduce((a, b) => a + b, 0)).toBe(buf.length);
      s.forEach((x, i) => {
        expect(x).toBeLessThanOrEqual(P.max);
        if (i < s.length - 1) expect(x).toBeGreaterThan(P.min);
      });
      expect(chunkViews(buf, s).map((v) => v.length)).toEqual(s);
    }), { numRuns: 200 });
  });

  it("an insertion near the start keeps most later boundaries (content-defined)", () => {
    const data = new Prng("shift").bytes(32768);
    const ins = new Uint8Array(data.length + 7);
    ins.set(data.subarray(0, 100));
    ins.set([1, 2, 3, 4, 5, 6, 7], 100);
    ins.set(data.subarray(100), 107);
    const ends = (s: number[], shift: number) => {
      let o = 0;
      return new Set(s.map((x) => (o += x) - shift));
    };
    const a = ends(chunkSizes(data, gear, P), 0);
    const b = ends(chunkSizes(ins, gear, P), 7);
    const shared = [...a].filter((x) => b.has(x)).length;
    expect(shared / a.size).toBeGreaterThan(0.8);
  });

  it("planContent: inline up to inlineMax, chunks above", () => {
    expect(planContent(new Uint8Array(4096), gear, P, 4096)).toEqual({ inline: true, chunkSizes: [] });
    const big = planContent(new Prng("x").bytes(5000), gear, P, 4096);
    expect(big.inline).toBe(false);
    expect(big.chunkSizes.reduce((a, b) => a + b, 0)).toBe(5000);
  });
});

const GOLDEN: number[] = [322, 233, 411, 214, 273, 180, 90, 261, 303, 165, 296, 309, 288, 392, 263, 190, 327, 272, 225, 284, 301, 231, 286, 370, 239, 286, 554, 323, 280, 24];
const GOLDEN_DEFAULT: number[] = [1228475, 1065906, 863692];
