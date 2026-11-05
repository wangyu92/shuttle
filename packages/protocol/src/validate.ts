// Hand-written runtime validators for every inbound shape (design §2.12: "hand-written JSON validators
// for every message", no codegen dependency).
//
// Rules shared by all validators:
//  - They check shape and format, never configurable limits (those are env-tunable; see checkCommitLimits
//    and checkOpSizes).
//  - Unknown extra keys pass and are left in place (forward compatibility, §2.2 `requires`/`features`,
//    §2.4 "unknown fields MUST be preserved and ignored").
//  - They do not copy or construct: on success `value` is the input object, narrowed.
//  - On failure they report the first failing JSON path ("$.ops[0].base") and a reason.

import {
  isB64u, isBlobId, isCid, isDeviceId, isFileId, isNonNegInt, isPathKey, isPosInt,
  isSeq, isSha256Hex, isVaultId, b64uDecodedLength,
} from "./ids";
import {
  DEFAULT_LIMITS, DEVICE_TOKEN_PREFIX, MAX_INLINE_BYTES, MAX_META_BYTES, MAX_MISSING_IDS, MAX_PACK_ENTRIES,
  MAX_PAIRING_BODY, MAX_WS_FRAME, S3_HEAD_FORMAT, S3_LOG_FORMAT, VAULT_INFO_FORMAT,
} from "./constants";
import type * as T from "./types";

export type Validation<V> = { ok: true; value: V } | { ok: false; path: string; reason: string };
export type Validator<V> = (v: unknown) => Validation<V>;

class ValidationFail {
  constructor(readonly path: string, readonly reason: string) {}
}

function fail(path: string, reason: string): never {
  throw new ValidationFail(path, reason);
}

function run<V>(check: (v: unknown, p: string) => void): Validator<V> {
  return (v: unknown): Validation<V> => {
    try {
      check(v, "$");
      return { ok: true, value: v as V };
    } catch (e) {
      if (e instanceof ValidationFail) return { ok: false, path: e.path, reason: e.reason };
      throw e;
    }
  };
}

// ---------- primitives ----------

type Rec = Record<string, unknown>;

function obj(v: unknown, p: string): Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p, "expected object");
  return v as Rec;
}
function arr(v: unknown, p: string, max?: number): unknown[] {
  if (!Array.isArray(v)) fail(p, "expected array");
  if (max !== undefined && v.length > max) fail(p, `more than ${max} items`);
  return v;
}
function str(v: unknown, p: string, min = 0, max = Infinity): string {
  if (typeof v !== "string") fail(p, "expected string");
  if (v.length < min) fail(p, min === 1 ? "empty string" : `shorter than ${min}`);
  if (v.length > max) fail(p, `longer than ${max}`);
  return v;
}
function bool(v: unknown, p: string): boolean {
  if (typeof v !== "boolean") fail(p, "expected boolean");
  return v;
}
function lit<L extends string | number>(v: unknown, p: string, allowed: readonly L[]): L {
  if (!(allowed as readonly unknown[]).includes(v)) fail(p, `expected one of ${allowed.map((a) => JSON.stringify(a)).join("|")}`);
  return v as L;
}
function is(v: unknown, p: string, pred: (v: unknown) => boolean, what: string): void {
  if (!pred(v)) fail(p, `expected ${what}`);
}
const nonNeg = (v: unknown, p: string) => is(v, p, isNonNegInt, "non-negative safe integer");
const pos = (v: unknown, p: string) => is(v, p, isPosInt, "positive safe integer");
const seq = (v: unknown, p: string) => is(v, p, isSeq, "seq");
const seqOrNull = (v: unknown, p: string) => { if (v !== null) seq(v, p); };
function optional(o: Rec, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}
function stringArray(v: unknown, p: string): void {
  arr(v, p).forEach((x, i) => str(x, `${p}[${i}]`));
}
function blobIds(v: unknown, p: string, max?: number): void {
  arr(v, p, max).forEach((x, i) => is(x, `${p}[${i}]`, isBlobId, "blobId (lowercase hex64)"));
}
function deviceToken(v: unknown, p: string): void {
  const s = str(v, p);
  if (!s.startsWith(DEVICE_TOKEN_PREFIX) || !isB64u(s.slice(DEVICE_TOKEN_PREFIX.length))) fail(p, "expected device token sxd_<b64u>");
}
/** rid on server pushes: absent or null. */
function pushRid(o: Rec, p: string): void {
  if (optional(o, "rid") && o.rid !== null) fail(`${p}.rid`, "expected null on a server push");
}

// ---------- vault paths (§2.3) ----------

/** Vault-relative, `/` separators, no leading `/`, no `.`/`..` or empty segments, NFC. */
export function isVaultPath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) return false;
  if (v.startsWith("/") || v.endsWith("/") || v.includes("\\") || v.includes("\0")) return false;
  if (v.normalize("NFC") !== v) return false;
  for (const seg of v.split("/")) if (seg === "" || seg === "." || seg === "..") return false;
  return true;
}

// ---------- §2.2 VaultInfo and retention ----------

function retention(v: unknown, p: string): void {
  const o = obj(v, p);
  for (const k of ["noteDays", "attachmentDays", "configDays", "tombstoneDays"]) nonNeg(o[k], `${p}.${k}`);
  for (const k of ["thinAfterHours", "thinBucketMinutes"]) if (optional(o, k)) nonNeg(o[k], `${p}.${k}`);
}

function vaultInfo(v: unknown, p: string): void {
  const o = obj(v, p);
  lit(o.format, `${p}.format`, [VAULT_INFO_FORMAT]);
  lit(o.formatVersion, `${p}.formatVersion`, [1]);
  is(o.vaultId, `${p}.vaultId`, isVaultId, "vaultId (b64u, 16 bytes)");
  nonNeg(o.createdAt, `${p}.createdAt`);
  pos(o.infoRev, `${p}.infoRev`);
  pos(o.epoch, `${p}.epoch`);
  const kdf = obj(o.kdf, `${p}.kdf`);
  // Unknown KDF algorithms pass here: §4.5.3 checks `unlockRequires` (step 2) before KDF bounds (step 3).
  str(kdf.alg, `${p}.kdf.alg`, 1);
  is(kdf.salt, `${p}.kdf.salt`, isB64u, "b64u");
  if (kdf.alg === "PBKDF2-SHA256") pos(kdf.iter, `${p}.kdf.iter`);
  const keys = arr(o.keys, `${p}.keys`);
  if (keys.length === 0) fail(`${p}.keys`, "empty");
  const kvs = new Set<number>();
  keys.forEach((k, i) => {
    const kp = `${p}.keys[${i}]`;
    const ko = obj(k, kp);
    pos(ko.kv, `${kp}.kv`);
    if (kvs.has(ko.kv as number)) fail(`${kp}.kv`, "duplicate kv");
    kvs.add(ko.kv as number);
    lit(ko.status, `${kp}.status`, ["active", "decrypt-only", "retired"]);
    str(ko.suite, `${kp}.suite`, 1);
    for (const f of ["nonce", "wrapped", "check"]) is(ko[f], `${kp}.${f}`, isB64u, "b64u");
    nonNeg(ko.createdAt, `${kp}.createdAt`);
  });
  pos(o.activeKv, `${p}.activeKv`);
  if (!kvs.has(o.activeKv as number)) fail(`${p}.activeKv`, "no key with this kv");
  const params = obj(o.params, `${p}.params`);
  const ch = obj(params.chunker, `${p}.params.chunker`);
  lit(ch.alg, `${p}.params.chunker.alg`, ["fastcdc-k1"]);
  for (const k of ["min", "avg", "max"]) pos(ch[k], `${p}.params.chunker.${k}`);
  if (!((ch.min as number) <= (ch.avg as number) && (ch.avg as number) <= (ch.max as number))) fail(`${p}.params.chunker`, "expected min <= avg <= max");
  nonNeg(params.inlineMax, `${p}.params.inlineMax`);
  lit(params.compression, `${p}.params.compression`, ["deflate-raw", "none"]);
  lit(params.padding, `${p}.params.padding`, ["none", "padme"]);
  pos(params.metaPadBucket, `${p}.params.metaPadBucket`);
  retention(o.retention, `${p}.retention`);
  stringArray(o.requires, `${p}.requires`);
  stringArray(o.unlockRequires, `${p}.unlockRequires`);
  stringArray(o.features, `${p}.features`);
  is(o.infoMac, `${p}.infoMac`, isB64u, "b64u");
}

/**
 * Server-side check (§2.2 last bullet): the server reads only vaultId, formatVersion, infoRev, epoch and
 * activeKv. Everything else is client business (and MAC'd).
 */
function vaultInfoEnvelope(v: unknown, p: string): void {
  const o = obj(v, p);
  lit(o.format, `${p}.format`, [VAULT_INFO_FORMAT]);
  lit(o.formatVersion, `${p}.formatVersion`, [1]);
  is(o.vaultId, `${p}.vaultId`, isVaultId, "vaultId (b64u, 16 bytes)");
  pos(o.infoRev, `${p}.infoRev`);
  pos(o.epoch, `${p}.epoch`);
  pos(o.activeKv, `${p}.activeKv`);
  str(o.infoMac, `${p}.infoMac`, 1);
}

// ---------- §2.4 VersionRecord ----------

const RC = ["note", "attachment", "config"] as const;
const KINDS = ["put", "del", "archive"] as const;

function versionRecord(v: unknown, p: string): void {
  const o = obj(v, p);
  pos(o.seq, `${p}.seq`);
  is(o.fileId, `${p}.fileId`, isFileId, "fileId (lowercase hex32)");
  is(o.pathKey, `${p}.pathKey`, isPathKey, "pathKey (b64u, 16 bytes)");
  seqOrNull(o.base, `${p}.base`);
  const kind = lit(o.kind, `${p}.kind`, KINDS);
  lit(o.rc, `${p}.rc`, RC);
  pos(o.kv, `${p}.kv`);
  is(o.meta, `${p}.meta`, isB64u, "b64u");
  blobIds(o.blobs, `${p}.blobs`);
  const hasInline = optional(o, "inline");
  if (hasInline) is(o.inline, `${p}.inline`, isB64u, "b64u (or absent)");
  nonNeg(o.encSize, `${p}.encSize`);
  is(o.device, `${p}.device`, isDeviceId, "deviceId");
  nonNeg(o.ts, `${p}.ts`);
  if (optional(o, "cid")) is(o.cid, `${p}.cid`, isCid, "cid (UUID)");
  if (kind !== "put" && o.base === null) fail(`${p}.base`, `${kind} requires a base`);
  if (kind === "del" && ((o.blobs as unknown[]).length > 0 || hasInline)) fail(p, "del carries no blobs or inline");
  if (hasInline && (o.blobs as unknown[]).length > 0) fail(`${p}.blobs`, "must be empty when inline is present");
  if (o.base !== null && (o.base as number) >= (o.seq as number)) fail(`${p}.base`, "must be below seq");
}

function records(v: unknown, p: string): void {
  arr(v, p).forEach((r, i) => versionRecord(r, `${p}[${i}]`));
}

// ---------- §2.5 ops and commits ----------

function commitOp(v: unknown, p: string): void {
  const o = obj(v, p);
  const op = lit(o.op, `${p}.op`, KINDS);
  is(o.fileId, `${p}.fileId`, isFileId, "fileId (lowercase hex32)");
  if (op === "put") seqOrNull(o.base, `${p}.base`);
  else seq(o.base, `${p}.base`);
  is(o.pathKey, `${p}.pathKey`, isPathKey, "pathKey (b64u, 16 bytes)");
  lit(o.rc, `${p}.rc`, RC);
  pos(o.kv, `${p}.kv`);
  is(o.meta, `${p}.meta`, isB64u, "b64u");
  const hasInline = optional(o, "inline") && o.inline !== null;
  if (op === "del") {
    if (optional(o, "blobs") && !(Array.isArray(o.blobs) && o.blobs.length === 0)) fail(`${p}.blobs`, "del carries no blobs");
    if (hasInline) fail(`${p}.inline`, "del carries no inline");
    return;
  }
  blobIds(o.blobs, `${p}.blobs`);
  if (hasInline) {
    is(o.inline, `${p}.inline`, isB64u, "b64u, null or absent");
    if ((o.blobs as unknown[]).length > 0) fail(`${p}.blobs`, "must be empty when inline is present");
  }
}

function commitRequest(v: unknown, p: string): void {
  const o = obj(v, p);
  is(o.cid, `${p}.cid`, isCid, "cid (UUID)");
  const ops = arr(o.ops, `${p}.ops`);
  if (ops.length === 0) fail(`${p}.ops`, "empty");
  ops.forEach((x, i) => commitOp(x, `${p}.ops[${i}]`));
  if (optional(o, "atomic")) bool(o.atomic, `${p}.atomic`);
}

function opResult(v: unknown, p: string): void {
  const o = obj(v, p);
  nonNeg(o.i, `${p}.i`);
  if (bool(o.ok, `${p}.ok`)) {
    const s = arr(o.seqs, `${p}.seqs`);
    if (s.length !== 1) fail(`${p}.seqs`, "expected exactly one seq per op");
    s.forEach((x, i) => pos(x, `${p}.seqs[${i}]`));
    return;
  }
  const code = lit(o.code, `${p}.code`, [
    "CONFLICT", "PATH_TAKEN", "MISSING_BLOB", "INVALID", "TOO_LARGE", "QUOTA", "KEY_VERSION", "ABORTED",
  ]);
  if (code === "CONFLICT" || code === "PATH_TAKEN") {
    if (o.current !== null) versionRecord(o.current, `${p}.current`);
  } else if (code === "MISSING_BLOB") {
    blobIds(o.missing, `${p}.missing`);
    if ((o.missing as unknown[]).length === 0) fail(`${p}.missing`, "empty");
  } else if (optional(o, "message")) str(o.message, `${p}.message`);
}

function commitResponse(v: unknown, p: string): void {
  const o = obj(v, p);
  is(o.cid, `${p}.cid`, isCid, "cid (UUID)");
  seq(o.headSeq, `${p}.headSeq`);
  bool(o.replayed, `${p}.replayed`);
  const rs = arr(o.results, `${p}.results`);
  const seen = new Set<number>();
  rs.forEach((r, i) => {
    opResult(r, `${p}.results[${i}]`);
    const idx = (r as Rec).i as number;
    if (seen.has(idx)) fail(`${p}.results[${i}].i`, "duplicate op index");
    seen.add(idx);
  });
}

// ---------- change batches and snapshots ----------

function changeBatchBody(o: Rec, p: string, requireLive: boolean): void {
  seq(o.from, `${p}.from`);
  seq(o.to, `${p}.to`);
  seq(o.headSeq, `${p}.headSeq`);
  seq(o.minSeq, `${p}.minSeq`);
  const from = o.from as number, to = o.to as number;
  if (to < from) fail(`${p}.to`, "below from");
  if (to > (o.headSeq as number)) fail(`${p}.to`, "above headSeq");
  arr(o.records, `${p}.records`).forEach((r, i) => {
    const rp = `${p}.records[${i}]`;
    versionRecord(r, rp);
    const s = (r as Rec).seq as number;
    if (s <= from || s > to) fail(`${rp}.seq`, "outside (from, to]");
  });
  bool(o.more, `${p}.more`);
  if (requireLive || optional(o, "live")) bool(o.live, `${p}.live`);
}

function snapshotPageBody(o: Rec, p: string): void {
  seq(o.headSeq, `${p}.headSeq`);
  seq(o.minSeq, `${p}.minSeq`);
  pos(o.epoch, `${p}.epoch`);
  arr(o.records, `${p}.records`).forEach((r, i) => {
    versionRecord(r, `${p}.records[${i}]`);
    if ((r as Rec).kind === "archive") fail(`${p}.records[${i}].kind`, "archive never appears in a snapshot");
  });
  if (o.next !== null) str(o.next, `${p}.next`, 1);
}

// ---------- WebSocket: client → server (§2.9.1) ----------

function hello(o: Rec, p: string): void {
  pos(o.rid, `${p}.rid`);
  pos(o.proto, `${p}.proto`);
  deviceToken(o.token, `${p}.token`);
  is(o.vaultId, `${p}.vaultId`, isVaultId, "vaultId (b64u, 16 bytes)");
  seqOrNull(o.since, `${p}.since`);
  if (o.epoch !== null) pos(o.epoch, `${p}.epoch`);
  seqOrNull(o.seenMaxSeq, `${p}.seenMaxSeq`);
  if (o.rollbackAck !== null) nonNeg(o.rollbackAck, `${p}.rollbackAck`);
  const c = obj(o.client, `${p}.client`);
  str(c.name, `${p}.client.name`, 1, 200);
  str(c.platform, `${p}.client.platform`, 1, 64);
  str(c.version, `${p}.client.version`, 1, 64);
  lit(c.role, `${p}.client.role`, ["plugin", "headless"]);
  const w = obj(o.window, `${p}.window`);
  pos(w.maxUnackedBytes, `${p}.window.maxUnackedBytes`);
}

function clientMessage(v: unknown, p: string): void {
  const o = obj(v, p);
  const type = lit(o.type, `${p}.type`, ["hello", "commit", "ack", "pull", "ping", "bye"]);
  switch (type) {
    case "hello": return hello(o, p);
    case "commit": pos(o.rid, `${p}.rid`); return commitRequest(o, p);
    case "ack": return seq(o.upTo, `${p}.upTo`);
    case "pull":
      pos(o.rid, `${p}.rid`);
      seq(o.since, `${p}.since`);
      if (optional(o, "limit")) pos(o.limit, `${p}.limit`);
      return;
    case "ping": pos(o.rid, `${p}.rid`); return nonNeg(o.ts, `${p}.ts`);
    case "bye": return;
  }
}

// ---------- WebSocket: server → client (§2.9.2) ----------

const SNAPSHOT_REASONS = ["cursor-too-old", "epoch", "no-cursor", "rollback"] as const;

function welcome(o: Rec, p: string): void {
  pos(o.rid, `${p}.rid`);
  pos(o.proto, `${p}.proto`);
  str(o.server, `${p}.server`, 1);
  is(o.deviceId, `${p}.deviceId`, isDeviceId, "deviceId");
  pos(o.epoch, `${p}.epoch`);
  seq(o.headSeq, `${p}.headSeq`);
  seq(o.minSeq, `${p}.minSeq`);
  if (o.infoEtag !== null) str(o.infoEtag, `${p}.infoEtag`, 1);
  retention(o.retention, `${p}.retention`);
  const l = obj(o.limits, `${p}.limits`);
  for (const k of Object.keys(DEFAULT_LIMITS)) pos(l[k], `${p}.limits.${k}`);
  pos(o.heartbeatSec, `${p}.heartbeatSec`);
  pos(o.idleTimeoutSec, `${p}.idleTimeoutSec`);
  nonNeg(o.serverTime, `${p}.serverTime`);
}

function serverMessage(v: unknown, p: string): void {
  const o = obj(v, p);
  const type = lit(o.type, `${p}.type`, [
    "welcome", "changes", "commitResult", "snapshotRequired", "vaultInfoChanged", "pause", "resume", "pong", "error",
  ]);
  switch (type) {
    case "welcome": return welcome(o, p);
    case "changes":
      if (o.rid !== null) pos(o.rid, `${p}.rid`);
      return changeBatchBody(o, p, true);
    case "commitResult": pos(o.rid, `${p}.rid`); return commitResponse(o, p);
    case "snapshotRequired":
      if (o.rid !== null) pos(o.rid, `${p}.rid`);
      lit(o.reason, `${p}.reason`, SNAPSHOT_REASONS);
      seq(o.minSeq, `${p}.minSeq`);
      pos(o.epoch, `${p}.epoch`);
      if (o.rollbackAt !== null) nonNeg(o.rollbackAt, `${p}.rollbackAt`);
      return;
    case "vaultInfoChanged": pushRid(o, p); str(o.etag, `${p}.etag`, 1); return;
    case "pause":
      pushRid(o, p);
      lit(o.reason, `${p}.reason`, ["rate", "maintenance", "backpressure"]);
      return nonNeg(o.retryAfterMs, `${p}.retryAfterMs`);
    case "resume": return pushRid(o, p);
    case "pong":
      pos(o.rid, `${p}.rid`);
      nonNeg(o.ts, `${p}.ts`);
      return nonNeg(o.serverTime, `${p}.serverTime`);
    case "error":
      if (o.rid !== null) pos(o.rid, `${p}.rid`);
      str(o.code, `${p}.code`, 1);
      if (optional(o, "message")) str(o.message, `${p}.message`);
      bool(o.fatal, `${p}.fatal`);
      if (optional(o, "retryAfterMs") && o.retryAfterMs !== null) nonNeg(o.retryAfterMs, `${p}.retryAfterMs`);
      return;
  }
}

// ---------- REST (§2.8.4, §2.8.5) ----------

function deviceDescriptor(v: unknown, p: string): void {
  const o = obj(v, p);
  str(o.name, `${p}.name`, 1, 200);
  str(o.platform, `${p}.platform`, 1, 64);
  str(o.clientVersion, `${p}.clientVersion`, 1, 64);
}
function userInfo(v: unknown, p: string): void {
  const o = obj(v, p);
  str(o.userId, `${p}.userId`, 1);
  str(o.username, `${p}.username`, 1);
  str(o.role, `${p}.role`, 1);
}
function deviceInfo(v: unknown, p: string): void {
  const o = obj(v, p);
  is(o.deviceId, `${p}.deviceId`, isDeviceId, "deviceId");
  str(o.name, `${p}.name`);
  str(o.platform, `${p}.platform`);
  if (o.clientVersion !== null) str(o.clientVersion, `${p}.clientVersion`);
  nonNeg(o.createdAt, `${p}.createdAt`);
  if (o.lastSeenAt !== null) nonNeg(o.lastSeenAt, `${p}.lastSeenAt`);
  bool(o.revoked, `${p}.revoked`);
  bool(o.current, `${p}.current`);
}

function errorBody(v: unknown, p: string): void {
  const e = obj(obj(v, p).error, `${p}.error`);
  str(e.code, `${p}.error.code`, 1);
  if (optional(e, "message")) str(e.message, `${p}.error.message`);
  if (optional(e, "retryAfterMs")) nonNeg(e.retryAfterMs, `${p}.error.retryAfterMs`);
  if (optional(e, "details")) obj(e.details, `${p}.error.details`);
}

function versionsPage(v: unknown, p: string): void {
  const o = obj(v, p);
  records(o.records, `${p}.records`);
  seqOrNull(o.next, `${p}.next`);
}

// ---------- §2.4 meta plaintext ----------

const CATS = [
  "app", "appearance", "appearance-data", "hotkey", "core-plugin", "core-plugin-data", "community-plugin", "community-plugin-data",
] as const;

function metaCommon(o: Rec, p: string): void {
  lit(o.v, `${p}.v`, [1]);
  is(o.path, `${p}.path`, isVaultPath, "vault path (relative, NFC, no ./..)");
  lit(o.type, `${p}.type`, ["file"]);
  if (o.cat !== null) lit(o.cat, `${p}.cat`, CATS);
}
function fileMeta(v: unknown, p: string): void {
  const o = obj(v, p);
  metaCommon(o, p);
  nonNeg(o.size, `${p}.size`);
  nonNeg(o.mtime, `${p}.mtime`);
  nonNeg(o.ctime, `${p}.ctime`);
  is(o.hash, `${p}.hash`, isSha256Hex, "lowercase hex sha256");
  str(o.chunker, `${p}.chunker`, 1);
  let sum = 0;
  arr(o.chunks, `${p}.chunks`).forEach((c, i) => { pos(c, `${p}.chunks[${i}]`); sum += c as number; });
  if (sum !== o.size) fail(`${p}.chunks`, "sizes do not sum to size");
  bool(o.z, `${p}.z`);
  bool(o.p, `${p}.p`);
}
function tombstoneMeta(v: unknown, p: string): void {
  metaCommon(obj(v, p), p);
}

// ---------- S3 objects (§2.10) ----------

function s3Head(v: unknown, p: string): void {
  const o = obj(v, p);
  lit(o.format, `${p}.format`, [S3_HEAD_FORMAT]);
  lit(o.v, `${p}.v`, [1]);
  pos(o.epoch, `${p}.epoch`);
  pos(o.nextSeq, `${p}.nextSeq`);
  seq(o.minSeq, `${p}.minSeq`);
  if (o.infoEtag !== null) str(o.infoEtag, `${p}.infoEtag`, 1);
  if (o.snapshot !== null) {
    const s = obj(o.snapshot, `${p}.snapshot`);
    seq(s.seq, `${p}.snapshot.seq`);
    str(s.key, `${p}.snapshot.key`, 1);
  }
  if (o.gcPending !== null) str(o.gcPending, `${p}.gcPending`, 1);
  nonNeg(o.gcEpoch, `${p}.gcEpoch`);
  nonNeg(o.updatedAt, `${p}.updatedAt`);
}
function s3LogEntry(v: unknown, p: string): void {
  const o = obj(v, p);
  lit(o.format, `${p}.format`, [S3_LOG_FORMAT]);
  lit(o.v, `${p}.v`, [1]);
  pos(o.firstSeq, `${p}.firstSeq`);
  pos(o.count, `${p}.count`);
  is(o.cid, `${p}.cid`, isCid, "cid (UUID)");
  is(o.device, `${p}.device`, isDeviceId, "deviceId");
  nonNeg(o.ts, `${p}.ts`);
  is(o.opsDigest, `${p}.opsDigest`, isB64u, "b64u");
  const rs = arr(o.records, `${p}.records`);
  if (rs.length !== o.count) fail(`${p}.count`, "does not match records.length");
  rs.forEach((r, i) => {
    versionRecord(r, `${p}.records[${i}]`);
    if ((r as Rec).seq !== (o.firstSeq as number) + i) fail(`${p}.records[${i}].seq`, "expected firstSeq + index");
  });
}
function s3Manifest(v: unknown, p: string): void {
  const o = obj(v, p);
  pos(o.kv, `${p}.kv`);
  nonNeg(o.recordCount, `${p}.recordCount`);
  nonNeg(o.fileCount, `${p}.fileCount`);
  arr(o.parts, `${p}.parts`).forEach((x, i) => {
    const po = obj(x, `${p}.parts[${i}]`);
    is(po.sha256, `${p}.parts[${i}].sha256`, isSha256Hex, "lowercase hex sha256");
    if (optional(po, "key")) str(po.key, `${p}.parts[${i}].key`, 1);
  });
  is(o.mac, `${p}.mac`, isB64u, "b64u");
  if (optional(o, "epoch")) pos(o.epoch, `${p}.epoch`);
  if (optional(o, "seq")) seq(o.seq, `${p}.seq`);
}
function s3Part(v: unknown, p: string): void {
  arr(obj(v, p).files, `${p}.files`).forEach((f, i) => {
    const fo = obj(f, `${p}.files[${i}]`);
    versionRecord(fo.head, `${p}.files[${i}].head`);
    records(fo.history, `${p}.files[${i}].history`);
  });
}
function s3Device(v: unknown, p: string): void {
  const o = obj(v, p);
  str(o.name, `${p}.name`);
  str(o.platform, `${p}.platform`);
  str(o.clientVersion, `${p}.clientVersion`);
  nonNeg(o.createdAt, `${p}.createdAt`);
  nonNeg(o.lastSeenAt, `${p}.lastSeenAt`);
  seqOrNull(o.ackedSeq, `${p}.ackedSeq`);
}
function s3Lease(v: unknown, p: string): void {
  const o = obj(v, p);
  is(o.holder, `${p}.holder`, isDeviceId, "deviceId");
  nonNeg(o.expiresAt, `${p}.expiresAt`);
}

// ---------- adapter config ----------

function adapterConfig(v: unknown, p: string): void {
  const o = obj(v, p);
  const kind = lit(o.kind, `${p}.kind`, ["shuttle-server", "s3"]);
  is(o.deviceId, `${p}.deviceId`, isDeviceId, "deviceId");
  if (kind === "shuttle-server") {
    const urls = arr(o.urls, `${p}.urls`);
    if (urls.length === 0) fail(`${p}.urls`, "empty");
    urls.forEach((u, i) => { if (!/^https?:\/\/\S+$/.test(str(u, `${p}.urls[${i}]`))) fail(`${p}.urls[${i}]`, "expected http(s) URL"); });
    is(o.vaultId, `${p}.vaultId`, isVaultId, "vaultId (b64u, 16 bytes)");
    return;
  }
  for (const k of ["endpoint", "region", "bucket"]) str(o[k], `${p}.${k}`, 1);
  str(o.prefix, `${p}.prefix`);
  bool(o.pathStyle, `${p}.pathStyle`);
  lit(o.maintenance, `${p}.maintenance`, ["auto", "never", "always"]);
}

// =====================================================================================
// Public validators
// =====================================================================================

// Records, vault-info, meta
export const validateVaultInfo = run<T.VaultInfo>(vaultInfo);
export const validateVaultInfoEnvelope = run<T.VaultInfoEnvelope>(vaultInfoEnvelope);
export const validateRetention = run<T.Retention>(retention);
export const validateVersionRecord = run<T.VersionRecord>(versionRecord);
export const validateCommitOp = run<T.CommitOp>(commitOp);
export const validateFileMeta = run<T.FileMeta>(fileMeta);
export const validateTombstoneMeta = run<T.TombstoneMeta>(tombstoneMeta);

// WebSocket
export const validateClientMessage = run<T.ClientMessage>(clientMessage);
export const validateServerMessage = run<T.ServerMessage>(serverMessage);

// REST, server side (request bodies)
export const validateLoginRequest = run<T.LoginRequest>((v, p) => {
  const o = obj(v, p);
  str(o.username, `${p}.username`, 1, 128);
  str(o.password, `${p}.password`, 1, 1024);
  deviceDescriptor(o.device, `${p}.device`);
});
export const validateEnrollRequest = run<T.EnrollRequest>((v, p) => {
  const o = obj(v, p);
  // §2.8.4 example has 4 groups (80 bits) while the text says 100 bits (5 groups); both are accepted.
  if (!/^SXE(-[0-9A-HJKMNP-TV-Z]{4}){4,5}$/.test(str(o.code, `${p}.code`))) fail(`${p}.code`, "expected SXE-XXXX-… (Crockford base32)");
  deviceDescriptor(o.device, `${p}.device`);
});
export const validateEnrollCodeRequest = run<T.EnrollCodeRequest>((v, p) => pos(obj(v, p).ttlSec, `${p}.ttlSec`));
export const validateRenameDeviceRequest = run<T.RenameDeviceRequest>((v, p) => { str(obj(v, p).name, `${p}.name`, 1, 200); });
export const validateCreateVaultRequest = run<T.CreateVaultRequest>((v, p) => {
  const o = obj(v, p);
  str(o.name, `${p}.name`, 1, 200);
  vaultInfoEnvelope(o.info, `${p}.info`);
});
export const validateRebuildRequest = run<T.RebuildRequest>((v, p) => vaultInfoEnvelope(obj(v, p).info, `${p}.info`));
export const validateMissingBlobsRequest = run<T.MissingBlobsRequest>((v, p) => blobIds(obj(v, p).ids, `${p}.ids`, MAX_MISSING_IDS));
export const validatePackGetRequest = run<T.PackGetRequest>((v, p) => {
  const o = obj(v, p);
  blobIds(o.ids, `${p}.ids`, MAX_PACK_ENTRIES);
  pos(o.maxBytes, `${p}.maxBytes`); // the server clamps to its configured maxPackBytes (env-tunable)
});
export const validateCommitRequest = run<T.CommitRequest>(commitRequest);
export const validateAckRequest = run<T.AckRequest>((v, p) => seq(obj(v, p).upTo, `${p}.upTo`));

// REST, client side (response bodies)
export const validateErrorBody = run<T.ErrorBody>(errorBody);
export const validateHealthResponse = run<T.HealthResponse>((v, p) => {
  const o = obj(v, p);
  bool(o.ok, `${p}.ok`);
  str(o.server, `${p}.server`, 1);
  arr(o.protocols, `${p}.protocols`).forEach((x, i) => pos(x, `${p}.protocols[${i}]`));
  nonNeg(o.time, `${p}.time`);
  str(o.source, `${p}.source`);
});
export const validateAuthResponse = run<T.AuthResponse>((v, p) => {
  const o = obj(v, p);
  deviceToken(o.token, `${p}.token`);
  is(o.deviceId, `${p}.deviceId`, isDeviceId, "deviceId");
  userInfo(o.user, `${p}.user`);
});
export const validateMeResponse = run<T.MeResponse>((v, p) => {
  const o = obj(v, p);
  userInfo(o.user, `${p}.user`);
  deviceInfo(o.device, `${p}.device`);
});
export const validateEnrollCodeResponse = run<T.EnrollCodeResponse>((v, p) => {
  const o = obj(v, p);
  str(o.code, `${p}.code`, 1);
  nonNeg(o.expiresAt, `${p}.expiresAt`);
  if (!str(o.link, `${p}.link`).startsWith("obsidian://shuttle-enroll?")) fail(`${p}.link`, "expected obsidian://shuttle-enroll?…");
});
export const validateDevicesResponse = run<T.DevicesResponse>((v, p) => {
  arr(obj(v, p).devices, `${p}.devices`).forEach((d, i) => deviceInfo(d, `${p}.devices[${i}]`));
});
export const validateVaultsResponse = run<T.VaultsResponse>((v, p) => {
  arr(obj(v, p).vaults, `${p}.vaults`).forEach((x, i) => {
    const q = `${p}.vaults[${i}]`;
    const o = obj(x, q);
    is(o.vaultId, `${q}.vaultId`, isVaultId, "vaultId (b64u, 16 bytes)");
    str(o.name, `${q}.name`, 1);
    str(o.role, `${q}.role`, 1);
    nonNeg(o.createdAt, `${q}.createdAt`);
    seq(o.headSeq, `${q}.headSeq`);
    const u = obj(o.usage, `${q}.usage`);
    nonNeg(u.liveBytes, `${q}.usage.liveBytes`);
    nonNeg(u.totalBytes, `${q}.usage.totalBytes`);
  });
});
export const validateCreateVaultResponse = run<T.CreateVaultResponse>((v, p) => {
  const o = obj(v, p);
  is(o.vaultId, `${p}.vaultId`, isVaultId, "vaultId (b64u, 16 bytes)");
  str(o.etag, `${p}.etag`, 1);
});
export const validatePutInfoResponse = run<T.PutInfoResponse>((v, p) => { str(obj(v, p).etag, `${p}.etag`, 1); });
export const validateRebuildResponse = run<T.RebuildResponse>((v, p) => {
  const o = obj(v, p);
  pos(o.epoch, `${p}.epoch`);
  seq(o.headSeq, `${p}.headSeq`);
});
export const validateUsageResponse = run<T.UsageResponse>((v, p) => {
  const o = obj(v, p);
  for (const k of ["liveBytes", "historyBytes", "blobCount", "fileCount"]) nonNeg(o[k], `${p}.${k}`);
  if (o.quotaBytes !== null) nonNeg(o.quotaBytes, `${p}.quotaBytes`);
  arr(o.largest, `${p}.largest`).forEach((x, i) => {
    const l = obj(x, `${p}.largest[${i}]`);
    is(l.fileId, `${p}.largest[${i}].fileId`, isFileId, "fileId (lowercase hex32)");
    nonNeg(l.encSize, `${p}.largest[${i}].encSize`);
  });
});
export const validateMissingBlobsResponse = run<T.MissingBlobsResponse>((v, p) => blobIds(obj(v, p).missing, `${p}.missing`, MAX_MISSING_IDS));
export const validatePackPutResponse = run<T.PackPutResponse>((v, p) => {
  const o = obj(v, p);
  nonNeg(o.stored, `${p}.stored`);
  nonNeg(o.present, `${p}.present`);
});
export const validateSnapshotResponse = run<T.SnapshotResponse>((v, p) => snapshotPageBody(obj(v, p), p));
export const validateSnapshotPage = run<T.SnapshotPage>((v, p) => {
  const o = obj(v, p);
  snapshotPageBody(o, p);
  if (optional(o, "history")) {
    const h = obj(o.history, `${p}.history`);
    for (const [fid, rs] of Object.entries(h)) {
      if (!isFileId(fid)) fail(`${p}.history`, `key ${JSON.stringify(fid)} is not a fileId`);
      records(rs, `${p}.history.${fid}`);
    }
  }
});
export const validateChangesResponse = run<T.ChangesResponse>((v, p) => changeBatchBody(obj(v, p), p, false));
export const validateChangeBatch = run<T.ChangeBatch>((v, p) => changeBatchBody(obj(v, p), p, true));
export const validateCommitResponse = run<T.CommitResponse>(commitResponse);
export const validateVersionsResponse = run<T.VersionsResponse>(versionsPage);

// S3 objects and adapter config
export const validateS3Head = run<T.S3Head>(s3Head);
export const validateS3LogEntry = run<T.S3LogEntry>(s3LogEntry);
export const validateS3SnapshotManifest = run<T.S3SnapshotManifest>(s3Manifest);
export const validateS3SnapshotPart = run<T.S3SnapshotPart>(s3Part);
export const validateS3DeviceEntry = run<T.S3DeviceEntry>(s3Device);
export const validateS3MaintLease = run<T.S3MaintLease>(s3Lease);
export const validateAdapterConfig = run<T.AdapterConfig>(adapterConfig);

// =====================================================================================
// Parsing and limit checks
// =====================================================================================

export type ParseResult<V> = Validation<V>;

/** UTF-8 byte length of a JS string without allocating. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function parseWith<V>(text: string, maxBytes: number, validate: Validator<V>): ParseResult<V> {
  if (text.length > maxBytes || utf8Length(text) > maxBytes) return { ok: false, path: "$", reason: `frame larger than ${maxBytes} bytes` };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, path: "$", reason: "invalid JSON" };
  }
  return validate(v);
}

/** Parse and validate one client → server WebSocket text frame. A failure maps to `PROTOCOL` / close 4400. */
export function parseClientFrame(text: string, maxBytes: number = MAX_WS_FRAME): ParseResult<T.ClientMessage> {
  return parseWith(text, maxBytes, validateClientMessage);
}

/** Parse and validate one server → client WebSocket text frame. */
export function parseServerFrame(text: string, maxBytes: number = MAX_WS_FRAME): ParseResult<T.ServerMessage> {
  return parseWith(text, maxBytes, validateServerMessage);
}

/** Pairing mailbox body (§2.8.5): opaque JSON, ≤ 4 KiB. */
export function validatePairingBody(text: string): Validation<string> {
  if (utf8Length(text) > MAX_PAIRING_BODY) return { ok: false, path: "$", reason: `body larger than ${MAX_PAIRING_BODY} bytes` };
  try {
    JSON.parse(text);
  } catch {
    return { ok: false, path: "$", reason: "invalid JSON" };
  }
  return { ok: true, value: text };
}

/** Commit-level limits (§2.5, §2.9.4). `frameBytes` is the UTF-8 size of the frame or request body. */
export function checkCommitLimits(
  req: T.CommitRequest,
  frameBytes: number,
  limits: Pick<T.WelcomeLimits, "maxCommitOps" | "maxCommitBytes"> = DEFAULT_LIMITS,
): { code: "TOO_LARGE"; message: string } | null {
  if (req.ops.length > limits.maxCommitOps) return { code: "TOO_LARGE", message: `more than ${limits.maxCommitOps} ops` };
  if (frameBytes > limits.maxCommitBytes) return { code: "TOO_LARGE", message: `commit exceeds ${limits.maxCommitBytes} bytes` };
  return null;
}

/** Per-op size checks (§2.9.7 step 1): meta ≤ 16 KiB and inline ≤ 6 KiB decoded → per-op `INVALID`. */
export function checkOpSizes(op: T.CommitOp): { code: "INVALID"; message: string } | null {
  if (b64uDecodedLength(op.meta) > MAX_META_BYTES) return { code: "INVALID", message: "meta too large" };
  if (op.op !== "del" && typeof op.inline === "string" && b64uDecodedLength(op.inline) > MAX_INLINE_BYTES) {
    return { code: "INVALID", message: "inline too large" };
  }
  return null;
}

/** Type guard wrapper for any validator. */
export function guard<V>(validate: Validator<V>): (v: unknown) => v is V {
  return (v: unknown): v is V => validate(v).ok;
}

export const isVersionRecord = guard(validateVersionRecord);
export const isCommitOp = guard(validateCommitOp);
export const isVaultInfo = guard(validateVaultInfo);
export const isClientMessage = guard(validateClientMessage);
export const isServerMessage = guard(validateServerMessage);
