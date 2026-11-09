// New contract pieces: state schema, remote error table, REST detail validators.
import { describe, expect, it } from "vitest";
import {
  META_KEYS, REMOTE_ERRORS, REMOTE_ERROR_CODES, STATE_SCHEMA, STORE_NAMES, StateStoreError, WIRE_ERRORS,
  isRemoteError, isRemoteErrorCode, isStateStoreError, remoteCodeFromWire, remoteError,
  validatePreconditionFailedDetails, validateSnapshotRequiredDetails,
  DEFAULT_LIMITS, validateHealthResponse, validateMeResponse,
} from "../src/index";
import type { StoreName, StoreValueMap } from "../src/index";

describe("state schema (design §3.3.2)", () => {
  it("names every store of the value map, with the documented key paths", () => {
    const expected: Record<StoreName, string> = {
      meta: "k", files: "fileId", bases: "fileId", remote: "fileId", history: "seq", journal: "opSeq", batches: "batchId",
      staging: "opSeq", applyQueue: "fileId", intents: "path", integrity: "seq", chunkCache: "blobId", deferred: "fileId", adapter: "k",
    };
    expect(Object.fromEntries(STORE_NAMES.map((n) => [n, STATE_SCHEMA[n].keyPath]))).toEqual(expected);
    expect(STATE_SCHEMA.files.indexes.path?.unique).toBe(true);
    expect(STATE_SCHEMA.journal.autoIncrement).toBe(true);
    expect(Object.keys(STATE_SCHEMA.remote.indexes).sort()).toEqual(["deleted", "path", "pathKey"]);
    // every index key path is a field of the store's value type (type-level spot check)
    const k: keyof StoreValueMap["chunkCache"] = "lastUsed";
    expect(STATE_SCHEMA.chunkCache.indexes[k]).toBeDefined();
    expect(META_KEYS).toContain("cursor");
  });

  it("StateStoreError carries a code", () => {
    const e = new StateStoreError("CONSTRAINT", "dup");
    expect(isStateStoreError(e, "CONSTRAINT")).toBe(true);
    expect(isStateStoreError(e, "CLOSED")).toBe(false);
    expect(isStateStoreError(new Error("x"))).toBe(false);
  });
});

describe("remote error table (design §2.9.3)", () => {
  it("covers every RemoteErrorCode and agrees with the wire retry column", () => {
    expect(Object.keys(REMOTE_ERRORS).sort()).toEqual([...REMOTE_ERROR_CODES].sort());
    for (const c of REMOTE_ERROR_CODES) {
      if (c in WIRE_ERRORS) expect(REMOTE_ERRORS[c].retry).toBe(WIRE_ERRORS[c as keyof typeof WIRE_ERRORS].retry);
    }
    expect(REMOTE_ERRORS.NETWORK.retry).toBe(true);
    expect(REMOTE_ERRORS.TIMEOUT.retry).toBe(true);
  });

  it("remoteError uses the default retry flag", () => {
    const e = remoteError("RATE_LIMITED", "slow down", { retryAfterMs: 2000 });
    expect(e).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 2000 });
    expect(isRemoteError(e, "RATE_LIMITED")).toBe(true);
    expect(isRemoteErrorCode("CONFLICT")).toBe(false);
    expect(remoteCodeFromWire("BAD_CREDENTIALS")).toBe("UNAUTHENTICATED");
  });
});

describe("REST detail validators (design §2.8.5)", () => {
  it("SNAPSHOT_REQUIRED details", () => {
    expect(validateSnapshotRequiredDetails({ minSeq: 12000, epoch: 1, reason: "cursor-too-old" }).ok).toBe(true);
    expect(validateSnapshotRequiredDetails({ minSeq: 0, epoch: 2, reason: "rollback", rollbackAt: 1762318800000 }).ok).toBe(true);
    expect(validateSnapshotRequiredDetails({ minSeq: 1, epoch: 1, reason: "later" })).toMatchObject({ ok: false, path: "$.reason" });
    expect(validateSnapshotRequiredDetails({ minSeq: -1, epoch: 1, reason: "epoch" })).toMatchObject({ ok: false, path: "$.minSeq" });
  });

  it("PRECONDITION_FAILED details", () => {
    expect(validatePreconditionFailedDetails({ etag: "\"a81f\"" }).ok).toBe(true);
    expect(validatePreconditionFailedDetails({ etag: "" }).ok).toBe(false);
  });
});

describe("optional limits on /v1/health and /v1/me (design §2.8.5, §2.9.2 welcome limits)", () => {
  const health = { ok: true, server: "0.1.0", protocols: [1], time: 1, source: "https://example.invalid/shuttle" };
  const me = {
    user: { userId: "u1", username: "alice", role: "owner" },
    device: { deviceId: "ZGV2aWNlLWlk", name: "laptop", platform: "linux", clientVersion: null, createdAt: 1, lastSeenAt: null, revoked: false, current: true },
  };
  it("accepts responses without limits (older servers) and with complete limits", () => {
    expect(validateHealthResponse(health).ok).toBe(true);
    expect(validateMeResponse(me).ok).toBe(true);
    const h = validateHealthResponse({ ...health, limits: { ...DEFAULT_LIMITS, futureKnob: 3 } });
    expect(h.ok && h.value.limits?.maxCommitOps).toBe(DEFAULT_LIMITS.maxCommitOps);
    expect(validateMeResponse({ ...me, limits: { ...DEFAULT_LIMITS } }).ok).toBe(true);
  });
  it("rejects incomplete or non-positive limits", () => {
    const { maxCommitOps: _drop, ...partial } = DEFAULT_LIMITS;
    const r = validateMeResponse({ ...me, limits: partial });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe("$.limits.maxCommitOps");
    expect(validateHealthResponse({ ...health, limits: { ...DEFAULT_LIMITS, maxCommitBytes: 0 } }).ok).toBe(false);
    expect(validateHealthResponse({ ...health, limits: null }).ok).toBe(false);
  });
});
