// WebSocket link to the own server (design §2.9): hello/welcome, catch-up then live delivery through a
// ChangeSink, ack after each persisted batch, commits over the socket with an in-flight window,
// heartbeat, reconnect with backoff, and the close-code rules of §2.9.3.
//
// Invariants this file keeps:
// - Batches reach the sink one at a time, in order; the ack for a batch is sent only after its
//   `onChanges` resolved (design §2.12 ChangeSink, §2.9.4).
// - The resume cursor is the `to` of the last batch whose `onChanges` resolved, never a frame that was
//   only received (design §2.9.5 step 1).
// - A commit whose answer was not received is rejected with a retryable error when its socket goes
//   away. The adapter never resends it on its own: the engine resends the journal batch with the same
//   cid (design §2.9.5 step 2) and the server's cid cache makes that safe.
// - Frames from a socket that was abandoned are ignored (generation check).

import {
  CloseCode, HEARTBEAT_SEC, MAX_UNACKED_BYTES, MAX_WS_FRAME, PONG_TIMEOUT_SEC, PROTO_VERSION, WS_SUBPROTOCOL,
  checkCommitLimits, parseServerFrame, remoteError, remoteErrorFromWire, utf8Length,
} from "@shuttle/protocol";
import type {
  ChangeBatch, ChangeSink, ChangesMsg, ClientMessage, ClientRole, Clock, CommitRequest, CommitResponse,
  ConnectionState, RemoteError, Scheduler, Seq, ServerMessage, Subscription, TimerHandle, WelcomeLimits, WelcomeMsg,
  WsFactory, WsLike,
} from "@shuttle/protocol";
import { closeAction, networkError, type CloseAction } from "./errors";
import { errText } from "./runtime";

/** Hello fields the adapter cannot know by itself (design §2.6.1, §4.9.2). */
export interface HelloContext {
  /** The device's `seen.epoch`; null when unknown (the server then answers snapshotRequired{epoch} for a non-null since). */
  epoch: number | null;
  /** The device's `seen.maxSeq` (design §2.6.1). */
  seenMaxSeq: Seq | null;
  /** `rollbackAt` the user accepted, after the snapshot reconcile finished (design §2.6.1). */
  rollbackAck: number | null;
}

export interface FeedTimeouts {
  /** Socket open plus welcome. */
  connectMs: number;
  /** A commit without commitResult is rejected with TIMEOUT after this. */
  commitMs: number;
  /** No frame within this after a ping → reconnect (design §2.9.4: 10 s). */
  pongMs: number;
  /** Backoff resets after this long connected (design §2.9.5: 60 s). */
  stableMs: number;
  /** Backoff cap (design §2.9.5: 60 s). */
  maxBackoffMs: number;
}

export const DEFAULT_FEED_TIMEOUTS: FeedTimeouts = Object.freeze({
  connectMs: 15_000, commitMs: 60_000, pongMs: PONG_TIMEOUT_SEC * 1000, stableMs: 60_000, maxBackoffMs: 60_000,
});

export interface FeedOptions {
  ws: WsFactory;
  /** ws:// or wss:// endpoint; re-resolved before every attempt so URL fallback applies. */
  wsUrl: () => Promise<string>;
  /** Called when an attempt failed before welcome, so the next attempt re-probes the URL list. */
  onEndpointFailed: () => void;
  token: () => Promise<string>;
  vaultId: string;
  client: { name: string; platform: string; version: string; role: ClientRole };
  hello: () => Promise<HelloContext>;
  maxUnackedBytes?: number;
  clock: Clock;
  scheduler: Scheduler;
  random: () => number;
  timeouts: FeedTimeouts;
  /** welcome arrived (limits, epoch, infoEtag). */
  onWelcome: (w: WelcomeMsg) => void;
  /** A batch was persisted by the sink. */
  onPersisted: (b: ChangeBatch) => void;
  onVaultInfoChanged: (etag: string) => void;
}

type Phase =
  | "idle"        // no socket and none wanted
  | "opening"     // socket or hello in progress
  | "parked"      // welcome received; the server will not feed this socket (no cursor, snapshot required)
  | "catchup"     // feed running, catch-up not yet persisted
  | "live"        // catch-up persisted; live pushes
  | "backoff"     // waiting to reconnect
  | "stopped";    // no reconnect (auth error, superseded) until the next explicit start

interface PendingCommit {
  req: CommitRequest;
  rid: number | null;
  resolve: (r: CommitResponse) => void;
  reject: (e: RemoteError) => void;
  timer: TimerHandle;
}

/** Backoff delay (design §2.9.5): min(cap, 1 s × 2^n) ± 30 %. */
export function backoffDelay(attempt: number, random: () => number, capMs = 60_000): number {
  const base = Math.min(capMs, 1000 * 2 ** Math.min(attempt, 30));
  return Math.round(base * (0.7 + 0.6 * random()));
}

class FeedSubscription implements Subscription {
  closed = false;
  /** Cursor: `to` of the last batch persisted by the sink (or the subscribe() argument). */
  cursor: Seq | null;
  /** `to` of the last batch accepted from the current socket (contiguity check, design §2.9.2). */
  lastTo: Seq | null = null;
  readonly queue: Array<{ batch: ChangeBatch; gen: number }> = [];
  delivering = false;
  /** Last state reported, to avoid repeating the same onState. */
  reported: ConnectionState | null = null;

  constructor(readonly link: FeedLink, since: Seq | null, readonly sink: ChangeSink) {
    this.cursor = since;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.link.detach(this);
  }

  nudge(): void {
    if (!this.closed) this.link.nudge();
  }

  state(s: ConnectionState, detail?: string): void {
    if (this.closed) return;
    if (this.reported === s && detail === undefined) return;
    this.reported = s;
    try { this.sink.onState(s, detail); } catch { /* sink callbacks must not break the link */ }
  }

  error(e: RemoteError): void {
    if (this.closed) return;
    try { this.sink.onError(e); } catch { /* ignore */ }
  }
}

export class FeedLink {
  private ws: WsLike | null = null;
  private gen = 0;
  private phase: Phase = "idle";
  private rid = 0;
  private helloRid = -1;
  private helloSince: Seq | null = null;
  private welcome: WelcomeMsg | null = null;
  private connectedAt: number | null = null;
  private attempt = 0;
  private lastInbound = 0;
  private fatal: RemoteError | null = null;
  private stopError: RemoteError | null = null;
  private sub: FeedSubscription | null = null;
  private readonly queued: PendingCommit[] = [];
  private readonly inflight = new Map<number, PendingCommit>();
  private paused = false;
  private pauseTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private connectTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private pongTimer: TimerHandle | null = null;
  private limits: Pick<WelcomeLimits, "maxCommitOps" | "maxCommitBytes" | "maxInFlightCommits"> | null = null;
  /** Counters for tests and debugInfo. */
  readonly stats = { opens: 0, welcomes: 0, reconnects: 0, gaps: 0, pings: 0, acks: 0, batches: 0 };

  constructor(private readonly o: FeedOptions) {}

  // ---------------- public surface (used by the adapter) ----------------

  get state(): Phase {
    return this.phase;
  }

  /** True when a commit sent now goes over this socket. */
  get hasSubscription(): boolean {
    return this.sub !== null && !this.sub.closed;
  }

  subscribe(since: Seq | null, sink: ChangeSink): Subscription {
    // One feed per (device, vault): a newer subscribe replaces the older one (design §2.9.4).
    if (this.sub) this.sub.closed = true;
    const sub = new FeedSubscription(this, since, sink);
    this.sub = sub;
    if (this.phase === "stopped") this.stopError = null;
    if (this.ws && (this.phase === "parked" || this.phase === "catchup" || this.phase === "live")) {
      // design §2.9.2: after snapshotRequired the client sends a new hello on the same socket; a repeated
      // hello also resets the server's feed state for that socket.
      // Hold commits from now on until the new welcome (they must not go out under the old feed).
      this.phase = "opening";
      const gen = this.gen;
      void this.sendHello(gen);
    } else if (this.phase === "opening") {
      // The hello in flight may already carry the old cursor: resend once the socket is greeted.
      this.rehelloOnWelcome = true;
    } else {
      this.cancelReconnect();
      void this.open();
    }
    return sub;
  }

  private rehelloOnWelcome = false;

  /** Called by FeedSubscription.close(). */
  detach(sub: FeedSubscription): void {
    if (this.sub !== sub) return;
    this.sub = null;
    // Queued commits are answered on the socket that is still up; close it once nothing is pending.
    this.closeIfUnused();
  }

  nudge(): void {
    if (this.phase === "backoff") {
      this.cancelReconnect();
      void this.open();
    } else if (this.phase === "idle" && this.hasSubscription) {
      void this.open();
    } else if (this.phase === "catchup" || this.phase === "live" || this.phase === "parked") {
      this.ping();
    }
  }

  /** Fire-and-forget ack (design §2.12 `ack`). Returns false when no greeted socket could take it. */
  ack(upTo: Seq): boolean {
    if (!this.ws || !(this.phase === "catchup" || this.phase === "live")) return false;
    this.send({ type: "ack", upTo });
    this.stats.acks++;
    return true;
  }

  /**
   * Commit over the socket (design §2.9.1). Held while a connection attempt is in progress; rejected at
   * once (retryable) while waiting to reconnect, so nothing is held across a backoff.
   */
  commit(req: CommitRequest): Promise<CommitResponse> {
    return new Promise<CommitResponse>((resolve, reject) => {
      const lim = this.limits;
      if (lim) {
        const bytes = utf8Length(JSON.stringify({ type: "commit", rid: 2 ** 31, ...req }));
        const tooBig = checkCommitLimits(req, bytes, lim);
        if (tooBig) return reject(remoteError("TOO_LARGE", tooBig.message));
      }
      switch (this.phase) {
        case "parked": return reject(remoteError("SNAPSHOT_REQUIRED", "commit refused: the feed needs a snapshot bootstrap first"));
        case "stopped": return reject(this.stopError ?? remoteError("UNAVAILABLE", "link stopped"));
        case "backoff": case "idle": return reject(remoteError("NETWORK", "not connected; reconnecting"));
        default: break;
      }
      const p: PendingCommit = {
        req, rid: null, resolve, reject,
        timer: this.o.scheduler.setTimer(this.o.timeouts.commitMs, () => this.expire(p)),
      };
      this.queued.push(p);
      this.flushCommits();
    });
  }

  /** Close the socket and stop reconnecting. Pending commits are rejected (retryable). */
  async close(): Promise<void> {
    if (this.sub) { this.sub.closed = true; this.sub = null; }
    this.cancelReconnect();
    const ws = this.ws;
    this.abandonSocket();
    this.failPending(remoteError("NETWORK", "adapter closed"));
    this.phase = "idle";
    if (ws) {
      try { ws.send(JSON.stringify({ type: "bye" })); } catch { /* closing anyway */ }
      try { ws.close(CloseCode.NORMAL, "bye"); } catch { /* already closed */ }
    }
  }

  // ---------------- connection lifecycle ----------------

  private async open(): Promise<void> {
    if (this.ws || this.phase === "opening") return;
    this.phase = "opening";
    this.welcome = null;
    this.fatal = null;
    this.stats.opens++;
    const gen = ++this.gen;
    this.sub?.state("connecting");
    let url: string;
    try {
      url = await this.o.wsUrl();
    } catch (e) {
      if (gen !== this.gen) return;
      this.attemptFailed(networkError(e, "connect"), "backoff");
      return;
    }
    if (gen !== this.gen) return;
    let ws: WsLike;
    try {
      ws = this.o.ws(url, [WS_SUBPROTOCOL]);
    } catch (e) {
      this.attemptFailed(networkError(e, "websocket"), "backoff");
      return;
    }
    this.ws = ws;
    this.connectTimer = this.o.scheduler.setTimer(this.o.timeouts.connectMs, () => {
      if (gen !== this.gen || this.welcome) return;
      this.abandon(remoteError("TIMEOUT", "no welcome within the connect timeout"), "backoff", true);
    });
    ws.onopen = () => {
      if (gen !== this.gen) return;
      // design §2.9: subprotocol not echoed → the client closes 4400.
      if (ws.protocol !== WS_SUBPROTOCOL) {
        this.abandon(remoteError("PROTOCOL", `server did not accept subprotocol ${WS_SUBPROTOCOL}`), "backoff", true, CloseCode.PROTOCOL);
        return;
      }
      void this.sendHello(gen);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const raw: unknown = ev.data;
      const text = typeof raw === "string" ? raw : decodeFrame(raw);
      if (text === null) {
        this.abandon(remoteError("PROTOCOL", "binary frame from server"), "backoff", false);
        return;
      }
      this.onText(text, gen);
    };
    ws.onerror = () => { /* the close event follows */ };
    ws.onclose = (ev) => {
      if (gen !== this.gen) return;
      this.onSocketClosed(ev.code, ev.reason ?? "");
    };
  }

  private async sendHello(gen: number): Promise<void> {
    let token: string;
    let ctx: HelloContext;
    try {
      [token, ctx] = await Promise.all([this.o.token(), this.o.hello()]);
    } catch (e) {
      if (gen !== this.gen) return;
      const err = networkError(e, "hello");
      if (err.code === "UNAUTHENTICATED") return this.stop(err, "auth-error");
      this.abandon(err, "backoff", true);
      return;
    }
    if (gen !== this.gen || !this.ws) return;
    const sub = this.sub && !this.sub.closed ? this.sub : null;
    // Without a subscription the hello has no cursor: the server greets and parks the socket (no feed).
    const since = sub ? sub.cursor : null;
    this.helloRid = ++this.rid;
    this.helloSince = since;
    this.rehelloOnWelcome = false;
    if (this.phase !== "opening") this.phase = "opening";
    this.send({
      type: "hello", rid: this.helloRid, proto: PROTO_VERSION, token, vaultId: this.o.vaultId,
      since, epoch: ctx.epoch, seenMaxSeq: ctx.seenMaxSeq, rollbackAck: ctx.rollbackAck,
      client: this.o.client, window: { maxUnackedBytes: this.o.maxUnackedBytes ?? MAX_UNACKED_BYTES },
    });
  }

  private onText(text: string, gen: number): void {
    this.lastInbound = this.o.clock.monotonic();
    const parsed = parseServerFrame(text, MAX_WS_FRAME + 1024);
    if (!parsed.ok) {
      this.abandon(remoteError("PROTOCOL", `bad frame from server at ${parsed.path}: ${parsed.reason}`), "backoff", false);
      return;
    }
    const m: ServerMessage = parsed.value;
    switch (m.type) {
      case "welcome": return this.onWelcome(m, gen);
      case "changes": return this.onChanges(m, gen);
      case "commitResult": {
        const p = this.inflight.get(m.rid);
        if (!p) return;
        this.inflight.delete(m.rid);
        this.o.scheduler.clearTimer(p.timer);
        p.resolve({ cid: m.cid, headSeq: m.headSeq, replayed: m.replayed, results: m.results });
        this.flushCommits();
        this.closeIfUnused();
        return;
      }
      case "snapshotRequired": {
        // Only the answer to the current hello, or a server-initiated park (rid null), counts.
        if (m.rid !== null && m.rid !== this.helloRid) return;
        if (this.rehelloOnWelcome) return; // a newer hello is about to replace this one
        this.phase = "parked";
        for (const p of this.queued.splice(0)) this.settle(p, remoteError("SNAPSHOT_REQUIRED", `snapshot required (${m.reason})`));
        const sub = this.sub && !this.sub.closed ? this.sub : null;
        if (sub) {
          sub.queue.length = 0;
          sub.state("connected", "snapshot required");
          try {
            sub.sink.onSnapshotRequired({ reason: m.reason, minSeq: m.minSeq, epoch: m.epoch, rollbackAt: m.rollbackAt });
          } catch { /* sink callbacks must not break the link */ }
        }
        return;
      }
      case "vaultInfoChanged":
        this.o.onVaultInfoChanged(m.etag);
        if (this.sub && !this.sub.closed) { try { this.sub.sink.onVaultInfoChanged(m.etag); } catch { /* ignore */ } }
        return;
      case "pause": {
        this.paused = true;
        if (this.pauseTimer !== null) this.o.scheduler.clearTimer(this.pauseTimer);
        this.pauseTimer = this.o.scheduler.setTimer(Math.max(0, m.retryAfterMs), () => { this.pauseTimer = null; this.resume(); });
        this.sub?.state("paused", m.reason);
        return;
      }
      case "resume": return this.resume();
      case "pong": return;
      case "error": return this.onErrorFrame(m.rid, remoteErrorFromWire({
        code: m.code, ...(m.message !== undefined ? { message: m.message } : {}),
        ...(m.retryAfterMs !== undefined && m.retryAfterMs !== null ? { retryAfterMs: m.retryAfterMs } : {}),
      }), m.fatal);
    }
  }

  private onWelcome(w: WelcomeMsg, gen: number): void {
    if (w.rid !== this.helloRid) return; // greeting for an older hello on this socket
    if (this.connectTimer !== null) { this.o.scheduler.clearTimer(this.connectTimer); this.connectTimer = null; }
    const first = this.welcome === null;
    this.welcome = w;
    this.limits = { maxCommitOps: w.limits.maxCommitOps, maxCommitBytes: w.limits.maxCommitBytes, maxInFlightCommits: w.limits.maxInFlightCommits };
    if (first) { this.connectedAt = this.o.clock.monotonic(); this.stats.welcomes++; }
    this.o.onWelcome(w);
    this.startHeartbeat(gen, w.heartbeatSec > 0 ? w.heartbeatSec : HEARTBEAT_SEC);
    const sub = this.sub && !this.sub.closed ? this.sub : null;
    if (this.rehelloOnWelcome) {
      void this.sendHello(gen);
      return;
    }
    if (sub && this.helloSince !== null) {
      this.phase = "catchup";
      sub.lastTo = this.helloSince;
      sub.queue.length = 0;
      sub.state("connected");
      sub.state("catching-up");
    } else {
      // since:null → the server answers snapshotRequired{no-cursor} and keeps the socket parked.
      this.phase = "parked";
      sub?.state("connected");
    }
    this.flushCommits();
  }

  private onChanges(m: ChangesMsg, gen: number): void {
    if (m.rid !== null) return; // pull replies: the adapter pulls over REST, nothing to match here
    const sub = this.sub;
    if (!sub || sub.closed || !(this.phase === "catchup" || this.phase === "live")) return;
    if (m.from !== sub.lastTo) {
      // design §2.9.2: batches are contiguous. A gap is a server or proxy bug; resuming from the
      // persisted cursor re-reads everything after it, so nothing is skipped.
      this.stats.gaps++;
      sub.error(remoteError("PROTOCOL", `changes gap: expected from=${sub.lastTo}, got ${m.from}`));
      this.abandon(null, "jitter", false);
      return;
    }
    sub.lastTo = m.to;
    const batch: ChangeBatch = { from: m.from, to: m.to, headSeq: m.headSeq, minSeq: m.minSeq, records: m.records, more: m.more, live: m.live };
    sub.queue.push({ batch, gen });
    void this.deliver(sub);
  }

  /** Serial delivery: one onChanges at a time, ack after it resolves. */
  private async deliver(sub: FeedSubscription): Promise<void> {
    if (sub.delivering) return;
    sub.delivering = true;
    try {
      while (!sub.closed && sub.queue.length > 0) {
        const { batch, gen } = sub.queue.shift()!;
        try {
          await sub.sink.onChanges(batch);
        } catch (e) {
          // Not persisted: no ack, and the feed restarts from the persisted cursor after a backoff.
          if (sub.closed || this.sub !== sub) return;
          sub.queue.length = 0;
          sub.state("offline", `change sink failed: ${errText(e)}`);
          if (gen === this.gen) this.abandon(null, "backoff", false);
          return;
        }
        if (sub.cursor === null || batch.to > sub.cursor) sub.cursor = batch.to;
        this.stats.batches++;
        this.o.onPersisted(batch);
        if (sub.closed || this.sub !== sub) return;
        if (gen === this.gen && this.ws) {
          this.ack(batch.to);
          if (!batch.live && !batch.more && this.phase === "catchup") {
            this.phase = "live";
            sub.state("live");
          }
        }
      }
    } finally {
      sub.delivering = false;
    }
  }

  private onErrorFrame(rid: number | null, err: RemoteError, fatal: boolean): void {
    if (rid !== null) {
      const p = this.inflight.get(rid);
      if (p) {
        this.inflight.delete(rid);
        this.settle(p, err);
        this.flushCommits();
        this.closeIfUnused();
      }
    }
    if (fatal) {
      this.fatal = err; // the close that follows decides what to do
      return;
    }
    if (rid === null || rid === this.helloRid) this.sub?.error(err);
  }

  private onSocketClosed(code: number, reason: string): void {
    const action = closeAction(code, reason, this.fatal);
    this.abandonSocket();
    this.handleDrop(action, this.fatal ?? remoteError("NETWORK", `connection closed (${code}${reason ? ` ${reason}` : ""})`));
  }

  /**
   * Give up on the current socket now (heartbeat timeout, protocol error, gap). Does not wait for the
   * close event, which on a dead TCP connection may take minutes.
   */
  private abandon(err: RemoteError | null, delay: "backoff" | "jitter", endpointFailed: boolean, closeCode: number = CloseCode.NORMAL): void {
    const ws = this.ws;
    const beforeWelcome = this.welcome === null;
    this.abandonSocket();
    if (ws) { try { ws.close(closeCode, "client reconnect"); } catch { /* ignore */ } }
    if (err && err.code === "PROTOCOL") this.sub?.error(err);
    if (endpointFailed || beforeWelcome) this.o.onEndpointFailed();
    this.handleDrop({ kind: "reconnect", delay }, err ?? remoteError("NETWORK", "connection dropped"));
  }

  private attemptFailed(err: RemoteError, delay: "backoff"): void {
    this.abandonSocket();
    this.o.onEndpointFailed();
    if (err.code === "UNSUPPORTED") this.sub?.error(err);
    this.handleDrop({ kind: "reconnect", delay }, err);
  }

  /** Detach handlers and timers of the current socket; later events from it are ignored. */
  private abandonSocket(): void {
    this.gen++;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; }
    for (const t of [this.connectTimer, this.heartbeatTimer, this.pongTimer, this.pauseTimer]) if (t !== null) this.o.scheduler.clearTimer(t);
    this.connectTimer = this.heartbeatTimer = this.pongTimer = this.pauseTimer = null;
    this.paused = false;
    if (this.connectedAt !== null && this.o.clock.monotonic() - this.connectedAt >= this.o.timeouts.stableMs) this.attempt = 0;
    this.connectedAt = null;
    this.welcome = null;
    if (this.sub) { this.sub.queue.length = 0; this.sub.lastTo = null; }
  }

  private handleDrop(action: CloseAction, err: RemoteError): void {
    if (action.kind === "stop") return this.stop(action.error, action.state);
    // design §2.9.5: unanswered commits are resent by the engine with the same cid.
    this.failPending(err.retryable ? err : remoteError("NETWORK", err.message));
    const sub = this.sub && !this.sub.closed ? this.sub : null;
    if (!sub) { this.phase = "idle"; return; }
    sub.state("offline", err.message);
    let ms: number;
    if (action.delay === "jitter") ms = Math.round(this.o.random() * 1000);
    else if (action.delay === "restart") ms = 2000 + Math.round(this.o.random() * 3000);
    else ms = backoffDelay(this.attempt++, this.o.random, this.o.timeouts.maxBackoffMs);
    this.phase = "backoff";
    this.stats.reconnects++;
    this.reconnectTimer = this.o.scheduler.setTimer(ms, () => {
      this.reconnectTimer = null;
      if (this.phase === "backoff") { this.phase = "idle"; void this.open(); }
    });
  }

  private stop(err: RemoteError, state: "auth-error" | "offline"): void {
    this.cancelReconnect();
    this.abandonSocket();
    this.failPending(err);
    this.phase = "stopped";
    this.stopError = err;
    const sub = this.sub && !this.sub.closed ? this.sub : null;
    if (sub) {
      sub.state(state, err.message);
      sub.error(err);
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) { this.o.scheduler.clearTimer(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.phase === "backoff") this.phase = "idle";
  }

  private closeIfUnused(): void {
    if (this.hasSubscription || this.queued.length > 0 || this.inflight.size > 0) return;
    if (!this.ws && this.phase !== "opening") {
      if (this.phase !== "stopped") { this.cancelReconnect(); this.phase = "idle"; }
      return;
    }
    const ws = this.ws;
    this.abandonSocket();
    this.phase = "idle";
    if (ws) { try { ws.send(JSON.stringify({ type: "bye" })); ws.close(CloseCode.NORMAL, "bye"); } catch { /* ignore */ } }
  }

  // ---------------- heartbeat (design §2.9.4) ----------------

  private startHeartbeat(gen: number, sec: number): void {
    if (this.heartbeatTimer !== null) this.o.scheduler.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.o.scheduler.setTimer(sec * 1000, () => {
      this.heartbeatTimer = null;
      if (gen !== this.gen) return;
      this.ping();
      this.startHeartbeat(gen, sec);
    });
  }

  private ping(): void {
    if (!this.ws || this.pongTimer !== null) return;
    const gen = this.gen;
    const sentAt = this.o.clock.monotonic();
    this.send({ type: "ping", rid: ++this.rid, ts: this.o.clock.now() });
    this.stats.pings++;
    this.pongTimer = this.o.scheduler.setTimer(this.o.timeouts.pongMs, () => {
      this.pongTimer = null;
      if (gen !== this.gen) return;
      // Any inbound frame counts (design §2.9.4: "no pong (or any frame) within 10 s").
      if (this.lastInbound < sentAt) this.abandon(remoteError("TIMEOUT", "no answer to ping"), "backoff", false);
    });
  }

  // ---------------- commits ----------------

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.pauseTimer !== null) { this.o.scheduler.clearTimer(this.pauseTimer); this.pauseTimer = null; }
    if (this.phase === "live") this.sub?.state("live");
    else if (this.phase === "catchup") this.sub?.state("catching-up");
    this.flushCommits();
  }

  private flushCommits(): void {
    if (!this.ws || this.paused) return;
    if (this.phase === "parked") {
      for (const p of this.queued.splice(0)) this.settle(p, remoteError("SNAPSHOT_REQUIRED", "commit refused: the feed needs a snapshot bootstrap first"));
      return;
    }
    if (!(this.phase === "catchup" || this.phase === "live")) return;
    const max = Math.max(1, this.limits?.maxInFlightCommits ?? 4);
    while (this.queued.length > 0 && this.inflight.size < max) {
      const p = this.queued.shift()!;
      p.rid = ++this.rid;
      this.inflight.set(p.rid, p);
      this.send({ type: "commit", rid: p.rid, cid: p.req.cid, ops: p.req.ops, ...(p.req.atomic !== undefined ? { atomic: p.req.atomic } : {}) });
    }
  }

  private expire(p: PendingCommit): void {
    const qi = this.queued.indexOf(p);
    if (qi >= 0) this.queued.splice(qi, 1);
    if (p.rid !== null && this.inflight.get(p.rid) === p) this.inflight.delete(p.rid);
    p.reject(remoteError("TIMEOUT", `no commitResult for ${p.req.cid} within ${this.o.timeouts.commitMs} ms`));
    this.flushCommits();
  }

  private settle(p: PendingCommit, err: RemoteError): void {
    this.o.scheduler.clearTimer(p.timer);
    p.reject(err);
  }

  private failPending(err: RemoteError): void {
    const all = [...this.queued.splice(0), ...this.inflight.values()];
    this.inflight.clear();
    for (const p of all) this.settle(p, err);
  }

  private send(m: ClientMessage): void {
    const ws = this.ws;
    if (!ws) return;
    try { ws.send(JSON.stringify(m)); } catch { /* close event follows */ }
  }
}

function decodeFrame(data: unknown): string | null {
  // `ws` hands text frames to `onmessage` as Buffer when used through its EventTarget shim in some modes.
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return null;
}
