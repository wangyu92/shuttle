// Blob directory and rows (design §2.6.2, §2.7.7, §2.8.2, §2.8.5). AGPL-3.0-only.
// The final step of every blob write (re-check row, renameSync, fsync dir, upsert row) runs in one
// synchronous block, as does GC phase (b) in gc.ts. Neither can interleave with the other (S13).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Stmts } from "./db";
import { HttpError } from "./util";

// design §4.6.1: sealed blobs start with "SXB1"; minimum sealed length 34. The server must not import crypto.
const BLOB_MAGIC = [0x53, 0x58, 0x42, 0x31] as const;
export const BLOB_MIN_LEN = 34;

export function looksSealed(head: ArrayLike<number>, size: number): boolean {
  return size >= BLOB_MIN_LEN && BLOB_MAGIC.every((b, i) => head[i] === b);
}

export class BlobStore {
  readonly tmpDir: string;
  readonly graveyard: string;

  constructor(
    readonly dataDir: string, private readonly s: Stmts, private readonly now: () => number,
    /** Called after a new blob row landed, with the change in stored bytes (usage cache). */
    private readonly onStoredDelta?: (vid: string, delta: number) => void,
  ) {
    this.tmpDir = path.join(dataDir, "tmp");
    this.graveyard = path.join(dataDir, "graveyard");
  }

  vaultDir(vid: string): string {
    return path.join(this.dataDir, "vaults", vid);
  }

  blobPath(vid: string, blobId: string): string {
    return path.join(this.vaultDir(vid), "blobs", blobId.slice(0, 2), blobId.slice(2, 4), blobId);
  }

  tmpPath(): string {
    return path.join(this.tmpDir, randomBytes(12).toString("hex"));
  }

  row(vid: string, blobId: string): { size: number; state: string; touched_at: number } | undefined {
    return this.s.get("SELECT size, state, touched_at FROM blobs WHERE vault_id = ? AND blob_id = ?", vid, blobId);
  }

  /** Blob is readable: row present (live or doomed) and file present. */
  readableSize(vid: string, blobId: string): number | null {
    const r = this.row(vid, blobId);
    if (!r) return null;
    try {
      return statSync(this.blobPath(vid, blobId)).size;
    } catch {
      return null;
    }
  }

  /**
   * Streams a request body into tmp/ with SHA-256 and size checks, fsyncs it, and returns the tmp path.
   * The caller must pass the result to `land` (or delete it).
   */
  async stage(body: Readable | AsyncIterable<Uint8Array>, maxSize: number, expectedSha: string | null): Promise<{ tmp: string; size: number }> {
    const tmp = this.tmpPath();
    const fh = await open(tmp, "wx");
    const hash = createHash("sha256");
    let size = 0;
    const head: number[] = [];
    let ok = false;
    try {
      try {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > maxSize) throw new HttpError("TOO_LARGE", `blob exceeds ${maxSize} bytes`);
          for (let i = 0; head.length < 4 && i < chunk.length; i++) head.push(chunk[i]!);
          hash.update(chunk);
          await fh.write(chunk);
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (expectedSha !== null && hash.digest("hex") !== expectedSha) throw new HttpError("HASH_MISMATCH", "body sha256 does not match");
      if (!looksSealed(head, size)) throw new HttpError("BAD_BLOB", "not a sealed blob (magic or length)");
      ok = true;
      return { tmp, size };
    } finally {
      if (!ok) rmSync(tmp, { force: true });
    }
  }

  /** Writes bytes already in memory (pack-put entries) to tmp/ and fsyncs them. */
  async stageBytes(bytes: Uint8Array): Promise<string> {
    const tmp = this.tmpPath();
    const fh = await open(tmp, "wx");
    try {
      await fh.write(bytes);
      await fh.sync();
    } catch (e) {
      await fh.close();
      rmSync(tmp, { force: true });
      throw e;
    }
    await fh.close();
    return tmp;
  }

  /**
   * The synchronous final step (design §2.6.2): re-check the row, renameSync into place, fsync the dir,
   * insert or update the row. Returns "stored" for a new blob, "present" when it was already there
   * (touched_at updated, state set back to live; the first copy's bytes are kept).
   */
  land(vid: string, blobId: string, tmp: string, size: number): "stored" | "present" {
    const dest = this.blobPath(vid, blobId);
    const t = this.now();
    const row = this.row(vid, blobId);
    if (row && existsSync(dest)) {
      rmSync(tmp, { force: true });
      this.s.run("UPDATE blobs SET touched_at = ?, state = 'live' WHERE vault_id = ? AND blob_id = ?", t, vid, blobId);
      return "present";
    }
    const dir = path.dirname(dest);
    mkdirSync(dir, { recursive: true });
    renameSync(tmp, dest);
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    this.s.run(
      `INSERT INTO blobs (vault_id, blob_id, size, created_at, touched_at, state) VALUES (?, ?, ?, ?, ?, 'live')
       ON CONFLICT (vault_id, blob_id) DO UPDATE SET size = excluded.size, touched_at = excluded.touched_at, state = 'live'`,
      vid, blobId, size, t, t);
    // A row without its file (restored DB) is overwritten: count only the size difference.
    this.onStoredDelta?.(vid, size - (row?.size ?? 0));
    return "stored";
  }

  discard(tmp: string): void {
    rmSync(tmp, { force: true });
  }

  /** Quota check for a new blob (507 QUOTA). */
  checkQuota(quota: number | null, stored: number, size: number): void {
    if (quota !== null && stored + size > quota) throw new HttpError("QUOTA", "vault limit exceeded");
  }
}
