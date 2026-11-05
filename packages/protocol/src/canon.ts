// Canonical JSON (design §4.5.2) and the op-header projection hashed into `ops_digest` (§2.8.3).
// Hashing itself is left to the caller (crypto / server): this package has no platform crypto.

import type { CommitOp } from "./types";

/** §4.5.2 canon: sorted keys (UTF-16 code units), no whitespace, safe integers only. */
export function canon(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("non-integer");
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v !== "object") throw new Error(`cannot canonicalize ${typeof v}`);
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
}

export interface OpHeader { op: CommitOp["op"]; fileId: string; base: number | null; pathKey: string; rc: string; kv: number; blobs: string[] }

/** `[{op, fileId, base, pathKey, rc, kv, blobs}…]`: excludes meta/inline so re-sealing keeps the digest. del → blobs []. */
export function opHeaders(ops: readonly CommitOp[]): OpHeader[] {
  return ops.map((o) => ({
    op: o.op, fileId: o.fileId, base: o.base, pathKey: o.pathKey, rc: o.rc, kv: o.kv,
    blobs: o.op === "del" ? [] : [...o.blobs],
  }));
}

/** UTF-8 preimage of ops_digest: `SHA-256(UTF8(opsDigestPreimage(ops)))`. */
export function opsDigestPreimage(ops: readonly CommitOp[]): string {
  return canon(opHeaders(ops));
}
