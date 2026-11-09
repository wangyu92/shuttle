// I27 JSON merge (design §3.10.3, §3.18): union of keys, local wins on top-level collisions, unparsable
// JSON falls back to LWW (null). Properties over random objects.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { jsonCanon, mergeJson, utf8DecodeStrict, utf8Encode, type JsonValue } from "../src/index";

const key = fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom("__proto__", "constructor", "toString", "a", "b"));
const leaf: fc.Arbitrary<JsonValue> = fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean(), fc.constant(null), fc.string({ maxLength: 5 }));
const value: fc.Arbitrary<JsonValue> = fc.oneof(leaf, fc.array(leaf, { maxLength: 3 }), fc.dictionary(key, leaf, { maxKeys: 3 }));
const obj = fc.dictionary(key, value, { maxKeys: 6 });
const indent = fc.constantFrom(0, 2, 4);

const enc = (o: unknown, n: number): Uint8Array => utf8Encode(JSON.stringify(o, null, n) + (n ? "\n" : ""));
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

describe("I27 mergeJson properties", () => {
  it("union of keys; local wins collisions; values otherwise from remote", () => {
    fc.assert(fc.property(obj, obj, indent, indent, (l, r, il, ir) => {
      const m = mergeJson(enc(l, il), enc(r, ir));
      expect(m).not.toBeNull();
      const out = JSON.parse(utf8DecodeStrict(m!.bytes)!) as Record<string, JsonValue>;
      const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
      expect(new Set(Object.keys(out))).toEqual(keys);
      for (const k of keys) {
        const want = own(l, k) ? l[k] : r[k];
        expect(jsonCanon(out[k] as JsonValue), k).toBe(jsonCanon(want as JsonValue));
      }
      expect(m!.equalsLocal).toBe(jsonCanon(out) === jsonCanon(l));
      expect(m!.equalsRemote).toBe(jsonCanon(out) === jsonCanon(r));
    }), { numRuns: 300 });
  });

  it("merge with itself is itself; local-only edits survive a remote that did not change them", () => {
    fc.assert(fc.property(obj, (o) => {
      const m = mergeJson(enc(o, 2), enc(o, 0))!;
      expect(m.equalsLocal && m.equalsRemote).toBe(true);
    }), { numRuns: 200 });
  });

  it("unparsable or non-object input falls back to LWW (null)", () => {
    fc.assert(fc.property(obj, fc.oneof(fc.constant("{oops"), fc.constant("[1]"), fc.constant("null"), fc.constant("\"s\""), fc.constant("")), fc.boolean(), (o, bad, badLocal) => {
      const good = enc(o, 2);
      const b = utf8Encode(bad);
      expect(badLocal ? mergeJson(b, good) : mergeJson(good, b)).toBeNull();
    }), { numRuns: 100 });
  });
});
