// Record headers, meta plaintext and decoding of VersionRecords into RemoteHeads
// (design §2.4, §4.6.3, §4.9.1, §3.8.1 `toHead`).
//
// The engine never builds AAD strings (design §4.13, D11): it hands a RecordHeader to the Keyring.
// The header of a record is exactly what the remote stores in plaintext, so a received record is opened
// with the header "as received"; any tampering with base, kind, blobs, rc or pathKey fails the AEAD.

import {
  validateFileMeta, validateTombstoneMeta,
  type ConfigCategory, type FileMeta, type Keyring, type RecordHeader, type RemoteHead, type RetentionClass,
  type TombstoneMeta, type VersionRecord,
} from "@shuttle/protocol";
import { IntegrityError } from "../errors";
import { normalizePath } from "../path/normalize";
import { CHUNKER_ALG } from "../content/chunker";

/** Header of a received record (design §4.6.3: "recAAD(header of r as received)"). */
export function headerOf(rec: VersionRecord): RecordHeader {
  return { fileId: rec.fileId, kv: rec.kv, kind: rec.kind, base: rec.base, rc: rec.rc, blobs: [...rec.blobs], pathKey: rec.pathKey };
}

/** Header for opening a stored head's inline body or for re-checking it. */
export function headerOfHead(h: RemoteHead, rcFallback: RetentionClass): RecordHeader {
  return {
    fileId: h.fileId, kv: h.kv, kind: h.deleted ? "del" : "put", base: h.base, rc: h.rc ?? rcFallback, blobs: [...h.blobs], pathKey: h.pathKey,
  };
}

export interface PutMetaInput {
  path: string; size: number; mtime: number; ctime: number; hash: string; chunkSizes: readonly number[];
  inline: boolean; z: boolean; p: boolean; cat: ConfigCategory | null;
}

/** design §2.4 meta plaintext. Inline: chunks = [size] (empty file: []). */
export function putMeta(i: PutMetaInput): FileMeta {
  const chunks = i.inline ? (i.size === 0 ? [] : [i.size]) : [...i.chunkSizes];
  return {
    v: 1, path: i.path, type: "file", size: i.size, mtime: Math.max(0, Math.floor(i.mtime)), ctime: Math.max(0, Math.floor(i.ctime)),
    hash: i.hash, chunker: CHUNKER_ALG, chunks, z: i.z, p: i.p, cat: i.cat,
  };
}

/** Tombstone meta carries only {v, path, type, cat} (ID-8). */
export function tombstoneMeta(path: string, cat: ConfigCategory | null): TombstoneMeta {
  return { v: 1, path, type: "file", cat };
}

export interface DecodedRecord {
  rec: VersionRecord;
  /** null for an archive record (history hint only, never a head). */
  head: RemoteHead | null;
  meta: Record<string, unknown>;
}

/**
 * Open and validate one record (design §4.6.3 "on open" checks 1-4; check 5, size and hash after
 * reassembly, runs in BlobPipeline.download). Throws IntegrityError on any failure; the caller
 * quarantines (design §4.14). The Keyring logs a pathKey consistency warning itself.
 */
export async function decodeRecord(ring: Keyring, rec: VersionRecord): Promise<DecodedRecord> {
  let meta: Record<string, unknown>;
  try {
    meta = await ring.openMeta(rec.meta, headerOf(rec));
  } catch (err) {
    throw new IntegrityError(`record ${rec.seq}: meta does not open`, "meta", { cause: err });
  }
  const isDel = rec.kind === "del";
  const v = isDel ? validateTombstoneMeta(meta) : validateFileMeta(meta);
  if (!v.ok) throw new IntegrityError(`record ${rec.seq}: invalid meta at ${v.path}: ${v.reason}`, "meta");
  const path = normalizePath(String(meta.path));
  if (path === "" || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new IntegrityError(`record ${rec.seq}: invalid path`, "identity");
  }
  if (isDel) {
    if (rec.blobs.length > 0 || rec.inline !== undefined) throw new IntegrityError(`record ${rec.seq}: tombstone with content`, "meta");
    return { rec, meta, head: rec.kind === "del" ? baseHead(rec, path, { deleted: true }) : null };
  }
  const m = meta as FileMeta;
  const hasInline = rec.inline !== undefined && rec.inline !== null;
  if (hasInline && rec.blobs.length > 0) throw new IntegrityError(`record ${rec.seq}: inline and blobs`, "meta");
  if (!hasInline && rec.blobs.length !== m.chunks.length) throw new IntegrityError(`record ${rec.seq}: blob list does not match chunks`, "meta");
  if (!hasInline && m.size > 0 && rec.blobs.length === 0) throw new IntegrityError(`record ${rec.seq}: no content`, "meta");
  if (rec.kind === "archive") return { rec, meta, head: null };
  return {
    rec, meta,
    head: baseHead(rec, path, {
      deleted: false, size: m.size, mtime: m.mtime, ctime: m.ctime, contentHash: m.hash,
      chunkSizes: hasInline ? [] : [...m.chunks], z: m.z, p: m.p,
    }),
  };
}

function baseHead(
  rec: VersionRecord, path: string,
  c: { deleted: boolean; size?: number; mtime?: number; ctime?: number; contentHash?: string; chunkSizes?: number[]; z?: boolean; p?: boolean },
): RemoteHead {
  const h: RemoteHead = {
    fileId: rec.fileId, seq: rec.seq, base: rec.base, pathKey: rec.pathKey, path, deleted: c.deleted,
    size: c.size ?? 0, mtime: c.mtime ?? 0, contentHash: c.contentHash ?? null, chunkSizes: c.chunkSizes ?? [], blobs: [...rec.blobs],
    kv: rec.kv, deviceId: rec.device, ts: rec.ts, rc: rec.rc,
  };
  if (rec.inline !== undefined && rec.inline !== null) h.inline = rec.inline;
  if (rec.cid !== undefined) h.cid = rec.cid;
  if (c.z !== undefined) h.z = c.z;
  if (c.p !== undefined) h.p = c.p;
  if (c.ctime !== undefined) h.ctime = c.ctime;
  return h;
}
