// Lead decision D9: how far the server trusts a client-reported seq (hello.seenMaxSeq / since, and
// REST GET /changes since / seenMaxSeq). design §2.6.1 raises head_seq to it; D9 limits that raise to
// a known restore (rollback_at set, or hwm.json above the DB head), capped at
// max(hwm mark, head_seq + 1,000,000). Values that are not safe integers are refused with no change.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SEQ } from "@shuttle/protocol";
import { readHwm, writeHwm } from "../src/hwm";
import { SEEN_RAISE_MAX } from "../src/server-core";
import type { RunningServer } from "../src/server";
import { guardLog } from "../../testkit/test/outputGuard";
import { TestWs, api, fileId, fixture, guardSuite, pathKey, putOp, removeDir, start, tempDir, type Client } from "./helpers";

guardSuite();

let srv: RunningServer | null = null;
let dir: string | undefined;
let logs: string[] = [];

afterEach(async () => {
  await srv?.close();
  srv = null;
  await removeDir(dir);
  dir = undefined;
});

async function boot(prefix: string): Promise<void> {
  dir = await tempDir(prefix);
  logs = [];
  srv = await start(dir, { log: (m) => { logs.push(m); guardLog(m); } });
}

async function restart(): Promise<void> {
  await srv!.close();
  srv = await start(dir!, { log: (m) => { logs.push(m); guardLog(m); } });
}

async function commitN(c: Client, vid: string, n: number): Promise<number> {
  const ws = await TestWs.open(srv!);
  await ws.connect(c.token, vid);
  const r = await ws.commit(Array.from({ length: n }, () => putOp(fileId(), null, pathKey())));
  ws.close();
  return r.headSeq;
}

/** The head as the server reports it (vault list), without sending any client seq. */
async function headOf(c: Client, vid: string): Promise<number> {
  const r = await api(srv!, c, "GET", "/v1/vaults");
  const v = (r.json.vaults as Array<{ vaultId: string; headSeq: number }>).find((x) => x.vaultId === vid);
  return v!.headSeq;
}

/** Simulate a restore: the DB head stays, hwm.json says `mark`; on start the head is raised to it. */
async function restoreTo(vid: string, mark: number): Promise<void> {
  await srv!.close();
  writeHwm(dir!, vid, { epoch: 1, headSeq: mark });
  srv = await start(dir!, { log: (m) => { logs.push(m); guardLog(m); } });
}

const changes = (vid: string, q: string) => `/v1/vaults/${vid}/changes?${q}`;

describe("D9: values that are not safe seqs are refused and change nothing", () => {
  it("hello with seenMaxSeq or since above 2^53 is a protocol error; head unchanged", async () => {
    await boot("seen-nonsafe");
    const { c, vid } = await fixture(srv!, dir!);
    expect(await commitN(c, vid, 3)).toBe(3);
    for (const o of [{ seenMaxSeq: 2 ** 53 + 2 }, { since: 2 ** 53 + 2 }, { seenMaxSeq: MAX_SEQ + 1 }, { seenMaxSeq: 1.5 }, { seenMaxSeq: -1 }]) {
      const ws = await TestWs.open(srv!);
      const rid = ws.hello(c.token, vid, o);
      const f = await ws.take((x) => x.rid === rid || x.type === "error");
      expect(f.type).toBe("error");
      expect(f.code).toBe("PROTOCOL");
      ws.close();
    }
    expect(await headOf(c, vid)).toBe(3);
  });

  it("REST /changes with a bad since or seenMaxSeq is INVALID; head unchanged", async () => {
    await boot("seen-nonsafe-rest");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 3);
    for (const q of ["since=9007199254740993", "since=0&seenMaxSeq=9007199254740993", `since=0&seenMaxSeq=${MAX_SEQ + 1}`,
      "since=0&seenMaxSeq=1e9", "since=0&seenMaxSeq=-5", "since=0&seenMaxSeq=1.5", "since=0&seenMaxSeq=abc", "since=1e3"]) {
      const r = await api(srv!, c, "GET", changes(vid, q));
      expect(r.status, q).toBe(400);
      expect(r.json.error.code, q).toBe("INVALID");
    }
    expect(await headOf(c, vid)).toBe(3);
  });
});

describe("D9: a raise outside a known restore is logged and ignored", () => {
  it("WS hello: head stays, no rollback rule, the next commit takes head+1", async () => {
    await boot("seen-ignored");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 3);
    const ws = await TestWs.open(srv!);
    const { welcome } = await ws.connect(c.token, vid, { since: 3, seenMaxSeq: 500 });
    expect(welcome.headSeq).toBe(3);
    expect(ws.frames.find((f) => f.type === "snapshotRequired")).toBeUndefined();
    const r = await ws.commit([putOp(fileId(), null, pathKey())]);
    expect(r.headSeq).toBe(4);
    ws.close();
    expect(logs.some((l) => /hello: .*outside a restore; ignored/.test(l))).toBe(true);
    // A cursor above the head is not trusted either.
    const ws2 = await TestWs.open(srv!);
    const again = await ws2.connect(c.token, vid, { since: 900, seenMaxSeq: null });
    expect(again.welcome.headSeq).toBe(4);
    ws2.close();
    expect(await headOf(c, vid)).toBe(4);
  });

  it("REST /changes: same rule, head stays and the page is served", async () => {
    await boot("seen-ignored-rest");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 3);
    const r = await api(srv!, c, "GET", changes(vid, "since=0&seenMaxSeq=500"));
    expect(r.status).toBe(200);
    expect(r.json.headSeq).toBe(3);
    expect(r.json.records).toHaveLength(3);
    expect(logs.some((l) => /changes: .*outside a restore; ignored/.test(l))).toBe(true);
    expect(await headOf(c, vid)).toBe(3);
  });

  it("log lines carry the gap only, never the client's value", async () => {
    await boot("seen-log");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 2);
    await api(srv!, c, "GET", changes(vid, "since=0&seenMaxSeq=123456789"));
    expect(logs.join("\n")).not.toContain("123456789");
  });
});

describe("D9: during a restore the raise is honoured, capped", () => {
  it("rollback_at set: a raise within the cap goes to the reported value; the rule then parks the device", async () => {
    await boot("seen-restore");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 5);
    await restoreTo(vid, 8); // head 5 -> 8 at start, rollback_at set, restored_seq 5
    expect(await headOf(c, vid)).toBe(8);
    const ws = await TestWs.open(srv!);
    ws.hello(c.token, vid, { since: 5, seenMaxSeq: 120 });
    expect((await ws.type("welcome")).headSeq).toBe(120);
    expect(await ws.type("snapshotRequired")).toMatchObject({ reason: "rollback" });
    ws.close();
    expect(await headOf(c, vid)).toBe(120);
  });

  it("rollback_at set: a raise above head + 1,000,000 is capped there; rollback_at is kept", async () => {
    await boot("seen-cap");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 5);
    await restoreTo(vid, 10);
    const ws = await TestWs.open(srv!);
    ws.hello(c.token, vid, { since: 10, seenMaxSeq: 10 + 5 * SEEN_RAISE_MAX });
    expect((await ws.type("welcome")).headSeq).toBe(10 + SEEN_RAISE_MAX);
    const sr = await ws.type("snapshotRequired");
    expect(sr).toMatchObject({ reason: "rollback" });
    ws.close();
    expect(logs.some((l) => /\(capped\)/.test(l))).toBe(true);
    // A second report raises by at most another step and does not restart the rule (same rollbackAt).
    const ws2 = await TestWs.open(srv!);
    ws2.hello(c.token, vid, { since: 10, seenMaxSeq: MAX_SEQ });
    expect((await ws2.type("welcome")).headSeq).toBe(10 + 2 * SEEN_RAISE_MAX);
    expect((await ws2.type("snapshotRequired")).rollbackAt).toBe(sr.rollbackAt);
    ws2.close();
    // The raised head is persisted in the high-water mark (no seq reused after another restart).
    await restart();
    expect(await headOf(c, vid)).toBe(10 + 2 * SEEN_RAISE_MAX);
    expect(readHwm(dir!, vid)!.headSeq).toBe(10 + 2 * SEEN_RAISE_MAX);
  });

  it("hwm.json above the DB head while running counts as a restore; the cap is the mark when it is higher", async () => {
    await boot("seen-hwm");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 4);
    const mark = 4 + 3 * SEEN_RAISE_MAX;
    writeHwm(dir!, vid, { epoch: 1, headSeq: mark });
    const r = await api(srv!, c, "GET", changes(vid, `since=4&seenMaxSeq=${mark + 50}`));
    expect(r.status).toBe(409);
    expect(r.json.error.details).toMatchObject({ reason: "rollback" });
    expect(await headOf(c, vid)).toBe(mark);
  });

  it("REST /changes matches the WS hello: same cap, same rollback rule on max(since, seenMaxSeq)", async () => {
    await boot("seen-rest-match");
    const { c, vid } = await fixture(srv!, dir!);
    await commitN(c, vid, 5);
    await restoreTo(vid, 9); // restored_seq 5
    // since at restored_seq, seenMaxSeq above it: rollback (the device saw seqs the restore lost).
    const r1 = await api(srv!, c, "GET", changes(vid, `since=5&seenMaxSeq=${9 + 5 * SEEN_RAISE_MAX}`));
    expect(r1.status).toBe(409);
    expect(r1.json.error.details.reason).toBe("rollback");
    expect(await headOf(c, vid)).toBe(9 + SEEN_RAISE_MAX);
    // The same request over WS gives the same head step and the same answer.
    const ws = await TestWs.open(srv!);
    ws.hello(c.token, vid, { since: 5, seenMaxSeq: 9 + 5 * SEEN_RAISE_MAX });
    expect((await ws.type("welcome")).headSeq).toBe(9 + 2 * SEEN_RAISE_MAX);
    expect(await ws.type("snapshotRequired")).toMatchObject({ reason: "rollback", rollbackAt: r1.json.error.details.rollbackAt });
    ws.close();
    // A device at or below restored_seq that saw nothing above it keeps reading.
    const ok = await api(srv!, c, "GET", changes(vid, "since=5&seenMaxSeq=5"));
    expect(ok.status).toBe(200);
    // After the accepted snapshot the device acks and the rule stops for it, on REST too.
    const acked = await api(srv!, c, "GET", changes(vid, `since=${9 + 2 * SEEN_RAISE_MAX}&rollbackAck=${r1.json.error.details.rollbackAt}`));
    expect(acked.status).toBe(200);
  });
});
