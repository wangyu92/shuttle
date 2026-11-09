// FeedLink and ServerAdapter socket behaviour against a scripted WebSocket on a fake clock:
// catch-up then live, ack gating, resume cursor, reconnect backoff and close codes, heartbeat,
// commits (window, pause, drop, errors), re-hello after snapshotRequired, URL fallback.
import { describe, expect, it } from "vitest";
import { isRemoteError } from "@shuttle/protocol";
import type { CommitRequest } from "@shuttle/protocol";
import { TestIds } from "@shuttle/testkit";
import { backoffDelay } from "../src/index";
import { DEV, RecSink, changes, harness, memState, welcome, type Harness } from "./fakes";

const ids = new TestIds("feed");
const req = (): CommitRequest => ({ cid: ids.cid(), ops: [ids.put()] });

/** subscribe(since) and answer the hello with welcome. Returns the hello frame. */
async function greet(h: Harness, sink: RecSink, since: number | null = 5, w: Parameters<typeof welcome>[1] = {}) {
  const sub = h.adapter.subscribe(since, sink);
  await h.settle();
  const hello = h.pool.current.last("hello");
  h.pool.current.push(welcome(hello.rid, w));
  await h.settle();
  return { sub, hello };
}

function result(rid: number, cid: string, replayed = false) {
  return { type: "commitResult", rid, cid, headSeq: 11, replayed, results: [{ i: 0, ok: true, seqs: [11] }] };
}

describe("hello and catch-up", () => {
  it("sends hello with cursor, epoch from state, client and window; reports states in order", async () => {
    const h = harness();
    const sink = new RecSink();
    const { hello } = await greet(h, sink, 5, { limits: { ...welcome(0).limits, maxCommitOps: 123, maxBlobSize: 2048 } });
    expect(h.pool.current.url).toBe("wss://sync.example.com/v1/ws");
    expect(h.pool.current.protocols).toEqual(["shuttle.1"]);
    expect(hello).toMatchObject({ type: "hello", proto: 1, token: "sxd_test", since: 5, epoch: 1, rollbackAck: null, client: { role: "headless" }, window: { maxUnackedBytes: 8 * 1024 * 1024 } });
    expect(sink.stateNames()).toEqual(["connecting", "connected", "catching-up"]);
    expect(h.adapter.capabilities.limits).toMatchObject({ maxCommitOps: 123, maxBlobSize: 2048 }); // welcome.limits replace the defaults
  });

  it("delivers batches one at a time and acks only after onChanges resolved", async () => {
    const h = harness();
    const sink = new RecSink();
    await greet(h, sink, 5);
    let open!: () => void;
    sink.gate = new Promise<void>((r) => { open = r; });
    const ws = h.pool.current;
    ws.push(changes(5, 8, { more: true }));
    ws.push(changes(8, 10, { more: false }));
    await h.settle();
    expect(sink.batches).toHaveLength(0);
    expect(ws.ofType("ack")).toHaveLength(0);
    open();
    sink.gate = null;
    await h.settle();
    expect(sink.batches.map((b) => [b.from, b.to])).toEqual([[5, 8], [8, 10]]);
    expect(ws.ofType("ack").map((a) => a.upTo)).toEqual([8, 10]);
    expect(sink.stateNames().at(-1)).toBe("live");
  });

  it("resumes from the last persisted cursor, not the last received frame", async () => {
    const h = harness();
    const sink = new RecSink();
    await greet(h, sink, 5);
    const ws = h.pool.current;
    ws.push(changes(5, 8, { more: true }));
    await h.settle();
    let open!: () => void;
    sink.gate = new Promise<void>((r) => { open = r; });
    ws.push(changes(8, 12, { more: false })); // received, never persisted
    await h.settle();
    sink.fail = new Error("disk full");
    open();
    await h.settle();
    expect(ws.ofType("ack").map((a) => a.upTo)).toEqual([8]);
    sink.fail = null;
    sink.gate = null;
    await h.advance(2000);
    const hello2 = h.pool.current.last("hello");
    expect(h.pool.sockets).toHaveLength(2);
    expect(hello2.since).toBe(8);
  });

  it("a gap in from/to drops the frame and reconnects from the persisted cursor", async () => {
    const h = harness();
    const sink = new RecSink();
    await greet(h, sink, 5);
    h.pool.current.push(changes(5, 7));
    await h.settle();
    h.pool.current.push(changes(9, 12, { live: true }));
    await h.settle();
    expect(sink.batches.map((b) => b.to)).toEqual([7]);
    expect(sink.errors.some((e) => e.code === "PROTOCOL" && /gap/.test(e.message))).toBe(true);
    await h.advance(1000); // jitter ≤ 1 s
    expect(h.pool.sockets).toHaveLength(2);
    expect(h.pool.current.last("hello").since).toBe(7);
  });

  it("snapshotRequired parks the feed; a later subscribe re-hellos on the same socket", async () => {
    const h = harness();
    const sink = new RecSink();
    const { hello } = await greet(h, sink, 5);
    const ws = h.pool.current;
    ws.push({ type: "snapshotRequired", rid: hello.rid, reason: "cursor-too-old", minSeq: 7, epoch: 1, rollbackAt: null });
    await h.settle();
    expect(sink.snaps).toEqual([{ reason: "cursor-too-old", minSeq: 7, epoch: 1, rollbackAt: null }]);
    await expect(h.adapter.commit(req())).rejects.toMatchObject({ code: "SNAPSHOT_REQUIRED" });
    // The engine bootstraps over REST, then subscribes again; the newer subscribe replaces the old one.
    const sink2 = new RecSink();
    h.adapter.subscribe(20, sink2);
    const r = req();
    const pending = h.adapter.commit(r); // right after subscribe: held for the new welcome, not refused
    await h.settle();
    expect(h.pool.sockets).toHaveLength(1);
    expect(ws.ofType("commit")).toHaveLength(0);
    const hello2 = ws.last("hello");
    expect(hello2.rid).not.toBe(hello.rid);
    expect(hello2.since).toBe(20);
    ws.push(welcome(hello2.rid));
    ws.push(changes(20, 21));
    await h.settle();
    expect(sink2.batches.map((b) => b.to)).toEqual([21]);
    expect(sink.batches).toHaveLength(0);
    ws.push(result(ws.last("commit").rid, r.cid));
    await expect(pending).resolves.toMatchObject({ cid: r.cid });
  });

  it("subscribe(null) says no-cursor through onSnapshotRequired", async () => {
    const h = harness();
    const sink = new RecSink();
    const { hello } = await greet(h, sink, null);
    expect(hello.since).toBeNull();
    h.pool.current.push({ type: "snapshotRequired", rid: hello.rid, reason: "no-cursor", minSeq: 0, epoch: 1, rollbackAt: null });
    await h.settle();
    expect(sink.snaps[0]!.reason).toBe("no-cursor");
  });

  it("passes the session's seen values and epoch in hello", async () => {
    const h = harness({ session: () => ({ seenMaxSeq: 99, rollbackAck: 1234, epoch: 3 }) });
    const { hello } = await greet(h, new RecSink(), 5);
    expect(hello).toMatchObject({ seenMaxSeq: 99, rollbackAck: 1234, epoch: 3 });
  });

  it("without a known epoch sends epoch:null so the server decides", async () => {
    const h = harness({ state: memState() });
    const { hello } = await greet(h, new RecSink(), 5);
    expect(hello.epoch).toBeNull();
  });

  it("forwards vaultInfoChanged", async () => {
    const h = harness();
    const sink = new RecSink();
    await greet(h, sink);
    h.pool.current.push({ type: "vaultInfoChanged", etag: "\"e2\"" });
    await h.settle();
    expect(sink.etags).toEqual(["\"e2\""]);
  });
});

describe("reconnect", () => {
  it("backoff is min(60 s, 1 s·2^n) ± 30 %", () => {
    expect(backoffDelay(0, () => 0)).toBe(700);
    expect(backoffDelay(0, () => 0.9999)).toBe(1300);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(10, () => 0.5)).toBe(60000);
  });

  it("grows on repeated failures and resets after 60 s connected", async () => {
    const h = harness();
    const sink = new RecSink();
    await greet(h, sink, 5);
    h.pool.current.drop(1006);
    await h.settle();
    await h.advance(999);
    expect(h.pool.sockets).toHaveLength(1);
    await h.advance(1);
    expect(h.pool.sockets).toHaveLength(2);
    h.pool.current.drop(1006); // failed before welcome
    await h.advance(1999);
    expect(h.pool.sockets).toHaveLength(2);
    await h.advance(1);
    expect(h.pool.sockets).toHaveLength(3);
    // connected for 60 s → the next drop starts again at 1 s
    const hello = h.pool.current.last("hello");
    h.pool.current.push(welcome(hello.rid));
    await h.advance(60_000);
    h.pool.current.push({ type: "pong", rid: 1, ts: 0, serverTime: 0 });
    h.pool.current.drop(1006);
    await h.advance(1000);
    expect(h.pool.sockets).toHaveLength(4);
  });

  it("4503 waits 2–5 s, 1001 at most 1 s", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    h.pool.current.drop(4503, "restart");
    await h.advance(3499);
    expect(h.pool.sockets).toHaveLength(1);
    await h.advance(1);
    expect(h.pool.sockets).toHaveLength(2);
    h.pool.current.push(welcome(h.pool.current.last("hello").rid));
    await h.settle();
    h.pool.current.drop(1001);
    await h.advance(500);
    expect(h.pool.sockets).toHaveLength(3);
  });

  it.each([
    [4401, "UNAUTHENTICATED", "UNAUTHENTICATED"],
    [4403, "REVOKED", "REVOKED"],
    [4404, "VAULT_NOT_FOUND", "VAULT_NOT_FOUND"],
  ])("close %i stops with auth-error and never reconnects", async (code, wire, expected) => {
    const h = harness();
    const sink = new RecSink();
    const { hello } = await greet(h, sink, 5);
    const pending = h.adapter.commit(req());
    await h.settle();
    h.pool.current.push({ type: "error", rid: hello.rid, code: wire, message: "x", fatal: true, retryAfterMs: null });
    h.pool.current.drop(code);
    await expect(pending).rejects.toMatchObject({ code: expected });
    await h.advance(600_000);
    expect(h.pool.sockets).toHaveLength(1);
    expect(sink.stateNames().at(-1)).toBe("auth-error");
    expect(sink.errors.at(-1)!.code).toBe(expected);
    await expect(h.adapter.commit(req())).rejects.toMatchObject({ code: expected });
  });

  it("4409 superseded stops without reconnecting", async () => {
    const h = harness();
    const sink = new RecSink();
    await greet(h, sink, 5);
    h.pool.current.drop(4409, "superseded");
    await h.advance(600_000);
    expect(h.pool.sockets).toHaveLength(1);
    expect(sink.stateNames().at(-1)).toBe("offline");
  });

  it("nudge() reconnects at once while backing off", async () => {
    const h = harness();
    const sink = new RecSink();
    const { sub } = await greet(h, sink, 5);
    h.pool.current.drop(1006);
    await h.settle();
    sub.nudge();
    await h.settle();
    expect(h.pool.sockets).toHaveLength(2);
  });

  it("closes 4400 and backs off when the subprotocol is not echoed", async () => {
    const h = harness();
    h.pool.protocol = "";
    const sink = new RecSink();
    h.adapter.subscribe(5, sink);
    await h.settle();
    expect(h.pool.current.closedByClient?.code).toBe(4400);
    expect(sink.errors[0]!.code).toBe("PROTOCOL");
    await h.advance(1000);
    expect(h.pool.sockets).toHaveLength(2);
  });

  it("times out an attempt without welcome", async () => {
    const h = harness();
    const sink = new RecSink();
    h.adapter.subscribe(5, sink);
    await h.advance(15_000);
    expect(h.pool.sockets[0]!.closedByClient).not.toBeNull();
    await h.advance(1000);
    expect(h.pool.sockets).toHaveLength(2);
  });

  it("close() sends bye, closes 1000 and stops reconnecting", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const ws = h.pool.current;
    const pending = h.adapter.commit(req());
    await h.adapter.close();
    expect(ws.last("bye")).toBeDefined();
    expect(ws.closedByClient?.code).toBe(1000);
    await expect(pending).rejects.toMatchObject({ code: "NETWORK", retryable: true });
    await h.advance(600_000);
    expect(h.pool.sockets).toHaveLength(1);
  });
});

describe("heartbeat", () => {
  it("pings every heartbeatSec and reconnects when nothing arrives within 10 s", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5, { heartbeatSec: 25 });
    const ws = h.pool.current;
    await h.advance(25_000);
    expect(ws.ofType("ping")).toHaveLength(1);
    ws.push({ type: "pong", rid: ws.last("ping").rid, ts: 0, serverTime: 0 });
    await h.advance(25_000);
    expect(ws.ofType("ping")).toHaveLength(2);
    await h.advance(10_000); // no answer
    expect(ws.closedByClient).not.toBeNull();
    await h.advance(1000);
    expect(h.pool.sockets).toHaveLength(2);
  });

  it("any inbound frame counts as an answer", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const ws = h.pool.current;
    await h.advance(25_000);
    ws.push(changes(5, 6, { live: true }));
    await h.advance(10_000);
    expect(ws.closedByClient).toBeNull();
  });
});

describe("commits over the socket", () => {
  it("sends with a fresh rid and resolves from commitResult", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const r = req();
    const p = h.adapter.commit(r);
    await h.settle();
    const f = h.pool.current.last("commit");
    expect(f).toMatchObject({ cid: r.cid, ops: r.ops });
    h.pool.current.push(result(f.rid, r.cid));
    await expect(p).resolves.toMatchObject({ cid: r.cid, headSeq: 11, replayed: false });
  });

  it("keeps at most maxInFlightCommits unanswered", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5, { limits: { ...welcome(0).limits, maxInFlightCommits: 2 } });
    const reqs = [req(), req(), req()];
    const ps = reqs.map((r) => h.adapter.commit(r));
    await h.settle();
    const ws = h.pool.current;
    expect(ws.ofType("commit")).toHaveLength(2);
    ws.push(result(ws.ofType("commit")[0]!.rid, reqs[0]!.cid));
    await h.settle();
    expect(ws.ofType("commit")).toHaveLength(3);
    ws.push(result(ws.ofType("commit")[1]!.rid, reqs[1]!.cid));
    ws.push(result(ws.ofType("commit")[2]!.rid, reqs[2]!.cid));
    await expect(Promise.all(ps)).resolves.toHaveLength(3);
  });

  it("holds commits during pause until resume", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const ws = h.pool.current;
    ws.push({ type: "pause", reason: "rate", retryAfterMs: 2000 });
    await h.settle();
    const r = req();
    const p = h.adapter.commit(r);
    await h.settle();
    expect(ws.ofType("commit")).toHaveLength(0);
    ws.push({ type: "resume" });
    await h.settle();
    expect(ws.ofType("commit")).toHaveLength(1);
    ws.push(result(ws.last("commit").rid, r.cid));
    await p;
  });

  it("pause ends by itself after retryAfterMs", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const ws = h.pool.current;
    ws.push({ type: "pause", reason: "maintenance", retryAfterMs: 2000 });
    void h.adapter.commit(req()).catch(() => undefined);
    await h.advance(1999);
    expect(ws.ofType("commit")).toHaveLength(0);
    await h.advance(1);
    expect(ws.ofType("commit")).toHaveLength(1);
  });

  it("rejects an unanswered commit with a retryable NETWORK error when the socket drops; the same cid can be resent", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const r = req();
    const p = h.adapter.commit(r);
    await h.settle();
    h.pool.current.drop(1006);
    const err = await p.catch((e: unknown) => e);
    expect(isRemoteError(err, "NETWORK") && err.retryable).toBe(true);
    await h.advance(1000);
    const ws2 = h.pool.current;
    ws2.push(welcome(ws2.last("hello").rid));
    await h.settle();
    expect(ws2.ofType("commit")).toHaveLength(0); // never resent by the adapter itself
    const p2 = h.adapter.commit(r);
    await h.settle();
    const f = ws2.last("commit");
    expect(f.cid).toBe(r.cid);
    ws2.push(result(f.rid, r.cid, true));
    await expect(p2).resolves.toMatchObject({ replayed: true });
  });

  it("rejects at once while waiting to reconnect, and holds while an attempt is in progress", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    h.pool.current.drop(1006);
    await h.settle();
    await expect(h.adapter.commit(req())).rejects.toMatchObject({ code: "NETWORK" });
    await h.advance(1000); // attempt starts
    const r = req();
    const p = h.adapter.commit(r);
    await h.settle();
    const ws = h.pool.current;
    expect(ws.ofType("commit")).toHaveLength(0);
    ws.push(welcome(ws.last("hello").rid));
    await h.settle();
    ws.push(result(ws.last("commit").rid, r.cid));
    await p;
  });

  it("maps error frames for a commit to RemoteError with retryAfterMs", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    const p = h.adapter.commit(req());
    await h.settle();
    h.pool.current.push({ type: "error", rid: h.pool.current.last("commit").rid, code: "RATE_LIMITED", message: "slow down", fatal: false, retryAfterMs: 1500 });
    await expect(p).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 1500 });
  });

  it("refuses a commit over maxCommitOps locally", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5, { limits: { ...welcome(0).limits, maxCommitOps: 1 } });
    await expect(h.adapter.commit({ cid: ids.cid(), ops: [ids.put(), ids.put()] })).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(h.pool.current.ofType("commit")).toHaveLength(0);
  });

  it("times out a commit without answer", async () => {
    const h = harness({ timeouts: { commitMs: 5000 } });
    await greet(h, new RecSink(), 5);
    const p = h.adapter.commit(req());
    const caught = p.catch((e: unknown) => e);
    await h.advance(5000);
    expect(await caught).toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("closing the subscription closes the socket once the last commit is answered", async () => {
    const h = harness();
    const { sub } = await greet(h, new RecSink(), 5);
    const r = req();
    const p = h.adapter.commit(r);
    await h.settle();
    const ws = h.pool.current;
    sub.close();
    expect(ws.closedByClient).toBeNull();
    ws.push(result(ws.last("commit").rid, r.cid));
    await p;
    expect(ws.closedByClient?.code).toBe(1000);
  });
});

describe("URL selection", () => {
  it("uses the first URL in order that answers health, and http → ws", async () => {
    const h = harness({}, ["https://sync.example.com", "http://127.0.0.1:8787"]);
    h.http.health.set("https://sync.example.com", "down");
    h.adapter.subscribe(5, new RecSink());
    await h.settle();
    expect(h.pool.current.url).toBe("ws://127.0.0.1:8787/v1/ws");
    expect(h.adapter.endpoint).toBe("http://127.0.0.1:8787");
  });

  it("waits up to 3 s for an earlier URL before taking a later one", async () => {
    const h = harness({}, ["https://sync.example.com", "https://backup.example.com"]);
    h.http.health.set("https://sync.example.com", "hang");
    h.adapter.subscribe(5, new RecSink());
    await h.advance(2999);
    expect(h.pool.sockets).toHaveLength(0);
    await h.advance(1);
    expect(h.pool.current.url).toBe("wss://backup.example.com/v1/ws");
  });

  it("re-probes after a failed attempt and falls back", async () => {
    const h = harness({}, ["https://sync.example.com", "https://backup.example.com"]);
    const sink = new RecSink();
    await greet(h, sink, 5);
    expect(h.pool.current.url).toBe("wss://sync.example.com/v1/ws");
    h.http.health.set("https://sync.example.com", "down");
    h.pool.current.drop(1006);
    await h.advance(1000);
    expect(h.pool.current.url).toBe("wss://backup.example.com/v1/ws");
  });

  it("rejects plain http to a non-loopback host unless allowed", () => {
    expect(() => harness({}, ["http://sync.example.com"])).toThrow(/allowHttp/);
    expect(() => harness({ allowHttp: true }, ["http://sync.example.com"])).not.toThrow();
  });

  it("reports UNSUPPORTED when no server speaks protocol 1", async () => {
    const h = harness();
    h.http.health.set("https://sync.example.com", "old");
    await expect(h.adapter.connect()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("deviceId", () => {
  it("is taken from welcome", async () => {
    const h = harness();
    await greet(h, new RecSink(), 5);
    expect(h.adapter.feedStats.welcomes).toBe(1);
    expect(DEV).toHaveLength(22);
  });
});
