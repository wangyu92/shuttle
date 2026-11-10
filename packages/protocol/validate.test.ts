import { describe, expect, it } from "vitest";
import * as F from "./fixtures";
import {
  type Validation, type Validator,
  checkCommitLimits, checkOpSizes, isVaultPath, parseClientFrame, parseServerFrame,
  validateAdapterConfig, validateAuthResponse, validateChangeBatch, validateChangesResponse, validateClientMessage,
  validateCommitOp, validateCommitRequest, validateCommitResponse, validateCreateVaultRequest, validateDevicesResponse,
  validateEnrollCodeResponse, validateEnrollRequest, validateErrorBody, validateFileMeta, validateHealthResponse,
  validateLoginRequest, validateMissingBlobsRequest, validatePackGetRequest, validatePairingBody, validateS3Head,
  validateS3LogEntry, validateServerMessage, validateSnapshotResponse, validateTombstoneMeta, validateUsageResponse,
  validateVaultInfo, validateVaultInfoEnvelope, validateVaultsResponse, validateVersionRecord,
  validateMeResponse, validateRebuildRequest, validateRebuildResponse, validatePutInfoResponse, validateCreateVaultResponse,
  validateMissingBlobsResponse, validatePackPutResponse, validateSnapshotPage, validateVersionsResponse,
  validateEnrollCodeRequest, validateRenameDeviceRequest, validateAckRequest, validateS3SnapshotManifest,
  validateS3SnapshotPart, validateS3DeviceEntry, validateS3MaintLease,
  isB64u16, isBlobId, isFileId, WIRE_ERRORS, WIRE_ERROR_CODES, remoteErrorFromWire, RemoteError, DEFAULT_LIMITS,
  canon, opsDigestPreimage,
} from "./src/index";
import { guardOutput } from "./test/h3";

// design §7.2 H3: console output is scanned for the fixture token and password.
guardOutput([{ name: "fixture token", value: F.TOKEN }, { name: "fixture password", value: F.login.password }]);

type Mut = (o: any) => void;
const set = (path: string, value: unknown): Mut => (o) => {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[/^\d+$/.test(k) ? Number(k) : k];
  cur[keys[keys.length - 1]!] = value;
};
const del = (path: string): Mut => (o) => {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[/^\d+$/.test(k) ? Number(k) : k];
  delete cur[keys[keys.length - 1]!];
};

function expectOk<V>(r: Validation<V>): void {
  if (!r.ok) throw new Error(`expected ok, got ${r.path}: ${r.reason}`);
}

/** Each case: fixture, validator, mutations that must each fail (with the failing path prefix). */
interface Case { name: string; fixture: unknown; validate: Validator<unknown>; bad: Array<[string, Mut, string]>; optional?: string[] }

const cases: Case[] = [
  {
    name: "VaultInfo (§2.2)", fixture: F.vaultInfo, validate: validateVaultInfo,
    bad: [
      ["wrong format", set("format", "other.vault-info"), "$.format"],
      ["formatVersion 2", set("formatVersion", 2), "$.formatVersion"],
      ["short vaultId", set("vaultId", "q3mY5r0Q2bS7TqvJvKzW1"), "$.vaultId"],
      ["non-canonical vaultId tail", set("vaultId", "q3mY5r0Q2bS7TqvJvKzW1B"), "$.vaultId"],
      ["infoRev 0", set("infoRev", 0), "$.infoRev"],
      ["float epoch", set("epoch", 1.5), "$.epoch"],
      ["no iter for PBKDF2", del("kdf.iter"), "$.kdf.iter"],
      ["empty keys", set("keys", []), "$.keys"],
      ["bad key status", set("keys.0.status", "gone"), "$.keys[0].status"],
      ["activeKv without key", set("activeKv", 2), "$.activeKv"],
      ["chunker min > avg", set("params.chunker.min", 2000000), "$.params.chunker"],
      ["bad padding", set("params.padding", "zero"), "$.params.padding"],
      ["missing retention day", del("retention.tombstoneDays"), "$.retention.tombstoneDays"],
      ["requires not array", set("requires", "x"), "$.requires"],
      ["infoMac with padding", set("infoMac", "abc="), "$.infoMac"],
    ],
  },
  {
    name: "VersionRecord (§2.4)", fixture: F.versionRecord, validate: validateVersionRecord, optional: ["inline", "cid"],
    bad: [
      ["seq 0", set("seq", 0), "$.seq"],
      ["uppercase fileId", set("fileId", F.FILE_ID.toUpperCase()), "$.fileId"],
      ["short pathKey", set("pathKey", "u-4A"), "$.pathKey"],
      ["base as string", set("base", "18011"), "$.base"],
      ["base >= seq", set("base", 18234), "$.base"],
      ["unknown kind", set("kind", "move"), "$.kind"],
      ["unknown rc", set("rc", "image"), "$.rc"],
      ["kv 0", set("kv", 0), "$.kv"],
      ["meta not b64u", set("meta", "a+b/"), "$.meta"],
      ["inline null", set("inline", null), "$.inline"],
      ["inline and blobs", set("blobs", [F.BLOB_A]), "$.blobs"],
      ["bad blobId", (o) => { delete o.inline; o.blobs = ["zz"]; }, "$.blobs[0]"],
      ["negative encSize", set("encSize", -1), "$.encSize"],
      ["missing device", del("device"), "$.device"],
      ["bad cid", set("cid", "not-a-uuid"), "$.cid"],
      ["del with inline", set("kind", "del"), "$"],
      ["archive with null base", (o) => { o.kind = "archive"; o.base = null; }, "$.base"],
    ],
  },
  {
    name: "tombstone VersionRecord", fixture: F.tombstoneRecord, validate: validateVersionRecord, optional: ["cid"],
    bad: [
      ["del with blobs", set("blobs", [F.BLOB_A]), "$"],
      ["del with null base", set("base", null), "$.base"],
    ],
  },
  {
    name: "CommitOp put (§2.5)", fixture: F.opPut, validate: validateCommitOp, optional: ["inline"],
    bad: [
      ["unknown op", set("op", "move"), "$.op"],
      ["missing blobs", del("blobs"), "$.blobs"],
      ["inline with blobs", set("inline", F.SEALED), "$.blobs"],
      ["negative base", set("base", -1), "$.base"],
    ],
  },
  {
    name: "CommitOp del (§2.5)", fixture: F.opDel, validate: validateCommitOp,
    bad: [
      ["null base", set("base", null), "$.base"],
      ["blobs on del", set("blobs", [F.BLOB_A]), "$.blobs"],
      ["inline on del", set("inline", F.SEALED), "$.inline"],
    ],
  },
  {
    name: "CommitOp archive (§2.5)", fixture: F.opArchive, validate: validateCommitOp, optional: ["inline"],
    bad: [["null base", set("base", null), "$.base"]],
  },
  {
    name: "meta plaintext (§2.4)", fixture: F.meta, validate: validateFileMeta,
    bad: [
      ["v 2", set("v", 2), "$.v"],
      ["leading slash", set("path", "/a.md"), "$.path"],
      ["dot-dot", set("path", "a/../b.md"), "$.path"],
      ["NFD path", set("path", "가.md"), "$.path"],
      ["folder type", set("type", "folder"), "$.type"],
      ["chunk sum mismatch", set("chunks", [5320]), "$.chunks"],
      ["uppercase hash", set("hash", "9F2C".padEnd(64, "0")), "$.hash"],
      ["unknown cat", set("cat", "theme"), "$.cat"],
      ["z not boolean", set("z", 0), "$.z"],
    ],
  },
  {
    name: "tombstone meta (ID-8)", fixture: F.tombstoneMeta, validate: validateTombstoneMeta,
    bad: [["missing cat", del("cat"), "$.cat"]],
  },
  {
    name: "hello (§2.9.1)", fixture: F.hello, validate: validateClientMessage,
    bad: [
      ["unknown type", set("type", "helo"), "$.type"],
      ["rid 0", set("rid", 0), "$.rid"],
      ["token without prefix", set("token", "Q".repeat(43)), "$.token"],
      ["since missing", del("since"), "$.since"],
      ["epoch missing", del("epoch"), "$.epoch"],
      ["bad role", set("client.role", "mobile"), "$.client.role"],
      ["window missing", del("window"), "$.window"],
    ],
  },
  {
    name: "commit (§2.9.1)", fixture: F.commit, validate: validateClientMessage, optional: ["atomic"],
    bad: [
      ["missing rid", del("rid"), "$.rid"],
      ["bad cid", set("cid", "x"), "$.cid"],
      ["empty ops", set("ops", []), "$.ops"],
      ["bad op fileId", set("ops.0.fileId", "3f9c"), "$.ops[0].fileId"],
      ["atomic not boolean", set("atomic", "yes"), "$.atomic"],
    ],
  },
  { name: "ack", fixture: F.ack, validate: validateClientMessage, bad: [["upTo float", set("upTo", 1.5), "$.upTo"]] },
  { name: "pull", fixture: F.pull, validate: validateClientMessage, optional: ["limit"], bad: [["limit 0", set("limit", 0), "$.limit"], ["no rid", del("rid"), "$.rid"]] },
  { name: "ping", fixture: F.ping, validate: validateClientMessage, bad: [["no ts", del("ts"), "$.ts"]] },
  { name: "bye", fixture: F.bye, validate: validateClientMessage, bad: [["type case", set("type", "Bye"), "$.type"]] },
  {
    name: "welcome (§2.9.2)", fixture: F.welcome, validate: validateServerMessage,
    bad: [
      ["missing limit", del("limits.maxRequestBody"), "$.limits.maxRequestBody"],
      ["epoch 0", set("epoch", 0), "$.epoch"],
      ["infoEtag number", set("infoEtag", 1), "$.infoEtag"],
      ["no retention", del("retention"), "$.retention"],
    ],
  },
  {
    name: "changes (§2.9.2)", fixture: F.changes, validate: validateServerMessage,
    bad: [
      ["to < from", set("to", 18000), "$.to"],
      ["to > headSeq", set("headSeq", 18239), "$.to"],
      ["record seq <= from", set("records.0.seq", 18011), "$.records[0]"],
      ["live missing", del("live"), "$.live"],
      ["rid string", set("rid", "1"), "$.rid"],
    ],
  },
  {
    name: "commitResult (§2.9.2)", fixture: F.commitResult, validate: validateServerMessage,
    bad: [
      ["two seqs", set("results.0.seqs", [1, 2]), "$.results[0].seqs"],
      ["unknown op code", set("results.4.code", "NOPE"), "$.results[4].code"],
      ["empty missing", set("results.3.missing", []), "$.results[3].missing"],
      ["bad current", set("results.1.current", { seq: 1 }), "$.results[1].current"],
      ["duplicate i", set("results.1.i", 0), "$.results[1].i"],
      ["replayed missing", del("replayed"), "$.replayed"],
    ],
  },
  {
    name: "snapshotRequired", fixture: F.snapshotRequired, validate: validateServerMessage,
    bad: [["unknown reason", set("reason", "gone"), "$.reason"], ["rollbackAt missing", del("rollbackAt"), "$.rollbackAt"]],
  },
  { name: "vaultInfoChanged", fixture: F.vaultInfoChanged, validate: validateServerMessage, bad: [["rid on push", set("rid", 3), "$.rid"]] },
  { name: "pause", fixture: F.pause, validate: validateServerMessage, bad: [["bad reason", set("reason", "sleep"), "$.reason"]] },
  { name: "resume", fixture: F.resume, validate: validateServerMessage, bad: [["rid on push", set("rid", 1), "$.rid"]] },
  { name: "pong", fixture: F.pong, validate: validateServerMessage, bad: [["no serverTime", del("serverTime"), "$.serverTime"]] },
  { name: "error", fixture: F.error, validate: validateServerMessage, optional: ["message", "retryAfterMs"], bad: [["fatal missing", del("fatal"), "$.fatal"], ["empty code", set("code", ""), "$.code"]] },
  {
    name: "POST /auth/login", fixture: F.login, validate: validateLoginRequest,
    bad: [["empty password", set("password", ""), "$.password"], ["no device", del("device"), "$.device"]],
  },
  {
    name: "POST /auth/enroll", fixture: F.enroll, validate: validateEnrollRequest,
    bad: [["lowercase code", set("code", "sxe-7k3q-m9wd-2hpv-x4ta"), "$.code"], ["Crockford excludes U", set("code", "SXE-7K3U-M9WD-2HPV-X4TA"), "$.code"]],
  },
  { name: "auth response", fixture: F.authResponse, validate: validateAuthResponse, bad: [["bad token", set("token", "abc"), "$.token"]] },
  { name: "GET /health", fixture: F.health, validate: validateHealthResponse, bad: [["protocols not array", set("protocols", 1), "$.protocols"]] },
  { name: "GET /devices", fixture: { devices: [F.deviceInfo] }, validate: validateDevicesResponse, bad: [["revoked missing", del("devices.0.revoked"), "$.devices[0].revoked"]] },
  { name: "POST /enroll-codes response", fixture: F.enrollCode, validate: validateEnrollCodeResponse, bad: [["other scheme", set("link", "obsidian://other-enroll?code=x"), "$.link"]] },
  { name: "GET /vaults", fixture: F.vaults, validate: validateVaultsResponse, bad: [["usage missing", del("vaults.0.usage"), "$.vaults[0].usage"]] },
  { name: "GET /usage", fixture: F.usage, validate: validateUsageResponse, bad: [["quota string", set("quotaBytes", "1"), "$.quotaBytes"]] },
  {
    name: "POST /vaults", fixture: { name: "Obsidian", info: F.vaultInfo }, validate: validateCreateVaultRequest,
    bad: [["no name", set("name", ""), "$.name"], ["bad vaultId", set("info.vaultId", "x"), "$.info.vaultId"]],
  },
  {
    name: "POST /blobs/missing", fixture: { ids: [F.BLOB_A, F.BLOB_B] }, validate: validateMissingBlobsRequest,
    bad: [["over 1000 ids", set("ids", Array(1001).fill(F.BLOB_A)), "$.ids"], ["bad id", set("ids.1", "x"), "$.ids[1]"]],
  },
  {
    name: "POST /blobs/pack-get", fixture: { ids: [F.BLOB_A], maxBytes: 8388608 }, validate: validatePackGetRequest,
    bad: [["maxBytes 0", set("maxBytes", 0), "$.maxBytes"], ["over 256 ids", set("ids", Array(257).fill(F.BLOB_A)), "$.ids"]],
  },
  {
    name: "POST /commit", fixture: { cid: F.CID, ops: [F.opPut, F.opDel, F.opArchive], atomic: true }, validate: validateCommitRequest, optional: ["atomic"],
    bad: [["op 2 bad base", set("ops.2.base", null), "$.ops[2].base"]],
  },
  {
    name: "POST /commit response", fixture: (({ type: _t, rid: _r, ...rest }) => rest)(F.commitResult), validate: validateCommitResponse,
    bad: [["headSeq missing", del("headSeq"), "$.headSeq"]],
  },
  {
    name: "GET /snapshot", fixture: F.snapshot, validate: validateSnapshotResponse,
    bad: [["archive in snapshot", set("records.0.kind", "archive"), "$.records[0].kind"], ["next empty", set("next", ""), "$.next"]],
  },
  {
    name: "GET /changes (long-poll)", fixture: F.changesResponse, validate: validateChangesResponse,
    bad: [["more missing", del("more"), "$.more"]],
  },
  {
    name: "REST error body", fixture: F.errorBody, validate: validateErrorBody,
    bad: [["no code", del("error.code"), "$.error.code"], ["details array", set("error.details", []), "$.error.details"]],
  },
  { name: "GET /me", fixture: F.meResponse, validate: validateMeResponse, bad: [["bad device id", set("device.deviceId", "x+y"), "$.device.deviceId"]] },
  { name: "POST /rebuild", fixture: { info: { ...F.vaultInfo, epoch: 2, infoRev: 2 } }, validate: validateRebuildRequest, bad: [["epoch 0", set("info.epoch", 0), "$.info.epoch"]] },
  { name: "POST /rebuild response", fixture: { epoch: 2, headSeq: 18240 }, validate: validateRebuildResponse, bad: [["epoch 0", set("epoch", 0), "$.epoch"]] },
  { name: "PUT /info response", fixture: { etag: "\"a81f\"" }, validate: validatePutInfoResponse, bad: [["empty etag", set("etag", ""), "$.etag"]] },
  { name: "POST /vaults response", fixture: { vaultId: F.VAULT_ID, etag: "\"a81f\"" }, validate: validateCreateVaultResponse, bad: [["bad vaultId", set("vaultId", "x"), "$.vaultId"]] },
  { name: "POST /blobs/missing response", fixture: { missing: [F.BLOB_B] }, validate: validateMissingBlobsResponse, bad: [["bad id", set("missing.0", F.BLOB_B.toUpperCase()), "$.missing[0]"]] },
  { name: "POST /blobs/pack-put response", fixture: { stored: 3, present: 1 }, validate: validatePackPutResponse, bad: [["negative", set("stored", -1), "$.stored"]] },
  {
    name: "SnapshotPage with history (§2.12)", fixture: F.snapshotPage, validate: validateSnapshotPage, optional: ["history"],
    bad: [["history key not a fileId", set("history", { nope: [] }), "$.history"], ["bad history record", set(`history.${F.FILE_ID}.0.seq`, 0), `$.history.${F.FILE_ID}[0].seq`]],
  },
  { name: "GET /files/{id}/versions", fixture: F.versionsResponse, validate: validateVersionsResponse, bad: [["next string", set("next", "1"), "$.next"]] },
  { name: "POST /enroll-codes", fixture: { ttlSec: 900 }, validate: validateEnrollCodeRequest, bad: [["ttl 0", set("ttlSec", 0), "$.ttlSec"]] },
  { name: "PATCH /devices/{id}", fixture: { name: "iPad" }, validate: validateRenameDeviceRequest, bad: [["empty name", set("name", ""), "$.name"]] },
  { name: "POST /ack", fixture: { upTo: 18240 }, validate: validateAckRequest, bad: [["negative", set("upTo", -1), "$.upTo"]] },
  {
    name: "S3 snapshot manifest", fixture: F.s3Manifest, validate: validateS3SnapshotManifest,
    bad: [["bad part sha", set("parts.0.sha256", "x"), "$.parts[0].sha256"], ["no mac", del("mac"), "$.mac"], ["no kv", del("kv"), "$.kv"]],
  },
  { name: "S3 snapshot part", fixture: F.s3Part, validate: validateS3SnapshotPart, bad: [["history missing", del("files.0.history"), "$.files[0].history"]] },
  { name: "S3 devices/<id>.json", fixture: F.s3Device, validate: validateS3DeviceEntry, bad: [["ackedSeq string", set("ackedSeq", "1"), "$.ackedSeq"]] },
  { name: "S3 locks/maint.json", fixture: F.s3Lease, validate: validateS3MaintLease, bad: [["no expiry", del("expiresAt"), "$.expiresAt"]] },
  {
    name: "S3 head.json", fixture: F.s3Head, validate: validateS3Head,
    bad: [["wrong format", set("format", "shuttle.log"), "$.format"], ["nextSeq 0", set("nextSeq", 0), "$.nextSeq"]],
  },
  {
    name: "S3 log entry", fixture: F.s3Log, validate: validateS3LogEntry,
    bad: [["count mismatch", set("count", 2), "$.count"], ["seq not firstSeq", set("records.0.seq", 18242), "$.records[0].seq"]],
  },
  {
    name: "adapter config (server)", fixture: F.serverConfig, validate: validateAdapterConfig,
    bad: [["empty urls", set("urls", []), "$.urls"], ["ws url", set("urls.0", "wss://x"), "$.urls[0]"]],
  },
  {
    name: "adapter config (s3)", fixture: F.s3Config, validate: validateAdapterConfig,
    bad: [["bad maintenance", set("maintenance", "sometimes"), "$.maintenance"]],
  },
];

describe("validators: spec fixtures pass, mutations fail", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("accepts the spec example", () => expectOk(c.validate(F.clone(c.fixture))));
      it("accepts unknown extra fields (forward compatibility)", () => {
        const v = F.clone(c.fixture) as Record<string, unknown>;
        v.futureField = { x: 1 };
        expectOk(c.validate(v));
      });
      it("rejects non-objects", () => {
        for (const v of [null, 1, "x", [], undefined]) expect(c.validate(v).ok).toBe(false);
      });
      it("rejects deletion of each required top-level key", () => {
        const optional = new Set(c.optional ?? []);
        for (const k of Object.keys(c.fixture as object)) {
          if (optional.has(k)) continue;
          const v = F.clone(c.fixture) as Record<string, unknown>;
          delete v[k];
          expect(c.validate(v).ok, `deleting ${k}`).toBe(false);
        }
      });
      for (const [label, mut, path] of c.bad) {
        it(`rejects: ${label}`, () => {
          const v = F.clone(c.fixture);
          mut(v);
          const r = c.validate(v);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.path.startsWith(path), `${r.path}: ${r.reason}`).toBe(true);
        });
      }
    });
  }
});

describe("validator details", () => {
  it("returns the input object itself (no copy) on success", () => {
    const v = F.clone(F.versionRecord);
    const r = validateVersionRecord(v);
    expect(r.ok && r.value).toBe(v);
  });

  it("VaultInfo accepts an unknown KDF and suite so §4.5.3 can report UpdateRequired", () => {
    const v = F.clone(F.vaultInfo) as any;
    v.kdf = { alg: "argon2id", salt: v.kdf.salt, m: 65536 };
    v.keys[0].suite = "sx2";
    v.unlockRequires = ["kdf-argon2id"];
    expectOk(validateVaultInfo(v));
  });

  it("server envelope check ignores client-only fields", () => {
    const v = F.clone(F.vaultInfo) as any;
    delete v.params;
    delete v.keys;
    expectOk(validateVaultInfoEnvelope(v));
    expect(validateVaultInfo(v).ok).toBe(false);
  });

  it("CommitOp accepts inline absent, null or string", () => {
    const a = F.clone(F.opPut) as any; delete a.inline;
    expectOk(validateCommitOp(a));
    expectOk(validateCommitOp({ ...F.opPut, blobs: [], inline: F.SEALED }));
    expectOk(validateCommitOp({ ...F.opPut, base: null }));
    expectOk(validateCommitOp({ ...F.opDel, blobs: [] }));
  });

  it("changes on WS requires live; the REST long-poll body does not", () => {
    const { type: _t, rid: _r, live: _l, ...body } = F.clone(F.changes);
    expectOk(validateChangesResponse(body));
    expect(validateChangeBatch(body).ok).toBe(false);
  });

  it("server pushes accept rid null or absent", () => {
    expectOk(validateServerMessage({ ...F.vaultInfoChanged, rid: null }));
    expectOk(validateServerMessage({ ...F.pause, rid: null }));
  });

  it("hello for a never-bootstrapped device: since, epoch, seenMaxSeq null", () => {
    expectOk(validateClientMessage({ ...F.hello, since: null, epoch: null, seenMaxSeq: null }));
  });

  it("enroll accepts 5-group codes (100 bits per §2.8.4 text)", () => {
    expectOk(validateEnrollRequest({ ...F.enroll, code: "SXE-7K3Q-M9WD-2HPV-X4TA-ABCD" }));
  });

  it("vault paths", () => {
    expect(isVaultPath("a/b.md")).toBe(true);
    expect(isVaultPath(".obsidian/app.json")).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "./a", "a\\b", "a/./b", "a\u0000"]) expect(isVaultPath(bad), bad).toBe(false);
  });

  it("id predicates", () => {
    expect(isFileId(F.FILE_ID)).toBe(true);
    expect(isFileId(F.FILE_ID + "0")).toBe(false);
    expect(isBlobId(F.BLOB_A)).toBe(true);
    expect(isB64u16(F.PATH_KEY)).toBe(true);
    expect(isB64u16(F.DEVICE_ID)).toBe(true);
  });
});

describe("frame parsing", () => {
  it("parses valid frames", () => {
    expectOk(parseClientFrame(JSON.stringify(F.hello)));
    expectOk(parseServerFrame(JSON.stringify(F.welcome)));
  });
  it("rejects invalid JSON and oversize frames", () => {
    expect(parseClientFrame("{")).toEqual({ ok: false, path: "$", reason: "invalid JSON" });
    const r = parseClientFrame(JSON.stringify(F.ack), 5);
    expect(r.ok).toBe(false);
  });
  it("rejects a client frame that is a server message", () => {
    expect(parseClientFrame(JSON.stringify(F.welcome)).ok).toBe(false);
  });
  it("pairing body: opaque JSON up to 4 KiB", () => {
    expectOk(validatePairingBody(JSON.stringify({ a: "x" })));
    expect(validatePairingBody("not json").ok).toBe(false);
    expect(validatePairingBody(JSON.stringify({ a: "x".repeat(4096) })).ok).toBe(false);
  });
});

describe("limit checks", () => {
  const req = { cid: F.CID, ops: [F.opPut] } as any;
  it("commit op count and bytes", () => {
    expect(checkCommitLimits(req, 100)).toBeNull();
    expect(checkCommitLimits({ ...req, ops: Array(501).fill(F.opPut) }, 100)?.code).toBe("TOO_LARGE");
    expect(checkCommitLimits(req, DEFAULT_LIMITS.maxCommitBytes + 1)?.code).toBe("TOO_LARGE");
  });
  it("meta 16 KiB and inline 6 KiB decoded", () => {
    expect(checkOpSizes(F.opPut as any)).toBeNull();
    const meta = "A".repeat(Math.ceil((16 * 1024 + 1) * 4 / 3));
    expect(checkOpSizes({ ...F.opPut, meta } as any)?.message).toBe("meta too large");
    const inline = "A".repeat(Math.ceil((6 * 1024 + 1) * 4 / 3));
    expect(checkOpSizes({ ...F.opPut, blobs: [], inline } as any)?.message).toBe("inline too large");
    expect(checkOpSizes({ ...F.opPut, blobs: [], inline: "A".repeat(8192) } as any)).toBeNull(); // 6144 bytes exactly
  });
});

describe("errors", () => {
  it("every wire code has an HTTP status", () => {
    for (const c of WIRE_ERROR_CODES) expect(WIRE_ERRORS[c].http).toBeGreaterThanOrEqual(400);
    expect(WIRE_ERRORS.QUOTA.http).toBe(507);
    expect(WIRE_ERRORS.HASH_MISMATCH.http).toBe(422);
  });
  it("maps wire errors to RemoteError", () => {
    const e = remoteErrorFromWire({ code: "RATE_LIMITED", retryAfterMs: 1234 });
    expect(e).toBeInstanceOf(RemoteError);
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(1234);
    expect(remoteErrorFromWire({ code: "VAULT_EXISTS" }).code).toBe("ALREADY_EXISTS");
    expect(remoteErrorFromWire({ code: "WHATEVER" }).code).toBe("PROTOCOL");
  });
});

describe("crypto vector cross-check (vectors-v1.json)", () => {
  it("the vector vault-info validates and canon reproduces its MAC preimage", () => {
    const info = { ...JSON.parse(F.VECTOR_VAULT_INFO_CANONICAL), infoMac: F.VECTOR_VAULT_INFO_MAC };
    expectOk(validateVaultInfo(info));
    const { infoMac: _m, ...unsigned } = info;
    expect(canon(unsigned)).toBe(F.VECTOR_VAULT_INFO_CANONICAL);
    expect(canon(F.clone(F.vaultInfo))).not.toContain(" ");
  });
});

describe("canon and ops digest preimage", () => {
  it("sorts keys and rejects non-integers", () => {
    expect(canon({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canon({ a: 1.5 })).toThrow();
  });
  it("excludes meta and inline so re-sealing keeps the digest", () => {
    const a = opsDigestPreimage([F.opPut as any, F.opDel as any]);
    const b = opsDigestPreimage([{ ...F.opPut, meta: "AAAA", inline: null } as any, { ...F.opDel, meta: "BBBB" } as any]);
    expect(a).toBe(b);
    expect(a).toBe(
      `[{"base":18011,"blobs":["${F.BLOB_A}"],"fileId":"${F.FILE_ID}","kv":1,"op":"put","pathKey":"${F.PATH_KEY}","rc":"note"},` +
      `{"base":18234,"blobs":[],"fileId":"${F.FILE_ID}","kv":1,"op":"del","pathKey":"${F.PATH_KEY}","rc":"note"}]`,
    );
  });
});
