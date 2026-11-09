// RemoteAdapter wrapper for the headless client:
//  - mode enforcement below the engine (design §6.1.1): in pull-only and mirror-remote every commit
//    throws, so a planner bug fails loudly instead of writing to the server;
//  - progress tracking for health (design §6.1.9): connectedSince, serverHeadSeq from connect
//    (welcome.headSeq) and every changes batch, lastPullOkAt, lastCommitOkAt.

import type { ChangeBatch, ChangeSink, CommitRequest, CommitResponse, ConnectInfo, RemoteAdapter, Seq, SyncMode } from "@shuttle/protocol";
import { remoteError } from "@shuttle/protocol";

export interface RemoteProgress {
  connected: boolean;
  connectedSince: number | null;
  serverHeadSeq: number | null;
  serverHeadSeqAt: number | null;
  lastPullOkAt: number | null;
  lastCommitOkAt: number | null;
  epoch: number | null;
}

export class ModeViolation extends Error {
  constructor(mode: SyncMode) {
    super(`commit refused: this device runs in ${mode} mode`);
    this.name = "ModeViolation";
  }
}

export function wrapRemote(inner: RemoteAdapter, o: { mode: SyncMode; now?: () => number }): { remote: RemoteAdapter; progress: RemoteProgress } {
  const now = o.now ?? Date.now;
  const progress: RemoteProgress = {
    connected: false, connectedSince: null, serverHeadSeq: null, serverHeadSeqAt: null, lastPullOkAt: null, lastCommitOkAt: null, epoch: null,
  };
  const head = (seq: Seq): void => {
    if (progress.serverHeadSeq === null || seq !== progress.serverHeadSeq) progress.serverHeadSeqAt = now();
    progress.serverHeadSeq = seq;
  };
  const noCommit = o.mode === "pull-only" || o.mode === "mirror-remote";
  const overrides: Partial<RemoteAdapter> = {
    async connect(): Promise<ConnectInfo> {
      try {
        const ci = await inner.connect();
        if (!progress.connected) progress.connectedSince = now();
        progress.connected = true;
        progress.epoch = ci.epoch;
        head(ci.headSeq);
        return ci;
      } catch (e) {
        progress.connected = false;
        progress.connectedSince = null;
        throw e;
      }
    },
    async close(): Promise<void> {
      progress.connected = false;
      progress.connectedSince = null;
      return inner.close();
    },
    async commit(req: CommitRequest): Promise<CommitResponse> {
      if (noCommit) throw remoteError("FORBIDDEN", new ModeViolation(o.mode).message);
      const r = await inner.commit(req);
      progress.lastCommitOkAt = now();
      head(r.headSeq);
      return r;
    },
    async pull(since: Seq, limit?: number): Promise<ChangeBatch> {
      const b = await inner.pull(since, limit);
      progress.lastPullOkAt = now();
      head(b.headSeq);
      return b;
    },
    subscribe(since: Seq | null, sink: ChangeSink) {
      const wrapped: ChangeSink = {
        onChanges: async (b) => {
          head(b.headSeq);
          await sink.onChanges(b);
          progress.lastPullOkAt = now();
        },
        headOf: (id) => sink.headOf(id),
        liveHeadByPathKey: (pk) => sink.liveHeadByPathKey(pk),
        onSnapshotRequired: (i) => sink.onSnapshotRequired(i),
        onVaultInfoChanged: (e) => sink.onVaultInfoChanged(e),
        onError: (e) => sink.onError(e),
        onState: (s, d) => {
          if (s === "live" || s === "connected" || s === "catching-up") {
            if (!progress.connected) progress.connectedSince = now();
            progress.connected = true;
          } else if (s === "offline" || s === "auth-error") {
            progress.connected = false;
            progress.connectedSince = null;
          }
          sink.onState(s, d);
        },
      };
      return inner.subscribe(since, wrapped);
    },
  };
  const remote = new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return (overrides as Record<string, unknown>)[prop];
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { remote, progress };
}
