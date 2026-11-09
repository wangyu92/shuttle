// Upload and download of file content (design §2.3.1, §3.7.2 "blobs before metadata", §3.8.5).
//
// Upload: plaintext → planContent (inline or FastCDC chunks) → blobId per chunk (keyed, §4.7) →
// missingBlobs → seal + putBlob only for missing ones (idempotent, content-addressed).
// Download: inline → openInline; else every blob → openBlob (verifies blobId and size) → reassemble →
// verify SHA-256 against the head's contentHash. Any mismatch is an IntegrityError (design §4.14).
//
// Budgets (design §3.15): the optional `budget` hooks bracket every blob held in memory; the
// upload/download slots cap concurrent blob requests (desktop/node 4, mobile 2), shared by the whole
// engine. Blobs of one file move in parallel up to that cap; ops still run one file at a time.
// Chunk cache (design §3.3.2 `chunkCache`, §3.15): downloads read sealed blobs from it first.

import { MAX_MISSING_IDS, type BlobId, type Keyring, type RemoteAdapter, type RemoteHead, type RetentionClass, type VaultInfoParams } from "@shuttle/protocol";
import { IntegrityError } from "../errors";
import { headerOfHead } from "../remote/records";
import { chunkViews, planContent } from "./chunker";
import { sha256Hex } from "./hash";

export interface ContentParams {
  chunker: { min: number; avg: number; max: number };
  inlineMax: number;
  compression: VaultInfoParams["compression"];
  padding: VaultInfoParams["padding"];
}

export interface PreparedContent {
  hash: string;
  size: number;
  inline: boolean;
  chunkSizes: number[];
  blobs: BlobId[];
  /** Plaintext chunk views into the read buffer (in blob order). */
  chunks: Uint8Array[];
}

export interface BlobBudget {
  acquire(bytes: number): Promise<void>;
  release(bytes: number): void;
}

/** Counting slots (sched/Budget.ts Semaphore). */
export interface RequestSlots {
  acquire(): Promise<void>;
  release(): void;
}

/** Sealed-blob cache (content/ChunkCache.ts). */
export interface SealedBlobCache {
  get(id: BlobId): Promise<Uint8Array | null>;
  put(id: BlobId, sealed: Uint8Array): Promise<void>;
}

export interface BlobPipelineDeps {
  remote: RemoteAdapter;
  keyring(): Keyring;
  params(): ContentParams;
  budget?: BlobBudget;
  uploadSlots?: RequestSlots;
  downloadSlots?: RequestSlots;
  cache?: SealedBlobCache;
}

/** Run every task; reject with the first failure only after all have settled (no stray rejections). */
async function allOrFirstError<T>(tasks: ReadonlyArray<Promise<T>>, abort?: Abort): Promise<T[]> {
  const res = await Promise.allSettled(tasks);
  if (abort?.failed) throw abort.err;
  const out: T[] = [];
  for (const r of res) {
    if (r.status === "rejected") throw r.reason;
    out.push(r.value);
  }
  return out;
}

/** Shared failure flag of one upload/download: once a blob fails, queued blobs are not started. */
interface Abort { failed: boolean; err?: unknown }

async function inSlot<T>(slots: RequestSlots | undefined, abort: Abort, fn: () => Promise<T>): Promise<T | undefined> {
  if (slots) await slots.acquire();
  try {
    if (abort.failed) return undefined;
    return await fn();
  } catch (e) {
    if (!abort.failed) {
      abort.failed = true;
      abort.err = e;
    }
    throw e;
  } finally {
    slots?.release();
  }
}

export class BlobPipeline {
  constructor(private readonly d: BlobPipelineDeps) {}

  params(): ContentParams {
    return this.d.params();
  }

  /** Hash, chunk and derive blob ids of one file body (design §3.7.2 content snapshot). */
  async prepare(bytes: Uint8Array): Promise<PreparedContent> {
    const ring = this.d.keyring();
    const p = this.d.params();
    const hash = await sha256Hex(bytes);
    const plan = planContent(bytes, await ring.gearTable(), p.chunker, p.inlineMax);
    if (plan.inline) return { hash, size: bytes.length, inline: true, chunkSizes: [], blobs: [], chunks: [] };
    const chunks = chunkViews(bytes, plan.chunkSizes);
    const blobs: BlobId[] = [];
    for (const c of chunks) blobs.push((await ring.blobId(c)).blobId);
    return { hash, size: bytes.length, inline: false, chunkSizes: plan.chunkSizes, blobs, chunks };
  }

  /** Upload the chunks the remote does not have. Returns the number of blobs uploaded. */
  async upload(c: Pick<PreparedContent, "blobs" | "chunks">, only?: ReadonlySet<BlobId>): Promise<number> {
    if (c.blobs.length === 0) return 0;
    const ring = this.d.keyring();
    const p = this.d.params();
    const want = [...new Set(c.blobs)].filter((id) => !only || only.has(id));
    const missing = new Set<BlobId>();
    for (let i = 0; i < want.length; i += MAX_MISSING_IDS) {
      for (const id of await this.d.remote.missingBlobs(want.slice(i, i + MAX_MISSING_IDS))) missing.add(id);
    }
    const done = new Set<BlobId>();
    const tasks: Array<Promise<void | undefined>> = [];
    const abort: Abort = { failed: false };
    for (let i = 0; i < c.blobs.length; i++) {
      const id = c.blobs[i] as BlobId;
      if (!missing.has(id) || done.has(id)) continue;
      done.add(id);
      const chunk = c.chunks[i] as Uint8Array;
      tasks.push(inSlot(this.d.uploadSlots, abort, async () => {
        await this.d.budget?.acquire(chunk.length);
        try {
          const sealed = await ring.sealBlob(chunk, id, { compress: p.compression !== "none", pad: p.padding === "padme", chunkMax: p.chunker.max });
          await this.d.remote.putBlob(id, sealed);
        } finally {
          this.d.budget?.release(chunk.length);
        }
      }));
    }
    await allOrFirstError(tasks, abort);
    return tasks.length;
  }

  /**
   * Plaintext of a live head (design §3.8.5). `rcFallback` is used only for heads written before the
   * head carried its retention class. A head without its inline body (own commit) refetches the record.
   */
  async download(h: RemoteHead, rcFallback: RetentionClass): Promise<Uint8Array> {
    if (h.deleted || h.contentHash === null) throw new IntegrityError(`head ${h.seq} has no content`, "hash");
    const ring = this.d.keyring();
    let bytes: Uint8Array;
    if (h.blobs.length === 0) {
      if (h.size === 0 && h.inline === undefined) bytes = new Uint8Array(0);
      else {
        let ct = h.inline;
        let z = h.z;
        let p = h.p;
        if (ct === undefined) {
          const rec = await this.d.remote.getVersion(h.fileId, h.seq);
          if (!rec || rec.inline === undefined) throw new IntegrityError(`head ${h.seq}: inline body missing`, "inline");
          ct = rec.inline;
        }
        if (z === undefined || p === undefined) {
          // Flags live in the meta; a head stored before they were recorded is re-opened.
          const rec = await this.d.remote.getVersion(h.fileId, h.seq);
          if (!rec) throw new IntegrityError(`head ${h.seq}: record gone`, "inline");
          const meta = await ring.openMeta(rec.meta, { fileId: rec.fileId, kv: rec.kv, kind: rec.kind, base: rec.base, rc: rec.rc, blobs: rec.blobs, pathKey: rec.pathKey });
          z = meta.z === true;
          p = meta.p === true;
        }
        try {
          bytes = await ring.openInline(ct, headerOfHead(h, rcFallback), z, p, h.size);
        } catch (err) {
          throw new IntegrityError(`head ${h.seq}: inline does not open`, "inline", { cause: err });
        }
      }
    } else {
      if (h.chunkSizes.length !== h.blobs.length) throw new IntegrityError(`head ${h.seq}: chunk list mismatch`, "meta");
      await this.d.budget?.acquire(h.size);
      try {
        const out = new Uint8Array(h.size);
        const offs: number[] = [];
        let off = 0;
        for (const size of h.chunkSizes) {
          offs.push(off);
          off += size;
        }
        if (off !== out.length) throw new IntegrityError(`head ${h.seq}: reassembled size mismatch`, "hash");
        const abort: Abort = { failed: false };
        await allOrFirstError(h.blobs.map((id, i) => inSlot(this.d.downloadSlots, abort, async () => {
          const size = h.chunkSizes[i] as number;
          const plain = await this.fetchBlob(ring, id, size);
          if (plain.length !== size) throw new IntegrityError(`blob ${id}: size mismatch`, "blob");
          out.set(plain, offs[i] as number);
        })), abort);
        bytes = out;
      } finally {
        this.d.budget?.release(h.size);
      }
    }
    if (bytes.length !== h.size) throw new IntegrityError(`head ${h.seq}: size mismatch`, "hash");
    if ((await sha256Hex(bytes)) !== h.contentHash) throw new IntegrityError(`head ${h.seq}: content hash mismatch`, "hash");
    return bytes;
  }

  /** One blob: the chunk cache first (a cached blob that does not open is refetched), else the remote. */
  private async fetchBlob(ring: Keyring, id: BlobId, size: number): Promise<Uint8Array> {
    const cache = this.d.cache;
    if (cache) {
      const hit = await cache.get(id).catch(() => null);
      if (hit) {
        try {
          return await ring.openBlob(hit, id, size);
        } catch {
          // stale or damaged cache entry: fall through to the remote
        }
      }
    }
    const sealed = await this.d.remote.getBlob(id);
    let plain: Uint8Array;
    try {
      plain = await ring.openBlob(sealed, id, size);
    } catch (err) {
      throw new IntegrityError(`blob ${id} does not open`, "blob", { cause: err });
    }
    if (cache) await cache.put(id, sealed).catch(() => undefined);
    return plain;
  }
}
