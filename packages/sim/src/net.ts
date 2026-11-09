// SimNet (design §7.4, ops-spec §3.4): a RemoteAdapter proxy between one simulated device and the
// shared FakeRemoteServer. Faults are drawn from the device's own seeded stream, so a run replays bit
// for bit. Supported here: offline (every call fails, the feed reports 'offline'), drop the request
// (nothing applied), drop the response (applied, the client sees NETWORK and retries: cid replay),
// duplicate a commit (the second send must be a replay), injected 5xx / QUOTA answers. Push-frame
// reorder, MISSING_BLOB GC races and truncated bodies need hooks inside testkit (openIssues).
//
// The proxy also records every commit for the oracles: I5 (blobs before meta) is checked on every
// successful op right after the server applied it, and I16 counts commits per device.

import type {
  BlobId, ChangeSink, CommitRequest, CommitResponse, ConnectInfo, RemoteAdapter, RemoteCapabilities, RemoteError, Seq,
  Subscription, VaultInfo,
} from "@shuttle/protocol";
import { remoteError } from "@shuttle/protocol";
import type { FakeRemote, FakeRemoteServer, Prng } from "@shuttle/testkit";

export interface NetFaultRates {
  /** Per call: fail with NETWORK before the server sees it. */
  dropRequest: number;
  /** Per mutating call: apply, then lose the response (NETWORK). */
  dropResponse: number;
  /** Per commit: send it twice (the second must be a cid replay). */
  duplicate: number;
  /** Per call: answer UNAVAILABLE (5xx) before the server sees it. */
  serverError: number;
}

export const NO_FAULTS: NetFaultRates = { dropRequest: 0, dropResponse: 0, duplicate: 0, serverError: 0 };

export interface CommitRecord {
  device: string;
  step: number;
  ops: number;
  okOps: number;
  kinds: string[];
  replayed: boolean;
}

export interface NetViolation { inv: string; detail: string }

/** Methods that change server state: a lost response still applied them. */
const MUTATING = new Set(["commit", "putBlob", "putBlobs", "createVaultInfo", "updateVaultInfo", "rebuild"]);
/** Methods the fault draw applies to (connect/close/ack stay reliable: offline covers connect). */
const FAULTABLE = new Set(["commit", "putBlob", "putBlobs", "getBlob", "getBlobs", "missingBlobs", "pull", "snapshot", "getVersion", "getVaultInfo"]);

export class SimNet implements RemoteAdapter {
  readonly kind = "fake";
  private inner: FakeRemote;
  offline = false;
  rates: NetFaultRates = NO_FAULTS;
  /** Current step, stamped on every commit record. */
  step = 0;
  readonly faults: Array<{ step: number; method: string; fault: string }> = [];

  constructor(
    private server: FakeRemoteServer, readonly deviceId: string, private readonly name: string, private readonly prng: Prng,
    private readonly commits: CommitRecord[], private readonly violations: NetViolation[],
  ) {
    this.inner = server.adapter(deviceId, { name });
  }

  /**
   * Server restored from a backup (design §2.6.1): while set, every subscribe whose hello does not
   * carry `rollbackAck === rollbackAt` answers snapshotRequired{reason:'rollback'} instead of opening
   * the feed. A matching ack is stored for this device (`device_cursors.rollback_ack`) and clears it.
   */
  rollbackAt: number | null = null;
  /** The hello fields the engine supplies (ServerAdapter `session` option; engine.helloContext()). */
  session: (() => { rollbackAck: number | null }) | null = null;

  /** Point this proxy at another server (the DB-restore fault builds a new server object). */
  rebind(server: FakeRemoteServer, rollbackAt: number | null = null): void {
    this.server = server;
    this.inner = server.adapter(this.deviceId, { name: this.name });
    this.rollbackAt = rollbackAt;
  }

  get capabilities(): RemoteCapabilities {
    return this.inner.capabilities;
  }

  private draw(method: string): void {
    if (this.offline) throw remoteError("NETWORK", `sim offline (${method})`);
    if (!FAULTABLE.has(method)) return;
    const r = this.rates;
    if (r.dropRequest > 0 && this.prng.float() < r.dropRequest) {
      this.faults.push({ step: this.step, method, fault: "dropRequest" });
      throw remoteError("NETWORK", `sim dropped request (${method})`);
    }
    if (r.serverError > 0 && this.prng.float() < r.serverError) {
      this.faults.push({ step: this.step, method, fault: "5xx" });
      throw remoteError("UNAVAILABLE", `sim server error (${method})`);
    }
  }

  private loseResponse(method: string): RemoteError | null {
    if (!MUTATING.has(method) || this.rates.dropResponse <= 0) return null;
    if (this.prng.float() >= this.rates.dropResponse) return null;
    this.faults.push({ step: this.step, method, fault: "dropResponse" });
    return remoteError("NETWORK", `sim lost the response (${method})`);
  }

  private async call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    this.draw(method);
    const out = await fn();
    const lost = this.loseResponse(method);
    if (lost) throw lost;
    return out;
  }

  connect(): Promise<ConnectInfo> {
    if (this.offline) return Promise.reject(remoteError("NETWORK", "sim offline (connect)"));
    return this.inner.connect();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  getVaultInfo(): Promise<{ info: VaultInfo; etag: string } | null> {
    return this.call("getVaultInfo", () => this.inner.getVaultInfo());
  }

  createVaultInfo(info: VaultInfo): Promise<{ etag: string }> {
    return this.call("createVaultInfo", () => this.inner.createVaultInfo(info));
  }

  updateVaultInfo(info: VaultInfo, ifMatch: string): Promise<{ etag: string }> {
    return this.call("updateVaultInfo", () => this.inner.updateVaultInfo(info, ifMatch));
  }

  missingBlobs(ids: BlobId[]): Promise<BlobId[]> {
    return this.call("missingBlobs", () => this.inner.missingBlobs(ids));
  }

  putBlob(id: BlobId, bytes: Uint8Array): Promise<'stored' | 'present'> {
    return this.call("putBlob", () => this.inner.putBlob(id, bytes));
  }

  getBlob(id: BlobId): Promise<Uint8Array> {
    return this.call("getBlob", () => this.inner.getBlob(id));
  }

  putBlobs(items: Array<{ id: BlobId; bytes: Uint8Array }>): Promise<void> {
    return this.call("putBlobs", () => this.inner.putBlobs(items));
  }

  getBlobs(ids: BlobId[], maxBytes: number): Promise<Map<BlobId, Uint8Array | null>> {
    return this.call("getBlobs", () => this.inner.getBlobs(ids, maxBytes));
  }

  async commit(req: CommitRequest): Promise<CommitResponse> {
    this.draw("commit");
    let res = await this.inner.commit(req);
    this.record(req, res);
    if (this.rates.duplicate > 0 && this.prng.float() < this.rates.duplicate) {
      this.faults.push({ step: this.step, method: "commit", fault: "duplicate" });
      const again = await this.inner.commit(req);
      if (!again.replayed) this.violations.push({ inv: "I3", detail: `duplicate commit ${req.cid} was not a replay` });
      this.record(req, again);
      res = again;
    }
    const lost = this.loseResponse("commit");
    if (lost) throw lost;
    return res;
  }

  /** I5: every op the server accepted references only blobs the server holds. */
  private record(req: CommitRequest, res: CommitResponse): void {
    let okOps = 0;
    for (const r of res.results) {
      if (!r.ok) continue;
      okOps++;
      const op = req.ops[r.i];
      if (!op || op.op === "del") continue;
      for (const b of op.blobs) {
        if (!this.server.hasBlob(b)) this.violations.push({ inv: "I5", detail: `step ${this.step}: ${this.name} committed op ${r.i} (${op.op}) referencing missing blob ${b}` });
      }
    }
    this.commits.push({ device: this.name, step: this.step, ops: req.ops.length, okOps, kinds: req.ops.map((o) => o.op), replayed: res.replayed });
  }

  pull(since: Seq, limit?: number) {
    return this.call("pull", () => this.inner.pull(since, limit));
  }

  subscribe(since: Seq | null, sink: ChangeSink): Subscription {
    if (this.offline) {
      // The socket never opens: report offline after the call returns (never inside it).
      let closed = false;
      this.server.later(() => { if (!closed) sink.onState("offline", "sim offline"); });
      return { close: () => { closed = true; }, nudge: () => undefined };
    }
    if (this.rollbackAt !== null && this.session?.().rollbackAck === this.rollbackAt) this.rollbackAt = null;
    if (this.rollbackAt !== null) {
      const info = { reason: "rollback" as const, minSeq: this.server.minSeq, epoch: this.server.epoch, rollbackAt: this.rollbackAt };
      let closed = false;
      this.server.later(() => { if (!closed) sink.onSnapshotRequired(info); });
      return { close: () => { closed = true; }, nudge: () => undefined };
    }
    return this.inner.subscribe(since, sink);
  }

  snapshot(opts: { pageToken?: string | null; limit?: number; tombstones: boolean; history?: boolean }) {
    return this.call("snapshot", () => this.inner.snapshot(opts));
  }

  ack(upTo: Seq): void {
    if (this.offline) return;
    this.inner.ack(upTo);
  }

  getVersion(fileId: string, seq: Seq) {
    return this.call("getVersion", () => this.inner.getVersion(fileId, seq));
  }

  listVersions(fileId: string, opts?: { before?: Seq; limit?: number }) {
    return this.call("listVersions", () => this.inner.listVersions(fileId, opts));
  }

  listDeleted(opts?: { before?: Seq; limit?: number }) {
    return this.call("listDeleted", () => this.inner.listDeleted(opts));
  }

  usage() {
    return this.call("usage", () => this.inner.usage());
  }

  listDevices() {
    return this.call("listDevices", () => this.inner.listDevices());
  }

  revokeDevice(id: string): Promise<void> {
    return this.call("revokeDevice", () => this.inner.revokeDevice(id));
  }

  createEnrollCode(ttlSec: number) {
    return this.call("createEnrollCode", () => this.inner.createEnrollCode(ttlSec));
  }

  pairingPut(pairId: string, body: string): Promise<void> {
    return this.call("pairingPut", () => this.inner.pairingPut(pairId, body));
  }

  pairingTake(pairId: string): Promise<string | null> {
    return this.call("pairingTake", () => this.inner.pairingTake(pairId));
  }

  runMaintenance(signal?: AbortSignal) {
    return this.call("runMaintenance", () => this.inner.runMaintenance(signal));
  }

  rebuild(info: VaultInfo): Promise<{ epoch: number }> {
    return this.call("rebuild", () => this.inner.rebuild(info));
  }
}
