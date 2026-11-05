// Pack codec for application/x-shuttle-pack (design §2.8.5).
//
//   "SXPK" (4) | version u8 = 1 | count u32 BE
//   repeat count:
//     blobId 32 raw bytes | length u32 BE | bytes
//     length = 0xFFFFFFFF → blob missing (no bytes follow)       [pack-get only]

import { DEFAULT_LIMITS, MAX_PACK_ENTRIES, PACK_MAGIC, PACK_MISSING, PACK_VERSION } from "./constants";
import { bytesToHex, hexToBytes, isBlobId } from "./ids";
import type { PackEntry } from "./types";

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

const HEADER = 9;          // magic 4 + version 1 + count 4
const ENTRY_HEADER = 36;   // id 32 + length 4
const MAGIC = [0x53, 0x58, 0x50, 0x4b]; // "SXPK"

export interface PackOptions {
  /** Max entries (default 256). */
  maxEntries?: number;
  /** Max total pack size in bytes (default 8 MiB). */
  maxBytes?: number;
  /** Allow `missing` entries (pack-get responses only). Default false. */
  allowMissing?: boolean;
}

/** Total encoded size of a pack, for sizing pack-put requests before allocating. */
export function packSize(entries: readonly PackEntry[]): number {
  let n = HEADER;
  for (const e of entries) n += ENTRY_HEADER + (e.bytes ? e.bytes.length : 0);
  return n;
}

export function encodePack(entries: readonly PackEntry[], opts: PackOptions = {}): Uint8Array {
  const maxEntries = opts.maxEntries ?? MAX_PACK_ENTRIES;
  const maxBytes = opts.maxBytes ?? DEFAULT_LIMITS.maxPackBytes;
  if (entries.length > maxEntries) throw new PackError(`more than ${maxEntries} entries`);
  const total = packSize(entries);
  if (total > maxBytes) throw new PackError(`pack of ${total} bytes exceeds ${maxBytes}`);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = PACK_VERSION;
  dv.setUint32(5, entries.length);
  let off = HEADER;
  for (const e of entries) {
    if (!isBlobId(e.id)) throw new PackError(`bad blobId ${JSON.stringify(e.id)}`);
    out.set(hexToBytes(e.id), off);
    off += 32;
    if (e.bytes === null) {
      if (!opts.allowMissing) throw new PackError("missing entry not allowed");
      dv.setUint32(off, PACK_MISSING);
      off += 4;
      continue;
    }
    if (e.bytes.length >= PACK_MISSING) throw new PackError("entry too large");
    dv.setUint32(off, e.bytes.length);
    off += 4;
    out.set(e.bytes, off);
    off += e.bytes.length;
  }
  return out;
}

/**
 * Decode a pack. Entry `bytes` are subarray views into `buf` (no copy). Throws PackError on any
 * malformed input: bad magic or version, truncation, trailing bytes, limit violations.
 */
export function decodePack(buf: Uint8Array, opts: PackOptions = {}): PackEntry[] {
  const maxEntries = opts.maxEntries ?? MAX_PACK_ENTRIES;
  const maxBytes = opts.maxBytes ?? DEFAULT_LIMITS.maxPackBytes;
  if (buf.length > maxBytes) throw new PackError(`pack of ${buf.length} bytes exceeds ${maxBytes}`);
  if (buf.length < HEADER) throw new PackError("truncated header");
  for (let i = 0; i < 4; i++) if (buf[i] !== MAGIC[i]) throw new PackError(`bad magic (expected ${PACK_MAGIC})`);
  if (buf[4] !== PACK_VERSION) throw new PackError(`unsupported pack version ${buf[4]}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint32(5);
  if (count > maxEntries) throw new PackError(`count ${count} exceeds ${maxEntries}`);
  const out: PackEntry[] = [];
  let off = HEADER;
  for (let i = 0; i < count; i++) {
    if (off + ENTRY_HEADER > buf.length) throw new PackError(`truncated entry ${i} header`);
    const id = bytesToHex(buf.subarray(off, off + 32));
    off += 32;
    const len = dv.getUint32(off);
    off += 4;
    if (len === PACK_MISSING) {
      if (!opts.allowMissing) throw new PackError(`entry ${i}: missing marker not allowed`);
      out.push({ id, bytes: null });
      continue;
    }
    if (off + len > buf.length) throw new PackError(`truncated entry ${i} body`);
    out.push({ id, bytes: buf.subarray(off, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new PackError(`${buf.length - off} trailing bytes`);
  return out;
}
