// I8: the decision table is total. Enumerates L × B × R × P × scope × hold × mode × kind × conflictMode.
import type { RemoteHead, Scope } from "@shuttle/protocol";
import { describe, expect, it } from "vitest";
import { applySyncMode, decide, pushesRemote, writesLocal, type Action, type PlanInput, type PlanRow } from "../src/index";
import { checkInvariants } from "./plannerInvariants";

const F = "a".repeat(32);
const G = "b".repeat(32);
const H = "c".repeat(32);
const BP = "n/a.md";
const B = { version: 10, path: BP, hash: "hB", size: 1, mtime: 1, hasBase: true };

const Ls = {
  absent: null,
  same: { path: BP, hash: "hB", size: 1, mtime: 1 },
  modified: { path: BP, hash: "hL", size: 2, mtime: 5 },
  moved: { path: "m/a.md", hash: "hB", size: 1, mtime: 1 },
  movedModified: { path: "m/a.md", hash: "hL", size: 2, mtime: 5 },
} as const;

function head(o: Partial<RemoteHead> & { seq: number }): RemoteHead {
  return {
    fileId: F, base: 9, pathKey: "pk", path: BP, deleted: false, size: 1, mtime: 3, contentHash: "hB",
    chunkSizes: [], blobs: [], kv: 1, deviceId: "dev", ts: 100, ...o,
  };
}

function Rs(fileId: string): Record<string, RemoteHead | null> {
  return {
    absent: null,
    liveSame: head({ fileId, seq: 10 }),
    liveChanged: head({ fileId, seq: 12, contentHash: "hR" }),
    liveMoved: head({ fileId, seq: 12, path: "r/a.md" }),
    liveMovedChanged: head({ fileId, seq: 12, path: "r/a.md", contentHash: "hR" }),
    liveEqL: head({ fileId, seq: 12, contentHash: "hL" }),
    liveBothMovedSame: head({ fileId, seq: 12, path: "m/a.md" }),
    liveMetaOnly: head({ fileId, seq: 12 }),
    tomb: head({ fileId, seq: 12, deleted: true, contentHash: null }),
    behindLive: head({ fileId, seq: 8, contentHash: "hR" }),
    behindTomb: head({ fileId, seq: 8, deleted: true, contentHash: null }),
  };
}

const Ps: Record<string, RemoteHead | null> = {
  none: null,
  holderSame: head({ fileId: H, seq: 20, path: "m/a.md", contentHash: "hL" }),
  holderOther: head({ fileId: H, seq: 20, path: "m/a.md", contentHash: "hP" }),
};

const scopes: Scope[] = ["active", "excluded", "ignored", "oversize", "illegal"];
const modes = ["incremental", "snapshotResync", "rebuild", "epoch"] as const;
const kinds = [
  { kind: "note", configJson: false, path: BP },
  { kind: "config", configJson: true, path: ".obsidian/app.json" },
  { kind: "attachment", configJson: false, path: "n/a.png" },
] as const;

function* inputs(): Generator<PlanInput> {
  for (const [, L] of Object.entries(Ls)) {
    for (const bState of ["none", "entryNoSync", "base"] as const) {
      const Rmap = Rs(bState === "base" ? F : G);
      for (const R of Object.values(Rmap)) {
        for (const P of Object.values(Ps)) {
          for (const scope of scopes) {
            for (const hold of [false, true]) {
              if (scope !== "active" && hold) continue;
              for (const mode of modes) {
                for (const rollbackAccepted of [false, true]) {
                  for (const k of kinds) {
                    for (const conflictMode of ["merge", "conflictFile"] as const) {
                      if (scope !== "active" && (conflictMode !== "merge" || k.kind !== "note" || rollbackAccepted)) continue;
                      const entry = bState === "none" ? null
                        : { fileId: F, path: L?.path ?? BP, synced: bState === "base" ? B : null, ...(hold ? { integrityHold: true } : {}) };
                      if (!entry && hold) continue;
                      yield {
                        L, entry, R, P, path: L?.path ?? BP, scope, kind: k.kind, configJson: k.configJson, conflictMode,
                        ctx: { mode, ...(rollbackAccepted ? { rollbackAccepted } : {}) },
                        tombstoneBaseHash: R?.deleted ? "hB" : null,
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

describe("Planner decision table (design §3.4.3, I8)", () => {
  it("is total, deterministic and satisfies the I8 / I6 checks for every enumerated input", { timeout: 60_000 }, () => {
    const rows = new Set<PlanRow>();
    let n = 0;
    for (const i of inputs()) {
      const a = decide(i);
      expect(decide(i)).toEqual(a);
      checkInvariants(i, a);
      rows.add(a.row);
      n++;
      for (const m of ["pull-only", "push-only", "mirror-remote"] as const) {
        const b = applySyncMode(a, m, i.R);
        if (m !== "push-only") expect(pushesRemote(b), `${m} ${JSON.stringify(a)}`).toBe(false);
        else expect(writesLocal(b), `${m} ${JSON.stringify(a)}`).toBe(false);
      }
    }
    expect(n).toBeGreaterThan(10_000);
    const all: PlanRow[] = ["SCOPE", "HOLD", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "X1", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "P1", "N1", "N2", "N3", "N4", "N5", "N6", "N7"];
    expect([...rows].sort()).toEqual([...all].sort());
  });
});

// Row-by-row expectations (design §3.4.3 table text).
function plan(o: Partial<PlanInput> & { L: PlanInput["L"]; R: PlanInput["R"] }, base: boolean | "entry" = true): Action {
  return decide({
    entry: base === true ? { fileId: F, path: o.L?.path ?? BP, synced: B } : base === "entry" ? { fileId: F, path: o.L?.path ?? BP, synced: null } : null,
    path: o.L?.path ?? BP, scope: "active", kind: "note", configJson: false, conflictMode: "merge", ctx: { mode: "incremental" }, ...o,
  });
}
const R = Rs(F);
const RG = Rs(G);

describe("Planner rows", () => {
  it("S1–S8", () => {
    expect(plan({ L: Ls.same, R: R.liveSame! })).toMatchObject({ row: "S1", type: "NOOP" });
    expect(plan({ L: Ls.modified, R: R.liveSame! })).toMatchObject({ row: "S2", type: "PUSH_PUT", base: 10, path: BP });
    expect(plan({ L: Ls.moved, R: R.liveSame! })).toMatchObject({ row: "S3", type: "PUSH_PUT", base: 10, path: "m/a.md" });
    expect(plan({ L: Ls.movedModified, R: R.liveSame! })).toMatchObject({ row: "S4", type: "PUSH_PUT", path: "m/a.md" });
    expect(plan({ L: null, R: R.liveSame! })).toMatchObject({ row: "S5", type: "PUSH_DELETE", base: 10, path: BP });
    expect(plan({ L: Ls.same, R: R.liveChanged! })).toMatchObject({ row: "S6", type: "PULL", seq: 12 });
    expect(plan({ L: Ls.same, R: R.liveMetaOnly! })).toMatchObject({ row: "S6", type: "ADOPT", seq: 12 });
    expect(plan({ L: Ls.same, R: R.tomb! })).toMatchObject({ row: "S7", type: "LOCAL_DELETE", mode: "trash" });
    expect(plan({ L: Ls.same, R: null })).toMatchObject({ row: "S8", type: "INTEGRITY_ERROR" });
    expect(plan({ L: Ls.same, R: null, ctx: { mode: "snapshotResync" } })).toMatchObject({ row: "S8", type: "LOCAL_DELETE" });
    expect(plan({ L: Ls.same, R: null, ctx: { mode: "rebuild" } })).toMatchObject({ row: "S8", type: "LOCAL_DELETE" });
    expect(plan({ L: Ls.same, R: null, ctx: { mode: "epoch" } })).toMatchObject({ row: "S8", type: "PUSH_CREATE", fileId: F });
  });

  it("X1 after a rollback accept", () => {
    expect(plan({ L: Ls.same, R: R.behindLive! })).toMatchObject({ row: "X1", type: "PUSH_PUT", base: 8, source: "local" });
    expect(plan({ L: Ls.modified, R: R.behindTomb! })).toMatchObject({ row: "X1", type: "PUSH_PUT", base: 8 });
    expect(plan({ L: Ls.same, R: null, ctx: { mode: "snapshotResync", rollbackAccepted: true } })).toMatchObject({ row: "X1", type: "PUSH_CREATE", fileId: F });
    expect(plan({ L: null, R: R.behindLive! })).toMatchObject({ row: "X1", type: "PUSH_PUT", source: "base", path: BP });
    const noBase = decide({ L: null, entry: { fileId: F, path: BP, synced: { ...B, hasBase: false } }, R: R.behindLive!, path: BP, scope: "active", kind: "note", configJson: false, conflictMode: "merge", ctx: { mode: "snapshotResync" } });
    expect(noBase).toMatchObject({ row: "X1", type: "FORGET", log: { key: "log.lostInServerRestore" } });
  });

  it("C1–C8", () => {
    expect(plan({ L: Ls.modified, R: R.liveEqL! })).toMatchObject({ row: "C1", type: "ADOPT", seq: 12 });
    expect(plan({ L: Ls.modified, R: R.liveChanged! })).toMatchObject({ row: "C2", type: "MERGE", strategy: "dmp3", base: 12, path: BP });
    expect(plan({ L: Ls.modified, R: R.liveChanged!, conflictMode: "conflictFile" })).toMatchObject({ row: "C2", strategy: "conflictCopy" });
    expect(plan({ L: Ls.modified, R: R.liveChanged!, kind: "attachment" })).toMatchObject({ row: "C2", strategy: "lww" });
    expect(plan({ L: Ls.modified, R: R.liveChanged!, ctx: { mode: "incremental", conflictLoop: true } })).toMatchObject({ strategy: "conflictCopy" });
    // C2 with remote moved only: content S2, path remote wins (rename first, push at R.path).
    expect(plan({ L: Ls.modified, R: R.liveMoved! })).toMatchObject({
      row: "C2", type: "PUSH_PUT", base: 12, path: "r/a.md", preRename: { from: BP, to: "r/a.md" },
    });
    expect(plan({ L: null, R: R.liveChanged! })).toMatchObject({ row: "C3", type: "PULL", log: { key: "log.restoredChangedElsewhere" } });
    expect(plan({ L: Ls.modified, R: R.tomb! })).toMatchObject({ row: "C4", type: "PUSH_PUT", base: 12, path: BP });
    expect(plan({ L: Ls.modified, R: null, ctx: { mode: "snapshotResync" } })).toMatchObject({ row: "C5", type: "PUSH_CREATE", fileId: null, replaces: F });
    expect(plan({ L: Ls.modified, R: null, ctx: { mode: "epoch" } })).toMatchObject({ row: "C5", type: "PUSH_CREATE", fileId: F });
    expect(plan({ L: Ls.modified, R: null })).toMatchObject({ row: "C5", type: "INTEGRITY_ERROR" });
    expect(plan({ L: null, R: R.tomb! })).toMatchObject({ row: "C6", type: "FORGET" });
    expect(plan({ L: null, R: null, ctx: { mode: "rebuild" } })).toMatchObject({ row: "C6", type: "FORGET" });
    expect(plan({ L: null, R: null, ctx: { mode: "epoch" } })).toMatchObject({ row: "C6", type: "FORGET" });
    expect(plan({ L: null, R: null })).toMatchObject({ row: "C6", type: "INTEGRITY_ERROR" });
    expect(plan({ L: Ls.moved, R: R.liveMoved! })).toMatchObject({ row: "C7", type: "LOCAL_RENAME", from: "m/a.md", to: "r/a.md" });
    expect(plan({ L: Ls.movedModified, R: R.liveMovedChanged! })).toMatchObject({ row: "C7", type: "LOCAL_RENAME" });
    expect(plan({ L: Ls.moved, R: R.liveChanged! })).toMatchObject({ row: "C8", type: "PULL", path: "m/a.md", thenPush: { path: "m/a.md", base: 12 } });
    // after C7 the paths agree: content handled normally
    expect(plan({ L: Ls.moved, R: R.liveBothMovedSame! })).toMatchObject({ row: "C1", type: "ADOPT" });
  });

  it("P1 PATH_TAKEN", () => {
    expect(plan({ L: Ls.movedModified, R: R.liveSame!, P: Ps.holderSame! })).toMatchObject({ row: "P1", type: "ADOPT", fileId: H, replaces: F });
    expect(plan({ L: Ls.movedModified, R: R.liveSame!, P: Ps.holderOther! })).toMatchObject({ row: "P1", type: "KEEP_BOTH", fileId: F, path: "m/a.md" });
    expect(plan({ L: Ls.modified, R: null, P: { ...Ps.holderOther!, path: "N/A.md" } }, false)).toMatchObject({ row: "P1", type: "KEEP_BOTH", fileId: null });
  });

  it("N1–N7", () => {
    expect(plan({ L: Ls.modified, R: null }, false)).toMatchObject({ row: "N1", type: "PUSH_CREATE", fileId: null });
    expect(plan({ L: Ls.modified, R: null }, "entry")).toMatchObject({ row: "N1", type: "PUSH_CREATE", fileId: F });
    expect(plan({ L: Ls.modified, R: RG.tomb! }, false)).toMatchObject({ row: "N1", type: "PUSH_CREATE" });
    expect(plan({ L: null, R: RG.liveChanged! }, false)).toMatchObject({ row: "N2", type: "PULL", fileId: G });
    expect(plan({ L: null, R: RG.liveChanged! }, "entry")).toMatchObject({ row: "N2", type: "PULL", fileId: G, forget: F });
    expect(plan({ L: Ls.modified, R: RG.liveEqL! }, false)).toMatchObject({ row: "N3", type: "ADOPT", fileId: G });
    expect(plan({ L: Ls.modified, R: RG.liveEqL! }, "entry")).toMatchObject({ row: "N3", type: "ADOPT", fileId: G, replaces: F });
    expect(plan({ L: { ...Ls.modified, path: ".obsidian/app.json" }, R: { ...RG.liveChanged!, path: ".obsidian/app.json" }, kind: "config", configJson: true }, false))
      .toMatchObject({ row: "N4", type: "MERGE", strategy: "json", base: 12, fileId: G });
    expect(plan({ L: { ...Ls.modified, path: ".obsidian/app.json" }, R: { ...RG.liveChanged!, path: ".obsidian/app.json" }, kind: "config", configJson: true }, "entry"))
      .toMatchObject({ row: "N4", type: "MERGE", fileId: G, replaces: F });
    expect(plan({ L: Ls.modified, R: RG.liveChanged! }, false)).toMatchObject({
      row: "N5", type: "KEEP_BOTH", allowTemplateAdopt: true, pull: { fileId: G, seq: 12, path: BP },
    });
    expect(plan({ L: Ls.modified, R: RG.liveChanged!, kind: "attachment" }, false)).toMatchObject({ row: "N5", allowTemplateAdopt: false });
    expect(plan({ L: Ls.same, R: RG.tomb!, ctx: { mode: "rebuild" }, tombstoneBaseHash: "hB" }, false)).toMatchObject({ row: "N6", type: "LOCAL_DELETE" });
    expect(plan({ L: { ...Ls.same, mtime: 1000 }, R: RG.tomb!, ctx: { mode: "rebuild" }, tombstoneBaseHash: "hB" }, false)).toMatchObject({ row: "N1" });
    expect(plan({ L: Ls.same, R: RG.tomb!, ctx: { mode: "snapshotResync" }, tombstoneBaseHash: "hB" }, false)).toMatchObject({ row: "N1" });
    expect(plan({ L: null, R: null }, false)).toMatchObject({ row: "N7", type: "NOOP" });
    expect(plan({ L: null, R: RG.tomb! }, "entry")).toMatchObject({ row: "N7", type: "FORGET", fileId: F });
  });

  it("case-only difference without base: ADOPT takes the remote spelling", () => {
    const a = plan({ L: { ...Ls.modified, path: "N/A.md" }, R: RG.liveEqL! }, false);
    expect(a).toMatchObject({ row: "N3", type: "ADOPT", preRename: { from: "N/A.md", to: BP } });
  });

  it("sync modes", () => {
    const push = plan({ L: Ls.modified, R: R.liveSame! });
    expect(applySyncMode(push, "pull-only", R.liveSame!)).toMatchObject({ type: "NOOP", log: { key: "log.skippedReadOnly" } });
    expect(applySyncMode(push, "mirror-remote", R.liveSame!)).toMatchObject({ type: "PULL", seq: 10, log: { key: "log.revertedToRemote" } });
    expect(applySyncMode(push, "push-only", R.liveSame!)).toBe(push);
    const pull = plan({ L: Ls.same, R: R.liveChanged! });
    expect(applySyncMode(pull, "push-only", R.liveChanged!)).toMatchObject({ type: "NOOP" });
    const c8 = plan({ L: Ls.moved, R: R.liveChanged! });
    const po = applySyncMode(c8, "pull-only", R.liveChanged!);
    expect(po.type === "PULL" && po.thenPush === undefined).toBe(true);
    const resurrect = plan({ L: Ls.modified, R: R.tomb! });
    expect(applySyncMode(resurrect, "mirror-remote", R.tomb!)).toMatchObject({ type: "LOCAL_DELETE", mode: "trash", path: BP });
    expect(applySyncMode(plan({ L: Ls.modified, R: null }, false), "mirror-remote", null)).toMatchObject({ type: "NOOP" });
  });
});
