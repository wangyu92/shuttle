// Seqs stay at or below MAX_SEQ (design §2.4 ID-10). Regression: one hello with seenMaxSeq near 2^53
// raised the head so far that the next commits stored seqs node:sqlite cannot read back; the coalesced
// live flush then threw outside any handler and the process exited, and the vault row stayed unreadable.
import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_SEQ } from "@shuttle/protocol";
import type { RunningServer } from "../src/server";
import { TestWs, fileId, fixture, pathKey, putOp, removeDir, start, tempDir } from "./helpers";

let dir: string;
let srv: RunningServer;
beforeAll(async () => { dir = await tempDir("seqbound"); srv = await start(dir); });
afterAll(async () => { await srv?.close(); await removeDir(dir); });

it("a hello with seenMaxSeq above MAX_SEQ is refused and the vault keeps working", async () => {
  const { c, vid } = await fixture(srv, dir);
  const m = await TestWs.open(srv);
  await m.connect(c.token, vid, { since: 0, seenMaxSeq: Number.MAX_SAFE_INTEGER - 1 }).catch(() => undefined);
  m.close();
  const b = await TestWs.open(srv);
  const { welcome } = await b.connect(c.token, vid, { since: 0 });
  expect(welcome.headSeq).toBeLessThanOrEqual(MAX_SEQ);
  const r = await b.commit([putOp(fileId(), null, pathKey())]);
  expect(r.results[0]!.ok).toBe(true);
  b.close();
});

it("the seq space ends at MAX_SEQ: commits past it are refused, nothing crashes and the vault stays readable", async () => {
  const { c, vid } = await fixture(srv, dir, "bob");
  const m = await TestWs.open(srv);
  await m.connect(c.token, vid, { since: 0, seenMaxSeq: MAX_SEQ - 1 });
  m.close();
  const b = await TestWs.open(srv);
  await b.connect(c.token, vid, { since: 0 });
  const r1 = await b.commit([putOp(fileId(), null, pathKey())]);
  expect(r1.results[0]!.ok).toBe(true);
  const rid = b.nextRid();
  b.send({ type: "commit", rid, cid: crypto.randomUUID(), ops: [putOp(fileId(), null, pathKey())] });
  const f = await b.take((x) => x.rid === rid);
  expect(f.type).toBe("error");
  expect((f as { code?: string }).code).toBe("INVALID");
  // Let the coalesced live flush run, then read the vault again on a new socket.
  await new Promise((res) => setTimeout(res, 200));
  b.close();
  const b2 = await TestWs.open(srv);
  const { welcome } = await b2.connect(c.token, vid, { since: 0 });
  expect(welcome.headSeq).toBe(MAX_SEQ);
  b2.close();
});
