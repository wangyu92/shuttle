// RemoteAdapter for the own server (design §2.12, §2.8.5, §2.9). REST for vault-info, blobs, snapshot,
// history, devices and pairing; one WebSocket for the change feed and commits while a subscription is
// open. HttpClient and WsFactory are injected: the plugin passes requestUrl and WebSocket, headless
// passes fetch and the `ws` package.

import {
  DEFAULT_LIMITS, MAX_MISSING_IDS, MAX_PACK_ENTRIES, PACK_CONTENT_TYPE, SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX,
  CHANGES_LIMIT_DEFAULT, HEADER_SHA256, checkCommitLimits, decodePack, encodePack, isRemoteError, remoteError,
  validateAuthResponse, validateChangesResponse, validateCommitResponse, validateCreateVaultResponse,
  validateDevicesResponse, validateEnrollCodeResponse, validateMeResponse, validateMissingBlobsResponse,
  validatePackPutResponse, validatePutInfoResponse, validateRebuildResponse, validateSnapshotRequiredDetails,
  validateSnapshotResponse, validateUsageResponse, validateVaultInfo, validateVersionRecord, validateVersionsResponse,
  PackError, utf8Length,
} from "@shuttle/protocol";
import type {
  AdapterDevice, AdapterStateStore, AuthResponse, BlobId, ChangeBatch, ChangeSink, ClientRole, Clock, CommitRequest,
  CommitResponse, ConnectInfo, DeviceDescriptor, DeviceId, FileId, HttpClient, MaintenanceResult, RemoteAdapter,
  RemoteCapabilities, RemoteError, Retention, Scheduler, Seq, ServerAdapterConfig, SnapshotPage, Subscription,
  UsageInfo, Validation, VaultInfo, VersionRecord, WelcomeMsg, WsFactory,
} from "@shuttle/protocol";
import { header } from "./errors";
import { DEFAULT_FEED_TIMEOUTS, FeedLink, type FeedTimeouts, type HelloContext } from "./feed";
import { DEFAULT_REST_TIMEOUTS, RestClient, parseJson, wsUrlOf, type RestTimeouts, type TokenSource } from "./rest";
import { realClock, realScheduler, sha256Hex, toArrayBuffer } from "./runtime";

export interface ServerAdapterOptions {
  /** `urls` in fallback order, `vaultId`, `deviceId` (design §2.12 adapter config). */
  config: Pick<ServerAdapterConfig, "urls" | "vaultId"> & Partial<Pick<ServerAdapterConfig, "deviceId">>;
  /** The device token `sxd_…` (design §4.10.1 keeps it out of the adapter config). */
  token: TokenSource;
  http: HttpClient;
  ws: WsFactory;
  client: { name: string; platform: string; version: string; role: ClientRole };
  /** Name for POST /v1/vaults when createVaultInfo() creates the vault. Default: the vaultId. */
  vaultName?: string;
  /** Durable per-device state (design §2.12). Holds the epoch this device last bootstrapped into. */
  state?: AdapterStateStore;
  /**
   * The device's `seen` values for hello (design §2.6.1, §4.9.2), from the engine's localStorage. Any
   * field left undefined falls back to the adapter's own tracking.
   */
  session?: () => Partial<HelloContext> | Promise<Partial<HelloContext>>;
  /** Plain http:// to a non-loopback host (headless on a private network, design §6.1). */
  allowHttp?: boolean;
  /** hello.window.maxUnackedBytes (design §2.9.4: 8 MiB). */
  maxUnackedBytes?: number;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Jitter source in [0, 1). */
  random?: () => number;
  timeouts?: Partial<RestTimeouts & FeedTimeouts>;
}

/** AdapterStateStore key for the epoch of the last bootstrap (snapshot, create, rebuild). */
export const STATE_EPOCH_KEY = "shuttle-server.epoch";

/** Shown until the vault exists; the server sends its own in welcome and vault-info. */
const DEFAULT_RETENTION: Retention = Object.freeze({ noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90 });

const HASH_MISMATCH_TRIES = 3; // design §2.9.3: HASH_MISMATCH retry ≤ 3

function memoryState(): AdapterStateStore {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}

function need<V>(v: Validation<V>, what: string): V {
  if (!v.ok) throw remoteError("PROTOCOL", `${what}: unexpected response at ${v.path}: ${v.reason}`);
  return v.value;
}

export function serverCapabilities(limits: Pick<WelcomeMsg["limits"], "maxBlobSize" | "maxCommitOps" | "maxCommitBytes" | "maxInFlightCommits" | "maxFileSize" | "inlineMax" | "maxPackBytes">): RemoteCapabilities {
  return {
    changeFeed: "push", cas: "strong", atomicCommit: true, serverHistory: true, maintenance: "server", snapshots: "server",
    blobBatch: true, revocation: true, deviceRegistry: "server", serverTimestamps: true, enforcesActiveKv: true, usage: "exact",
    limits: {
      maxBlobSize: limits.maxBlobSize, maxCommitOps: limits.maxCommitOps, maxCommitBytes: limits.maxCommitBytes,
      maxInFlightCommits: limits.maxInFlightCommits, maxFileSize: limits.maxFileSize, inlineMax: limits.inlineMax,
      maxPackBytes: limits.maxPackBytes,
    },
  };
}

export class ServerAdapter implements RemoteAdapter {
  readonly kind = "shuttle-server";
  private caps: RemoteCapabilities = serverCapabilities(DEFAULT_LIMITS);
  private readonly rest: RestClient;
  private readonly feed: FeedLink;
  private readonly state: AdapterStateStore;
  private readonly vid: string;
  private readonly scheduler: Scheduler;
  private deviceId: DeviceId | null;
  private epochCache: number | null | undefined = undefined;
  private seenMaxSeq: Seq | null = null;
  private infoEtag: string | null = null;

  constructor(private readonly o: ServerAdapterOptions) {
    this.vid = o.config.vaultId;
    this.deviceId = o.config.deviceId ?? null;
    this.state = o.state ?? memoryState();
    this.scheduler = o.scheduler ?? realScheduler();
    const clock = o.clock ?? realClock;
    this.rest = new RestClient({
      urls: o.config.urls, http: o.http, token: o.token, scheduler: this.scheduler, allowHttp: o.allowHttp ?? false,
      timeouts: { ...DEFAULT_REST_TIMEOUTS, ...pick(o.timeouts, ["probeMs", "requestMs", "transferMs"]) },
    });
    this.feed = new FeedLink({
      ws: o.ws,
      // Probe the URL list before every attempt: an earlier URL that came back is preferred again.
      wsUrl: async () => wsUrlOf(await this.rest.probe()),
      onEndpointFailed: () => this.rest.invalidate(),
      token: () => this.rest.token(),
      vaultId: this.vid,
      client: o.client,
      hello: () => this.helloContext(),
      ...(o.maxUnackedBytes !== undefined ? { maxUnackedBytes: o.maxUnackedBytes } : {}),
      clock, scheduler: this.scheduler, random: o.random ?? Math.random,
      timeouts: { ...DEFAULT_FEED_TIMEOUTS, ...pick(o.timeouts, ["connectMs", "commitMs", "pongMs", "stableMs", "maxBackoffMs"]) },
      onWelcome: (w) => this.onWelcome(w),
      onPersisted: (b) => this.noteSeen(b.headSeq),
      onVaultInfoChanged: (etag) => { this.infoEtag = etag; },
    });
  }

  get capabilities(): RemoteCapabilities {
    return this.caps;
  }

  /** The base URL in use (null before the first probe). */
  get endpoint(): string | null {
    return this.rest.current;
  }

  /** Feed counters and link phase (debugInfo, tests). */
  get feedStats(): { phase: string } & FeedLink["stats"] {
    return { phase: this.feed.state, ...this.feed.stats };
  }

  // ---------------- session ----------------

  /**
   * Probe the URL list, check the token (GET /v1/me) and read the vault's head. REST only: the vault
   * may not exist yet (onboarding creates it after getVaultInfo() returns null), and a WebSocket hello
   * for a missing vault is fatal. Does not start the feed.
   */
  async connect(): Promise<ConnectInfo> {
    await this.rest.probe();
    const { data: meData } = await this.rest.json("GET", "/me", "me");
    const me = need(validateMeResponse(meData), "me");
    this.deviceId = me.device.deviceId;
    // Server limits before any subscribe (a welcome refreshes them): REST commits and the engine's batch
    // sizes follow them from the start. /v1/me wins over the probe's /v1/health; a server sending
    // neither keeps the protocol defaults.
    const limits = me.limits ?? this.rest.lastHealth?.limits;
    if (limits) this.caps = serverCapabilities(limits);
    const serverTime = this.rest.lastHealth?.time;
    const info = await this.getVaultInfo();
    if (!info) {
      // Remote empty (design §2.12 getVaultInfo → null): nothing to read yet.
      return {
        deviceId: me.device.deviceId, headSeq: 0, minSeq: 0, epoch: 0, infoEtag: null, retention: { ...DEFAULT_RETENTION },
        ...(serverTime !== undefined ? { serverTime } : {}), capabilities: this.caps,
      };
    }
    const { data } = await this.rest.json("GET", `${this.vpath()}/snapshot?limit=1&tombstones=0`, "snapshot");
    const head = need(validateSnapshotResponse(data), "snapshot");
    return {
      deviceId: me.device.deviceId, headSeq: head.headSeq, minSeq: head.minSeq, epoch: head.epoch, infoEtag: info.etag,
      retention: { ...info.info.retention }, ...(serverTime !== undefined ? { serverTime } : {}), capabilities: this.caps,
    };
  }

  async close(): Promise<void> {
    await this.feed.close();
  }

  // ---------------- vault info (CAS) ----------------

  async getVaultInfo(): Promise<{ info: VaultInfo; etag: string } | null> {
    const res = await this.rest.call("GET", `${this.vpath()}/info`, "vault-info", { accept: [404] });
    if (res.status === 404) {
      const code = errorCodeOf(res);
      if (code === "VAULT_NOT_FOUND") return null;
      throw remoteError("NOT_FOUND", `vault-info: ${code ?? "HTTP 404"}`);
    }
    const etag = header(res, "etag");
    if (!etag) throw remoteError("PROTOCOL", "vault-info: response has no ETag");
    const info = need(validateVaultInfo(parseJson(res)), "vault-info");
    this.infoEtag = etag;
    return { info, etag };
  }

  async createVaultInfo(info: VaultInfo): Promise<{ etag: string }> {
    if (info.vaultId !== this.vid) throw remoteError("PROTOCOL", "createVaultInfo: info.vaultId differs from the configured vaultId");
    const { data } = await this.rest.json("POST", "/vaults", "create vault", { name: this.o.vaultName ?? this.vid, info });
    const out = need(validateCreateVaultResponse(data), "create vault");
    await this.setEpoch(info.epoch);
    this.infoEtag = out.etag;
    return { etag: out.etag };
  }

  async updateVaultInfo(info: VaultInfo, ifMatch: string): Promise<{ etag: string }> {
    const { data } = await this.rest.json("PUT", `${this.vpath()}/info`, "update vault-info", info, { headers: { "If-Match": ifMatch } });
    const out = need(validatePutInfoResponse(data), "update vault-info");
    this.infoEtag = out.etag;
    return { etag: out.etag };
  }

  // ---------------- blobs ----------------

  async missingBlobs(ids: BlobId[]): Promise<BlobId[]> {
    const out: BlobId[] = [];
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += MAX_MISSING_IDS) {
      const { data } = await this.rest.json("POST", `${this.vpath()}/blobs/missing`, "missing blobs", { ids: uniq.slice(i, i + MAX_MISSING_IDS) });
      out.push(...need(validateMissingBlobsResponse(data), "missing blobs").missing);
    }
    return out;
  }

  async putBlob(id: BlobId, bytes: Uint8Array): Promise<'stored' | 'present'> {
    if (bytes.length > this.caps.limits.maxBlobSize) throw remoteError("TOO_LARGE", `blob ${id} exceeds ${this.caps.limits.maxBlobSize} bytes`);
    const sha = await sha256Hex(bytes);
    const body = toArrayBuffer(bytes);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.rest.call("PUT", `${this.vpath()}/blobs/${id}`, "put blob", {
          body, headers: { "Content-Type": "application/octet-stream", [HEADER_SHA256]: sha }, timeoutMs: this.transferMs(),
        });
        return res.status === 201 ? "stored" : "present";
      } catch (e) {
        // design §2.9.3: HASH_MISMATCH means a proxy truncated the body; re-upload up to 3 times.
        if (isRemoteError(e, "HASH_MISMATCH") && attempt < HASH_MISMATCH_TRIES) continue;
        throw e;
      }
    }
  }

  async getBlob(id: BlobId): Promise<Uint8Array> {
    const res = await this.rest.call("GET", `${this.vpath()}/blobs/${id}`, "get blob", { timeoutMs: this.transferMs(), headers: { Accept: "application/octet-stream" } });
    return new Uint8Array(res.body);
  }

  /** pack-put (design §2.8.5), split to ≤ 256 entries and ≤ maxPackBytes per request. */
  async putBlobs(items: Array<{ id: BlobId; bytes: Uint8Array }>): Promise<void> {
    const max = this.caps.limits.maxPackBytes ?? DEFAULT_LIMITS.maxPackBytes;
    let group: Array<{ id: BlobId; bytes: Uint8Array }> = [];
    let size = 9;
    const flush = async () => {
      if (group.length === 0) return;
      const pack = encodePack(group, { maxBytes: max, maxEntries: MAX_PACK_ENTRIES });
      const { data } = await this.rest.json("POST", `${this.vpath()}/blobs/pack-put`, "pack-put", undefined, {
        body: toArrayBuffer(pack), headers: { "Content-Type": PACK_CONTENT_TYPE, [HEADER_SHA256]: await sha256Hex(pack) }, timeoutMs: this.transferMs(),
      });
      need(validatePackPutResponse(data), "pack-put");
      group = [];
      size = 9;
    };
    for (const it of items) {
      const n = 36 + it.bytes.length;
      if (9 + n > max) throw remoteError("TOO_LARGE", `blob ${it.id} does not fit in a pack; use putBlob`);
      if (group.length >= MAX_PACK_ENTRIES || size + n > max) await flush();
      group.push(it);
      size += n;
    }
    await flush();
  }

  /** pack-get (design §2.8.5). The map holds only the entries the server included; null = missing. */
  async getBlobs(ids: BlobId[], maxBytes: number): Promise<Map<BlobId, Uint8Array | null>> {
    const out = new Map<BlobId, Uint8Array | null>();
    if (ids.length === 0) return out;
    if (ids.length > MAX_PACK_ENTRIES) throw remoteError("PROTOCOL", `getBlobs: more than ${MAX_PACK_ENTRIES} ids`);
    const cap = Math.min(maxBytes, this.caps.limits.maxPackBytes ?? DEFAULT_LIMITS.maxPackBytes);
    const res = await this.rest.call("POST", `${this.vpath()}/blobs/pack-get`, "pack-get", {
      body: JSON.stringify({ ids, maxBytes: cap }),
      headers: { "Content-Type": "application/json", Accept: PACK_CONTENT_TYPE }, timeoutMs: this.transferMs(),
    });
    let entries;
    try {
      entries = decodePack(new Uint8Array(res.body), { allowMissing: true, maxEntries: MAX_PACK_ENTRIES, maxBytes: Math.max(cap, this.caps.limits.maxBlobSize) + 64 * 1024 });
    } catch (e) {
      if (e instanceof PackError) throw remoteError("PROTOCOL", `pack-get: ${e.message}`);
      throw e;
    }
    const wanted = new Set(ids);
    for (const e of entries) {
      if (!wanted.has(e.id)) throw remoteError("PROTOCOL", `pack-get: unrequested blob ${e.id}`);
      out.set(e.id, e.bytes);
    }
    return out;
  }

  // ---------------- log ----------------

  /**
   * Over the socket while a subscription is open (design §2.9.1, commitResult before the changes frame
   * carrying its seqs); over POST /commit otherwise (design §2.8.5). Idempotent per cid either way.
   */
  async commit(req: CommitRequest): Promise<CommitResponse> {
    if (this.feed.hasSubscription) return this.feed.commit(req);
    // Same frame-level check as the socket path (design §2.5, §2.9.4), against the limits read at connect.
    const tooBig = checkCommitLimits(req, utf8Length(JSON.stringify(req)), this.caps.limits);
    if (tooBig) throw remoteError("TOO_LARGE", tooBig.message);
    const { data } = await this.rest.json("POST", `${this.vpath()}/commit`, "commit", req);
    const out = need(validateCommitResponse(data), "commit");
    if (out.cid !== req.cid || out.results.length !== req.ops.length) throw remoteError("PROTOCOL", "commit: response does not match the request");
    return out;
  }

  /** One coalesced page over REST (design §2.8.5 GET /changes, wait=0). */
  async pull(since: Seq, limit?: number): Promise<ChangeBatch> {
    const epoch = await this.knownEpoch();
    const q = new URLSearchParams({ since: String(since), limit: String(clampInt(limit ?? CHANGES_LIMIT_DEFAULT, 1, CHANGES_LIMIT_DEFAULT)) });
    if (epoch !== null) q.set("epoch", String(epoch));
    // design §2.6.1: an accepted restore is acked on REST pulls too (the rollback resync's catch-up).
    const s = this.o.session ? await this.o.session() : {};
    if (s.rollbackAck !== undefined && s.rollbackAck !== null) q.set("rollbackAck", String(s.rollbackAck));
    // design §2.6.1 / lead decision D9: the REST pull reports seen.maxSeq exactly like the WS hello.
    const seen = s.seenMaxSeq !== undefined ? s.seenMaxSeq : this.seenMaxSeq;
    if (seen !== null && seen > since) q.set("seenMaxSeq", String(seen));
    const { data } = await this.rest.json("GET", `${this.vpath()}/changes?${q.toString()}`, "pull");
    const r = need(validateChangesResponse(data), "pull");
    if (r.from !== since) throw remoteError("PROTOCOL", `pull: asked from ${since}, got ${r.from}`);
    this.noteSeen(r.headSeq);
    return { from: r.from, to: r.to, headSeq: r.headSeq, minSeq: r.minSeq, records: r.records, more: r.more, live: false };
  }

  subscribe(since: Seq | null, sink: ChangeSink): Subscription {
    return this.feed.subscribe(since, sink);
  }

  async snapshot(opts: { pageToken?: string | null; limit?: number; tombstones: boolean; history?: boolean }): Promise<SnapshotPage> {
    const q = new URLSearchParams({
      limit: String(clampInt(opts.limit ?? SNAPSHOT_PAGE_DEFAULT, 1, SNAPSHOT_PAGE_MAX)), tombstones: opts.tombstones ? "1" : "0",
    });
    if (opts.pageToken) q.set("after", opts.pageToken);
    const { data } = await this.rest.json("GET", `${this.vpath()}/snapshot?${q.toString()}`, "snapshot");
    const page = need(validateSnapshotResponse(data), "snapshot");
    // The first page is the bootstrap point: the device now follows this epoch (cf. FakeRemote).
    if (!opts.pageToken) await this.setEpoch(page.epoch);
    this.noteSeen(page.headSeq);
    return { headSeq: page.headSeq, minSeq: page.minSeq, epoch: page.epoch, records: page.records, next: page.next };
  }

  ack(upTo: Seq): void {
    if (this.feed.ack(upTo)) return;
    // No greeted socket: report the cursor over REST, best effort (fire-and-forget by contract).
    this.rest.json("POST", `${this.vpath()}/ack`, "ack", { upTo }).catch(() => { /* next ack covers it */ });
  }

  // ---------------- history ----------------

  async getVersion(fileId: FileId, seq: Seq): Promise<VersionRecord | null> {
    const res = await this.rest.call("GET", `${this.vpath()}/files/${fileId}/versions/${seq}`, "get version", { accept: [404] });
    if (res.status === 404) {
      if (errorCodeOf(res) === "VAULT_NOT_FOUND") throw remoteError("VAULT_NOT_FOUND", "vault not found");
      return null;
    }
    return need(validateVersionRecord(parseJson(res)), "get version");
  }

  async listVersions(fileId: FileId, opts: { before?: Seq; limit?: number } = {}): Promise<{ records: VersionRecord[]; next: Seq | null }> {
    const q = pageQuery(opts, 50, 500);
    const { data } = await this.rest.json("GET", `${this.vpath()}/files/${fileId}/versions${q}`, "list versions");
    return need(validateVersionsResponse(data), "list versions");
  }

  async listDeleted(opts: { before?: Seq; limit?: number } = {}): Promise<{ records: VersionRecord[]; next: Seq | null }> {
    const q = pageQuery(opts, 100, 1000);
    const { data } = await this.rest.json("GET", `${this.vpath()}/deleted${q}`, "list deleted");
    return need(validateVersionsResponse(data), "list deleted");
  }

  async usage(): Promise<UsageInfo> {
    const { data } = await this.rest.json("GET", `${this.vpath()}/usage`, "usage");
    const u = need(validateUsageResponse(data), "usage");
    return { liveBytes: u.liveBytes, historyBytes: u.historyBytes, blobCount: u.blobCount, fileCount: u.fileCount, quotaBytes: u.quotaBytes, exact: true };
  }

  // ---------------- devices ----------------

  async listDevices(): Promise<AdapterDevice[]> {
    const { data } = await this.rest.json("GET", "/devices", "list devices");
    return need(validateDevicesResponse(data), "list devices").devices.map((d) => ({
      deviceId: d.deviceId, name: d.name, platform: d.platform, revoked: d.revoked, current: d.current,
      ...(d.clientVersion !== null ? { clientVersion: d.clientVersion } : {}),
      ...(d.lastSeenAt !== null ? { lastSeenAt: d.lastSeenAt } : {}),
    }));
  }

  async revokeDevice(id: DeviceId): Promise<void> {
    await this.rest.call("DELETE", `/devices/${encodeURIComponent(id)}`, "revoke device");
  }

  async createEnrollCode(ttlSec: number): Promise<{ code: string; expiresAt: number; link: string }> {
    const { data } = await this.rest.json("POST", "/enroll-codes", "enroll code", { ttlSec });
    return need(validateEnrollCodeResponse(data), "enroll code");
  }

  // ---------------- pairing mailbox (design §4.12.2) ----------------

  async pairingPut(pairId: string, body: string): Promise<void> {
    await this.rest.call("PUT", `${this.vpath()}/pairing/${encodeURIComponent(pairId)}`, "pairing put", {
      body, headers: { "Content-Type": "application/json" },
    });
  }

  async pairingTake(pairId: string): Promise<string | null> {
    // Read-and-delete: never retried here, a lost response cannot be read again.
    const res = await this.rest.call("GET", `${this.vpath()}/pairing/${encodeURIComponent(pairId)}`, "pairing take", { accept: [404, 410] });
    if (res.status === 404 || res.status === 410) {
      if (errorCodeOf(res) === "VAULT_NOT_FOUND") throw remoteError("VAULT_NOT_FOUND", "vault not found");
      return null;
    }
    return new TextDecoder().decode(new Uint8Array(res.body));
  }

  // ---------------- maintenance and recovery ----------------

  /** The server runs retention, snapshots and GC itself (capabilities.maintenance = 'server'). */
  async runMaintenance(_signal?: AbortSignal): Promise<MaintenanceResult> {
    return { ran: false };
  }

  async rebuild(info: VaultInfo): Promise<{ epoch: number }> {
    const { data } = await this.rest.json("POST", `${this.vpath()}/rebuild`, "rebuild", { info });
    const out = need(validateRebuildResponse(data), "rebuild");
    await this.setEpoch(out.epoch);
    return { epoch: out.epoch };
  }

  // ---------------- internals ----------------

  private vpath(): string {
    return `/vaults/${encodeURIComponent(this.vid)}`;
  }

  private transferMs(): number {
    return this.o.timeouts?.transferMs ?? DEFAULT_REST_TIMEOUTS.transferMs;
  }

  private onWelcome(w: WelcomeMsg): void {
    this.deviceId = w.deviceId;
    this.infoEtag = w.infoEtag;
    this.caps = serverCapabilities(w.limits);
  }

  /** seen.maxSeq fallback: the highest head the device has persisted or read (design §4.9.2). */
  private noteSeen(headSeq: Seq): void {
    if (this.seenMaxSeq === null || headSeq > this.seenMaxSeq) this.seenMaxSeq = headSeq;
  }

  private async knownEpoch(): Promise<number | null> {
    if (this.epochCache !== undefined) return this.epochCache;
    const v = await this.state.get(STATE_EPOCH_KEY);
    this.epochCache = typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
    return this.epochCache;
  }

  private async setEpoch(epoch: number): Promise<void> {
    this.epochCache = epoch;
    await this.state.put(STATE_EPOCH_KEY, epoch);
  }

  private async helloContext(): Promise<HelloContext> {
    const s = this.o.session ? await this.o.session() : {};
    const epoch = s.epoch !== undefined ? s.epoch : await this.knownEpoch();
    return {
      epoch,
      seenMaxSeq: s.seenMaxSeq !== undefined ? s.seenMaxSeq : this.seenMaxSeq,
      rollbackAck: s.rollbackAck !== undefined ? s.rollbackAck : null,
    };
  }
}

// ---------------- onboarding helpers (no adapter instance yet) ----------------

export interface AuthOptions {
  urls: readonly string[];
  http: HttpClient;
  allowHttp?: boolean;
  scheduler?: Scheduler;
  timeouts?: Partial<RestTimeouts>;
}

function anonymousRest(o: AuthOptions): RestClient {
  return new RestClient({
    urls: o.urls, http: o.http, token: () => null, scheduler: o.scheduler ?? realScheduler(), allowHttp: o.allowHttp ?? false,
    timeouts: { ...DEFAULT_REST_TIMEOUTS, ...o.timeouts },
  });
}

/** POST /v1/auth/login (design §2.8.4). The token goes to vault-scoped secret storage (§4.10.1). */
export async function serverLogin(o: AuthOptions, username: string, password: string, device: DeviceDescriptor): Promise<AuthResponse & { url: string }> {
  const rest = anonymousRest(o);
  const url = await rest.base();
  const { data } = await rest.json("POST", "/auth/login", "login", { username, password, device }, { auth: false });
  return { ...need(validateAuthResponse(data), "login"), url };
}

/** POST /v1/auth/enroll with a single-use code (design §2.8.4). */
export async function serverEnroll(o: AuthOptions, code: string, device: DeviceDescriptor): Promise<AuthResponse & { url: string }> {
  const rest = anonymousRest(o);
  const url = await rest.base();
  const { data } = await rest.json("POST", "/auth/enroll", "enroll", { code, device }, { auth: false });
  return { ...need(validateAuthResponse(data), "enroll"), url };
}

/** `details` of a REST SNAPSHOT_REQUIRED (design §2.8.5), for callers that pulled and got one. */
export function snapshotRequiredDetails(e: RemoteError): { reason: string; minSeq: Seq; epoch: number; rollbackAt?: number | null } | null {
  if (e.code !== "SNAPSHOT_REQUIRED") return null;
  const v = validateSnapshotRequiredDetails(e.details);
  return v.ok ? v.value : null;
}

// ---------------- small helpers ----------------

function errorCodeOf(res: { body: ArrayBuffer }): string | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(new Uint8Array(res.body))) as { error?: { code?: unknown } };
    return typeof j?.error?.code === "string" ? j.error.code : null;
  } catch {
    return null;
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function pageQuery(opts: { before?: Seq; limit?: number }, def: number, max: number): string {
  const q = new URLSearchParams({ limit: String(clampInt(opts.limit ?? def, 1, max)) });
  if (opts.before !== undefined) q.set("before", String(opts.before));
  return `?${q.toString()}`;
}

function pick<T extends object, K extends keyof T>(o: Partial<T> | undefined, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  if (!o) return out;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * Host helper for the `session` option: the engine's hello context (engine.helloContext()) reduced to
 * the fields the adapter cannot know (design §2.6.1). The epoch stays the adapter's own; null fields
 * fall back to the adapter's values.
 */
export function helloSession(c: { epoch: number | null; seenMaxSeq: Seq | null; rollbackAck: number | null } | null): Partial<HelloContext> {
  if (!c) return {};
  return {
    ...(c.seenMaxSeq !== null ? { seenMaxSeq: c.seenMaxSeq } : {}),
    ...(c.rollbackAck !== null ? { rollbackAck: c.rollbackAck } : {}),
  };
}
