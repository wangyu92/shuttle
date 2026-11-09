// Deterministic ids and structurally valid wire objects for tests. Nothing here is cryptographically
// meaningful: metas are random b64u, MACs are placeholders. Use @shuttle/crypto for real envelopes.

import type { BlobId, CommitOp, DeviceId, FileId, PathKey, RetentionClass, Seq, VaultInfo } from "@shuttle/protocol";
import { Prng } from "./prng";

export class TestIds {
  readonly prng: Prng;
  constructor(seed: number | string | Prng = "ids") {
    this.prng = seed instanceof Prng ? seed : new Prng(seed);
  }
  fileId(): FileId { return this.prng.hex(16); }
  blobId(): BlobId { return this.prng.hex(32); }
  pathKey(): PathKey { return this.prng.b64u(16); }
  deviceId(): DeviceId { return this.prng.b64u(16); }
  vaultId(): string { return this.prng.b64u(16); }
  cid(): string { return this.prng.uuid(); }
  /** Opaque b64u standing in for a sealed meta/inline of `n` bytes. */
  sealed(n = 64): string { return this.prng.b64u(n); }

  put(o: { fileId?: FileId; base?: Seq | null; pathKey?: PathKey; rc?: RetentionClass; kv?: number; blobs?: BlobId[]; inline?: string | null } = {}): Extract<CommitOp, { op: 'put' }> {
    const op: Extract<CommitOp, { op: 'put' }> = {
      op: "put", fileId: o.fileId ?? this.fileId(), base: o.base ?? null, pathKey: o.pathKey ?? this.pathKey(),
      rc: o.rc ?? "note", kv: o.kv ?? 1, meta: this.sealed(), blobs: o.blobs ?? [],
    };
    const inline = o.inline === undefined ? (op.blobs.length === 0 ? this.sealed(32) : null) : o.inline;
    if (inline !== null) op.inline = inline;
    return op;
  }

  del(o: { fileId: FileId; base: Seq; pathKey: PathKey; rc?: RetentionClass; kv?: number }): Extract<CommitOp, { op: 'del' }> {
    return { op: "del", fileId: o.fileId, base: o.base, pathKey: o.pathKey, rc: o.rc ?? "note", kv: o.kv ?? 1, meta: this.sealed() };
  }

  archive(o: { fileId: FileId; base: Seq; pathKey: PathKey; rc?: RetentionClass; kv?: number; blobs?: BlobId[] }): Extract<CommitOp, { op: 'archive' }> {
    const op: Extract<CommitOp, { op: 'archive' }> = {
      op: "archive", fileId: o.fileId, base: o.base, pathKey: o.pathKey, rc: o.rc ?? "note", kv: o.kv ?? 1,
      meta: this.sealed(), blobs: o.blobs ?? [],
    };
    if (op.blobs.length === 0) op.inline = this.sealed(32);
    return op;
  }

  /** A shape-valid vault-info (placeholder MAC and wrapped key). */
  vaultInfo(o: { vaultId?: string; epoch?: number; infoRev?: number; activeKv?: number } = {}): VaultInfo {
    const kv = o.activeKv ?? 1;
    return {
      format: "shuttle.vault-info", formatVersion: 1, vaultId: o.vaultId ?? this.vaultId(), createdAt: 1_767_225_600_000,
      infoRev: o.infoRev ?? 1, epoch: o.epoch ?? 1,
      kdf: { alg: "PBKDF2-SHA256", iter: 600000, salt: this.prng.b64u(32) },
      keys: [{ kv, status: "active", suite: "sx1", nonce: this.prng.b64u(12), wrapped: this.prng.b64u(48), check: this.prng.b64u(16), createdAt: 1_767_225_600_000 }],
      activeKv: kv,
      params: {
        chunker: { alg: "fastcdc-k1", min: 262144, avg: 1048576, max: 4194304 },
        inlineMax: 4096, compression: "deflate-raw", padding: "none", metaPadBucket: 256,
      },
      retention: { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90, thinAfterHours: 24, thinBucketMinutes: 60 },
      requires: [], unlockRequires: [], features: ["history-v1", "archive-v1"],
      infoMac: this.prng.b64u(32),
    };
  }
}
