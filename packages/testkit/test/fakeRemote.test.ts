// FakeRemote: the logical model of design §2.1-2.5 and the commit/feed rules of §2.9.5-2.9.7.
import { describe, expect, it } from "vitest";
import { isRemoteError, remoteError, validateChangeBatch, validateCommitResponse, validateSnapshotPage } from "@shuttle/protocol";
import type { ChangeBatch, ChangeSink, ConnectionState, OpResult, RemoteError, SnapshotRequiredInfo, VersionRecord } from "@shuttle/protocol";
import { FakeRemote, FakeRemoteServer, TestIds } from "../src/index";

async function setup(o: ConstructorParameters<typeof FakeRemoteServer>[0] = {}) {
  const ids = new TestIds("fake-remote-test");
  const server = new FakeRemoteServer(o);
  const a = server.adapter(ids.deviceId(), { name: "alice-mac" });
  const b = server.adapter(ids.deviceId(), { name: "alice-phone" });
  await a.connect();
  await b.connect();
  await a.createVaultInfo(ids.vaultInfo());
  return { ids, server, a, b };
}

function ok(r: OpResult | undefined): number {
  if (!r || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.seqs[0] as number;
}

function code(r: OpResult | undefined): string {
  if (!r || r.ok) throw new Error(`expected failure, got ${JSON.stringify(r)}`);
  return r.code;
}

function current(r: OpResult | undefined): VersionRecord | null {
  if (r && !r.ok && (r.code === "CONFLICT" || r.code === "PATH_TAKEN")) return r.current;
  throw new Error(`no current in ${JSON.stringify(r)}`);
}

class RecordingSink implements ChangeSink {
  batches: ChangeBatch[] = [];
  states: ConnectionState[] = [];
  snapshots: SnapshotRequiredInfo[] = [];
  infos: string[] = [];
  errors: RemoteError[] = [];
  hold: Promise<void> | null = null;
  async onChanges(batch: ChangeBatch): Promise<void> {
    expect(validateChangeBatch(batch).ok).toBe(true);
    if (this.hold) await this.hold;
    this.batches.push(batch);
  }
  headOf(): VersionRecord | null { return null; }
  liveHeadByPathKey(): VersionRecord | null { return null; }
  onSnapshotRequired(info: SnapshotRequiredInfo): void { this.snapshots.push(info); }
  onVaultInfoChanged(etag: string): void { this.infos.push(etag); }
  onState(state: ConnectionState): void { this.states.push(state); }
  onError(err: RemoteError): void { this.errors.push(err); }
  records(): VersionRecord[] { return this.batches.flatMap((b) => b.records); }
}

describe("FakeRemote CAS (design §2.5)", () => {
  it("creates, edits and deletes with correct bases; seqs are vault-wide and monotonic", async () => {
    const { ids, a } = await setup();
    const pk = ids.pathKey();
    const put = ids.put({ pathKey: pk });
    const r1 = await a.commit({ cid: ids.cid(), ops: [put] });
    expect(validateCommitResponse(r1).ok).toBe(true);
    const s1 = ok(r1.results[0]);
    expect(s1).toBe(1);
    expect(r1.headSeq).toBe(1);
    const s2 = ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, base: s1, pathKey: pk })] })).results[0]);
    expect(s2).toBe(2);
    const s3 = ok((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: put.fileId, base: s2, pathKey: pk })] })).results[0]);
    expect(s3).toBe(3);
    const v = await a.getVersion(put.fileId, s2);
    expect(v?.base).toBe(s1);
    expect(v?.cid).toBeDefined();
  });

  it("put base:null over any head (live or tombstone) is CONFLICT with current = head", async () => {
    const { ids, a } = await setup();
    const put = ids.put();
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [put] })).results[0]);
    const again = await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, pathKey: put.pathKey })] });
    expect(code(again.results[0])).toBe("CONFLICT");
    expect(current(again.results[0])?.seq).toBe(s1);
    const s2 = ok((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: put.fileId, base: s1, pathKey: put.pathKey })] })).results[0]);
    const overTomb = await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, pathKey: put.pathKey })] });
    expect(code(overTomb.results[0])).toBe("CONFLICT");
    expect(current(overTomb.results[0])?.seq).toBe(s2);
    expect(current(overTomb.results[0])?.kind).toBe("del");
  });

  it("stale base is CONFLICT; put with base = tombstone seq resurrects", async () => {
    const { ids, a, b } = await setup();
    const put = ids.put();
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [put] })).results[0]);
    const s2 = ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, base: s1, pathKey: put.pathKey })] })).results[0]);
    const stale = await b.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, base: s1, pathKey: put.pathKey })] });
    expect(code(stale.results[0])).toBe("CONFLICT");
    expect(current(stale.results[0])?.seq).toBe(s2);
    const s3 = ok((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: put.fileId, base: s2, pathKey: put.pathKey })] })).results[0]);
    const res = await b.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, base: s3, pathKey: put.pathKey })] });
    expect(ok(res.results[0])).toBe(4);
  });

  it("put with a base on a fileId without head is CONFLICT with current null", async () => {
    const { ids, a } = await setup();
    const r = await a.commit({ cid: ids.cid(), ops: [ids.put({ base: 5 })] });
    expect(code(r.results[0])).toBe("CONFLICT");
    expect(current(r.results[0])).toBeNull();
  });

  it("del on a tombstone or with a stale base is CONFLICT", async () => {
    const { ids, a } = await setup();
    const put = ids.put();
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [put] })).results[0]);
    const s2 = ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: put.fileId, base: s1, pathKey: put.pathKey })] })).results[0]);
    expect(code((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: put.fileId, base: s1, pathKey: put.pathKey })] })).results[0])).toBe("CONFLICT");
    const s3 = ok((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: put.fileId, base: s2, pathKey: put.pathKey })] })).results[0]);
    const twice = await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: put.fileId, base: s3, pathKey: put.pathKey })] });
    expect(code(twice.results[0])).toBe("CONFLICT");
    expect(current(twice.results[0])?.kind).toBe("del");
  });

  it("PATH_TAKEN: a live head of another fileId holds the pathKey; a delete frees it", async () => {
    const { ids, a, b } = await setup();
    const pk = ids.pathKey();
    const first = ids.put({ pathKey: pk });
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [first] })).results[0]);
    const clash = await b.commit({ cid: ids.cid(), ops: [ids.put({ pathKey: pk })] });
    expect(code(clash.results[0])).toBe("PATH_TAKEN");
    expect(current(clash.results[0])?.fileId).toBe(first.fileId);
    // move of an existing file onto the taken path
    const other = ids.put();
    const so = ok((await b.commit({ cid: ids.cid(), ops: [other] })).results[0]);
    const move = await b.commit({ cid: ids.cid(), ops: [ids.put({ fileId: other.fileId, base: so, pathKey: pk })] });
    expect(code(move.results[0])).toBe("PATH_TAKEN");
    ok((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: first.fileId, base: s1, pathKey: pk })] })).results[0]);
    ok((await b.commit({ cid: ids.cid(), ops: [ids.put({ pathKey: pk })] })).results[0]);
  });

  it("CAS is checked before PATH_TAKEN", async () => {
    const { ids, a } = await setup();
    const pk = ids.pathKey();
    const x = ids.put({ pathKey: pk });
    ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    const y = ids.put();
    ok((await a.commit({ cid: ids.cid(), ops: [y] })).results[0]);
    const r = await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: y.fileId, base: 99, pathKey: pk })] });
    expect(code(r.results[0])).toBe("CONFLICT");
  });

  it("moving a file away frees its old pathKey", async () => {
    const { ids, a } = await setup();
    const pk1 = ids.pathKey();
    const x = ids.put({ pathKey: pk1 });
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: x.fileId, base: s1, pathKey: ids.pathKey() })] })).results[0]);
    ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ pathKey: pk1 })] })).results[0]);
  });

  it("archive: OK with base <= head, head unchanged, no pathKey check; INVALID without head", async () => {
    const { ids, a, server } = await setup();
    const pk = ids.pathKey();
    const x = ids.put({ pathKey: pk });
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    const holder = ids.put();
    ok((await a.commit({ cid: ids.cid(), ops: [holder] })).results[0]);
    const s3 = ok((await a.commit({ cid: ids.cid(), ops: [ids.archive({ fileId: x.fileId, base: s1, pathKey: holder.pathKey })] })).results[0]);
    expect(server.inspect().heads.find((h) => h.fileId === x.fileId)?.seq).toBe(s1);
    expect((await a.getVersion(x.fileId, s3))?.kind).toBe("archive");
    const none = await a.commit({ cid: ids.cid(), ops: [ids.archive({ fileId: ids.fileId(), base: 1, pathKey: pk })] });
    expect(code(none.results[0])).toBe("INVALID");
    const above = await a.commit({ cid: ids.cid(), ops: [ids.archive({ fileId: x.fileId, base: 99, pathKey: pk })] });
    expect(code(above.results[0])).toBe("INVALID");
  });

  it("non-atomic commits evaluate ops one by one; later ops see earlier ones", async () => {
    const { ids, a } = await setup();
    const pk = ids.pathKey();
    const r = await a.commit({ cid: ids.cid(), ops: [ids.put({ pathKey: pk }), ids.put({ pathKey: pk }), ids.put()] });
    expect(ok(r.results[0])).toBe(1);
    expect(code(r.results[1])).toBe("PATH_TAKEN");
    expect(ok(r.results[2])).toBe(2);
    expect(r.headSeq).toBe(2);
  });

  it("atomic commits are all-or-none: one failure aborts the rest, nothing is written", async () => {
    const { ids, a, server } = await setup();
    const r = await a.commit({ cid: ids.cid(), atomic: true, ops: [ids.put(), ids.put({ base: 7 }), ids.put()] });
    expect(code(r.results[0])).toBe("ABORTED");
    expect(code(r.results[1])).toBe("CONFLICT");
    expect(code(r.results[2])).toBe("ABORTED");
    expect(r.headSeq).toBe(0);
    expect(server.inspect().log).toEqual([]);
  });

  it("atomic swap passes: pathKey uniqueness is checked on the final state", async () => {
    const { ids, a, server } = await setup();
    const pkA = ids.pathKey(), pkB = ids.pathKey();
    const x = ids.put({ pathKey: pkA }), y = ids.put({ pathKey: pkB });
    const r0 = await a.commit({ cid: ids.cid(), ops: [x, y] });
    const sx = ok(r0.results[0]), sy = ok(r0.results[1]);
    const nonAtomic = await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: x.fileId, base: sx, pathKey: pkB })] });
    expect(code(nonAtomic.results[0])).toBe("PATH_TAKEN");
    const swap = await a.commit({
      cid: ids.cid(), atomic: true,
      ops: [ids.put({ fileId: x.fileId, base: sx, pathKey: pkB }), ids.put({ fileId: y.fileId, base: sy, pathKey: pkA })],
    });
    expect(ok(swap.results[0])).toBe(3);
    expect(ok(swap.results[1])).toBe(4);
    expect(server.inspect().livePaths.get(pkA)).toBe(y.fileId);
    expect(server.inspect().livePaths.get(pkB)).toBe(x.fileId);
  });

  it("atomic commit where two new files claim one pathKey fails with PATH_TAKEN", async () => {
    const { ids, a } = await setup();
    const pk = ids.pathKey();
    const r = await a.commit({ cid: ids.cid(), atomic: true, ops: [ids.put({ pathKey: pk }), ids.put({ pathKey: pk })] });
    expect(r.results.map((x) => (x.ok ? "ok" : x.code))).toEqual(["PATH_TAKEN", "PATH_TAKEN"]);
  });

  it("atomic delete + create at the same pathKey passes", async () => {
    const { ids, a } = await setup();
    const pk = ids.pathKey();
    const x = ids.put({ pathKey: pk });
    const sx = ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    const r = await a.commit({ cid: ids.cid(), atomic: true, ops: [ids.del({ fileId: x.fileId, base: sx, pathKey: pk }), ids.put({ pathKey: pk })] });
    expect(r.results.every((x) => x.ok)).toBe(true);
  });
});

describe("FakeRemote blobs and commit checks", () => {
  it("no commit with a missing blob; after upload the same cid succeeds (ops re-evaluated)", async () => {
    const { ids, a, server } = await setup();
    const b1 = ids.blobId(), b2 = ids.blobId();
    expect(await a.putBlob(b1, new Uint8Array([1, 2, 3]))).toBe("stored");
    const req = { cid: ids.cid(), ops: [ids.put({ blobs: [b1, b2] })] };
    const r1 = await a.commit(req);
    expect(r1.results[0]).toEqual({ i: 0, ok: false, code: "MISSING_BLOB", missing: [b2] });
    expect(server.inspect().log).toEqual([]);
    expect(await a.missingBlobs([b1, b2])).toEqual([b2]);
    await a.putBlob(b2, new Uint8Array(10));
    const r2 = await a.commit(req);   // same cid: MISSING_BLOB is re-evaluated (design §2.9.3)
    expect(ok(r2.results[0])).toBe(1);
    expect((await a.commit(req)).results).toEqual(r2.results);   // and now final
    expect(server.inspect().heads[0]?.encSize).toBe(13);
  });

  it("blobs are immutable and idempotent", async () => {
    const { ids, a, server } = await setup();
    const id = ids.blobId();
    expect(await a.putBlob(id, new Uint8Array([1]))).toBe("stored");
    expect(await a.putBlob(id, new Uint8Array([1]))).toBe("present");
    expect(await a.putBlob(id, new Uint8Array([2]))).toBe("present");
    expect(server.stats.blobRewriteMismatches).toBe(1);
    expect([...(await a.getBlob(id))]).toEqual([1]);
    const got = await a.getBlob(id);
    got[0] = 9;
    expect([...(await a.getBlob(id))]).toEqual([1]);
    await expect(a.getBlob(ids.blobId())).rejects.toSatisfy((e: unknown) => isRemoteError(e, "NOT_FOUND"));
  });

  it("getBlobs returns request order up to maxBytes, missing as null, at least one blob", async () => {
    const { ids, a } = await setup();
    const x = ids.blobId(), y = ids.blobId(), z = ids.blobId(), gone = ids.blobId();
    await a.putBlobs([{ id: x, bytes: new Uint8Array(10) }, { id: y, bytes: new Uint8Array(10) }, { id: z, bytes: new Uint8Array(10) }]);
    const m = await a.getBlobs([gone, x, y, z], 25);
    expect([...m.keys()]).toEqual([gone, x, y]);
    expect(m.get(gone)).toBeNull();
    const one = await a.getBlobs([x, y], 1);
    expect([...one.keys()]).toEqual([x]);
  });

  it("KEY_VERSION when kv != activeKv; INVALID for oversize meta", async () => {
    const { ids, a } = await setup();
    const r = await a.commit({ cid: ids.cid(), ops: [ids.put({ kv: 2 })] });
    expect(code(r.results[0])).toBe("KEY_VERSION");
    const big = ids.put();
    big.meta = ids.prng.b64u(17 * 1024);
    expect(code((await a.commit({ cid: ids.cid(), ops: [big] })).results[0])).toBe("INVALID");
  });

  it("rejects malformed commits and too many ops as RemoteErrors", async () => {
    const { ids, a } = await setup({ limits: { maxCommitOps: 2 } });
    await expect(a.commit({ cid: "not-a-uuid", ops: [ids.put()] })).rejects.toSatisfy((e: unknown) => isRemoteError(e, "PROTOCOL"));
    await expect(a.commit({ cid: ids.cid(), ops: [ids.put(), ids.put(), ids.put()] })).rejects.toSatisfy((e: unknown) => isRemoteError(e, "TOO_LARGE"));
  });

  it("QUOTA for blobs and inline bodies past the vault limit", async () => {
    const { ids, a } = await setup({ quotaBytes: 100 });
    await expect(a.putBlob(ids.blobId(), new Uint8Array(101))).rejects.toSatisfy((e: unknown) => isRemoteError(e, "QUOTA"));
    const op = ids.put({ inline: ids.prng.b64u(120) });
    expect(code((await a.commit({ cid: ids.cid(), ops: [op] })).results[0])).toBe("QUOTA");
  });

  it("commit before any vault-info is VAULT_NOT_FOUND", async () => {
    const ids = new TestIds(3);
    const server = new FakeRemoteServer();
    const a = server.adapter();
    await a.connect();
    expect(await a.getVaultInfo()).toBeNull();
    await expect(a.commit({ cid: ids.cid(), ops: [ids.put()] })).rejects.toSatisfy((e: unknown) => isRemoteError(e, "VAULT_NOT_FOUND"));
  });

  it("calls before connect() fail", async () => {
    const server = new FakeRemoteServer();
    const a = server.adapter();
    await expect(a.getVaultInfo()).rejects.toSatisfy((e: unknown) => isRemoteError(e, "PROTOCOL"));
  });
});

describe("FakeRemote cid idempotency (design §2.9.5)", () => {
  it("same cid + same op headers replays the cached result, even with re-sealed meta", async () => {
    const { ids, a, server } = await setup();
    const op = ids.put();
    const cid = ids.cid();
    const r1 = await a.commit({ cid, ops: [op] });
    const r2 = await a.commit({ cid, ops: [{ ...op, meta: ids.sealed() }] });
    expect(r2.replayed).toBe(true);
    expect(r2.results).toEqual(r1.results);
    expect(server.inspect().log).toHaveLength(1);
  });

  it("same cid with different op headers is PROTOCOL", async () => {
    const { ids, a } = await setup();
    const cid = ids.cid();
    await a.commit({ cid, ops: [ids.put()] });
    await expect(a.commit({ cid, ops: [ids.put()] })).rejects.toSatisfy((e: unknown) => isRemoteError(e, "PROTOCOL"));
  });

  it("non-atomic resend keeps final results and re-evaluates only MISSING_BLOB ops", async () => {
    const { ids, a, server } = await setup();
    const blob = ids.blobId();
    const req = { cid: ids.cid(), ops: [ids.put(), ids.put({ blobs: [blob] })] };
    const r1 = await a.commit(req);
    expect(ok(r1.results[0])).toBe(1);
    expect(code(r1.results[1])).toBe("MISSING_BLOB");
    await a.putBlob(blob, new Uint8Array(4));
    const r2 = await a.commit(req);
    expect(r2.replayed).toBe(true);
    expect(ok(r2.results[0])).toBe(1);
    expect(ok(r2.results[1])).toBe(2);
    expect(server.inspect().log).toHaveLength(2);
  });

  it("atomic resend after MISSING_BLOB re-evaluates the whole commit", async () => {
    const { ids, a } = await setup();
    const blob = ids.blobId();
    const req = { cid: ids.cid(), atomic: true, ops: [ids.put(), ids.put({ blobs: [blob] })] };
    const r1 = await a.commit(req);
    expect(r1.results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ABORTED", "MISSING_BLOB"]);
    await a.putBlob(blob, new Uint8Array(4));
    const r2 = await a.commit(req);
    expect(r2.results.map((r) => (r.ok ? r.seqs[0] : r.code))).toEqual([1, 2]);
  });

  it("cached CONFLICT stays final on replay", async () => {
    const { ids, a } = await setup();
    const cid = ids.cid();
    const op = ids.put({ base: 3 });
    const r1 = await a.commit({ cid, ops: [op] });
    expect(code(r1.results[0])).toBe("CONFLICT");
    expect((await a.commit({ cid, ops: [op] })).results).toEqual(r1.results);
  });

  it("response lost after commit: the retry with the same cid gets the original seqs", async () => {
    const { ids, a, server } = await setup();
    server.injectFault({ method: "commit", when: "after" });
    const req = { cid: ids.cid(), ops: [ids.put()] };
    await expect(a.commit(req)).rejects.toSatisfy((e: unknown) => isRemoteError(e, "NETWORK") && (e as RemoteError).retryable);
    expect(server.inspect().log).toHaveLength(1);
    const again = await a.commit(req);
    expect(again.replayed).toBe(true);
    expect(ok(again.results[0])).toBe(1);
  });

  it("cid caches are per device", async () => {
    const { ids, a, b } = await setup();
    const cid = ids.cid();
    await a.commit({ cid, ops: [ids.put()] });
    const r = await b.commit({ cid, ops: [ids.put()] });
    expect(r.replayed).toBe(false);
  });
});

describe("FakeRemote fault injection", () => {
  it("'before' faults leave no trace and honor skip/times/device", async () => {
    const { ids, a, b, server } = await setup();
    server.injectFault({ method: "putBlob", device: a.deviceId, skip: 1, times: 2, error: remoteError("UNAVAILABLE", "test") });
    const id = ids.blobId();
    expect(await a.putBlob(id, new Uint8Array(1))).toBe("stored");
    await expect(a.putBlob(ids.blobId(), new Uint8Array(1))).rejects.toSatisfy((e: unknown) => isRemoteError(e, "UNAVAILABLE"));
    expect(await b.putBlob(ids.blobId(), new Uint8Array(1))).toBe("stored");
    await expect(a.putBlob(ids.blobId(), new Uint8Array(1))).rejects.toSatisfy((e: unknown) => isRemoteError(e, "UNAVAILABLE"));
    expect(await a.putBlob(ids.blobId(), new Uint8Array(1))).toBe("stored");
    expect(server.inspect().blobIds).toHaveLength(3);
  });

  it("'after' faults hit only the matching call, also when calls overlap", async () => {
    const { ids, a, b, server } = await setup();
    server.injectFault({ method: "putBlob", when: "after", device: a.deviceId, error: remoteError("TIMEOUT", "lost") });
    const [ra, rb] = await Promise.allSettled([a.putBlob(ids.blobId(), new Uint8Array(1)), b.putBlob(ids.blobId(), new Uint8Array(1))]);
    expect(ra.status === "rejected" && isRemoteError(ra.reason, "TIMEOUT")).toBe(true);
    expect(rb).toEqual({ status: "fulfilled", value: "stored" });
    expect(server.inspect().blobIds).toHaveLength(2);
  });

  it("subscribe can be failed", async () => {
    const { a, server } = await setup();
    server.injectFault({ method: "subscribe" });
    expect(() => a.subscribe(0, new RecordingSink())).toThrow(/injected/);
    expect(server.subs.size).toBe(0);
  });

  it("onCall sees every call", async () => {
    const { ids, a, server } = await setup();
    const seen: string[] = [];
    server.onCall = (c) => { seen.push(c.method); };
    await a.missingBlobs([ids.blobId()]);
    expect(seen).toEqual(["missingBlobs"]);
  });
});

describe("FakeRemote change feed", () => {
  it("catch-up is coalesced (≤1 head per fileId, no archive), then live batches are contiguous", async () => {
    const { ids, a, b, server } = await setup();
    const x = ids.put();
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    const s2 = ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: x.fileId, base: s1, pathKey: x.pathKey })] })).results[0]);
    ok((await a.commit({ cid: ids.cid(), ops: [ids.archive({ fileId: x.fileId, base: s1, pathKey: x.pathKey })] })).results[0]);
    const y = ids.put();
    ok((await a.commit({ cid: ids.cid(), ops: [y] })).results[0]);

    const sink = new RecordingSink();
    b.subscribe(0, sink);
    await server.settle();
    expect(sink.batches).toHaveLength(1);
    const c = sink.batches[0] as ChangeBatch;
    expect(c).toMatchObject({ from: 0, to: 4, headSeq: 4, more: false, live: false });
    expect(c.records.map((r) => r.seq)).toEqual([s2, 4]);
    expect(sink.states).toEqual(["connected", "catching-up", "live"]);

    const s5 = ok((await a.commit({ cid: ids.cid(), ops: [ids.archive({ fileId: x.fileId, base: s2, pathKey: x.pathKey })] })).results[0]);
    const s6 = ok((await a.commit({ cid: ids.cid(), ops: [ids.put()] })).results[0]);
    await server.settle();
    const live = sink.batches.slice(1);
    expect(live.map((l) => [l.from, l.to, l.live])).toEqual([[4, s5, true], [s5, s6, true]]);
    expect(live[0]?.records[0]?.kind).toBe("archive");
    expect(server.devices.get(b.deviceId)?.ackedSeq).toBe(s6);
  });

  it("catch-up pages respect the page size and keep from == previous to", async () => {
    const { ids, a, b, server } = await setup({ catchUpPage: 2 });
    for (let i = 0; i < 5; i++) ok((await a.commit({ cid: ids.cid(), ops: [ids.put()] })).results[0]);
    const sink = new RecordingSink();
    b.subscribe(0, sink);
    await server.settle();
    expect(sink.batches.map((x) => [x.from, x.to, x.more])).toEqual([[0, 2, true], [2, 4, true], [4, 5, false]]);
  });

  it("the committer receives its own records", async () => {
    const { ids, a, server } = await setup();
    const sink = new RecordingSink();
    a.subscribe(0, sink);
    await server.settle();
    const r = await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    await server.settle();
    expect(sink.records().map((x) => x.seq)).toEqual([ok(r.results[0])]);
    expect(sink.records()[0]?.cid).toBe(r.cid);
  });

  it("next batch is delivered only after onChanges resolved (flow control) and acks follow it", async () => {
    const { ids, a, b, server } = await setup();
    const sink = new RecordingSink();
    b.subscribe(0, sink);
    await server.settle();
    let release!: () => void;
    sink.hold = new Promise<void>((r) => { release = r; });
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.batches).toHaveLength(1);
    expect(server.devices.get(b.deviceId)?.ackedSeq).toBe(0);
    release();
    sink.hold = null;
    await server.settle();
    expect(sink.batches).toHaveLength(3);
    expect(server.devices.get(b.deviceId)?.ackedSeq).toBe(2);
  });

  it("commits during catch-up are not lost or duplicated", async () => {
    const { ids, a, b, server } = await setup({ catchUpPage: 1 });
    for (let i = 0; i < 3; i++) await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    const sink = new RecordingSink();
    let injected = false;
    const orig = sink.onChanges.bind(sink);
    sink.onChanges = async (batch) => {
      await orig(batch);
      if (!injected) { injected = true; await a.commit({ cid: ids.cid(), ops: [ids.put()] }); }
    };
    b.subscribe(0, sink);
    await server.settle();
    const seqs = sink.records().map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < sink.batches.length; i++) expect(sink.batches[i]?.from).toBe(sink.batches[i - 1]?.to);
  });

  it("since null, since < minSeq and a changed epoch require a snapshot", async () => {
    const { ids, a, b, server } = await setup();
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    const s1 = new RecordingSink();
    b.subscribe(null, s1);
    await server.settle();
    expect(s1.snapshots.map((x) => x.reason)).toEqual(["no-cursor"]);
    expect(s1.batches).toEqual([]);
    server.setMinSeq(1);
    const s2 = new RecordingSink();
    b.subscribe(0, s2);
    await server.settle();
    expect(s2.snapshots[0]).toMatchObject({ reason: "cursor-too-old", minSeq: 1 });
    await expect(b.pull(0)).rejects.toSatisfy((e: unknown) => isRemoteError(e, "SNAPSHOT_REQUIRED"));
    const info = (await a.getVaultInfo())!.info;
    const s3 = new RecordingSink();
    b.subscribe(1, s3);
    await server.settle();
    await a.rebuild({ ...info, epoch: 2, infoRev: 2 });
    await server.settle();
    expect(s3.snapshots.map((x) => x.reason)).toEqual(["epoch"]);
    await expect(b.pull(1)).rejects.toSatisfy((e: unknown) => isRemoteError(e, "SNAPSHOT_REQUIRED"));
    // after reconnecting and bootstrapping, the device follows the new epoch
    await b.connect();
    const page = await b.snapshot({ tombstones: true });
    expect(page.epoch).toBe(2);
    expect(page.records).toEqual([]);
    expect(page.headSeq).toBe(1);   // head_seq is kept across rebuild (ID-10)
  });

  it("rebuild (design §2.11): the rebuilding device's own feed stays live and its creates commit", async () => {
    const { a, b, server, ids } = await setup();
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    const own = new RecordingSink();
    const other = new RecordingSink();
    a.subscribe(1, own);
    b.subscribe(1, other);
    await server.settle();
    const info = (await a.getVaultInfo())!.info;
    await a.rebuild({ ...info, epoch: 2, infoRev: 2 });
    await server.settle();
    expect(other.snapshots.map((x) => x.reason)).toEqual(["epoch"]);
    expect(own.snapshots).toEqual([]);
    // step 4: upload as creates; the own feed delivers them from the kept head_seq.
    const r = await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    expect(r.results[0]).toMatchObject({ ok: true, seqs: [2] });
    await server.settle();
    expect(own.batches.flatMap((x) => x.records.map((rec) => rec.seq))).toContain(2);
    expect(server.devices.get(b.deviceId)?.ackedSeq ?? null).toBeNull();
  });

  it("vault-info updates are CAS'd and broadcast", async () => {
    const { a, b, server } = await setup();
    const sink = new RecordingSink();
    b.subscribe(0, sink);
    await server.settle();
    const cur = (await a.getVaultInfo())!;
    await expect(a.updateVaultInfo({ ...cur.info, infoRev: 2 }, "\"stale\"")).rejects.toSatisfy((e: unknown) => isRemoteError(e, "PRECONDITION_FAILED"));
    const { etag } = await a.updateVaultInfo({ ...cur.info, infoRev: 2 }, cur.etag);
    await expect(a.createVaultInfo(cur.info)).rejects.toSatisfy((e: unknown) => isRemoteError(e, "ALREADY_EXISTS"));
    await server.settle();
    expect(sink.infos).toEqual([etag]);
  });

  it("manual delivery holds batches until deliver()", async () => {
    const { ids, a, b, server } = await setup({ autoDeliver: false });
    const sink = new RecordingSink();
    b.subscribe(0, sink);
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.batches).toEqual([]);
    await server.deliver();
    expect(sink.records()).toHaveLength(1);
  });

  it("disconnect and revoke close feeds; revoked devices are refused", async () => {
    const { ids, a, b, server } = await setup();
    const sink = new RecordingSink();
    b.subscribe(0, sink);
    await server.settle();
    server.disconnect(b.deviceId);
    await server.settle();
    expect(sink.states.at(-1)).toBe("offline");
    const sink2 = new RecordingSink();
    b.subscribe(0, sink2);
    await server.settle();
    await a.revokeDevice(b.deviceId);
    await server.settle();
    expect(sink2.states.at(-1)).toBe("auth-error");
    expect(sink2.errors[0]?.code).toBe("REVOKED");
    await expect(b.commit({ cid: ids.cid(), ops: [ids.put()] })).rejects.toSatisfy((e: unknown) => isRemoteError(e, "REVOKED"));
    const devices = await a.listDevices();
    expect(devices.find((d) => d.deviceId === b.deviceId)?.revoked).toBe(true);
    expect(devices.find((d) => d.current)?.deviceId).toBe(a.deviceId);
  });

  it("a rejected onChanges is not acked and drops the feed", async () => {
    const { ids, a, b, server } = await setup();
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    const sink = new RecordingSink();
    sink.onChanges = async () => { throw new Error("disk full"); };
    b.subscribe(0, sink);
    await server.settle();
    expect(server.devices.get(b.deviceId)?.ackedSeq).toBeNull();
    expect(sink.states.at(-1)).toBe("offline");
  });

  it("requireSubscription refuses commits without a feed", async () => {
    const { ids, a } = await setup({ requireSubscription: true });
    await expect(a.commit({ cid: ids.cid(), ops: [ids.put()] })).rejects.toSatisfy((e: unknown) => isRemoteError(e, "PROTOCOL"));
    a.subscribe(0, new RecordingSink());
    expect((await a.commit({ cid: ids.cid(), ops: [ids.put()] })).results[0]?.ok).toBe(true);
  });
});

describe("FakeRemote pull, snapshot and history", () => {
  it("pull returns one coalesced page", async () => {
    const { ids, a } = await setup();
    const x = ids.put();
    const s1 = ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: x.fileId, base: s1, pathKey: x.pathKey })] });
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    const p1 = await a.pull(0, 1);
    expect(p1).toMatchObject({ from: 0, to: 2, more: true });
    const p2 = await a.pull(p1.to, 10);
    expect(p2).toMatchObject({ from: 2, to: 3, more: false, headSeq: 3 });
    expect(p2.records.map((r) => r.seq)).toEqual([3]);
  });

  it("snapshot pages by fileId with the first page's headSeq; tombstones optional", async () => {
    const { ids, a } = await setup();
    const files = [ids.put(), ids.put(), ids.put()];
    const r = await a.commit({ cid: ids.cid(), ops: files });
    const f0 = files[0]!;
    await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: f0.fileId, base: ok(r.results[0]), pathKey: f0.pathKey })] });
    const p1 = await a.snapshot({ tombstones: true, limit: 2 });
    expect(validateSnapshotPage(p1).ok).toBe(true);
    expect(p1.records).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    await a.commit({ cid: ids.cid(), ops: [ids.put()] });
    const p2 = await a.snapshot({ tombstones: true, limit: 2, pageToken: p1.next });
    const all = [...p1.records, ...p2.records].map((x) => x.fileId);
    expect(all).toEqual([...all].sort());
    expect(p1.headSeq).toBe(4);
    const live = await a.snapshot({ tombstones: false });
    expect(live.records.every((x) => x.kind === "put")).toBe(true);
    expect(live.records).toHaveLength(3);
  });

  it("listVersions / listDeleted page newest first; expire keeps heads and bases", async () => {
    const { ids, a, server } = await setup();
    const x = ids.put();
    let base = ok((await a.commit({ cid: ids.cid(), ops: [x] })).results[0]);
    for (let i = 0; i < 3; i++) base = ok((await a.commit({ cid: ids.cid(), ops: [ids.put({ fileId: x.fileId, base, pathKey: x.pathKey })] })).results[0]);
    const v = await a.listVersions(x.fileId, { limit: 3 });
    expect(v.records.map((r) => r.seq)).toEqual([4, 3, 2]);
    expect(v.next).toBe(2);
    const y = ids.put();
    const sy = ok((await a.commit({ cid: ids.cid(), ops: [y] })).results[0]);
    const sd = ok((await a.commit({ cid: ids.cid(), ops: [ids.del({ fileId: y.fileId, base: sy, pathKey: y.pathKey })] })).results[0]);
    expect((await a.listDeleted()).records.map((r) => r.seq)).toEqual([sd]);
    server.expire(4);
    // head (4) and its base (3) stay; 1 and 2 go; the young tombstone (6 > 4) stays
    expect((await a.listVersions(x.fileId)).records.map((r) => r.seq)).toEqual([4, 3]);
    server.expire(sd);
    expect((await a.listDeleted()).records).toEqual([]);
    expect(server.minSeq).toBe(sd);
  });

  it("usage, pairing mailbox, enroll codes, maintenance", async () => {
    const { ids, a, b, server } = await setup();
    await a.putBlob(ids.blobId(), new Uint8Array(50));
    expect((await a.usage()).blobCount).toBe(1);
    const pairId = ids.prng.b64u(16);
    await a.pairingPut(pairId, "{\"pk\":\"x\"}");
    await expect(a.pairingPut(pairId, "{}")).rejects.toSatisfy((e: unknown) => isRemoteError(e, "ALREADY_EXISTS"));
    expect(await b.pairingTake(pairId)).toBe("{\"pk\":\"x\"}");
    expect(await b.pairingTake(pairId)).toBeNull();
    const code = await a.createEnrollCode(900);
    expect(code.code).toMatch(/^SXE-[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    expect(code.link).toContain("sync.example.com");
    expect(await a.runMaintenance()).toEqual({ ran: false });
    void server;
  });
});

describe("FakeRemote is an isolated model", () => {
  it("returned records are copies", async () => {
    const { ids, a } = await setup();
    const x = ids.put();
    const r = await a.commit({ cid: ids.cid(), ops: [x] });
    const v = (await a.getVersion(x.fileId, ok(r.results[0])))!;
    v.meta = "tampered";
    expect((await a.getVersion(x.fileId, 1))!.meta).not.toBe("tampered");
  });

  it("FakeRemote satisfies RemoteAdapter", () => {
    const remote: import("@shuttle/protocol").RemoteAdapter = new FakeRemoteServer().adapter();
    expect(remote).toBeInstanceOf(FakeRemote);
  });
});
