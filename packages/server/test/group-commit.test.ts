// Group commit (lead decision D3, design §2.9.7, §2.6.2): commits queued in the same event-loop turn share
// one BEGIN IMMEDIATE … COMMIT (one fsync), each in its own SAVEPOINT. Nobody is acked before the outer
// COMMIT returned; a failure or crash mid-group acks nobody of that group; CAS and PATH_TAKEN are
// evaluated per commit in queue order, so a later commit sees the earlier ones of the same group.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommitOutcome } from "../src/store";
import type { CommitRequest, OpResult, VersionRecord } from "@shuttle/protocol";
import { resolveConfig } from "../src/config";
import { Server } from "../src/server-core";
import { HttpError } from "../src/util";
import { TestWs, cid, fileId, fixture, login, makeInfo, pathKey, putOp, removeDir, start, tempDir, testOptions, vaultId } from "./helpers";

type Exec = (sql: string) => void;

/** A Server without HTTP, so a test can call commitAsync directly and break the DB underneath it. */
function openCore(dir: string): { core: Server; vid: string } {
  const core = new Server(resolveConfig(testOptions(dir, { jobs: false })));
  const vid = vaultId();
  if (!core.s.get("SELECT 1 AS x FROM users WHERE user_id = 'u1'")) {
    core.s.run("INSERT INTO users (user_id, username, pw_hash, role, created_at) VALUES ('u1', 'alice', NULL, 'owner', 1)");
  }
  core.createVault("u1", `v-${vid}`, makeInfo(vid));
  return { core, vid };
}

/** Wraps db.exec; `hook` sees every statement and may throw instead of running it. */
function spyExec(core: Server, hook: (sql: string, run: Exec) => void): () => void {
  const db = core.db;
  const orig = db.exec.bind(db) as Exec;
  (db as unknown as { exec: Exec }).exec = (sql: string) => hook(sql, orig);
  return () => { (db as unknown as { exec: Exec }).exec = orig; };
}

const seqOf = (r: OpResult): number => {
  if (!r.ok) throw new Error(`op failed: ${JSON.stringify(r)}`);
  return r.seqs[0]!;
};

function settle(p: Promise<CommitOutcome>): Promise<CommitOutcome | Error> {
  return p.then((r) => r, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
}

const req = (ops: CommitRequest["ops"], c = cid()): CommitRequest => ({ cid: c, ops });

describe("group commit: per-commit results inside one transaction", () => {
  let dir: string;
  let core: Server;
  let vid: string;
  let begins: number;
  let restore: () => void;

  beforeEach(async () => {
    dir = await tempDir("gc-unit");
    ({ core, vid } = openCore(dir));
    begins = 0;
    restore = spyExec(core, (sql, run) => { if (sql === "BEGIN IMMEDIATE") begins++; run(sql); });
  });

  afterEach(async () => {
    restore();
    core.hwm.stop();
    core.db.close();
    await removeDir(dir);
  });

  it("same fileId and base from two devices in one group: the first wins, the second gets CONFLICT with the winner as current", async () => {
    const f = fileId();
    const pk = pathKey();
    const base = seqOf((await core.commitAsync(vid, "devA", req([putOp(f, null, pk)]))).response.results[0]!);
    begins = 0;
    const a = core.commitAsync(vid, "devA", req([putOp(f, base, pk)]));
    const b = core.commitAsync(vid, "devB", req([putOp(f, base, pk)]));
    const [ra, rb] = await Promise.all([a, b]);
    expect(begins).toBe(1); // one transaction for both
    const won = seqOf(ra.response.results[0]!);
    expect(won).toBe(base + 1);
    const lost = rb.response.results[0]!;
    expect(lost.ok).toBe(false);
    expect(lost.ok === false && lost.code).toBe("CONFLICT");
    expect((lost as { current: VersionRecord }).current.seq).toBe(won);
    expect((lost as { current: VersionRecord }).current.device).toBe("devA");
    expect(rb.response.headSeq).toBe(won);
    expect(rb.applied).toEqual([]);
  });

  it("two new fileIds on one pathKey in one group: the second gets PATH_TAKEN naming the first", async () => {
    const pk = pathKey();
    const f1 = fileId();
    const f2 = fileId();
    const [r1, r2] = await Promise.all([
      core.commitAsync(vid, "devA", req([putOp(f1, null, pk)])),
      core.commitAsync(vid, "devB", req([putOp(f2, null, pk)])),
    ]);
    expect(begins).toBe(1);
    seqOf(r1.response.results[0]!);
    const r = r2.response.results[0]!;
    expect(r.ok === false && r.code).toBe("PATH_TAKEN");
    expect((r as { current: VersionRecord }).current.fileId).toBe(f1);
    // An atomic swap later in the same kind of group still sees the committed holder.
    expect(core.store.livePathHolder(vid, pk)).toBe(f1);
  });

  it("a commit that throws after writing rolls back to its savepoint alone; seqs stay dense; neighbours commit", async () => {
    const bad = cid();
    const origCommit = core.store.commitInTx.bind(core.store);
    core.store.commitInTx = (v, d, r, e) => {
      const out = origCommit(v, d, r, e);
      if (r.cid === bad) throw new Error("injected failure after the writes");
      return out;
    };
    const f = fileId();
    const pk = pathKey();
    const results = await Promise.all([
      settle(core.commitAsync(vid, "devA", req([putOp(fileId(), null, pathKey())]))),
      settle(core.commitAsync(vid, "devB", req([putOp(f, null, pk), putOp(fileId(), null, pathKey())], bad))),
      // Would be PATH_TAKEN if the failed commit's rows had survived.
      settle(core.commitAsync(vid, "devC", req([putOp(fileId(), null, pk)]))),
    ]);
    expect(begins).toBe(1);
    const [a, b, c] = results;
    expect(b).toBeInstanceOf(Error);
    const sa = seqOf((a as CommitOutcome).response.results[0]!);
    const sc = seqOf((c as CommitOutcome).response.results[0]!);
    expect(sc).toBe(sa + 1); // the rolled-back seqs were never handed out
    expect(core.store.headRow(vid, f)).toBeUndefined();
    expect(core.s.get("SELECT 1 AS x FROM commits WHERE vault_id = ? AND cid = ?", vid, bad)).toBeUndefined();
    expect(core.store.vault(vid)!.head_seq).toBe(sc);
  });

  it("same cid with a different digest fails alone inside a group (CommitProtocolError)", async () => {
    const c = cid();
    await core.commitAsync(vid, "devA", req([putOp(fileId(), null, pathKey())], c));
    begins = 0;
    const [x, y] = await Promise.all([
      settle(core.commitAsync(vid, "devA", req([putOp(fileId(), null, pathKey())], c))),
      settle(core.commitAsync(vid, "devB", req([putOp(fileId(), null, pathKey())]))),
    ]);
    expect(begins).toBe(1);
    expect(x).toBeInstanceOf(Error);
    expect((x as Error).name).not.toBe("HttpError");
    expect((y as CommitOutcome).response.results[0]!.ok).toBe(true);
  });

  it("results are delivered only after the outer COMMIT returned", async () => {
    const events: string[] = [];
    restore();
    restore = spyExec(core, (sql, run) => {
      run(sql);
      if (sql === "COMMIT") events.push("committed");
    });
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      core.commitAsync(vid, `dev${i}`, req([putOp(fileId(), null, pathKey())])).then(() => events.push("acked"))));
    expect(events).toEqual(["committed", "acked", "acked", "acked", "acked", "acked"]);
  });

  it("a failing outer COMMIT acks nobody: every commit of the group gets SERVER, nothing is stored, a resend works", async () => {
    const head0 = core.store.vault(vid)!.head_seq;
    let armed = true;
    restore();
    restore = spyExec(core, (sql, run) => {
      if (armed && sql === "COMMIT") { armed = false; throw new Error("disk I/O error (injected)"); }
      run(sql);
    });
    const reqs = Array.from({ length: 6 }, (_, i) => ({ dev: `dev${i % 3}`, r: req([putOp(fileId(), null, pathKey())]) }));
    const out = await Promise.all(reqs.map(({ dev, r }) => settle(core.commitAsync(vid, dev, r))));
    for (const o of out) {
      expect(o).toBeInstanceOf(HttpError);
      expect((o as HttpError).code).toBe("SERVER");
    }
    expect(core.db.isTransaction).toBe(false);
    expect(core.store.vault(vid)!.head_seq).toBe(head0);
    expect(core.s.get<{ n: number }>("SELECT COUNT(*) AS n FROM versions WHERE vault_id = ?", vid)!.n).toBe(0);
    expect(core.s.get<{ n: number }>("SELECT COUNT(*) AS n FROM commits WHERE vault_id = ?", vid)!.n).toBe(0);
    // Same cids again: evaluated fresh (not replayed), seqs start right after the old head.
    const again = await Promise.all(reqs.map(({ dev, r }) => core.commitAsync(vid, dev, r)));
    expect(again.every((o) => o.response.replayed === false && o.response.results[0]!.ok)).toBe(true);
    expect(again.map((o) => seqOf(o.response.results[0]!))).toEqual([1, 2, 3, 4, 5, 6].map((n) => head0 + n));
  });

  it("SQLite rolling the whole transaction back mid-group aborts the group instead of autocommitting the rest", async () => {
    const origCommit = core.store.commitInTx.bind(core.store);
    let n = 0;
    core.store.commitInTx = (v, d, r, e) => {
      const out = origCommit(v, d, r, e);
      // Emulate SQLITE_FULL: SQLite ends the transaction on its own, then the statement fails.
      if (++n === 2) { core.db.exec("ROLLBACK"); throw new Error("database or disk is full (injected)"); }
      return out;
    };
    const out = await Promise.all(Array.from({ length: 4 }, (_, i) => settle(core.commitAsync(vid, `dev${i}`, req([putOp(fileId(), null, pathKey())])))));
    expect(out.every((o) => o instanceof Error)).toBe(true);
    expect(core.db.isTransaction).toBe(false);
    expect(core.s.get<{ n: number }>("SELECT COUNT(*) AS n FROM versions WHERE vault_id = ?", vid)!.n).toBe(0);
    expect(core.store.vault(vid)!.head_seq).toBe(0);
  });
});

describe("group commit: crash before the group's COMMIT", () => {
  let dir: string;
  beforeEach(async () => { dir = await tempDir("gc-crash"); });
  afterEach(async () => { await removeDir(dir); });

  it("every acked commit survives a reopen; no commit of the crashed group was acked or survives", async () => {
    const { core, vid } = openCore(dir);
    const acked = new Set<string>();
    const failed = new Set<string>();
    let groups = 0;
    const crashAt = 4;
    const restore = spyExec(core, (sql, run) => {
      if (sql === "COMMIT" && ++groups === crashAt) {
        // Power cut before the fsync: the open transaction never reaches the WAL's commit frame.
        core.hwm.stop();
        restore();
        core.db.close();
        throw new Error("process killed (simulated)");
      }
      run(sql);
    });
    const all: Promise<void>[] = [];
    for (let g = 0; g < 6; g++) {
      for (let i = 0; i < 5; i++) {
        const r = req([putOp(fileId(), null, pathKey())]);
        all.push(core.commitAsync(vid, `dev${i}`, r).then(() => { acked.add(r.cid); }, () => { failed.add(r.cid); }));
      }
      // Each loop turn is one group (setImmediate flush).
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(all);
    expect(acked.size).toBe((crashAt - 1) * 5);
    expect(failed.size).toBe(30 - acked.size);

    const again = new Server(resolveConfig(testOptions(dir, { jobs: false })));
    try {
      const stored = new Set(again.s.all<{ cid: string }>("SELECT cid FROM commits WHERE vault_id = ?", vid).map((r) => r.cid));
      for (const c of acked) expect(stored.has(c)).toBe(true);
      for (const c of failed) expect(stored.has(c)).toBe(false);
      expect(again.store.vault(vid)!.head_seq).toBe(acked.size);
    } finally {
      again.hwm.stop();
      again.db.close();
    }
  });
});

describe("group commit over WebSocket", () => {
  it("an injected COMMIT failure answers each socket with a non-fatal SERVER error; the same cid then succeeds", async () => {
    const dir = await tempDir("gc-ws");
    const srv = await start(dir);
    try {
      const { c, vid } = await fixture(srv, dir);
      const d2 = await login(srv, "alice", "second");
      const w1 = await TestWs.open(srv);
      const w2 = await TestWs.open(srv);
      await w1.connect(c.token, vid);
      await w2.connect(d2.token, vid);
      let armed = true;
      const restore = spyExec(srv.core, (sql, run) => {
        if (armed && sql === "COMMIT") { armed = false; throw new Error("injected"); }
        run(sql);
      });
      const c1 = cid();
      const c2 = cid();
      const ops1 = [putOp(fileId(), null, pathKey())];
      const ops2 = [putOp(fileId(), null, pathKey())];
      const r1 = w1.nextRid();
      const r2 = w2.nextRid();
      w1.send({ type: "commit", rid: r1, cid: c1, ops: ops1 });
      w2.send({ type: "commit", rid: r2, cid: c2, ops: ops2 });
      const e1 = await w1.take((f) => f.rid === r1);
      const e2 = await w2.take((f) => f.rid === r2);
      restore();
      for (const e of [e1, e2]) {
        expect(e).toMatchObject({ type: "error", code: "SERVER", fatal: false });
      }
      expect(w1.frames.some((f) => f.type === "commitResult")).toBe(false);
      const ok = await w1.commit(ops1, { cid: c1 });
      expect(ok.replayed).toBe(false);
      expect(ok.results[0]!.ok).toBe(true);
      w1.close();
      w2.close();
    } finally {
      await srv.close();
      await removeDir(dir);
    }
  });

  it("more than maxInFlightCommits unanswered commits on one socket: the extra one is refused RATE_LIMITED (retryable)", async () => {
    const dir = await tempDir("gc-inflight");
    const srv = await start(dir);
    try {
      const { c, vid } = await fixture(srv, dir);
      const w = await TestWs.open(srv);
      const { welcome } = await w.connect(c.token, vid);
      const max = welcome.limits.maxInFlightCommits as number;
      expect(max).toBe(4);
      // Hold the queue so the first four stay unanswered however the frames are split across ticks.
      const core = srv.core;
      const enqueue = core.enqueueCommit.bind(core);
      const held: Parameters<Server["enqueueCommit"]>[] = [];
      core.enqueueCommit = (...a) => { held.push(a); };
      const rids: number[] = [];
      for (let i = 0; i <= max; i++) {
        const rid = w.nextRid();
        rids.push(rid);
        w.send({ type: "commit", rid, cid: cid(), ops: [putOp(fileId(), null, pathKey())] });
      }
      const refused = await w.take((f) => f.rid === rids[max]);
      expect(held).toHaveLength(max);
      core.enqueueCommit = enqueue;
      for (const a of held) enqueue(...a);
      const answers = [...await Promise.all(rids.slice(0, max).map((rid) => w.take((f) => f.rid === rid))), refused];
      expect(answers.slice(0, max).every((f) => f.type === "commitResult")).toBe(true);
      expect(answers[max]).toMatchObject({ type: "error", code: "RATE_LIMITED", fatal: false });
      expect(answers[max]!.retryAfterMs).toBeGreaterThan(0);
      // Once answered, the slot is free again.
      const later = await w.commit([putOp(fileId(), null, pathKey())]);
      expect(later.results[0]!.ok).toBe(true);
      expect(w.closed).toBeNull();
      w.close();
    } finally {
      await srv.close();
      await removeDir(dir);
    }
  });
});
