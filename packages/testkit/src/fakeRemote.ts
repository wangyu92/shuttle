// In-memory reference remote (design §2.1-2.5, §2.9.5-2.9.7; engine-spec §15 "an in-memory RemoteStore
// reference implementation (log + CAS + cid dedupe + optional compaction)").
//
// FakeRemoteServer holds the shared state of one vault: one ordered log, heads per fileId with CAS,
// pathKey uniqueness among live heads (PATH_TAKEN), immutable blobs, no commit that references a
// missing blob, cid replay, change push to subscribers. Each device talks to it through its own
// FakeRemote, which implements the full RemoteAdapter interface.
//
// Delivery of pushed batches is asynchronous and ordered: every subscription has its own queue, the
// next batch is handed to `sink.onChanges` only after the previous one resolved (flow control, design
// §2.9.4), and the device's ack cursor advances only then. With `autoDeliver: false` nothing is
// delivered until `server.deliver()` is awaited, so a simulator can interleave devices explicitly.
// `await server.settle()` waits until every queue is empty.
//
// Faults: `injectFault` throws a RemoteError before a call (nothing happened) or after it (the call
// took effect, the response was lost: the cid-replay case). `onCall` runs before every call.

import {
  CHANGES_LIMIT_DEFAULT, DEFAULT_LIMITS, ENCSIZE_SLACK, ENROLL_CODE_PREFIX, MAX_MISSING_IDS, MAX_PACK_ENTRIES,
  MAX_PAIRING_BODY, PAIRING_TTL_SEC, SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX,
  b64uDecodedLength, checkCommitLimits, checkOpSizes, isBlobId, opsDigestPreimage, remoteError, utf8Length,
  validateCommitRequest,
} from "@shuttle/protocol";
import type {
  AdapterDevice, BlobId, ChangeBatch, ChangeSink, Clock, CommitOp, CommitRequest, CommitResponse, ConnectInfo,
  ConnectionState, DeviceId, FileId, MaintenanceResult, OpResult, PathKey, RemoteAdapter, RemoteCapabilities,
  RemoteError, Retention, Seq, SnapshotPage, SnapshotReason, Subscription, UsageInfo, VaultInfo, VersionRecord,
  WelcomeLimits,
} from "@shuttle/protocol";
import { FakeClock } from "./clock";
import { Prng } from "./prng";

const realSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis);
const clone = <T>(v: T): T => structuredClone(v);

export type FakeMethod = Exclude<keyof RemoteAdapter, 'kind' | 'capabilities'>;

export interface FaultSpec {
  /** Method to fail, or '*' for any. */
  method: FakeMethod | '*';
  /** 'before': nothing happens. 'after': the call takes effect, then the response is lost. Default 'before'. */
  when?: 'before' | 'after';
  /** Thrown error. Default: NETWORK (retryable). */
  error?: RemoteError;
  /** Only calls from this device. */
  device?: DeviceId;
  /** Skip this many matching calls first. */
  skip?: number;
  /** How many calls to fail (default 1). */
  times?: number;
}

export interface FakeCall { device: DeviceId; method: FakeMethod; args: readonly unknown[] }

export interface FakeRemoteOptions {
  /** Server clock (separate from device clocks). */
  clock?: Clock;
  prng?: Prng;
  capabilities?: Partial<Omit<RemoteCapabilities, 'limits'>>;
  limits?: Partial<WelcomeLimits>;
  retention?: Retention;
  quotaBytes?: number | null;
  /** Deliver pushed batches automatically (default true). */
  autoDeliver?: boolean;
  /** commit() fails with PROTOCOL unless the device has an open subscription (design §2.12 comment). Default false. */
  requireSubscription?: boolean;
  /** Records per catch-up page (default 1000, design §2.9.6). */
  catchUpPage?: number;
}

export interface DeviceRow {
  deviceId: DeviceId; name: string; platform: string; clientVersion: string;
  createdAt: number; lastSeenAt: number; revoked: boolean; ackedSeq: Seq | null;
}

/** Cached op results that a resend with the same cid evaluates again. */
const RETRY_ON_RESEND: ReadonlySet<string> = new Set(["MISSING_BLOB", "QUOTA", "ABORTED"]);

const DEFAULT_RETENTION: Retention = { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90, thinAfterHours: 24, thinBucketMinutes: 60 };

export class FakeRemoteServer {
  readonly clock: Clock;
  readonly prng: Prng;
  readonly limits: WelcomeLimits;
  readonly capabilities: RemoteCapabilities;
  retention: Retention;
  quotaBytes: number | null;
  autoDeliver: boolean;
  requireSubscription: boolean;
  readonly catchUpPage: number;

  // ---- vault state ----
  headSeq: Seq = 0;
  minSeq: Seq = 0;
  epoch = 1;
  private info: VaultInfo | null = null;
  private infoEtag: string | null = null;
  private etagCounter = 0;
  /** Every retained record by seq (put, del, archive). */
  private readonly log = new Map<Seq, VersionRecord>();
  /** Head seq per fileId (put/del only). */
  private readonly heads = new Map<FileId, Seq>();
  /** pathKey → fileId among LIVE heads. */
  private readonly livePath = new Map<PathKey, FileId>();
  private readonly blobs = new Map<BlobId, Uint8Array>();
  private readonly commitCache = new Map<string, { digest: string; response: CommitResponse }>();
  private readonly pairing = new Map<string, { body: string; expiresAt: number }>();
  readonly devices = new Map<DeviceId, DeviceRow>();
  /** @internal */ readonly subs = new Set<FakeSubscription>();

  // ---- test hooks ----
  private faults: Array<Required<Pick<FaultSpec, 'method' | 'when' | 'skip' | 'times'>> & FaultSpec> = [];
  onCall: ((call: FakeCall) => void | Promise<void>) | null = null;
  feedPaused = false;
  readonly stats = {
    commits: 0, replays: 0, opsOk: 0, opsFailed: 0, blobPuts: 0, blobPresent: 0,
    /** putBlob of an existing id with different bytes (blob ids are content-derived: must stay 0). */
    blobRewriteMismatches: 0,
    pulls: 0, snapshots: 0, batchesDelivered: 0,
  };
  /** Every call, in order (method and device only), for assertions. */
  readonly calls: Array<{ device: DeviceId; method: FakeMethod }> = [];

  constructor(o: FakeRemoteOptions = {}) {
    this.clock = o.clock ?? new FakeClock();
    this.prng = o.prng ?? new Prng("fake-remote");
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.retention = o.retention ?? { ...DEFAULT_RETENTION };
    this.quotaBytes = o.quotaBytes ?? null;
    this.autoDeliver = o.autoDeliver ?? true;
    this.requireSubscription = o.requireSubscription ?? false;
    this.catchUpPage = o.catchUpPage ?? 1000;
    const l = this.limits;
    this.capabilities = {
      changeFeed: "push", cas: "strong", atomicCommit: true, serverHistory: true, maintenance: "server",
      snapshots: "server", blobBatch: true, revocation: true, deviceRegistry: "server", serverTimestamps: true,
      enforcesActiveKv: true, usage: "exact",
      ...o.capabilities,
      limits: {
        maxBlobSize: l.maxBlobSize, maxCommitOps: l.maxCommitOps, maxCommitBytes: l.maxCommitBytes,
        maxInFlightCommits: l.maxInFlightCommits, maxFileSize: l.maxFileSize, inlineMax: l.inlineMax, maxPackBytes: l.maxPackBytes,
      },
    };
  }

  /** A RemoteAdapter for one device. Registers the device on first use. */
  adapter(deviceId?: DeviceId, o: { name?: string; platform?: string; clientVersion?: string } = {}): FakeRemote {
    const id = deviceId ?? this.prng.b64u(16);
    if (!this.devices.has(id)) {
      const now = this.clock.now();
      this.devices.set(id, {
        deviceId: id, name: o.name ?? `device-${this.devices.size + 1}`, platform: o.platform ?? "test",
        clientVersion: o.clientVersion ?? "0.0.0", createdAt: now, lastSeenAt: now, revoked: false, ackedSeq: null,
      });
    }
    return new FakeRemote(this, id);
  }

  // ---------------- test controls ----------------

  injectFault(f: FaultSpec): void {
    this.faults.push({ ...f, method: f.method, when: f.when ?? "before", skip: f.skip ?? 0, times: f.times ?? 1 });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /**
   * @internal Consume a matching fault. Throws for a 'before' fault; returns the error to throw after
   * the call took effect for an 'after' fault; null when nothing matches.
   */
  takeFault(device: DeviceId, method: FakeMethod): RemoteError | null {
    for (const f of this.faults) {
      if (f.times <= 0) continue;
      if (f.method !== "*" && f.method !== method) continue;
      if (f.device !== undefined && f.device !== device) continue;
      if (f.skip > 0) { f.skip--; continue; }
      f.times--;
      this.faults = this.faults.filter((x) => x.times > 0);
      if (f.when === "before") throw f.error ?? remoteError("NETWORK", `injected network failure before ${method}`);
      return f.error ?? remoteError("NETWORK", `injected response loss after ${method}`);
    }
    return null;
  }

  /** @internal */
  async enter(device: DeviceId, method: FakeMethod, args: readonly unknown[]): Promise<RemoteError | null> {
    this.calls.push({ device, method });
    if (this.onCall) await this.onCall({ device, method, args });
    return this.takeFault(device, method);
  }

  private pendingNotes = 0;
  /** @internal Sink callbacks never run inside the adapter call that caused them; settle() waits for them. */
  later(fn: () => void): void {
    this.pendingNotes++;
    realSetTimeout(() => {
      this.pendingNotes--;
      fn();
    }, 0);
  }

  /** Stop / restart pushing batches (subscriptions stay open). */
  pauseFeed(): void { this.feedPaused = true; }
  resumeFeed(): void { this.feedPaused = false; this.kickAll(); }

  /** Drop every open subscription of `device` (or all): sinks see 'offline'. */
  disconnect(device?: DeviceId): void {
    for (const s of [...this.subs]) if (device === undefined || s.device === device) s.terminate("offline", "disconnected by test");
  }

  /** Deliver queued batches until every subscription is idle (manual or auto mode). */
  async deliver(): Promise<void> {
    for (let rounds = 0; rounds < 100_000; rounds++) {
      const busy = [...this.subs].filter((s) => s.hasWork() && !this.feedPaused);
      const running = [...this.subs].filter((s) => s.running);
      if (busy.length === 0 && running.length === 0 && this.pendingNotes === 0) return;
      for (const s of busy) void s.pump();
      await new Promise((r) => { realSetTimeout(r, 0); });
    }
    throw new Error("FakeRemoteServer.deliver: did not settle");
  }

  /** Wait until all pushed batches are delivered and acknowledged. */
  settle(): Promise<void> {
    return this.deliver();
  }

  /** Raise minSeq (models trimmed history): cursors below it get SNAPSHOT_REQUIRED. */
  setMinSeq(seq: Seq): void {
    this.minSeq = Math.max(this.minSeq, seq);
  }

  /**
   * Retention/thinning model (design §2.7.1): remove non-head records with seq ≤ upTo, except the
   * base of a current head; purge tombstone heads with seq ≤ upTo together with their history.
   * Raises minSeq to the highest purged seq.
   */
  expire(upTo: Seq): { removed: number; purgedFiles: number } {
    const keepBase = new Set<Seq>();
    for (const hs of this.heads.values()) {
      const h = this.log.get(hs);
      if (h && h.base !== null) keepBase.add(h.base);
    }
    let removed = 0, purgedFiles = 0, maxPurged = this.minSeq;
    for (const [fileId, hs] of [...this.heads]) {
      const h = this.log.get(hs) as VersionRecord;
      if (h.kind === "del" && hs <= upTo) {
        this.heads.delete(fileId);
        purgedFiles++;
        for (const [s, r] of [...this.log]) if (r.fileId === fileId) { this.log.delete(s); removed++; maxPurged = Math.max(maxPurged, s); }
      }
    }
    const headSeqs = new Set(this.heads.values());
    for (const [s, r] of [...this.log]) {
      if (s > upTo || headSeqs.has(s) || keepBase.has(s)) continue;
      void r;
      this.log.delete(s);
      removed++;
    }
    this.minSeq = Math.max(this.minSeq, maxPurged);
    return { removed, purgedFiles };
  }

  /** Read-only views for assertions. */
  inspect(): {
    headSeq: Seq; minSeq: Seq; epoch: number; info: VaultInfo | null; infoEtag: string | null;
    heads: VersionRecord[]; log: VersionRecord[]; blobIds: BlobId[]; livePaths: Map<PathKey, FileId>;
  } {
    return {
      headSeq: this.headSeq, minSeq: this.minSeq, epoch: this.epoch, info: clone(this.info), infoEtag: this.infoEtag,
      heads: [...this.heads.values()].sort((a, b) => a - b).map((s) => clone(this.log.get(s) as VersionRecord)),
      log: [...this.log.keys()].sort((a, b) => a - b).map((s) => clone(this.log.get(s) as VersionRecord)),
      blobIds: [...this.blobs.keys()].sort(),
      livePaths: new Map(this.livePath),
    };
  }

  hasBlob(id: BlobId): boolean {
    return this.blobs.has(id);
  }

  // ---------------- internals used by FakeRemote ----------------

  /** @internal */ device(id: DeviceId): DeviceRow {
    const d = this.devices.get(id);
    if (!d) throw remoteError("UNAUTHENTICATED", "unknown device");
    if (d.revoked) throw remoteError("REVOKED", "this device was removed");
    d.lastSeenAt = this.clock.now();
    return d;
  }

  /** @internal */ head(fileId: FileId): VersionRecord | null {
    const s = this.heads.get(fileId);
    return s === undefined ? null : (this.log.get(s) ?? null);
  }

  /** @internal */ getInfo(): { info: VaultInfo; etag: string } | null {
    return this.info && this.infoEtag ? { info: clone(this.info), etag: this.infoEtag } : null;
  }

  private newEtag(): string {
    return `"e${++this.etagCounter}"`;
  }

  /** @internal */ createInfo(info: VaultInfo): { etag: string } {
    if (this.info) throw remoteError("ALREADY_EXISTS", "vault-info already exists");
    this.info = clone(info);
    this.epoch = info.epoch;
    this.infoEtag = this.newEtag();
    return { etag: this.infoEtag };
  }

  /** @internal */ updateInfo(info: VaultInfo, ifMatch: string): { etag: string } {
    if (!this.info || !this.infoEtag) throw remoteError("VAULT_NOT_FOUND", "no vault-info");
    if (ifMatch !== this.infoEtag) throw remoteError("PRECONDITION_FAILED", "etag mismatch", { details: { etag: this.infoEtag } });
    if (info.vaultId !== this.info.vaultId) throw remoteError("PROTOCOL", "vaultId cannot change");
    if (info.epoch !== this.epoch) throw remoteError("PROTOCOL", "epoch changes only through rebuild");
    if (!(info.infoRev > this.info.infoRev)) throw remoteError("PROTOCOL", "infoRev must increase");
    this.info = clone(info);
    this.infoEtag = this.newEtag();
    const etag = this.infoEtag;
    for (const s of this.subs) s.notifyInfo(etag);
    return { etag };
  }

  /** @internal */ rebuild(info: VaultInfo): { epoch: number } {
    if (!this.info) throw remoteError("VAULT_NOT_FOUND", "no vault-info");
    if (info.vaultId !== this.info.vaultId) throw remoteError("PROTOCOL", "vaultId cannot change");
    if (info.epoch !== this.epoch + 1) throw remoteError("PROTOCOL", `rebuild needs epoch ${this.epoch + 1}`);
    if (!(info.infoRev > this.info.infoRev)) throw remoteError("PROTOCOL", "infoRev must increase");
    this.info = clone(info);
    this.infoEtag = this.newEtag();
    this.epoch = info.epoch;
    // design §2.11 step 3: drop versions, files and blob rows; keep head_seq (seqs are never reused).
    this.log.clear();
    this.heads.clear();
    this.livePath.clear();
    this.blobs.clear();
    this.minSeq = this.headSeq;
    for (const s of [...this.subs]) s.requireSnapshot("epoch");
    return { epoch: this.epoch };
  }

  /** @internal */ putBlob(id: BlobId, bytes: Uint8Array): 'stored' | 'present' {
    if (!isBlobId(id)) throw remoteError("PROTOCOL", `bad blob id ${JSON.stringify(id)}`);
    if (bytes.length > this.limits.maxBlobSize) throw remoteError("TOO_LARGE", `blob larger than ${this.limits.maxBlobSize}`);
    const prev = this.blobs.get(id);
    if (prev) {
      // Immutable: the first bytes stay. A different body under the same id is an engine bug.
      if (!bytesEqual(prev, bytes)) this.stats.blobRewriteMismatches++;
      this.stats.blobPresent++;
      return "present";
    }
    if (this.quotaBytes !== null && this.storedBytes() + bytes.length > this.quotaBytes) throw remoteError("QUOTA", "vault limit exceeded");
    this.blobs.set(id, new Uint8Array(bytes));
    this.stats.blobPuts++;
    return "stored";
  }

  /** @internal */ getBlob(id: BlobId): Uint8Array | null {
    const b = this.blobs.get(id);
    return b ? new Uint8Array(b) : null;
  }

  private storedBytes(): number {
    let n = 0;
    for (const b of this.blobs.values()) n += b.length;
    for (const r of this.log.values()) if (r.inline !== undefined) n += b64uDecodedLength(r.inline);
    return n;
  }

  /** @internal */ usage(): UsageInfo {
    let liveBytes = 0, historyBytes = 0, fileCount = 0;
    const headSeqs = new Set(this.heads.values());
    for (const r of this.log.values()) {
      if (headSeqs.has(r.seq)) {
        if (r.kind === "put") { liveBytes += r.encSize; fileCount++; }
      } else historyBytes += r.encSize;
    }
    return { liveBytes, historyBytes, blobCount: this.blobs.size, fileCount, quotaBytes: this.quotaBytes, exact: true };
  }

  /** @internal */ snapshotRequiredError(reason: SnapshotReason): RemoteError {
    return remoteError("SNAPSHOT_REQUIRED", `snapshot required (${reason})`, { details: { minSeq: this.minSeq, epoch: this.epoch, reason } });
  }

  /** Coalesced head records with seq > since, in seq order (catch-up and pull). */
  /** @internal */ coalesced(since: Seq, limit: number): { records: VersionRecord[]; more: boolean } {
    const seqs = [...this.heads.values()].filter((s) => s > since).sort((a, b) => a - b);
    const page = seqs.slice(0, limit);
    return { records: page.map((s) => clone(this.log.get(s) as VersionRecord)), more: seqs.length > limit };
  }

  /** @internal */ pageAfter(since: Seq, limit: number): ChangeBatch {
    const { records, more } = this.coalesced(since, limit);
    const last = records[records.length - 1];
    return {
      from: since, to: more && last ? last.seq : this.headSeq, headSeq: this.headSeq, minSeq: this.minSeq,
      records, more, live: false,
    };
  }

  /** @internal */ snapshot(opts: { pageToken?: string | null; limit?: number; tombstones: boolean }): SnapshotPage {
    const limit = Math.min(opts.limit ?? SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX);
    if (!(limit >= 1)) throw remoteError("PROTOCOL", "snapshot limit must be >= 1");
    const after = opts.pageToken ?? null;
    const ids = [...this.heads.keys()]
      .filter((f) => after === null || f > after)
      .filter((f) => opts.tombstones || (this.head(f) as VersionRecord).kind === "put")
      .sort();
    const page = ids.slice(0, limit);
    const more = ids.length > limit;
    return {
      headSeq: this.headSeq, minSeq: this.minSeq, epoch: this.epoch,
      records: page.map((f) => clone(this.head(f) as VersionRecord)),
      next: more ? (page[page.length - 1] ?? null) : null,
    };
  }

  /** @internal */ getVersion(fileId: FileId, seq: Seq): VersionRecord | null {
    const r = this.log.get(seq);
    return r && r.fileId === fileId ? clone(r) : null;
  }

  /** @internal */ listVersions(fileId: FileId, before: Seq | undefined, limit: number): { records: VersionRecord[]; next: Seq | null } {
    const all = [...this.log.values()].filter((r) => r.fileId === fileId && (before === undefined || r.seq < before))
      .sort((a, b) => b.seq - a.seq);
    const page = all.slice(0, limit);
    return { records: page.map(clone), next: all.length > limit ? (page[page.length - 1]?.seq ?? null) : null };
  }

  /** @internal */ listDeleted(before: Seq | undefined, limit: number): { records: VersionRecord[]; next: Seq | null } {
    const all = [...this.heads.values()].map((s) => this.log.get(s) as VersionRecord)
      .filter((r) => r.kind === "del" && (before === undefined || r.seq < before))
      .sort((a, b) => b.seq - a.seq);
    const page = all.slice(0, limit);
    return { records: page.map(clone), next: all.length > limit ? (page[page.length - 1]?.seq ?? null) : null };
  }

  /** @internal */ pairingPut(pairId: string, body: string): void {
    if (utf8Length(body) > MAX_PAIRING_BODY) throw remoteError("TOO_LARGE", "pairing body too large");
    const now = this.clock.now();
    const prev = this.pairing.get(pairId);
    if (prev && prev.expiresAt > now) throw remoteError("ALREADY_EXISTS", "pairing slot taken");
    this.pairing.set(pairId, { body, expiresAt: now + PAIRING_TTL_SEC * 1000 });
  }

  /** @internal */ pairingTake(pairId: string): string | null {
    const e = this.pairing.get(pairId);
    this.pairing.delete(pairId);
    if (!e || e.expiresAt <= this.clock.now()) return null;
    return e.body;
  }

  // ---------------- commit (design §2.5, §2.9.7) ----------------

  /** @internal */ commit(device: DeviceId, req: CommitRequest, epochSeen: number): CommitResponse {
    const v = validateCommitRequest(req);
    if (!v.ok) throw remoteError("PROTOCOL", `invalid commit at ${v.path}: ${v.reason}`);
    const lim = checkCommitLimits(req, utf8Length(JSON.stringify(req)), this.limits);
    if (lim) throw remoteError("TOO_LARGE", lim.message);
    if (req.atomic && !this.capabilities.atomicCommit) throw remoteError("UNSUPPORTED", "atomic commits not supported");
    const cacheKey = `${device}\u0000${req.cid}`;
    const digest = opsDigestPreimage(req.ops);
    const cached = this.commitCache.get(cacheKey);
    if (cached && cached.digest !== digest) throw remoteError("PROTOCOL", "same cid with different ops digest");
    const atomic = req.atomic === true;
    // Replay (design §2.9.5): final results (success, CONFLICT, PATH_TAKEN, INVALID, ...) come from the
    // cache. Ops whose cached result was retryable (MISSING_BLOB, QUOTA, ABORTED) are evaluated again:
    // §2.9.3 says to upload and resend MISSING_BLOB with the same cid ("ops are re-evaluated").
    let reuse: Array<OpResult | null> = req.ops.map(() => null);
    if (cached) {
      const prev = cached.response.results;
      const retry = (r: OpResult): boolean => !r.ok && RETRY_ON_RESEND.has(r.code);
      if (atomic) {
        const allRetryable = prev.every((r) => r.ok || retry(r)) && prev.some((r) => !r.ok);
        if (!allRetryable) reuse = prev.map((r) => clone(r));
      } else {
        reuse = prev.map((r) => (retry(r) ? null : clone(r)));
      }
      if (reuse.every((r) => r !== null)) {
        this.stats.replays++;
        return { ...clone(cached.response), headSeq: this.headSeq, replayed: true };
      }
    }
    if (!this.info) throw remoteError("VAULT_NOT_FOUND", "no vault-info");
    if (epochSeen !== this.epoch) throw this.snapshotRequiredError("epoch");

    const plan = new CommitPlan(this, atomic, req.cid, device, this.clock.now());
    const results: OpResult[] = req.ops.map((op, i) => reuse[i] ?? plan.evaluate(op, i));
    if (atomic) {
      plan.finalPathCheck(req.ops, results);
      if (results.some((r) => !r.ok)) {
        for (let i = 0; i < results.length; i++) {
          if ((results[i] as OpResult).ok) results[i] = { i, ok: false, code: "ABORTED", message: "atomic commit aborted" };
        }
      } else plan.applyStaged(results);
    }
    const applied = plan.applied;
    for (const r of results) { if (r.ok) this.stats.opsOk++; else this.stats.opsFailed++; }
    this.stats.commits++;
    if (cached) this.stats.replays++;
    const response: CommitResponse = { cid: req.cid, headSeq: this.headSeq, replayed: cached !== undefined, results };
    this.commitCache.set(cacheKey, { digest, response: clone({ ...response, replayed: false }) });
    if (applied.length > 0) for (const s of this.subs) s.pushLive(applied);
    return clone(response);
  }

  /** @internal */ commitApply(rec: VersionRecord): void {
    this.log.set(rec.seq, rec);
    if (rec.kind === "archive") return;
    const prev = this.head(rec.fileId);
    if (prev && prev.kind === "put" && this.livePath.get(prev.pathKey) === rec.fileId) this.livePath.delete(prev.pathKey);
    this.heads.set(rec.fileId, rec.seq);
    if (rec.kind === "put") this.livePath.set(rec.pathKey, rec.fileId);
    else if (this.livePath.get(rec.pathKey) === rec.fileId) this.livePath.delete(rec.pathKey);
  }

  /** @internal */ livePathHolder(pk: PathKey): FileId | undefined { return this.livePath.get(pk); }
  /** @internal */ blobSize(id: BlobId): number | undefined { return this.blobs.get(id)?.length; }
  /** @internal */ nextSeq(): Seq { return ++this.headSeq; }
  /** @internal */ get activeKv(): number | null { return this.info ? this.info.activeKv : null; }
  /** @internal */ quotaLeft(): number { return this.quotaBytes === null ? Infinity : this.quotaBytes - this.storedBytes(); }

  /** @internal */ kickAll(): void {
    if (!this.autoDeliver || this.feedPaused) return;
    for (const s of this.subs) s.schedule();
  }
}

/**
 * Evaluates one commit. Non-atomic: each op is checked and applied in order, so later ops see earlier
 * ones. Atomic: ops are checked against a working state and staged; pathKey uniqueness is checked on
 * the final state (swaps and rename chains pass), then all are applied or none.
 */
class CommitPlan {
  /** Atomic only: fileId → working head after staged ops (null = deleted from the working view). */
  private heads = new Map<FileId, { kind: 'put' | 'del'; pathKey: PathKey; seq: Seq | null }>();
  private staged: Array<{ i: number; op: CommitOp; encSize: number }> = [];
  private quota: number;
  readonly applied: VersionRecord[] = [];

  constructor(
    private readonly srv: FakeRemoteServer, private readonly atomic: boolean,
    private readonly cid: string, private readonly device: DeviceId, private readonly ts: number,
  ) {
    this.quota = srv.quotaLeft();
  }

  /** CAS view of the head: seq and kind as the commit sees it so far. */
  private casHead(f: FileId): { seq: Seq | null; kind: 'put' | 'del' } | null {
    const w = this.heads.get(f);
    if (w) return w;
    const h = this.srv.head(f);
    return h ? { seq: h.seq, kind: h.kind as 'put' | 'del' } : null;
  }

  evaluate(op: CommitOp, i: number): OpResult {
    const ak = this.srv.activeKv;
    if (this.srv.capabilities.enforcesActiveKv && ak !== null && op.kv !== ak) {
      return { i, ok: false, code: "KEY_VERSION", message: `kv ${op.kv} is not the active kv ${ak}` };
    }
    const size = checkOpSizes(op);
    if (size) return { i, ok: false, code: "INVALID", message: size.message };
    const H = this.casHead(op.fileId);
    const current = (): VersionRecord | null => { const h = this.srv.head(op.fileId); return h ? clone(h) : null; };

    // CAS (design §2.5 table). In an atomic commit a second op on the same fileId sees the first as
    // its head; its base cannot name a seq that does not exist yet, so it conflicts.
    if (op.op === "put") {
      if (op.base === null ? H !== null : (H === null || H.seq !== op.base)) return { i, ok: false, code: "CONFLICT", current: current() };
    } else if (op.op === "del") {
      if (H === null || H.kind === "del" || H.seq !== op.base) return { i, ok: false, code: "CONFLICT", current: current() };
    } else {
      if (H === null) return { i, ok: false, code: "INVALID", message: "archive for a fileId without head" };
      if (H.seq !== null && op.base > H.seq) return { i, ok: false, code: "INVALID", message: "archive base above the head" };
    }

    // pathKey uniqueness among live heads (atomic: on the final state, see finalPathCheck).
    if (op.op === "put" && !this.atomic) {
      const holder = this.srv.livePathHolder(op.pathKey);
      if (holder !== undefined && holder !== op.fileId) {
        const P = this.srv.head(holder);
        return { i, ok: false, code: "PATH_TAKEN", current: P ? clone(P) : null };
      }
    }

    // Every referenced blob must be stored (design §2.9.7); encSize is recomputed, never trusted.
    let encSize = 0;
    let inlineBytes = 0;
    if (op.op !== "del") {
      const missing: BlobId[] = [];
      for (const b of op.blobs) {
        const s = this.srv.blobSize(b);
        if (s === undefined) { if (!missing.includes(b)) missing.push(b); } else encSize += s;
      }
      if (missing.length > 0) return { i, ok: false, code: "MISSING_BLOB", missing };
      if (typeof op.inline === "string") inlineBytes = b64uDecodedLength(op.inline);
      encSize += inlineBytes;
    }
    if (encSize > this.srv.limits.maxFileSize + ENCSIZE_SLACK) return { i, ok: false, code: "TOO_LARGE", message: "file exceeds maxFileSize" };
    if (inlineBytes > this.quota) return { i, ok: false, code: "QUOTA", message: "vault limit exceeded" };
    this.quota -= inlineBytes;

    if (!this.atomic) return { i, ok: true, seqs: [this.applyOne(op, encSize)] };
    this.staged.push({ i, op, encSize });
    if (op.op !== "archive") this.heads.set(op.fileId, { kind: op.op, pathKey: op.pathKey, seq: null });
    return { i, ok: true, seqs: [] };   // placeholder; applyStaged assigns the seq
  }

  /** fileIds live at `pk` after the staged ops. */
  private liveHoldersAfter(pk: PathKey): FileId[] {
    const out = new Set<FileId>();
    const srvHolder = this.srv.livePathHolder(pk);
    if (srvHolder !== undefined) {
      const w = this.heads.get(srvHolder);
      if (!w || (w.kind === "put" && w.pathKey === pk)) out.add(srvHolder);
    }
    for (const [f, w] of this.heads) if (w.kind === "put" && w.pathKey === pk) out.add(f);
    return [...out];
  }

  finalPathCheck(ops: readonly CommitOp[], results: OpResult[]): void {
    ops.forEach((op, i) => {
      if (op.op !== "put" || !(results[i] as OpResult).ok) return;
      const other = this.liveHoldersAfter(op.pathKey).find((f) => f !== op.fileId);
      if (other === undefined) return;
      const P = this.srv.head(other);
      results[i] = { i, ok: false, code: "PATH_TAKEN", current: P ? clone(P) : null };
    });
  }

  applyStaged(results: OpResult[]): void {
    for (const { i, op, encSize } of this.staged) results[i] = { i, ok: true, seqs: [this.applyOne(op, encSize)] };
  }

  private applyOne(op: CommitOp, encSize: number): Seq {
    const seq = this.srv.nextSeq();
    const rec: VersionRecord = {
      seq, fileId: op.fileId, pathKey: op.pathKey, base: op.base, kind: op.op, rc: op.rc, kv: op.kv, meta: op.meta,
      blobs: op.op === "del" ? [] : [...op.blobs], encSize, device: this.device, ts: this.ts, cid: this.cid,
    };
    if (op.op !== "del" && typeof op.inline === "string") rec.inline = op.inline;
    this.srv.commitApply(rec);
    this.applied.push(clone(rec));
    return seq;
  }
}

/** One open change feed of one device. */
class FakeSubscription implements Subscription {
  phase: 'catchup' | 'live' | 'parked' | 'closed' = "catchup";
  /** Last `to` handed out (live contiguity). */
  private lastTo: Seq;
  private queue: ChangeBatch[] = [];
  /** Sink notifications (state, snapshotRequired, vaultInfoChanged), delivered in order before batches. */
  private notes: Array<() => void> = [];
  running = false;
  private scheduled = false;

  constructor(
    private readonly srv: FakeRemoteServer,
    readonly device: DeviceId,
    since: Seq,
    private readonly sink: ChangeSink,
    private readonly onClose: () => void,
  ) {
    this.lastTo = since;
  }

  hasWork(): boolean {
    if (this.phase === "closed") return false;
    if (this.notes.length > 0) return true;
    if (this.phase === "parked") return false;
    return this.phase === "catchup" || this.queue.length > 0;
  }

  /** Queue a sink notification (ordered with batches). */
  note(fn: () => void): void {
    this.notes.push(fn);
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled || this.running || !this.srv.autoDeliver || this.srv.feedPaused) return;
    this.scheduled = true;
    realSetTimeout(() => { this.scheduled = false; void this.pump(); }, 0);
  }

  pushLive(records: VersionRecord[]): void {
    if (this.phase !== "live") return;   // catch-up reads the current state when it gets there
    const to = this.srv.headSeq;
    this.queue.push({ from: this.lastTo, to, headSeq: to, minSeq: this.srv.minSeq, records: clone(records), more: false, live: true });
    this.lastTo = to;
    this.srv.kickAll();
  }

  notifyInfo(etag: string): void {
    if (this.phase === "closed") return;
    this.note(() => this.sink.onVaultInfoChanged(etag));
  }

  requireSnapshot(reason: SnapshotReason): void {
    if (this.phase === "closed") return;
    this.phase = "parked";
    this.queue = [];
    const info = { reason, minSeq: this.srv.minSeq, epoch: this.srv.epoch, rollbackAt: null };
    this.note(() => this.sink.onSnapshotRequired(info));
  }

  terminate(state: ConnectionState, detail: string, err?: RemoteError): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.queue = [];
    this.srv.subs.delete(this);
    this.onClose();
    const sink = this.sink;
    this.srv.later(() => {
      if (err) sink.onError(err);
      sink.onState(state, detail);
    });
  }

  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.queue = [];
    this.srv.subs.delete(this);
    this.onClose();
  }

  nudge(): void {
    this.schedule();
  }

  isClosed(): boolean {
    return this.phase === "closed";
  }

  async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.srv.feedPaused) {
        if (this.phase === "closed") return;
        const n = this.notes.shift();
        if (n) { n(); continue; }
        if (this.phase === "parked") return;
        let batch: ChangeBatch | undefined;
        let wentLive = false;
        if (this.phase === "catchup") {
          batch = this.srv.pageAfter(this.lastTo, this.srv.catchUpPage);
          this.lastTo = batch.to;
          if (!batch.more) {
            // Same tick as reading headSeq: no commit can land between this page and going live.
            this.phase = "live";
            wentLive = true;
          }
        } else {
          batch = this.queue.shift();
        }
        if (!batch) return;
        try {
          await this.sink.onChanges(batch);
        } catch (e) {
          // The engine did not persist the batch: no ack. Model a dropped connection.
          this.terminate("offline", "onChanges rejected", remoteError("PROTOCOL", `sink rejected batch: ${String(e)}`));
          return;
        }
        if (this.isClosed()) return;
        this.srv.stats.batchesDelivered++;
        const d = this.srv.devices.get(this.device);
        if (d) d.ackedSeq = Math.max(d.ackedSeq ?? 0, batch.to);
        if (wentLive) this.sink.onState("live");
      }
    } finally {
      this.running = false;
    }
  }
}

/** The RemoteAdapter one device uses (server-like semantics, design §2.12). */
export class FakeRemote implements RemoteAdapter {
  readonly kind = "fake";
  private connected = false;
  private epochSeen = 0;
  private openSubs = 0;

  constructor(readonly server: FakeRemoteServer, readonly deviceId: DeviceId) {}

  get capabilities(): RemoteCapabilities {
    return this.server.capabilities;
  }

  private async call<T>(method: FakeMethod, args: readonly unknown[], fn: () => T | Promise<T>, needConnect = true): Promise<T> {
    const lost = await this.server.enter(this.deviceId, method, args);
    if (needConnect && !this.connected) throw remoteError("PROTOCOL", `${method} before connect()`);
    this.server.device(this.deviceId);
    const out = await fn();
    if (lost) throw lost;
    return out;
  }

  connect(): Promise<ConnectInfo> {
    return this.call("connect", [], () => {
      this.connected = true;
      this.epochSeen = this.server.epoch;
      return {
        deviceId: this.deviceId, headSeq: this.server.headSeq, minSeq: this.server.minSeq, epoch: this.server.epoch,
        infoEtag: this.server.getInfo()?.etag ?? null, retention: clone(this.server.retention),
        serverTime: this.server.clock.now(), capabilities: clone(this.server.capabilities),
      };
    }, false);
  }

  async close(): Promise<void> {
    this.connected = false;
    for (const s of [...this.server.subs]) if (s.device === this.deviceId) s.close();
  }

  getVaultInfo(): Promise<{ info: VaultInfo; etag: string } | null> {
    return this.call("getVaultInfo", [], () => this.server.getInfo());
  }
  createVaultInfo(info: VaultInfo): Promise<{ etag: string }> {
    return this.call("createVaultInfo", [info], () => {
      const r = this.server.createInfo(info);
      this.epochSeen = this.server.epoch;
      return r;
    });
  }
  updateVaultInfo(info: VaultInfo, ifMatch: string): Promise<{ etag: string }> {
    return this.call("updateVaultInfo", [info, ifMatch], () => this.server.updateInfo(info, ifMatch));
  }

  missingBlobs(ids: BlobId[]): Promise<BlobId[]> {
    return this.call("missingBlobs", [ids], () => {
      if (ids.length > MAX_MISSING_IDS) throw remoteError("PROTOCOL", `more than ${MAX_MISSING_IDS} ids`);
      return ids.filter((id, i) => !this.server.hasBlob(id) && ids.indexOf(id) === i);
    });
  }
  putBlob(id: BlobId, bytes: Uint8Array): Promise<'stored' | 'present'> {
    return this.call("putBlob", [id, bytes], () => this.server.putBlob(id, bytes));
  }
  getBlob(id: BlobId): Promise<Uint8Array> {
    return this.call("getBlob", [id], () => {
      const b = this.server.getBlob(id);
      if (!b) throw remoteError("NOT_FOUND", `blob ${id} not found`);
      return b;
    });
  }
  putBlobs(items: Array<{ id: BlobId; bytes: Uint8Array }>): Promise<void> {
    return this.call("putBlobs", [items], () => {
      if (items.length > MAX_PACK_ENTRIES) throw remoteError("TOO_LARGE", `more than ${MAX_PACK_ENTRIES} entries`);
      const total = items.reduce((n, x) => n + x.bytes.length, 0);
      if (total > this.server.limits.maxPackBytes) throw remoteError("TOO_LARGE", "pack too large");
      for (const it of items) this.server.putBlob(it.id, it.bytes);
    });
  }
  getBlobs(ids: BlobId[], maxBytes: number): Promise<Map<BlobId, Uint8Array | null>> {
    return this.call("getBlobs", [ids, maxBytes], () => {
      if (ids.length > MAX_PACK_ENTRIES) throw remoteError("PROTOCOL", `more than ${MAX_PACK_ENTRIES} ids`);
      const cap = Math.min(maxBytes, this.server.limits.maxPackBytes);
      const out = new Map<BlobId, Uint8Array | null>();
      let used = 0;
      for (const id of ids) {
        const b = this.server.getBlob(id);
        if (!b) { out.set(id, null); continue; }
        // In request order until the next would exceed maxBytes; at least one present blob (design §2.8.5).
        const anyPresent = [...out.values()].some((x) => x !== null);
        if (used + b.length > cap && anyPresent) break;
        out.set(id, b);
        used += b.length;
      }
      return out;
    });
  }

  commit(req: CommitRequest): Promise<CommitResponse> {
    return this.call("commit", [req], () => {
      if (this.server.requireSubscription && this.openSubs === 0) throw remoteError("PROTOCOL", "commit without an active subscription");
      return this.server.commit(this.deviceId, clone(req), this.epochSeen);
    });
  }

  pull(since: Seq, limit?: number): Promise<ChangeBatch> {
    return this.call("pull", [since, limit], () => {
      this.server.stats.pulls++;
      if (this.epochSeen !== this.server.epoch) throw this.server.snapshotRequiredError("epoch");
      if (since < this.server.minSeq) throw this.server.snapshotRequiredError("cursor-too-old");
      return this.server.pageAfter(since, Math.max(1, limit ?? CHANGES_LIMIT_DEFAULT));
    });
  }

  subscribe(since: Seq | null, sink: ChangeSink): Subscription {
    if (!this.connected) throw remoteError("PROTOCOL", "subscribe before connect()");
    this.server.device(this.deviceId);
    this.server.calls.push({ device: this.deviceId, method: "subscribe" });
    // Synchronous call: onCall is not awaited here; an injected fault (before or after) fails the subscribe.
    if (this.server.onCall) void this.server.onCall({ device: this.deviceId, method: "subscribe", args: [since] });
    const fault = this.server.takeFault(this.deviceId, "subscribe");
    if (fault) throw fault;
    // design §2.9.5 / §2.9.4: one feed per (device, vault); a newer one supersedes the older.
    for (const s of [...this.server.subs]) if (s.device === this.deviceId) s.terminate("offline", "superseded");
    this.openSubs++;
    let closed = false;
    const sub = new FakeSubscription(this.server, this.deviceId, since ?? 0, sink, () => {
      if (!closed) { closed = true; this.openSubs--; }
    });
    this.server.subs.add(sub);
    sub.note(() => sink.onState("connected"));
    let reason: SnapshotReason | null = null;
    if (since === null) reason = "no-cursor";
    else if (this.epochSeen !== this.server.epoch) reason = "epoch";
    else if (since < this.server.minSeq) reason = "cursor-too-old";
    if (reason) sub.requireSnapshot(reason);
    else {
      sub.note(() => sink.onState("catching-up"));
      sub.schedule();
    }
    return sub;
  }

  snapshot(opts: { pageToken?: string | null; limit?: number; tombstones: boolean; history?: boolean }): Promise<SnapshotPage> {
    return this.call("snapshot", [opts], () => {
      this.server.stats.snapshots++;
      const page = this.server.snapshot(opts);
      // A snapshot bootstrap adopts the current epoch (the engine validates the MAC'd info.epoch itself).
      this.epochSeen = this.server.epoch;
      return page;
    });
  }

  ack(upTo: Seq): void {
    const d = this.server.devices.get(this.deviceId);
    if (d && !d.revoked) d.ackedSeq = Math.max(d.ackedSeq ?? 0, upTo);
  }

  getVersion(fileId: FileId, seq: Seq): Promise<VersionRecord | null> {
    return this.call("getVersion", [fileId, seq], () => this.server.getVersion(fileId, seq));
  }
  listVersions(fileId: FileId, opts: { before?: Seq; limit?: number } = {}): Promise<{ records: VersionRecord[]; next: Seq | null }> {
    return this.call("listVersions", [fileId, opts], () => this.server.listVersions(fileId, opts.before, opts.limit ?? 50));
  }
  listDeleted(opts: { before?: Seq; limit?: number } = {}): Promise<{ records: VersionRecord[]; next: Seq | null }> {
    return this.call("listDeleted", [opts], () => this.server.listDeleted(opts.before, opts.limit ?? 100));
  }
  usage(): Promise<UsageInfo> {
    return this.call("usage", [], () => this.server.usage());
  }

  listDevices(): Promise<AdapterDevice[]> {
    return this.call("listDevices", [], () => [...this.server.devices.values()].map((d) => ({
      deviceId: d.deviceId, name: d.name, platform: d.platform, clientVersion: d.clientVersion,
      lastSeenAt: d.lastSeenAt, revoked: d.revoked, current: d.deviceId === this.deviceId,
    })));
  }
  revokeDevice(id: DeviceId): Promise<void> {
    return this.call("revokeDevice", [id], () => {
      const d = this.server.devices.get(id);
      if (!d) throw remoteError("NOT_FOUND", "unknown device");
      d.revoked = true;
      for (const s of [...this.server.subs]) {
        if (s.device === id) s.terminate("auth-error", "revoked", remoteError("REVOKED", "this device was removed"));
      }
    });
  }
  createEnrollCode(ttlSec: number): Promise<{ code: string; expiresAt: number; link: string }> {
    return this.call("createEnrollCode", [ttlSec], () => {
      const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      const groups: string[] = [];
      for (let g = 0; g < 5; g++) {
        let s = "";
        for (let k = 0; k < 4; k++) s += A[this.server.prng.int(32)];
        groups.push(s);
      }
      const code = ENROLL_CODE_PREFIX + groups.join("-");
      return {
        code, expiresAt: this.server.clock.now() + ttlSec * 1000,
        link: `obsidian://shuttle-enroll?server=${encodeURIComponent("https://sync.example.com")}&code=${code}`,
      };
    });
  }

  pairingPut(pairId: string, body: string): Promise<void> {
    return this.call("pairingPut", [pairId, body], () => this.server.pairingPut(pairId, body));
  }
  pairingTake(pairId: string): Promise<string | null> {
    return this.call("pairingTake", [pairId], () => this.server.pairingTake(pairId));
  }

  runMaintenance(_signal?: AbortSignal): Promise<MaintenanceResult> {
    return this.call("runMaintenance", [], () => ({ ran: false }));
  }
  rebuild(info: VaultInfo): Promise<{ epoch: number }> {
    return this.call("rebuild", [info], () => {
      const r = this.server.rebuild(info);
      this.epochSeen = r.epoch;
      return r;
    });
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
