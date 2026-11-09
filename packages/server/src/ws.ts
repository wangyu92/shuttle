// WebSocket protocol (design §2.9): hello/welcome, commit, changes push (catch-up then live), pull,
// ack-gated backpressure, heartbeat, supersede, snapshotRequired. AGPL-3.0-only.
import type { WebSocket } from "ws";
import {
  CloseCode, HEARTBEAT_SEC, LIVE_MAX_BYTES, LIVE_MAX_RECORDS, MAX_WS_FRAME, PROTO_VERSION, SUPPORTED_PROTOCOLS,
  checkCommitLimits, isCid, parseClientFrame,
} from "@shuttle/protocol";
import type {
  ChangesMsg, ClientMessage, CommitMsg, ErrorMsg, HelloMsg, PullMsg, SnapshotReason, SnapshotRequiredMsg,
  VersionRecord, WelcomeMsg,
} from "@shuttle/protocol";
import type { Server } from "./server-core";
import { CommitProtocolError, recordBytes } from "./store";
import { HttpError, errText } from "./util";

const CATCHUP_PAGE = 1000;
const BUFFERED_HIGH = 4 * 1024 * 1024; // design §2.9.4: stop sending above 4 MiB ws.bufferedAmount

type ConnState = "new" | "parked" | "catchup" | "live" | "closed";

export class Conn {
  state: ConnState = "new";
  deviceId: string | null = null;
  userId: string | null = null;
  vaultId: string | null = null;
  private parkedReason: SnapshotReason | null = null;
  /** Vault epoch this connection's hello was accepted for. */
  private epoch = 0;
  private lastTo = 0;
  private window = 8 * 1024 * 1024;
  private unacked = 0;
  private sent: Array<{ to: number; bytes: number }> = [];
  liveBuf: VersionRecord[] = [];
  private pumpScheduled = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null;
  lastInbound: number;

  constructor(readonly ws: WebSocket, private readonly srv: Server, readonly ip: string) {
    this.lastInbound = Date.now();
    this.helloTimer = setTimeout(() => {
      if (this.state === "new") this.close(CloseCode.TIMEOUT, "hello timeout");
    }, srv.cfg.helloTimeoutMs);
    ws.on("message", (data, isBinary) => {
      this.lastInbound = Date.now();
      try {
        if (isBinary) return this.fatal(null, "PROTOCOL", "binary frames are not allowed", CloseCode.PROTOCOL);
        this.onText(String(data));
      } catch (e) {
        srv.cfg.log(`ws handler error: ${errText(e)}`);
        this.fatal(null, "SERVER", "internal error", CloseCode.INTERNAL);
      }
    });
    ws.on("pong", () => { this.lastInbound = Date.now(); });
    ws.on("close", () => this.onClosed());
    ws.on("error", () => { /* close follows */ });
  }

  // ---------------- framing ----------------

  send(msg: object): number {
    if (this.ws.readyState !== this.ws.OPEN) return 0;
    const text = JSON.stringify(msg);
    this.ws.send(text);
    return Buffer.byteLength(text);
  }

  private error(rid: number | null, code: string, message: string, retryAfterMs: number | null = null): void {
    const e: ErrorMsg = { type: "error", rid, code, message, fatal: false, retryAfterMs };
    this.send(e);
  }

  fatal(rid: number | null, code: string, message: string, close: number): void {
    const e: ErrorMsg = { type: "error", rid, code, message, fatal: true, retryAfterMs: null };
    this.send(e);
    this.close(close, code);
  }

  close(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.detach();
    try { this.ws.close(code, reason.slice(0, 120)); } catch { this.ws.terminate(); }
  }

  private detach(): void {
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.srv.hub.forget(this);
    this.state = "closed";
  }

  private onClosed(): void {
    if (this.state !== "closed") this.detach();
    this.srv.hub.conns.delete(this);
  }

  // ---------------- inbound ----------------

  private onText(text: string): void {
    const parsed = parseClientFrame(text, MAX_WS_FRAME);
    if (!parsed.ok) {
      // A commit whose envelope is fine but whose ops are malformed is a message-level INVALID (§2.9.3);
      // anything else is a protocol error.
      const env = commitEnvelope(text);
      if (env && this.state !== "new") return this.error(env.rid, "INVALID", `invalid commit at ${parsed.path}: ${parsed.reason}`);
      return this.fatal(env?.rid ?? null, "PROTOCOL", `bad frame at ${parsed.path}: ${parsed.reason}`, CloseCode.PROTOCOL);
    }
    const msg: ClientMessage = parsed.value;
    if (msg.type === "hello") return this.onHello(msg);
    if (msg.type === "ping") {
      this.send({ type: "pong", rid: msg.rid, ts: msg.ts, serverTime: this.srv.cfg.now() });
      return;
    }
    if (msg.type === "bye") return this.close(CloseCode.NORMAL, "bye");
    if (this.state === "new") return this.fatal("rid" in msg ? msg.rid : null, "PROTOCOL", "hello required first", CloseCode.PROTOCOL);
    switch (msg.type) {
      case "commit": return this.onCommit(msg, Buffer.byteLength(text));
      case "ack": return this.onAck(msg.upTo);
      case "pull": return this.onPull(msg);
    }
  }

  private onHello(h: HelloMsg): void {
    const srv = this.srv;
    if (!SUPPORTED_PROTOCOLS.includes(h.proto)) return this.fatal(h.rid, "PROTOCOL", `unsupported proto ${h.proto}`, CloseCode.PROTOCOL);
    const auth = srv.authToken(h.token, this.ip);
    if (!auth.ok) {
      return this.fatal(h.rid, auth.code, auth.code === "REVOKED" ? "this device was removed" : "not logged in",
        auth.code === "REVOKED" ? CloseCode.FORBIDDEN : CloseCode.UNAUTHENTICATED);
    }
    if (this.deviceId !== null && (this.deviceId !== auth.device.device_id || this.vaultId !== h.vaultId)) {
      return this.fatal(h.rid, "PROTOCOL", "a repeated hello must use the same device and vault", CloseCode.PROTOCOL);
    }
    let v = srv.store.vault(h.vaultId);
    if (!v) return this.fatal(h.rid, "VAULT_NOT_FOUND", "vault not found", CloseCode.VAULT_NOT_FOUND);
    if (srv.store.memberRole(v.vault_id, auth.device.user_id) === null) {
      return this.fatal(h.rid, "FORBIDDEN", "not a member of this vault", CloseCode.FORBIDDEN);
    }
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    // Re-hello on the same socket (after snapshotRequired) resets the feed completely.
    srv.hub.forget(this);
    this.liveBuf = [];
    this.sent = [];
    this.unacked = 0;
    this.parkedReason = null;
    this.deviceId = auth.device.device_id;
    this.userId = auth.device.user_id;
    this.vaultId = v.vault_id;
    this.window = h.window.maxUnackedBytes;
    srv.touchDevice(auth.device.device_id, this.ip, h.client.version);
    srv.hub.claim(this); // one socket per (device, vault): the older one closes 4409

    // design §2.6.1: a device that has seen seqs above the head means a restore that also restored hwm.json.
    const seen = Math.max(h.seenMaxSeq ?? 0, h.since ?? 0);
    if (seen > v.head_seq && srv.store.raiseHeadForSeen(v.vault_id, seen)) {
      srv.cfg.log("hello: device has seen seqs above the head; head raised, rollback rule on");
      srv.hwm.mark(v.vault_id);
      v = srv.store.vault(v.vault_id)!;
    }
    if (h.rollbackAck !== null && v.rollback_at !== null && h.rollbackAck === v.rollback_at) {
      srv.store.setRollbackAck(v.vault_id, this.deviceId, v.rollback_at, h.since ?? 0);
    }
    const info = srv.store.infoOf(v);
    const welcome: WelcomeMsg = {
      type: "welcome", rid: h.rid, proto: PROTO_VERSION, server: srv.version, deviceId: this.deviceId, epoch: v.epoch,
      headSeq: v.head_seq, minSeq: v.min_seq, infoEtag: v.info_etag, retention: info.retention, limits: srv.cfg.limits,
      heartbeatSec: HEARTBEAT_SEC, idleTimeoutSec: srv.cfg.idleTimeoutSec, serverTime: srv.cfg.now(),
    };
    this.send(welcome);

    // design §2.9.6 step 1.
    let reason: SnapshotReason | null = null;
    if (h.since === null) reason = "no-cursor";
    else if (h.epoch !== v.epoch) reason = "epoch";
    else if (h.since < v.min_seq) reason = "cursor-too-old";
    else if (v.rollback_at !== null && v.restored_seq !== null && h.since > v.restored_seq && h.rollbackAck !== v.rollback_at
      && srv.store.rollbackAckOf(v.vault_id, this.deviceId) !== v.rollback_at) reason = "rollback";
    if (reason) return this.park(reason, h.rid);
    this.epoch = v.epoch;
    this.state = "catchup";
    this.lastTo = h.since!;
    this.schedulePump();
  }

  /** Stop the feed and tell the client to bootstrap; the socket stays open for a new hello. */
  park(reason: SnapshotReason, rid: number | null): void {
    const v = this.srv.store.vaultAny(this.vaultId!);
    this.srv.hub.removeLive(this);
    this.liveBuf = [];
    this.state = "parked";
    this.parkedReason = reason;
    const m: SnapshotRequiredMsg = {
      type: "snapshotRequired", rid, reason, minSeq: v?.min_seq ?? 0, epoch: v?.epoch ?? 1,
      rollbackAt: reason === "rollback" ? v?.rollback_at ?? null : null,
    };
    this.send(m);
  }

  private onCommit(msg: CommitMsg, frameBytes: number): void {
    const srv = this.srv;
    if (this.state === "parked") return this.error(msg.rid, "SNAPSHOT_REQUIRED", `snapshot required (${this.parkedReason})`);
    const wait = srv.commitBuckets.take(this.deviceId!);
    if (wait > 0) return this.error(msg.rid, "RATE_LIMITED", "too many commits", wait);
    const lim = checkCommitLimits(msg, frameBytes, srv.cfg.limits);
    if (lim) return this.error(msg.rid, lim.code, lim.message);
    if (!srv.store.vault(this.vaultId!)) return this.fatal(msg.rid, "VAULT_NOT_FOUND", "vault not found", CloseCode.VAULT_NOT_FOUND);
    if (srv.deviceRevoked(this.deviceId!)) return this.fatal(msg.rid, "REVOKED", "this device was removed", CloseCode.FORBIDDEN);
    const req = { cid: msg.cid, ops: msg.ops, ...(msg.atomic !== undefined ? { atomic: msg.atomic } : {}) };
    srv.enqueueCommit(this.vaultId!, this.deviceId!, req, this.epoch, (out) => {
      if (this.state === "closed") return;
      if (out instanceof CommitProtocolError) return this.fatal(msg.rid, "PROTOCOL", out.message, CloseCode.PROTOCOL);
      if (out instanceof HttpError) {
        if (out.code === "VAULT_NOT_FOUND") return this.fatal(msg.rid, out.code, out.message, CloseCode.VAULT_NOT_FOUND);
        return this.error(msg.rid, out.code, out.message);
      }
      if (out instanceof Error) {
        srv.cfg.log(`commit failed: ${errText(out)}`);
        return this.error(msg.rid, "SERVER", "internal error", 1000);
      }
      // commitResult goes out before the (coalesced) changes frame carrying the same seqs (§2.9.2).
      this.send({ type: "commitResult", rid: msg.rid, ...out.response });
    });
  }

  private onAck(upTo: number): void {
    if (this.state === "parked") return;
    const acked = Math.min(upTo, this.lastTo);
    while (this.sent.length > 0 && this.sent[0]!.to <= acked) this.unacked -= this.sent.shift()!.bytes;
    if (this.unacked < 0) this.unacked = 0;
    if (acked > 0) this.srv.store.ackCursor(this.vaultId!, this.deviceId!, acked);
    if (this.state === "catchup") this.schedulePump();
  }

  private onPull(msg: PullMsg): void {
    const srv = this.srv;
    if (this.state === "parked") return this.park(this.parkedReason!, msg.rid);
    const v = srv.store.vault(this.vaultId!);
    if (!v) return this.fatal(msg.rid, "VAULT_NOT_FOUND", "vault not found", CloseCode.VAULT_NOT_FOUND);
    if (msg.since < v.min_seq) {
      const m: SnapshotRequiredMsg = { type: "snapshotRequired", rid: msg.rid, reason: "cursor-too-old", minSeq: v.min_seq, epoch: v.epoch, rollbackAt: null };
      this.send(m);
      return;
    }
    const limit = Math.min(msg.limit ?? CATCHUP_PAGE, CATCHUP_PAGE);
    const page = srv.store.headsSince(v.vault_id, msg.since, limit, LIVE_MAX_BYTES);
    const to = page.full ? page.lastSeq! : Math.max(v.head_seq, msg.since);
    const m: ChangesMsg = {
      type: "changes", rid: msg.rid, from: msg.since, to, headSeq: Math.max(v.head_seq, to), minSeq: v.min_seq, live: false, more: page.full,
      records: page.records,
    };
    this.send(m);
  }

  // ---------------- outbound feed ----------------

  private blocked(): boolean {
    return this.unacked > this.window || this.ws.bufferedAmount > BUFFERED_HIGH;
  }

  private sendChanges(from: number, to: number, records: VersionRecord[], more: boolean, live: boolean, headSeq: number, minSeq: number): void {
    const m: ChangesMsg = { type: "changes", rid: null, from, to, headSeq, minSeq, live, more, records };
    const bytes = this.send(m);
    this.lastTo = to;
    this.unacked += bytes;
    this.sent.push({ to, bytes });
  }

  schedulePump(): void {
    if (this.pumpScheduled || this.state !== "catchup") return;
    this.pumpScheduled = true;
    setImmediate(() => { this.pumpScheduled = false; this.pump(); });
  }

  private waitUnblock(): void {
    // Acks resume via onAck; a full socket buffer has no event in `ws`, so poll it.
    if (this.ws.bufferedAmount > BUFFERED_HIGH && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.schedulePump(); }, 50);
    }
  }

  /** One catch-up page per tick (design §2.9.6 steps 2-3). Resume point is the last `to` sent. */
  private pump(): void {
    if (this.state !== "catchup") return;
    if (this.blocked()) return this.waitUnblock();
    const st = this.srv.store;
    const v = st.vault(this.vaultId!);
    if (!v) return this.fatal(null, "VAULT_NOT_FOUND", "vault not found", CloseCode.VAULT_NOT_FOUND);
    if (this.lastTo < v.min_seq) return this.park("cursor-too-old", null);
    const page = st.headsSince(v.vault_id, this.lastTo, CATCHUP_PAGE, LIVE_MAX_BYTES);
    if (page.full) {
      this.sendChanges(this.lastTo, page.lastSeq!, page.records, true, false, v.head_seq, v.min_seq);
      this.schedulePump();
      return;
    }
    // Same synchronous tick: read H, send the last page, join the live set. No commit can land between.
    this.sendChanges(this.lastTo, Math.max(v.head_seq, this.lastTo), page.records, false, false, Math.max(v.head_seq, this.lastTo), v.min_seq);
    this.state = "live";
    this.liveBuf = [];
    this.srv.hub.addLive(this);
  }

  /** Live flush (design §2.9.6 step 4): ≤ 500 records or 1 MiB per frame, `to` of the last = head. */
  flushLive(): void {
    if (this.state !== "live") return;
    const v = this.srv.store.vault(this.vaultId!);
    if (!v) return;
    const head = v.head_seq;
    if (this.liveBuf.length === 0 && head <= this.lastTo) return;
    const recs = this.liveBuf.filter((r) => r.seq > this.lastTo);
    this.liveBuf = [];
    let i = 0;
    do {
      if (this.blocked()) {
        // Slow consumer: drop the buffer, keep the target cursor, resume later with a coalesced DB read.
        this.state = "catchup";
        this.srv.hub.removeLive(this);
        this.waitUnblock();
        return;
      }
      const chunk: VersionRecord[] = [];
      let bytes = 0;
      while (i < recs.length && chunk.length < LIVE_MAX_RECORDS) {
        const n = recordBytes(recs[i]!);
        if (chunk.length > 0 && bytes + n > LIVE_MAX_BYTES) break;
        chunk.push(recs[i]!);
        bytes += n;
        i++;
      }
      const last = i >= recs.length;
      this.sendChanges(this.lastTo, last ? head : chunk[chunk.length - 1]!.seq, chunk, !last, true, head, v.min_seq);
    } while (i < recs.length);
  }

  get greeted(): boolean { return this.deviceId !== null && this.state !== "closed"; }
}

/** Minimal envelope check for a commit frame that failed full validation. */
function commitEnvelope(text: string): { rid: number } | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o && typeof o === "object" && o.type === "commit" && Number.isSafeInteger(o.rid) && (o.rid as number) > 0 && isCid(o.cid) && Array.isArray(o.ops)) {
      return { rid: o.rid as number };
    }
  } catch { /* not JSON */ }
  return null;
}

/** Live sets, device claims, coalescing timers. */
export class Hub {
  readonly conns = new Set<Conn>();
  private live = new Map<string, Set<Conn>>();
  private claims = new Map<string, Conn>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private waiters = new Map<string, Set<() => void>>();

  constructor(private readonly coalesceMs: number) {}

  claim(c: Conn): void {
    const key = `${c.vaultId}\u0000${c.deviceId}`;
    const prev = this.claims.get(key);
    this.claims.set(key, c);
    if (prev && prev !== c) prev.close(CloseCode.SUPERSEDED, "superseded");
  }

  forget(c: Conn): void {
    this.removeLive(c);
    if (c.vaultId && c.deviceId) {
      const key = `${c.vaultId}\u0000${c.deviceId}`;
      if (this.claims.get(key) === c) this.claims.delete(key);
    }
  }

  addLive(c: Conn): void {
    let set = this.live.get(c.vaultId!);
    if (!set) { set = new Set(); this.live.set(c.vaultId!, set); }
    set.add(c);
  }

  removeLive(c: Conn): void {
    if (c.vaultId) this.live.get(c.vaultId)?.delete(c);
  }

  /** After a commit: append records to every live connection and schedule one coalesced flush. */
  onCommit(vid: string, applied: VersionRecord[]): void {
    const set = this.live.get(vid);
    if (set && set.size > 0 && applied.length > 0) {
      for (const c of set) c.liveBuf.push(...applied);
      if (!this.flushTimers.has(vid)) {
        this.flushTimers.set(vid, setTimeout(() => {
          this.flushTimers.delete(vid);
          for (const c of [...(this.live.get(vid) ?? [])]) c.flushLive();
        }, this.coalesceMs));
      }
    }
    this.wake(vid);
  }

  /** Long-poll waiters (GET /changes?wait=…). */
  waitFor(vid: string, fn: () => void): () => void {
    let set = this.waiters.get(vid);
    if (!set) { set = new Set(); this.waiters.set(vid, set); }
    set.add(fn);
    return () => { this.waiters.get(vid)?.delete(fn); };
  }

  wake(vid: string): void {
    const set = this.waiters.get(vid);
    if (!set) return;
    this.waiters.delete(vid);
    for (const fn of set) fn();
  }

  ofVault(vid: string): Conn[] {
    return [...this.conns].filter((c) => c.vaultId === vid && c.greeted);
  }

  ofDevice(deviceId: string): Conn[] {
    return [...this.conns].filter((c) => c.deviceId === deviceId && c.greeted);
  }

  broadcast(vid: string, msg: object): void {
    for (const c of this.ofVault(vid)) c.send(msg);
  }

  stop(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    for (const set of this.waiters.values()) for (const fn of set) fn();
    this.waiters.clear();
  }
}
