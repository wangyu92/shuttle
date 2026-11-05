import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodePack, encodePack, packSize, PackError, type PackEntry } from "./src/index";

const A = "aa".repeat(32);
const B = "0123456789abcdef".repeat(4);

describe("pack codec (§2.8.5)", () => {
  it("encodes the documented layout", () => {
    const buf = encodePack([{ id: A, bytes: new Uint8Array([1, 2, 3]) }]);
    expect([...buf.subarray(0, 4)]).toEqual([0x53, 0x58, 0x50, 0x4b]); // "SXPK"
    expect(buf[4]).toBe(1);
    expect([...buf.subarray(5, 9)]).toEqual([0, 0, 0, 1]);
    expect([...buf.subarray(9, 41)]).toEqual(Array(32).fill(0xaa));
    expect([...buf.subarray(41, 45)]).toEqual([0, 0, 0, 3]);
    expect([...buf.subarray(45)]).toEqual([1, 2, 3]);
    expect(buf.length).toBe(packSize([{ id: A, bytes: new Uint8Array(3) }]));
  });

  it("round-trips, including empty blobs and missing markers", () => {
    const entries: PackEntry[] = [
      { id: A, bytes: new Uint8Array(0) },
      { id: B, bytes: null },
      { id: A, bytes: new Uint8Array([9]) },
    ];
    const out = decodePack(encodePack(entries, { allowMissing: true }), { allowMissing: true });
    expect(out.map((e) => [e.id, e.bytes && [...e.bytes]])).toEqual([[A, []], [B, null], [A, [9]]]);
  });

  it("rejects missing markers unless allowed (pack-put)", () => {
    expect(() => encodePack([{ id: A, bytes: null }])).toThrow(PackError);
    const buf = encodePack([{ id: A, bytes: null }], { allowMissing: true });
    expect(() => decodePack(buf)).toThrow(/missing marker/);
  });

  it("rejects bad magic, version, trailing bytes and limits", () => {
    const good = encodePack([{ id: A, bytes: new Uint8Array([1]) }]);
    const badMagic = good.slice(); badMagic[0] = 0x58;
    expect(() => decodePack(badMagic)).toThrow(/magic/);
    const badVer = good.slice(); badVer[4] = 2;
    expect(() => decodePack(badVer)).toThrow(/version/);
    const trailing = new Uint8Array(good.length + 1); trailing.set(good);
    expect(() => decodePack(trailing)).toThrow(/trailing/);
    expect(() => decodePack(good, { maxBytes: good.length - 1 })).toThrow(/exceeds/);
    expect(() => encodePack(Array(257).fill({ id: A, bytes: new Uint8Array(0) }))).toThrow(/entries/);
    expect(() => encodePack([{ id: "AA".repeat(32), bytes: new Uint8Array(0) }])).toThrow(/blobId/);
  });

  it("a hostile count with a short buffer is a PackError, not a crash", () => {
    const buf = new Uint8Array([0x53, 0x58, 0x50, 0x4b, 1, 0, 0, 0, 200]);
    expect(() => decodePack(buf)).toThrow(/truncated entry 0/);
    const huge = new Uint8Array([0x53, 0x58, 0x50, 0x4b, 1, 0xff, 0xff, 0xff, 0xfe]);
    expect(() => decodePack(huge)).toThrow(/count/);
  });

  it("decodes from a subarray with a non-zero byteOffset", () => {
    const inner = encodePack([{ id: B, bytes: new Uint8Array([7, 8]) }]);
    const outer = new Uint8Array(inner.length + 3);
    outer.set(inner, 3);
    const [e] = decodePack(outer.subarray(3));
    expect(e?.id).toBe(B);
    expect([...(e?.bytes ?? [])]).toEqual([7, 8]);
  });

  const entryArb = fc.record({
    id: fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("")),
    bytes: fc.option(fc.uint8Array({ maxLength: 64 }), { nil: null }),
  });

  it("property: round-trip", () => {
    fc.assert(fc.property(fc.array(entryArb, { maxLength: 20 }), (entries) => {
      const out = decodePack(encodePack(entries, { allowMissing: true }), { allowMissing: true });
      expect(out.map((e) => [e.id, e.bytes && [...e.bytes]])).toEqual(entries.map((e) => [e.id, e.bytes && [...e.bytes]]));
    }));
  });

  it("property: any truncation yields a PackError", () => {
    fc.assert(fc.property(fc.array(entryArb, { minLength: 1, maxLength: 8 }), fc.nat(), (entries, cut) => {
      const buf = encodePack(entries, { allowMissing: true });
      const n = cut % buf.length; // strictly shorter
      expect(() => decodePack(buf.subarray(0, n), { allowMissing: true })).toThrow(PackError);
    }));
  });
});
