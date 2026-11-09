import { FakeClock } from "@shuttle/testkit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ConflictLoopTracker, OscillationDetector, canonOfBytes, conflictCopyPath, conflictStamp, detectIndent, isConfigJson,
  isConflictCopyName, isTemplatePrefix, jsonCanon, kindOf, lwwDecide, mergeJson, MTIME_CLAMP_MS, retentionClassOf, strategyFor,
  utf8DecodeStrict, utf8Encode,
} from "../src/index";

const j = (v: unknown, indent = 2): Uint8Array => utf8Encode(JSON.stringify(v, null, indent) + "\n");
const parse = (b: Uint8Array): unknown => JSON.parse(utf8DecodeStrict(b)!);

describe("mergeJson (design §3.10.3, I27)", () => {
  it("union of keys, local wins top-level collisions, shallow", () => {
    const m = mergeJson(j({ a: 1, shared: { x: 1 }, list: [1] }), j({ b: 2, shared: { y: 2 }, list: [2, 3] }))!;
    expect(parse(m.bytes)).toEqual({ b: 2, shared: { x: 1 }, list: [1], a: 1 });
    expect(m.equalsRemote).toBe(false);
  });

  it("a key deleted locally comes back from remote (Sync parity)", () => {
    expect(parse(mergeJson(j({ a: 1 }), j({ a: 1, gone: true }))!.bytes)).toEqual({ a: 1, gone: true });
  });

  it("equal-to-remote is detected canonically (→ ADOPT)", () => {
    const m = mergeJson(utf8Encode('{"b":2,"a":1.5}'), j({ a: 1.5, b: 2 }, 4))!;
    expect(m.equalsRemote).toBe(true);
    expect(m.equalsLocal).toBe(true);
  });

  it("unparsable or non-object JSON → null (LWW fallback)", () => {
    expect(mergeJson(utf8Encode("{oops"), j({}))).toBeNull();
    expect(mergeJson(j([1, 2]), j({}))).toBeNull();
    expect(mergeJson(j({}), utf8Encode("null"))).toBeNull();
    expect(mergeJson(new Uint8Array([0xff, 0xfe]), j({}))).toBeNull();
  });

  it("keeps the local indent and trailing newline", () => {
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent('{\n    "a": 1\n}')).toBe("    ");
    expect(detectIndent('{"a":1}')).toBe("");
    const m = mergeJson(utf8Encode('{\n\t"a": 1\n}'), j({ b: 1 }))!;
    expect(utf8DecodeStrict(m.bytes)).toBe('{\n\t"b": 1,\n\t"a": 1\n}');
  });

  it("jsonCanon handles floats (protocol canon() would throw)", () => {
    expect(jsonCanon({ b: 0.5, a: [1, "x", null] })).toBe('{"a":[1,"x",null],"b":0.5}');
    expect(canonOfBytes(utf8Encode('{ "z": 1, "a": 2 }'))).toBe('{"a":2,"z":1}');
    expect(canonOfBytes(utf8Encode("nope"))).toBeNull();
  });

  it("property: result keys = union, local values on collisions", () => {
    const obj = fc.dictionary(fc.constantFrom("a", "b", "c", "d", "e"), fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 4 })));
    fc.assert(fc.property(obj, obj, (l, r) => {
      const m = mergeJson(j(l), j(r))!;
      const out = parse(m.bytes) as Record<string, unknown>;
      expect(Object.keys(out).sort()).toEqual([...new Set([...Object.keys(l), ...Object.keys(r)])].sort());
      for (const [k, v] of Object.entries(l)) expect(out[k]).toEqual(v);
      for (const [k, v] of Object.entries(r)) if (!(k in l)) expect(out[k]).toEqual(v);
    }), { numRuns: 200 });
  });
});

describe("conflict copy names (design §3.10.5)", () => {
  it("stamp is local time of the detecting device", () => {
    const t = Date.UTC(2026, 10, 5, 5, 32);
    expect(conflictStamp(t, 0)).toBe("202611050532");
    expect(conflictStamp(t, -540)).toBe("202611051432"); // KST
  });

  it("name, extension and collision suffix", () => {
    const taken = new Set<string>();
    const exists = (p: string) => taken.has(p);
    const a = conflictCopyPath("Daily/Note.md", "alice's Mac", "202611051432", exists);
    expect(a).toBe("Daily/Note (Conflicted copy alice's Mac 202611051432).md");
    taken.add(a);
    expect(conflictCopyPath("Daily/Note.md", "alice's Mac", "202611051432", exists)).toBe("Daily/Note (Conflicted copy alice's Mac 202611051432 2).md");
    expect(conflictCopyPath("README", "pc", "202611051432", () => false)).toBe("README (Conflicted copy pc 202611051432)");
    expect(conflictCopyPath("a/b.tar.gz", "p:c", "202611051432", () => false)).toBe("a/b.tar (Conflicted copy p-c 202611051432).gz");
    expect(isConflictCopyName(a)).toBe(true);
    expect(isConflictCopyName("Daily/Note.md")).toBe(false);
  });

  it("long names stay within 255 UTF-8 bytes per segment", () => {
    const p = conflictCopyPath("x/" + "한".repeat(84) + ".md", "dev", "202611051432", () => false);
    const seg = p.split("/")[1]!;
    expect(new TextEncoder().encode(seg).length).toBeLessThanOrEqual(255);
    expect(seg.endsWith("(Conflicted copy dev 202611051432).md")).toBe(true);
  });
});

describe("MergePolicy (design §3.10.1, §3.10.4)", () => {
  it("kinds and retention classes", () => {
    expect(kindOf("a/n.md", ".obsidian")).toBe("note");
    expect(kindOf("a/p.PNG", ".obsidian")).toBe("attachment");
    expect(kindOf("a/c.canvas", ".obsidian")).toBe("other");
    expect(kindOf(".obsidian/app.json", ".obsidian")).toBe("config");
    expect(isConfigJson(".obsidian/app.json", ".obsidian")).toBe(true);
    expect(isConfigJson(".obsidian/snippets/x.css", ".obsidian")).toBe(false);
    expect(isConfigJson("app.json", ".obsidian")).toBe(false);
    expect(retentionClassOf("c.canvas", ".obsidian")).toBe("note");
    expect(retentionClassOf("p.pdf", ".obsidian")).toBe("attachment");
    expect(retentionClassOf(".obsidian/app.json", ".obsidian")).toBe("config");
  });

  it("strategy table", () => {
    expect(strategyFor({ kind: "note", configJson: false, conflictMode: "merge" })).toBe("dmp3");
    expect(strategyFor({ kind: "note", configJson: false, conflictMode: "conflictFile" })).toBe("conflictCopy");
    expect(strategyFor({ kind: "config", configJson: true, conflictMode: "conflictFile" })).toBe("json");
    expect(strategyFor({ kind: "config", configJson: false, conflictMode: "merge" })).toBe("lww");
    expect(strategyFor({ kind: "attachment", configJson: false, conflictMode: "merge" })).toBe("lww");
    expect(strategyFor({ kind: "other", configJson: false, conflictMode: "conflictFile" })).toBe("conflictCopy");
    expect(strategyFor({ kind: "note", configJson: false, conflictMode: "merge", conflictLoop: true })).toBe("conflictCopy");
  });

  it("LWW: remote wins ties, future mtimes clamp to server time", () => {
    expect(lwwDecide({ localMtime: 10, remoteMtime: 10, remoteTs: 100 }).winner).toBe("remote");
    expect(lwwDecide({ localMtime: 11, remoteMtime: 10, remoteTs: 100 }).winner).toBe("local");
    const far = lwwDecide({ localMtime: 100 + MTIME_CLAMP_MS + 1, remoteMtime: 50, remoteTs: 100 });
    expect(far).toMatchObject({ winner: "local", clockWarning: true, localMtime: 100 });
    expect(lwwDecide({ localMtime: 100 + MTIME_CLAMP_MS + 1, remoteMtime: 100, remoteTs: 100 }).winner).toBe("remote");
  });

  it("template prefix refinement (design §3.10.6)", () => {
    expect(isTemplatePrefix("", "# Day\nstuff")).toBe(true);
    expect(isTemplatePrefix("  \n", "anything")).toBe(true);
    expect(isTemplatePrefix("# Day\n", "# Day\nstuff")).toBe(true);
    expect(isTemplatePrefix("# Day\nmine", "# Day\nstuff")).toBe(false);
  });
});

describe("conflict loop and oscillation (design §3.10.1, §3.10.3)", () => {
  it("5 conflicts within 60 s trip; success resets", () => {
    const c = new FakeClock();
    const t = new ConflictLoopTracker(c);
    for (let i = 0; i < 4; i++) { t.recordConflict("f"); c.tick(1000); }
    expect(t.tripped("f")).toBe(false);
    t.recordConflict("f");
    expect(t.tripped("f")).toBe(true);
    c.tick(61_000);
    expect(t.tripped("f")).toBe(false);
    for (let i = 0; i < 5; i++) t.recordConflict("f");
    t.recordSuccess("f");
    expect(t.tripped("f")).toBe(false);
  });

  it("A/B alternation more than 4 times per hour trips", () => {
    const c = new FakeClock();
    const o = new OscillationDetector(c);
    const seq = ["A", "B", "A", "B", "A"];
    expect(seq.map((v) => { c.tick(60_000); return o.observe("k", v); })).toEqual([false, false, false, false, false]);
    c.tick(60_000);
    expect(o.observe("k", "B")).toBe(true);
    expect(o.observe("k2", "A")).toBe(false);
    const p = new OscillationDetector(c);
    for (const v of ["A", "B", "C", "A", "B", "C"]) expect(p.observe("k", v)).toBe(false);
  });
});
