// FastCDC content-defined chunking with the keyed gear table (design ID-3, §2.3.1, §4.3).
//
// The design fixes the parameters in vault-info (`params.chunker = {alg:'fastcdc-k1', min, avg, max}`,
// default 256 KiB / 1 MiB / 4 MiB) but does not spell out the algorithm variant. Every device must cut
// identically or cross-device dedup breaks, so this file IS the definition of "fastcdc-k1":
//
//   gear  : 256 x u32 from Keyring.gearTable() (HKDF(VMK_1, "shuttle/v1/cdc-gear", 1024), big-endian).
//   fp    : 32-bit rolling fingerprint, fp = ((fp << 1) + gear[byte]) mod 2^32, starting at 0 at the
//           first byte after `min` (bytes before `min` are skipped, as in FastCDC).
//   masks : normalized chunking level 2. With bits = log2(avg) (avg must be a power of two):
//           maskS = the top (bits + 2) bits of the u32, maskL = the top (bits - 2) bits.
//           Top bits are used because with a left-shifting fingerprint bit k depends on the last
//           k + 1 bytes only; the top bits see the widest (32-byte) window.
//   cut   : scanning position i (0-based, i >= min):
//             while i < min(avg, n): roll byte i; if (fp & maskS) == 0 → chunk length i + 1
//             while i < min(max, n): roll byte i; if (fp & maskL) == 0 → chunk length i + 1
//           otherwise the chunk is min(max, n) bytes long. A remainder n <= min is one chunk.
//           Consequence: every non-final chunk is at least min + 1 bytes (never exactly min).
//
// The golden test in test/chunker.test.ts pins boundary offsets for a seeded gear and seeded data;
// changing anything above is a format change (new `alg` string), not a refactor.

export interface ChunkerParams { min: number; avg: number; max: number }

export const CHUNKER_ALG = "fastcdc-k1";
export const DEFAULT_CHUNKER: Readonly<ChunkerParams> = Object.freeze({ min: 262144, avg: 1048576, max: 4194304 });

export interface ChunkMasks { maskS: number; maskL: number }

function topBits(n: number): number {
  if (n <= 0) return 0;
  if (n >= 32) return 0xffffffff;
  return (0xffffffff << (32 - n)) >>> 0;
}

export function validateChunkerParams(p: ChunkerParams): ChunkMasks {
  const { min, avg, max } = p;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(avg) || !Number.isSafeInteger(max)) throw new RangeError("chunker params must be integers");
  if (!(min >= 1 && min <= avg && avg <= max)) throw new RangeError("chunker params must satisfy 1 <= min <= avg <= max");
  const bits = Math.log2(avg);
  if (!Number.isInteger(bits) || bits < 3 || bits > 30) throw new RangeError("chunker avg must be a power of two between 2^3 and 2^30");
  return { maskS: topBits(bits + 2), maskL: topBits(bits - 2) };
}

function checkGear(gear: Uint32Array): void {
  if (gear.length !== 256) throw new RangeError(`gear table must have 256 entries, got ${gear.length}`);
}

/** Length of the next chunk of `buf[start..end)`. */
export function nextCut(buf: Uint8Array, start: number, end: number, gear: Uint32Array, p: ChunkerParams, m: ChunkMasks): number {
  const n = end - start;
  if (n <= p.min) return n;
  const normal = Math.min(p.avg, n);
  const limit = Math.min(p.max, n);
  let fp = 0;
  let i = p.min;
  for (; i < normal; i++) {
    fp = ((fp << 1) + (gear[buf[start + i] as number] as number)) >>> 0;
    if ((fp & m.maskS) === 0) return i + 1;
  }
  for (; i < limit; i++) {
    fp = ((fp << 1) + (gear[buf[start + i] as number] as number)) >>> 0;
    if ((fp & m.maskL) === 0) return i + 1;
  }
  return limit;
}

/** Chunk sizes covering `buf` exactly, in order. Empty input → []. */
export function chunkSizes(buf: Uint8Array, gear: Uint32Array, p: ChunkerParams = DEFAULT_CHUNKER): number[] {
  checkGear(gear);
  const m = validateChunkerParams(p);
  const out: number[] = [];
  let off = 0;
  while (off < buf.length) {
    const len = nextCut(buf, off, buf.length, gear, p, m);
    out.push(len);
    off += len;
  }
  return out;
}

/** Views (no copies) of each chunk. */
export function chunkViews(buf: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  for (const s of sizes) {
    out.push(buf.subarray(off, off + s));
    off += s;
  }
  if (off !== buf.length) throw new RangeError("chunk sizes do not cover the buffer");
  return out;
}

export interface ContentPlan {
  /** Plaintext <= inlineMax goes in the record's `inline` field, no blobs (design §2.3.1). */
  inline: boolean;
  /** Chunk sizes for blobs; [] when inline. */
  chunkSizes: number[];
}

/** How a file body is carried: inline or as FastCDC chunks (design §2.3.1). */
export function planContent(buf: Uint8Array, gear: Uint32Array, p: ChunkerParams, inlineMax: number): ContentPlan {
  if (buf.length <= inlineMax) return { inline: true, chunkSizes: [] };
  return { inline: false, chunkSizes: chunkSizes(buf, gear, p) };
}
