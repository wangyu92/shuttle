// Planner properties over random inputs (design §7.3).
import type { RemoteHead, Scope } from "@shuttle/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applySyncMode, decide, pushesRemote, type PlanInput } from "../src/index";
import { checkInvariants } from "./plannerInvariants";

const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
const paths = ["x.md", "X.md", "d/x.md", "e/x.md"];
const hashes = ["h1", "h2", "h3"];

const local = fc.option(fc.record({ path: fc.constantFrom(...paths), hash: fc.constantFrom(...hashes), size: fc.nat(10), mtime: fc.nat(200) }), { nil: null });
const synced = fc.option(fc.record({
  version: fc.integer({ min: 1, max: 20 }), path: fc.constantFrom(...paths), hash: fc.constantFrom(...hashes),
  size: fc.nat(10), mtime: fc.nat(200), hasBase: fc.boolean(),
}), { nil: null });
const remote = (fileId: fc.Arbitrary<string>): fc.Arbitrary<RemoteHead | null> => fc.option(fc.record({
  fileId, seq: fc.integer({ min: 1, max: 25 }), base: fc.constant(null), pathKey: fc.constant("pk"), path: fc.constantFrom(...paths),
  deleted: fc.boolean(), size: fc.nat(10), mtime: fc.nat(200), contentHash: fc.constantFrom(...hashes),
  chunkSizes: fc.constant<number[]>([]), blobs: fc.constant<string[]>([]), kv: fc.constant(1), deviceId: fc.constant("d"), ts: fc.nat(300),
}).map((h) => (h.deleted ? { ...h, contentHash: null } : h)), { nil: null });

const input: fc.Arbitrary<PlanInput> = fc.record({
  L: local,
  hasEntry: fc.boolean(),
  synced,
  hold: fc.boolean(),
  R: remote(fc.constantFrom(...ids)),
  P: remote(fc.constantFrom(...ids)),
  scope: fc.constantFrom<Scope>("active", "active", "active", "excluded", "ignored", "oversize", "illegal"),
  kind: fc.constantFrom("note", "config", "attachment", "other" as const),
  configJson: fc.boolean(),
  conflictMode: fc.constantFrom("merge", "conflictFile" as const),
  mode: fc.constantFrom("incremental", "snapshotResync", "rebuild", "epoch" as const),
  rollbackAccepted: fc.boolean(),
  tomb: fc.option(fc.constantFrom(...hashes), { nil: null }),
}).map((x) => {
  const entry = x.hasEntry || x.synced
    ? { fileId: ids[0]!, path: x.L?.path ?? x.synced?.path ?? "x.md", synced: x.synced, ...(x.hold ? { integrityHold: true } : {}) }
    : null;
  // With a base, R is looked up by fileId: force R.fileId = entry.fileId.
  const R = x.R && entry?.synced ? { ...x.R, fileId: entry.fileId } : x.R;
  return {
    L: x.L, entry, R, P: x.P, path: x.L?.path ?? "x.md", scope: x.scope, kind: x.kind, configJson: x.configJson,
    conflictMode: x.conflictMode, ctx: { mode: x.mode, ...(x.rollbackAccepted ? { rollbackAccepted: true } : {}) }, tombstoneBaseHash: x.tomb,
  };
});

describe("Planner properties", () => {
  it("totality, determinism and I8/I6 invariants", () => {
    fc.assert(fc.property(input, (i) => {
      const a = decide(i);
      expect(decide(structuredClone(i))).toEqual(a);
      checkInvariants(i, a);
      expect(pushesRemote(applySyncMode(a, "pull-only", i.R))).toBe(false);
    }), { numRuns: 3000 });
  });
});
