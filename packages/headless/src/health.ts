// Health and staleness (design §6.1.9): progress against the server, not process liveness.
// computeHealth() is pure; HealthTracker keeps the time-based inputs (since when disconnected, lagging,
// pending) and writes `<state>/health.json` atomically.

import type { EngineStatus, GuardEvent, SyncMode } from "@shuttle/protocol";
import { promises as fsp } from "node:fs";
import path from "node:path";

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthReason { code: string; text: string; needsPerson: boolean; down: boolean }

export interface HealthJson {
  status: HealthStatus;
  reasons: string[];
  engine: EngineStatus["status"];
  mode: SyncMode;
  locked: boolean;
  connectedSince: number | null;
  serverHeadSeq: number | null;
  serverHeadSeqAt: number | null;
  cursor: number | null;
  cursorAt: number | null;
  lagSeq: number;
  lagSince: number | null;
  lastPullOkAt: number | null;
  lastCommitOkAt: number | null;
  pending: { up: number; down: number; failed: number; deferred: number };
  quarantined: number;
  watcher: { mode: string; degraded: boolean; missedByWatcher: number; lastScanAt: number | null; lastScanMs: number | null };
  guards: Array<Pick<GuardEvent, "id" | "kind" | "n">>;
  loopHeartbeatAt: number;
  version: string;
  /** Exit code `status` returns for this health (design §6.1.9). */
  exitCode: 0 | 1 | 4;
  at: number;
}

export interface HealthInputs {
  now: number;
  engine: EngineStatus;
  mode: SyncMode;
  version: string;
  connected: boolean;
  connectedSince: number | null;
  disconnectedSince: number | null;
  serverHeadSeq: number | null;
  serverHeadSeqAt: number | null;
  cursor: number | null;
  cursorAt: number | null;
  lagSince: number | null;
  lastPullOkAt: number | null;
  lastCommitOkAt: number | null;
  pendingUpSince: number | null;
  deferred: number;
  deferredHourAgo: number | null;
  quarantined: number;
  /** lastError values of failed journal ops. */
  failedErrors: string[];
  watcher: HealthJson["watcher"];
  pollIntervalSec: number;
  startedAt: number;
  guards: GuardEvent[];
  loopHeartbeatAt: number;
  startupFailure: { emptyVault: boolean; text: string } | null;
}

const MIN = 60_000;
const PERSON_ERRORS = /QUOTA|FORBIDDEN|TOO_LARGE|tooLarge|quota|forbidden/;

export function computeHealth(i: HealthInputs): HealthJson {
  const reasons: HealthReason[] = [];
  const add = (code: string, text: string, down: boolean, needsPerson = false): void => {
    reasons.push({ code, text, down, needsPerson });
  };
  const e = i.engine;
  if (i.startupFailure) add(i.startupFailure.emptyVault ? "emptyVault" : "startup", i.startupFailure.text, true, i.startupFailure.emptyVault);
  if (e.status === "error") {
    const auth = e.reason === "AUTH" || e.reason === "REVOKED" || e.reason === "UNAUTHENTICATED";
    const person = auth || e.reason === "tampered" || e.reason === "integrity";
    add("engineError", `engine error${e.reason ? `: ${e.reason}` : ""}`, true, person);
  }
  if (e.locked) add("locked", "vault is locked (keys not available; re-pair)", true, true);
  for (const g of i.guards) add("guard", `guard ${g.kind} pending (${g.id}, ${g.n} files)`, true, true);
  if (e.status === "paused" && e.reason === "user") add("paused", "sync paused by the operator", true, true);
  const disc = !i.connected && i.disconnectedSince !== null ? i.now - i.disconnectedSince : 0;
  if (!i.connected && i.disconnectedSince !== null) {
    if (disc > 10 * MIN) add("disconnected", `disconnected for ${Math.round(disc / MIN)} min`, true);
    else if (disc >= MIN) add("disconnected", `disconnected for ${Math.round(disc / MIN)} min`, false);
  }
  const lagSeq = i.serverHeadSeq !== null && i.cursor !== null ? Math.max(0, i.serverHeadSeq - i.cursor) : 0;
  if (i.connected && lagSeq > 0 && i.lagSince !== null && i.now - i.lagSince > 10 * MIN) add("lag", `${lagSeq} changes behind for more than 10 min`, true);
  if (e.pendingUp > 0 && i.pendingUpSince !== null) {
    const ref = Math.max(i.pendingUpSince, i.lastCommitOkAt ?? 0);
    if (i.now - ref > 15 * MIN) add("stuckUpload", "uploads pending with no successful commit for 15 min", true);
  }
  const scanRef = i.watcher.lastScanAt ?? i.startedAt;
  if (i.now - scanRef > 5 * i.pollIntervalSec * 1000) add("scanStale", "last scan is older than 5 poll intervals", true);
  if (i.watcher.degraded) add("watcher", "watcher degraded; polling", false);
  if (e.failed > 0) {
    const person = i.failedErrors.some((x) => PERSON_ERRORS.test(x));
    add("failedOps", `${e.failed} failed operations`, person, person);
  }
  if (i.quarantined > 0) add("quarantined", `${i.quarantined} quarantined records`, false);
  if (i.deferredHourAgo !== null && i.deferred - i.deferredHourAgo > 50) add("deferred", "deferred records grew by more than 50 in an hour", false);

  const down = reasons.some((r) => r.down);
  const status: HealthStatus = down ? "down" : reasons.length ? "degraded" : "ok";
  const exitCode: 0 | 1 | 4 = !down ? 0 : reasons.some((r) => r.down && r.needsPerson) ? 4 : 1;
  return {
    status, reasons: reasons.map((r) => r.text), engine: e.status, mode: i.mode, locked: e.locked,
    connectedSince: i.connected ? i.connectedSince : null,
    serverHeadSeq: i.serverHeadSeq, serverHeadSeqAt: i.serverHeadSeqAt, cursor: i.cursor, cursorAt: i.cursorAt,
    lagSeq, lagSince: lagSeq > 0 ? i.lagSince : null, lastPullOkAt: i.lastPullOkAt, lastCommitOkAt: i.lastCommitOkAt,
    pending: { up: e.pendingUp, down: e.pendingDown, failed: e.failed, deferred: i.deferred },
    quarantined: i.quarantined, watcher: { ...i.watcher },
    guards: i.guards.map((g) => ({ id: g.id, kind: g.kind, n: g.n })),
    loopHeartbeatAt: i.loopHeartbeatAt, version: i.version, exitCode, at: i.now,
  };
}

/** Time-based bookkeeping between health computations. */
export class HealthClock {
  disconnectedSince: number | null;
  lagSince: number | null = null;
  pendingUpSince: number | null = null;
  private deferredSamples: Array<{ at: number; n: number }> = [];

  constructor(startedAt: number) {
    this.disconnectedSince = startedAt;
  }

  observe(now: number, o: { connected: boolean; lagSeq: number; pendingUp: number; deferred: number }): { deferredHourAgo: number | null } {
    if (o.connected) this.disconnectedSince = null;
    else this.disconnectedSince ??= now;
    if (o.lagSeq > 0) this.lagSince ??= now;
    else this.lagSince = null;
    if (o.pendingUp > 0) this.pendingUpSince ??= now;
    else this.pendingUpSince = null;
    this.deferredSamples.push({ at: now, n: o.deferred });
    this.deferredSamples = this.deferredSamples.filter((s) => now - s.at <= 61 * MIN);
    const old = this.deferredSamples.find((s) => now - s.at >= 59 * MIN);
    return { deferredHourAgo: old ? old.n : null };
  }
}

/**
 * health.json via temp + rename, without fsync: it is a status file rewritten every 15 s, and an fsync
 * costs ~100 ms on the NAS volume. Readers see the old or the new file, never a partial one.
 */
export async function writeHealthFile(file: string, h: HealthJson): Promise<void> {
  const tmp = path.join(path.dirname(file), `.health.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(tmp, JSON.stringify(h) + "\n", { mode: 0o644 });
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
