// Shared I8 / I6 checks for the planner table and property tests (design §3.18 I8, §7.3).
import { expect } from "vitest";
import { pathTakenApplies, pushesRemote, type Action, type PlanInput } from "../src/index";

export function checkInvariants(i: PlanInput, a: Action): void {
  try {
    check(i, a);
  } catch (e) {
    throw new Error(`${JSON.stringify(i)} → ${JSON.stringify(a)}: ${(e as Error).message}`);
  }
}

function check(i: PlanInput, a: Action): void {
  const B = i.entry?.synced ?? null;
  const L = i.L;
  const R = i.R;
  const P = i.P ?? null;
  if (i.scope !== "active") {
    expect(a).toMatchObject({ type: "NOOP", row: "SCOPE" });
    return;
  }
  if (i.entry?.integrityHold) {
    expect(a).toMatchObject({ type: "NOOP", row: "HOLD" });
    return;
  }
  const p1 = pathTakenApplies(i);
  // Never PUSH_DELETE when L exists; only for an unchanged remote at B.
  if (a.type === "PUSH_DELETE") {
    expect(L).toBeNull();
    expect(B && R && !R.deleted && R.seq === B.version).toBeTruthy();
  }
  // Destructive local actions only touch content that is safe elsewhere.
  if (a.type === "LOCAL_DELETE") {
    expect(a.mode).toBe("trash");
    expect(L).not.toBeNull();
    const unchangedVsBase = !!B && L!.hash === B.hash && L!.path === B.path;
    const n6 = a.row === "N6" && i.ctx.mode === "rebuild" && i.tombstoneBaseHash === L!.hash;
    expect(unchangedVsBase || n6).toBe(true);
  }
  // A pull never overwrites unsynced local content (I6): L absent, or L equals the base content.
  if (a.type === "PULL") {
    expect(!L || (!!B && L.hash === B.hash)).toBe(true);
    expect(R && !R.deleted).toBeTruthy();
  }
  if (a.type === "ADOPT") {
    const src = a.row === "P1" ? P : R;
    expect(L && src && src.contentHash === L.hash).toBeTruthy();
  }
  if (a.type === "FORGET") expect(L).toBeNull();
  // X1: never pull when the remote went backwards.
  if (!p1 && B && R && R.seq < B.version) expect(a.type === "PULL" || a.type === "LOCAL_DELETE").toBe(false);
  // Incremental + base + no remote head: integrity error, never a delete.
  if (!p1 && B && !R && i.ctx.mode === "incremental" && !i.ctx.rollbackAccepted) expect(a.type).toBe("INTEGRITY_ERROR");
  // Epoch mode: absence from the snapshot never means delete.
  if (i.ctx.mode === "epoch" && !R) expect(a.type === "LOCAL_DELETE").toBe(false);
  // P1: never re-push the taken path.
  if (p1) {
    expect(a.row).toBe("P1");
    expect(a.type === "ADOPT" || a.type === "KEEP_BOTH").toBe(true);
  } else expect(a.row).not.toBe("P1");
  // Conflict rows push the resolved path with base = R.seq.
  if (!p1 && B && R && !R.deleted && R.seq > B.version && L && (L.hash !== B.hash || L.path !== B.path)) {
    if (a.type === "PUSH_PUT" || a.type === "MERGE") {
      expect(a.base).toBe(R.seq);
      const lMoved = L.path !== B.path;
      const rMoved = R.path !== B.path;
      const resolved = rMoved ? R.path : L.path;
      if (!(lMoved && rMoved && L.path !== R.path)) expect(a.path).toBe(resolved);
      if (a.path !== L.path) expect(a.preRename).toEqual({ from: L.path, to: a.path });
    }
    if (a.type === "PULL" && a.thenPush) expect(a.thenPush.base).toBe(R.seq);
  }
  // No push from absent local content except X1 re-upload from base bytes.
  if ((a.type === "PUSH_PUT" || a.type === "PUSH_CREATE") && a.source === "base") {
    expect(a.row).toBe("X1");
    expect(L === null && B?.hasBase).toBeTruthy();
  }
  if ((a.type === "PUSH_PUT" || a.type === "PUSH_CREATE") && a.source === "local") expect(L).not.toBeNull();
  // A push or merge after a conflict row is against R's identity (CAS on R's head).
  if (a.type === "MERGE") expect(a.fileId).toBe(R?.fileId);
  // An action that puts a different fileId at a path our entry holds must name the entry in `replaces`.
  const own = i.entry?.fileId;
  if (own && L) {
    const newId = a.type === "ADOPT" || a.type === "MERGE" ? a.fileId : a.type === "PUSH_CREATE" ? a.fileId : undefined;
    if (newId !== undefined && newId !== own) expect((a as { replaces?: string }).replaces).toBe(own);
  }
  if (a.type === "PULL" && own && a.fileId !== own) expect(a.forget).toBe(own);
}
