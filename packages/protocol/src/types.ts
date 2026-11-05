// @shuttle/protocol types. The first half is design §2.12 verbatim (the normative interface set, ID-4);
// RemoteError lives in errors.ts because it is a value. The second half adds the wire shapes §2 defines
// but §2.12 does not spell out: WebSocket frames (§2.9), REST bodies (§2.8.4, §2.8.5), meta plaintext
// (§2.4) and S3 objects (§2.10).

import type { RemoteError } from "./errors";

// ---------- shared primitives ----------
export type Seq = number;          // safe integer, vault-wide, monotonic across epochs
export type FileId = string;       // hex32, random
export type PathKey = string;      // b64u22
export type BlobId = string;       // hex64
export type DeviceId = string;     // b64u
export type RetentionClass = 'note' | 'attachment' | 'config';
export type RecordKind = 'put' | 'del' | 'archive';

export interface VaultInfoKey {
  // `suite` and `kdf.alg` are widened with `(string & {})` so a newer vault-info still parses and the
  // engine can report UpdateRequired / UnsupportedKdf (§4.5.3 steps 2-3) instead of a parse error.
  kv: number; status: 'active' | 'decrypt-only' | 'retired'; suite: 'sx1' | (string & {}); nonce: string; wrapped: string; check: string; createdAt: number;
}
export interface VaultInfoParams {
  chunker: { alg: 'fastcdc-k1'; min: number; avg: number; max: number }; inlineMax: number;
  compression: 'deflate-raw' | 'none'; padding: 'none' | 'padme'; metaPadBucket: number;
}

export interface VaultInfo {
  format: 'shuttle.vault-info'; formatVersion: 1; vaultId: string; createdAt: number;
  infoRev: number; epoch: number;
  kdf: { alg: 'PBKDF2-SHA256' | 'argon2id' | 'scrypt' | (string & {}); salt: string; [k: string]: unknown };
  keys: Array<VaultInfoKey>;
  activeKv: number;
  params: VaultInfoParams;
  retention: Retention;
  requires: string[]; unlockRequires: string[]; features: string[];
  infoMac: string;
  [k: string]: unknown;            // preserve unknown fields (included in the MAC)
}
/**
 * VaultInfo without `infoMac` (the MAC preimage, §4.5.2). Use this instead of `Omit<VaultInfo, 'infoMac'>`:
 * Omit over a type with an index signature collapses every known key to `unknown`.
 */
export type UnsignedVaultInfo = { [K in keyof VaultInfo as K extends 'infoMac' ? never : K]: VaultInfo[K] };
/** What the server checks of a vault-info body (§2.2 last bullet); the rest is opaque to it. */
export type VaultInfoEnvelope = Pick<VaultInfo, 'format' | 'formatVersion' | 'vaultId' | 'infoRev' | 'epoch' | 'activeKv' | 'infoMac'> & { [k: string]: unknown };
export interface Retention { noteDays: number; attachmentDays: number; configDays: number; tombstoneDays: number; thinAfterHours?: number; thinBucketMinutes?: number }

export interface VersionRecord {
  seq: Seq; fileId: FileId; pathKey: PathKey; base: Seq | null; kind: RecordKind; rc: RetentionClass; kv: number;
  meta: string; blobs: BlobId[]; inline?: string; encSize: number;
  device: DeviceId; ts: number; cid?: string;
}

export type CommitOp =
  | { op: 'put'; fileId: FileId; base: Seq | null; pathKey: PathKey; rc: RetentionClass; kv: number; meta: string; blobs: BlobId[]; inline?: string | null }
  | { op: 'del'; fileId: FileId; base: Seq; pathKey: PathKey; rc: RetentionClass; kv: number; meta: string }
  | { op: 'archive'; fileId: FileId; base: Seq; pathKey: PathKey; rc: RetentionClass; kv: number; meta: string; blobs: BlobId[]; inline?: string | null };

export interface CommitRequest { cid: string; ops: CommitOp[]; atomic?: boolean }
export type OpResult =
  | { i: number; ok: true; seqs: Seq[] }
  | { i: number; ok: false; code: 'CONFLICT' | 'PATH_TAKEN'; current: VersionRecord | null }
  | { i: number; ok: false; code: 'MISSING_BLOB'; missing: BlobId[] }
  | { i: number; ok: false; code: 'INVALID' | 'TOO_LARGE' | 'QUOTA' | 'KEY_VERSION' | 'ABORTED'; message?: string };
export interface CommitResponse { cid: string; headSeq: Seq; replayed: boolean; results: OpResult[] }

export interface ChangeBatch {
  from: Seq; to: Seq; headSeq: Seq; minSeq: Seq;
  records: VersionRecord[];   // catch-up: ≤1 head record per fileId; live: may include archive records
  more: boolean; live: boolean;
}
export interface SnapshotPage {
  headSeq: Seq;                 // the value from the FIRST page is the post-bootstrap cursor
  minSeq: Seq; epoch: number;
  records: VersionRecord[];     // heads only (put/del)
  history?: Record<FileId, VersionRecord[]>;   // S3 snapshots; server uses listVersions
  next: string | null;          // opaque page token
}

// ---------- capabilities ----------
export interface PollConfig { active: number; idle: number; background: number }   // ms
export interface RemoteLimits {
  maxBlobSize: number; maxCommitOps: number; maxCommitBytes: number; maxInFlightCommits: number;
  maxFileSize: number; inlineMax: number; maxPackBytes?: number;
}
export interface RemoteCapabilities {
  changeFeed: 'push' | 'longpoll' | 'poll';
  cas: 'strong';                          // v1 requires strong CAS; 'weak' | 'none' reserved
  atomicCommit: boolean;
  serverHistory: boolean;                 // remote applies retention and thinning itself
  maintenance: 'server' | 'client';
  snapshots: 'server' | 'client';
  blobBatch: boolean;                     // pack-get/pack-put
  revocation: boolean;
  deviceRegistry: 'server' | 'advisory';
  serverTimestamps: boolean;              // false on S3 (object LastModified used instead)
  enforcesActiveKv: boolean;              // server: true; S3: false (§4.11.4)
  usage: 'exact' | 'estimate' | 'none';
  limits: RemoteLimits;
  poll?: PollConfig;
}

// ---------- errors ----------
export type RemoteErrorCode =
  | 'NETWORK' | 'TIMEOUT' | 'UNAUTHENTICATED' | 'REVOKED' | 'FORBIDDEN' | 'VAULT_NOT_FOUND' | 'NOT_FOUND'
  | 'PRECONDITION_FAILED' | 'ALREADY_EXISTS' | 'RATE_LIMITED' | 'TOO_LARGE' | 'QUOTA' | 'SNAPSHOT_REQUIRED'
  | 'HASH_MISMATCH' | 'PROTOCOL' | 'UNSUPPORTED' | 'SERVER' | 'UNAVAILABLE';

// ---------- subscription ----------
export type ConnectionState = 'connecting' | 'connected' | 'catching-up' | 'live' | 'paused' | 'offline' | 'auth-error';
export type SnapshotReason = 'cursor-too-old' | 'epoch' | 'no-cursor' | 'rollback';
export interface SnapshotRequiredInfo { reason: SnapshotReason; minSeq: Seq; epoch: number; rollbackAt?: number | null }
export interface ChangeSink {
  /** Persist records + cursor in ONE transaction, then resolve. The adapter acks and advances flow control only after resolution. */
  onChanges(batch: ChangeBatch): Promise<void>;
  /** S3 commit path: the engine's current materialized head for CAS evaluation (after onChanges resolved). */
  headOf(fileId: FileId): VersionRecord | null;
  liveHeadByPathKey(pk: PathKey): VersionRecord | null;
  onSnapshotRequired(info: SnapshotRequiredInfo): void;
  onVaultInfoChanged(etag: string): void;
  onState(state: ConnectionState, detail?: string): void;   // status icon and activity log
  onError(err: RemoteError): void;
}
export interface Subscription { close(): void; nudge(): void /* poll or ping now */ }

export interface ConnectInfo {
  deviceId: DeviceId; headSeq: Seq; minSeq: Seq; epoch: number; infoEtag: string | null;
  retention: Retention; serverTime?: number; capabilities: RemoteCapabilities;
}

/** Durable per-device adapter state (plugin: IDB store `adapter`; headless: SQLite table). */
export interface AdapterStateStore {
  get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>;
}

export interface UsageInfo { liveBytes: number; historyBytes: number; blobCount: number; fileCount: number; quotaBytes: number | null; exact: boolean }
export interface AdapterDevice { deviceId: DeviceId; name: string; platform: string; clientVersion?: string; lastSeenAt?: number; revoked?: boolean; current: boolean }
export interface MaintenanceResult { ran: boolean; snapshotSeq?: Seq; trimmedEntries?: number; gcPhase?: 1 | 2; deletedBlobs?: number }

// ---------- the adapter ----------
export interface RemoteAdapter {
  readonly kind: 'shuttle-server' | 's3' | string;
  readonly capabilities: RemoteCapabilities;       // provisional until connect() resolves

  connect(): Promise<ConnectInfo>;                 // auth, probe (S3), welcome; does not start the feed
  close(): Promise<void>;

  getVaultInfo(): Promise<{ info: VaultInfo; etag: string } | null>;      // null = remote empty
  createVaultInfo(info: VaultInfo): Promise<{ etag: string }>;            // ALREADY_EXISTS
  updateVaultInfo(info: VaultInfo, ifMatch: string): Promise<{ etag: string }>; // PRECONDITION_FAILED

  missingBlobs(ids: BlobId[]): Promise<BlobId[]>;
  putBlob(id: BlobId, bytes: Uint8Array): Promise<'stored' | 'present'>;
  getBlob(id: BlobId): Promise<Uint8Array>;                               // NOT_FOUND
  putBlobs?(items: Array<{ id: BlobId; bytes: Uint8Array }>): Promise<void>;
  getBlobs?(ids: BlobId[], maxBytes: number): Promise<Map<BlobId, Uint8Array | null>>;

  commit(req: CommitRequest): Promise<CommitResponse>;   // idempotent per cid; CONFLICT/PATH_TAKEN per op; requires an active subscription
  pull(since: Seq, limit?: number): Promise<ChangeBatch>; // one coalesced page; SNAPSHOT_REQUIRED
  subscribe(since: Seq | null, sink: ChangeSink): Subscription;
  snapshot(opts: { pageToken?: string | null; limit?: number; tombstones: boolean; history?: boolean }): Promise<SnapshotPage>;
  ack(upTo: Seq): void;

  getVersion(fileId: FileId, seq: Seq): Promise<VersionRecord | null>;   // merge-base recovery
  listVersions?(fileId: FileId, opts?: { before?: Seq; limit?: number }): Promise<{ records: VersionRecord[]; next: Seq | null }>;
  listDeleted?(opts?: { before?: Seq; limit?: number }): Promise<{ records: VersionRecord[]; next: Seq | null }>;
  usage?(): Promise<UsageInfo>;

  listDevices?(): Promise<Array<AdapterDevice>>;
  revokeDevice?(id: DeviceId): Promise<void>;
  createEnrollCode?(ttlSec: number): Promise<{ code: string; expiresAt: number; link: string }>;

  pairingPut(pairId: string, body: string): Promise<void>;          // mailbox (§4.12.2)
  pairingTake(pairId: string): Promise<string | null>;              // read + delete

  runMaintenance?(signal?: AbortSignal): Promise<MaintenanceResult>;
  rebuild?(info: VaultInfo): Promise<{ epoch: number }>;
}

// ---------- platform injection ----------
export interface HttpRequest { url: string; method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD' | 'PATCH';
  headers?: Record<string, string>; body?: ArrayBuffer | string; timeoutMs: number }
export interface HttpResponse { status: number; headers: Record<string, string>; body: ArrayBuffer }
export interface HttpClient { request(req: HttpRequest): Promise<HttpResponse> }   // plugin: requestUrl({throw:false}) + Promise.race; headless: fetch
export interface WsLike { send(data: string): void; close(code?: number, reason?: string): void;
  readonly readyState: number; onopen: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: ((ev: unknown) => void) | null; readonly protocol: string }
export type WsFactory = (url: string, protocols: string[]) => WsLike;

// ---------- internal building block for serverless adapters ----------
export interface ObjectStore {
  get(key: string, opts?: { ifNoneMatch?: string }): Promise<{ bytes: Uint8Array; etag: string; lastModified: number } | 'not-modified' | null>;
  put(key: string, bytes: Uint8Array, opts?: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<{ etag: string; date: number } | 'precondition-failed'>;
  head(key: string): Promise<{ etag: string; size: number; lastModified: number } | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, startAfter?: string): AsyncIterable<{ key: string; etag: string; size: number; lastModified: number }>;
}

// =====================================================================================
// Wire shapes defined in §2 outside the §2.12 block
// =====================================================================================

// ---------- meta plaintext (§2.4; decrypted by crypto, validated by the engine) ----------
export type ConfigCategory =
  | 'app' | 'appearance' | 'appearance-data' | 'hotkey'
  | 'core-plugin' | 'core-plugin-data' | 'community-plugin' | 'community-plugin-data';
export interface FileMeta {
  v: 1; path: string; type: 'file'; size: number; mtime: number; ctime: number;
  hash: string; chunker: string; chunks: number[]; z: boolean; p: boolean; cat: ConfigCategory | null;
  [k: string]: unknown;            // unknown fields MUST be preserved and ignored
}
/** Tombstone meta (ID-8): only {v, path, type, cat}. */
export interface TombstoneMeta { v: 1; path: string; type: 'file'; cat: ConfigCategory | null; [k: string]: unknown }

// ---------- WebSocket: client → server (§2.9.1) ----------
export type ClientRole = 'plugin' | 'headless';
export interface HelloMsg {
  type: 'hello'; rid: number; proto: number; token: string; vaultId: string;
  since: Seq | null; epoch: number | null; seenMaxSeq: Seq | null; rollbackAck: number | null;
  client: { name: string; platform: string; version: string; role: ClientRole };
  window: { maxUnackedBytes: number };
}
export interface CommitMsg extends CommitRequest { type: 'commit'; rid: number }
export interface AckMsg { type: 'ack'; upTo: Seq }
export interface PullMsg { type: 'pull'; rid: number; since: Seq; limit?: number }
export interface PingMsg { type: 'ping'; rid: number; ts: number }
export interface ByeMsg { type: 'bye' }
export type ClientMessage = HelloMsg | CommitMsg | AckMsg | PullMsg | PingMsg | ByeMsg;

// ---------- WebSocket: server → client (§2.9.2) ----------
export interface WelcomeLimits {
  maxBlobSize: number; maxPackBytes: number; maxCommitOps: number; maxCommitBytes: number;
  maxInFlightCommits: number; maxFileSize: number; inlineMax: number; maxRequestBody: number;
}
export interface WelcomeMsg {
  type: 'welcome'; rid: number; proto: number; server: string; deviceId: DeviceId; epoch: number;
  headSeq: Seq; minSeq: Seq; infoEtag: string | null;
  retention: Retention; limits: WelcomeLimits;
  heartbeatSec: number; idleTimeoutSec: number; serverTime: number;
}
export interface ChangesMsg extends ChangeBatch { type: 'changes'; rid: number | null }
export interface CommitResultMsg extends CommitResponse { type: 'commitResult'; rid: number }
export interface SnapshotRequiredMsg {
  type: 'snapshotRequired'; rid: number | null; reason: SnapshotReason; minSeq: Seq; epoch: number; rollbackAt: number | null;
}
export interface VaultInfoChangedMsg { type: 'vaultInfoChanged'; rid?: null; etag: string }
export type PauseReason = 'rate' | 'maintenance' | 'backpressure';
export interface PauseMsg { type: 'pause'; rid?: null; reason: PauseReason; retryAfterMs: number }
export interface ResumeMsg { type: 'resume'; rid?: null }
export interface PongMsg { type: 'pong'; rid: number; ts: number; serverTime: number }
export interface ErrorMsg {
  type: 'error'; rid: number | null; code: string; message?: string; fatal: boolean; retryAfterMs?: number | null;
}
export type ServerMessage =
  | WelcomeMsg | ChangesMsg | CommitResultMsg | SnapshotRequiredMsg | VaultInfoChangedMsg
  | PauseMsg | ResumeMsg | PongMsg | ErrorMsg;

// ---------- REST (§2.8.4, §2.8.5) ----------
export interface ErrorBody { error: { code: string; message?: string; retryAfterMs?: number; details?: Record<string, unknown> } }

export interface DeviceDescriptor { name: string; platform: string; clientVersion: string }
export interface LoginRequest { username: string; password: string; device: DeviceDescriptor }
export interface EnrollRequest { code: string; device: DeviceDescriptor }
export type UserRole = 'owner' | 'member';
export interface UserInfo { userId: string; username: string; role: UserRole | string }
export interface AuthResponse { token: string; deviceId: DeviceId; user: UserInfo }
export interface DeviceInfo {
  deviceId: DeviceId; name: string; platform: string; clientVersion: string | null;
  createdAt: number; lastSeenAt: number | null; revoked: boolean; current: boolean;
}
export interface MeResponse { user: UserInfo; device: DeviceInfo }
export interface EnrollCodeRequest { ttlSec: number }
export interface EnrollCodeResponse { code: string; expiresAt: number; link: string }
export interface DevicesResponse { devices: DeviceInfo[] }
export interface RenameDeviceRequest { name: string }

export interface HealthResponse { ok: boolean; server: string; protocols: number[]; time: number; source: string }

export interface VaultSummary {
  vaultId: string; name: string; role: string; createdAt: number; headSeq: Seq;
  usage: { liveBytes: number; totalBytes: number };
}
export interface VaultsResponse { vaults: VaultSummary[] }
export interface CreateVaultRequest { name: string; info: VaultInfoEnvelope }
export interface CreateVaultResponse { vaultId: string; etag: string }
export interface PutInfoResponse { etag: string }
export interface RebuildRequest { info: VaultInfoEnvelope }
export interface RebuildResponse { epoch: number; headSeq: Seq }
export interface UsageResponse {
  liveBytes: number; historyBytes: number; blobCount: number; fileCount: number; quotaBytes: number | null;
  largest: Array<{ fileId: FileId; encSize: number }>;
}

export interface MissingBlobsRequest { ids: BlobId[] }
export interface MissingBlobsResponse { missing: BlobId[] }
export interface PackGetRequest { ids: BlobId[]; maxBytes: number }
export interface PackPutResponse { stored: number; present: number }

/** GET /snapshot (server). `next` is a fileId page token. */
export interface SnapshotResponse { headSeq: Seq; minSeq: Seq; epoch: number; records: VersionRecord[]; next: string | null }
/** GET /changes long-poll. Same as ChangeBatch; `live` is not sent. */
export interface ChangesResponse { from: Seq; to: Seq; headSeq: Seq; minSeq: Seq; records: VersionRecord[]; more: boolean; live?: boolean }
export interface AckRequest { upTo: Seq }
export interface VersionsResponse { records: VersionRecord[]; next: Seq | null }

// ---------- S3 objects (§2.10.1, §2.10.4–2.10.6) ----------
export interface S3Head {
  format: 'shuttle.head'; v: 1; epoch: number; nextSeq: Seq; minSeq: Seq; infoEtag: string | null;
  snapshot: { seq: Seq; key: string } | null;
  gcPending: string | null; gcEpoch: number; updatedAt: number;
  [k: string]: unknown;
}
export interface S3LogEntry {
  format: 'shuttle.log'; v: 1; firstSeq: Seq; count: number; cid: string; device: DeviceId; ts: number;
  opsDigest: string; records: VersionRecord[];
  [k: string]: unknown;
}
/**
 * Snapshot manifest (D10). §2.10.2 names recordCount, fileCount, parts[].sha256 and mac; §4.9.3 adds
 * `kv` (selects K_info for the MAC). Those are required. `epoch`, `seq` and `parts[].key` are optional
 * here until the S3 adapter fixes the layout.
 */
export interface S3SnapshotManifest {
  kv: number; recordCount: number; fileCount: number;
  parts: Array<{ sha256: string; key?: string; [k: string]: unknown }>;
  mac: string;
  epoch?: number; seq?: Seq;
  [k: string]: unknown;
}
export interface S3SnapshotPart { files: Array<{ head: VersionRecord; history: VersionRecord[] }> }
export interface S3DeviceEntry {
  name: string; platform: string; clientVersion: string; createdAt: number; lastSeenAt: number; ackedSeq: Seq | null;
  [k: string]: unknown;
}
export interface S3MaintLease { holder: DeviceId; expiresAt: number; [k: string]: unknown }

// ---------- adapter config (per device, localStorage; §2.12) ----------
export interface ServerAdapterConfig { kind: 'shuttle-server'; urls: string[]; vaultId: string; deviceId: DeviceId }
export interface S3AdapterConfig {
  kind: 's3'; endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean;
  deviceId: DeviceId; maintenance: 'auto' | 'never' | 'always';
}
export type AdapterConfig = ServerAdapterConfig | S3AdapterConfig;

// ---------- pack codec (§2.8.5) ----------
/** `bytes: null` = blob missing (pack-get responses only). */
export interface PackEntry { id: BlobId; bytes: Uint8Array | null }
