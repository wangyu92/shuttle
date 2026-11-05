// Valid fixtures taken from the design examples (§2.2, §2.4, §2.5, §2.8.4, §2.8.5, §2.9, §2.10.1).
// Placeholders in the spec ("…", "<b64u 32 bytes>") are replaced with well-formed values of the same kind;
// the real-shaped ids that appear in the spec are kept as is.

export const VAULT_ID = "q3mY5r0Q2bS7TqvJvKzW1A";
export const FILE_ID = "3f9c0a1e5b7d4c2f8e6a1b3c5d7e9f01";
export const FILE_ID_2 = "0123456789abcdef0123456789abcdef";
export const PATH_KEY = "u-4AmhZQy1GvDCVXociBXw";
export const DEVICE_ID = "Hq2v9dXc7bQ1Lr0aZk3n8w";
export const CID = "6f1c3a52-6a2e-4d61-9a5e-2b1b8a1f0c11";
export const BLOB_A = "aa".repeat(32);
export const BLOB_B = "bb".repeat(32);
/** b64u of 36 bytes (12 nonce + 8 ct + 16 tag). */
export const SEALED = "bm9uY2Utbm9uY2UtMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0";
export const TOKEN = "sxd_" + "Q".repeat(43);

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const vaultInfo = {
  format: "shuttle.vault-info", formatVersion: 1,
  vaultId: VAULT_ID, createdAt: 1762318800000,
  infoRev: 1, epoch: 1,
  kdf: { alg: "PBKDF2-SHA256", iter: 600000, salt: "c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ" },
  keys: [{ kv: 1, status: "active", suite: "sx1", nonce: "bm9uY2Vub25jZW5v",
    wrapped: "d3JhcHBlZHdyYXBwZWR3cmFwcGVkd3JhcHBlZHdyYXBwZWR3cmFwcGVk", check: "Y2hlY2tjaGVja2NoZWNrMQ", createdAt: 1762318800000 }],
  activeKv: 1,
  params: {
    chunker: { alg: "fastcdc-k1", min: 262144, avg: 1048576, max: 4194304 },
    inlineMax: 4096, compression: "deflate-raw", padding: "none", metaPadBucket: 256,
  },
  retention: { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90, thinAfterHours: 24, thinBucketMinutes: 60 },
  requires: [], unlockRequires: [], features: ["history-v1", "archive-v1"],
  infoMac: "bWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWE",
};

export const versionRecord = {
  seq: 18234,
  fileId: FILE_ID,
  pathKey: PATH_KEY,
  base: 18011,
  kind: "put",
  rc: "note",
  kv: 1,
  meta: SEALED,
  blobs: [],
  inline: SEALED,
  encSize: 1421,
  device: DEVICE_ID,
  ts: 1762318801234,
  cid: CID,
};

export const tombstoneRecord = {
  seq: 18235, fileId: FILE_ID, pathKey: PATH_KEY, base: 18234, kind: "del", rc: "note", kv: 1,
  meta: SEALED, blobs: [], encSize: 36, device: DEVICE_ID, ts: 1762318801300, cid: CID,
};

export const opPut = { op: "put", fileId: FILE_ID, base: 18011, pathKey: PATH_KEY, rc: "note", kv: 1, meta: SEALED, blobs: [BLOB_A], inline: null };
export const opDel = { op: "del", fileId: FILE_ID, base: 18234, pathKey: PATH_KEY, rc: "note", kv: 1, meta: SEALED };
export const opArchive = { op: "archive", fileId: FILE_ID, base: 18234, pathKey: PATH_KEY, rc: "attachment", kv: 1, meta: SEALED, blobs: [BLOB_A], inline: null };

export const meta = {
  v: 1, path: "2. Area/Daily Notes/2026-11-05.md", type: "file", size: 5321, mtime: 1762318800000,
  ctime: 1762300000000, hash: "9f2c".padEnd(64, "0"), chunker: "fastcdc-k1", chunks: [5321], z: false, p: false, cat: null,
};
export const tombstoneMeta = { v: 1, path: "2. Area/Daily Notes/2026-11-05.md", type: "file", cat: null };

// ---------- WebSocket client → server ----------
export const hello = {
  type: "hello", rid: 1, proto: 1, token: TOKEN, vaultId: VAULT_ID,
  since: 18011, epoch: 1, seenMaxSeq: 18011, rollbackAck: null,
  client: { name: "iPhone", platform: "ios", version: "0.1.0", role: "plugin" },
  window: { maxUnackedBytes: 8388608 },
};
export const commit = {
  type: "commit", rid: 7, cid: CID, atomic: false,
  ops: [{ op: "put", fileId: FILE_ID, base: 18011, pathKey: PATH_KEY, rc: "note", kv: 1, meta: SEALED, blobs: [], inline: SEALED }],
};
export const ack = { type: "ack", upTo: 18240 };
export const pull = { type: "pull", rid: 9, since: 18240, limit: 1000 };
export const ping = { type: "ping", rid: 10, ts: 1762318801000 };
export const bye = { type: "bye" };

// ---------- WebSocket server → client ----------
export const welcome = {
  type: "welcome", rid: 1, proto: 1, server: "0.1.0", deviceId: DEVICE_ID, epoch: 1,
  headSeq: 18240, minSeq: 12000, infoEtag: "\"a81f\"",
  retention: { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90 },
  limits: { maxBlobSize: 4195328, maxPackBytes: 8388608, maxCommitOps: 500, maxCommitBytes: 1048576,
    maxInFlightCommits: 4, maxFileSize: 209715200, inlineMax: 4096, maxRequestBody: 8650752 },
  heartbeatSec: 25, idleTimeoutSec: 60, serverTime: 1762318801300,
};
export const changes = {
  type: "changes", rid: null, from: 18011, to: 18240, headSeq: 18240, minSeq: 12000, live: false, more: false,
  records: [versionRecord, { ...tombstoneRecord, fileId: FILE_ID_2 }],
};
export const commitResult = {
  type: "commitResult", rid: 7, cid: CID, headSeq: 18241, replayed: false,
  results: [
    { i: 0, ok: true, seqs: [18241] },
    { i: 1, ok: false, code: "CONFLICT", current: versionRecord },
    { i: 2, ok: false, code: "PATH_TAKEN", current: versionRecord },
    { i: 3, ok: false, code: "MISSING_BLOB", missing: [BLOB_A] },
    { i: 4, ok: false, code: "INVALID", message: "meta too large" },
  ],
};
export const snapshotRequired = { type: "snapshotRequired", rid: 1, reason: "cursor-too-old", minSeq: 12000, epoch: 2, rollbackAt: null };
export const vaultInfoChanged = { type: "vaultInfoChanged", etag: "\"b77c\"" };
export const pause = { type: "pause", reason: "rate", retryAfterMs: 2000 };
export const resume = { type: "resume" };
export const pong = { type: "pong", rid: 10, ts: 1762318801000, serverTime: 1762318801021 };
export const error = { type: "error", rid: 7, code: "TOO_LARGE", message: "commit exceeds 1 MiB", fatal: false, retryAfterMs: null };

// ---------- REST ----------
export const device = { name: "MacBook Pro", platform: "macos", clientVersion: "0.1.0" };
export const login = { username: "alice", password: "correct horse", device };
export const enroll = { code: "SXE-7K3Q-M9WD-2HPV-X4TA", device };
export const authResponse = { token: TOKEN, deviceId: DEVICE_ID, user: { userId: "u1", username: "alice", role: "owner" } };
export const health = { ok: true, server: "0.1.0", protocols: [1], time: 1762318800000, source: "https://example.invalid/shuttle" };
export const deviceInfo = {
  deviceId: DEVICE_ID, name: "MacBook Pro", platform: "macos", clientVersion: "0.1.0",
  createdAt: 1762318800000, lastSeenAt: 1762318801000, revoked: false, current: true,
};
export const enrollCode = {
  code: "SXE-7K3Q-M9WD-2HPV-X4TA", expiresAt: 1762319700000,
  link: "obsidian://shuttle-enroll?server=https%3A%2F%2Fsync.example.com%3A6984&code=SXE-7K3Q-M9WD-2HPV-X4TA",
};
export const vaults = { vaults: [{ vaultId: VAULT_ID, name: "Obsidian", role: "owner", createdAt: 1762318800000, headSeq: 18240, usage: { liveBytes: 10, totalBytes: 20 } }] };
export const usage = { liveBytes: 1, historyBytes: 2, blobCount: 3, fileCount: 4, quotaBytes: null, largest: [{ fileId: FILE_ID, encSize: 99 }] };
export const snapshot = { headSeq: 18240, minSeq: 12000, epoch: 1, records: [versionRecord, tombstoneRecord], next: FILE_ID_2 };
export const changesResponse = { from: 18234, to: 18240, headSeq: 18240, minSeq: 12000, records: [tombstoneRecord], more: false };
export const errorBody = { error: { code: "PRECONDITION_FAILED", message: "etag", details: { etag: "\"a81f\"" } } };

// ---------- S3 ----------
export const s3Head = {
  format: "shuttle.head", v: 1, epoch: 1, nextSeq: 18242, minSeq: 12000, infoEtag: "\"a81f\"",
  snapshot: { seq: 18000, key: "e1/snap/00000000000000018000/manifest.json" },
  gcPending: "gc/pending-1762318800000.json", gcEpoch: 7, updatedAt: 1762318801234,
};
export const s3Log = {
  format: "shuttle.log", v: 1, firstSeq: 18241, count: 1, cid: CID, device: DEVICE_ID, ts: 1762318801234,
  opsDigest: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU", records: [{ ...versionRecord, seq: 18241 }],
};
export const serverConfig = { kind: "shuttle-server", urls: ["https://sync.example.com:6984"], vaultId: VAULT_ID, deviceId: DEVICE_ID };
export const s3Config = {
  kind: "s3", endpoint: "https://s3.example.invalid", region: "us-east-1", bucket: "b", prefix: "shuttle/obsidian/",
  pathStyle: true, deviceId: DEVICE_ID, maintenance: "auto",
};

// packages/crypto/vectors/vectors-v1.json → vaultInfo. Copied, not read,
// because this package has no Node types. canon(info − infoMac) must reproduce `canonical` byte for byte.
export const VECTOR_VAULT_INFO_CANONICAL = "{\"activeKv\":1,\"createdAt\":1762318800000,\"epoch\":1,\"features\":[\"history-v1\",\"archive-v1\"],\"format\":\"shuttle.vault-info\",\"formatVersion\":1,\"infoRev\":1,\"kdf\":{\"alg\":\"PBKDF2-SHA256\",\"iter\":1000,\"salt\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\"},\"keys\":[{\"check\":\"KJU4ocUChAvppr0v4XZVEA\",\"createdAt\":1762318800000,\"kv\":1,\"nonce\":\"QEFCQ0RFRkdISUpL\",\"status\":\"active\",\"suite\":\"sx1\",\"wrapped\":\"_CshdxEUwhEdlmFCzfQBKmshnv-Ov2m1QX04V9qo_vZPlEzeaj2vHT0A5C_UZ80_\"}],\"params\":{\"chunker\":{\"alg\":\"fastcdc-k1\",\"avg\":1048576,\"max\":4194304,\"min\":262144},\"compression\":\"deflate-raw\",\"inlineMax\":4096,\"metaPadBucket\":256,\"padding\":\"none\"},\"requires\":[],\"retention\":{\"attachmentDays\":14,\"configDays\":30,\"noteDays\":30,\"thinAfterHours\":24,\"thinBucketMinutes\":60,\"tombstoneDays\":90},\"unlockRequires\":[],\"vaultId\":\"EBESExQVFhcYGRobHB0eHw\"}";
export const VECTOR_VAULT_INFO_MAC = "Pu5R380XkMSe3yJ6zimVJ1HUt7PFYmO3Oc5AOM2wn5Y";

export const meResponse = { user: { userId: "u1", username: "alice", role: "owner" }, device: deviceInfo };
export const versionsResponse = { records: [versionRecord, { ...versionRecord, seq: 18100, kind: "archive", base: 18011 }], next: 18000 };
export const snapshotPage = { ...snapshot, history: { [FILE_ID]: [{ ...versionRecord, seq: 18100, kind: "archive", base: 18011 }] } };
export const s3Manifest = { kv: 1, recordCount: 2, fileCount: 2, parts: [{ key: "e1/snap/00000000000000018000/part-000.json.gz", sha256: "ab".repeat(32) }], mac: "bWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWE" };
export const s3Part = { files: [{ head: versionRecord, history: [{ ...versionRecord, seq: 18100, kind: "archive", base: 18011 }] }] };
export const s3Device = { name: "iPhone", platform: "ios", clientVersion: "0.1.0", createdAt: 1762318800000, lastSeenAt: 1762318801000, ackedSeq: 18240 };
export const s3Lease = { holder: DEVICE_ID, expiresAt: 1762319100000 };
