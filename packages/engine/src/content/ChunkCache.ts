// Chunk cache (design §3.3.2 store `chunkCache`, §3.15): sealed blobs kept in the state DB, LRU by
// `lastUsed`, capped per platform (desktop 256 MiB, mobile 64 MiB, node disabled). Downloads read it
// first (BlobPipeline.fetchBlob) and fill it after a fetch, so a re-download of the same content (a
// merge base, a conflict copy pulled back, a file restored after a delete) costs no request.
//
// Sealed bytes are cached, not plaintext: every hit is opened and verified again (blobId check), so a
// damaged entry is refetched, never trusted. The running total lives in `meta.chunkCacheBytes` and is
// updated in the same transaction as the rows. Each call is its own transaction; nothing else is
// awaited inside one.

import type { BlobId, StateStore, StateTx } from "@shuttle/protocol";
import type { SealedBlobCache } from "./BlobPipeline";

const TOTAL_KEY = "chunkCacheBytes";
/** Rows evicted per lookup of the oldest entries. */
const EVICT_PAGE = 32;

export interface ChunkCacheDeps {
  state: StateStore;
  /** Cap in bytes of sealed data (0 = disabled). */
  capBytes(): number;
  now(): number;
}

export class ChunkCache implements SealedBlobCache {
  readonly stats = { hits: 0, misses: 0, puts: 0, evictions: 0 };

  constructor(private readonly d: ChunkCacheDeps) {}

  get enabled(): boolean {
    return this.d.capBytes() > 0;
  }

  async get(id: BlobId): Promise<Uint8Array | null> {
    if (!this.enabled) return null;
    const now = this.d.now();
    const hit = await this.d.state.tx(["chunkCache"], async (tx) => {
      const row = await tx.chunkCache.get(id);
      if (!row) return null;
      await tx.chunkCache.put({ ...row, lastUsed: now });
      return row.sealed;
    });
    if (hit) this.stats.hits++;
    else this.stats.misses++;
    return hit;
  }

  async put(id: BlobId, sealed: Uint8Array): Promise<void> {
    const cap = this.d.capBytes();
    if (cap <= 0 || sealed.length > cap) return;
    const now = this.d.now();
    const evicted = await this.d.state.tx(["chunkCache", "meta"], async (tx) => {
      if (await tx.chunkCache.get(id)) return 0;
      let total = await totalOf(tx);
      await tx.chunkCache.put({ blobId: id, sealed, size: sealed.length, lastUsed: now });
      total += sealed.length;
      let n = 0;
      while (total > cap) {
        // Keys first, then one row at a time: never more than one sealed blob in memory (mobile).
        const keys = await tx.chunkCache.getAllKeys({ index: "lastUsed", limit: EVICT_PAGE });
        let progressed = false;
        for (const k of keys) {
          if (total <= cap) break;
          if (k === id) continue;
          const row = await tx.chunkCache.get(k);
          if (!row) continue;
          await tx.chunkCache.delete(k);
          total -= row.size;
          n++;
          progressed = true;
        }
        if (!progressed) break;
      }
      await tx.meta.put({ k: TOTAL_KEY, v: Math.max(0, total) });
      return n;
    });
    this.stats.puts++;
    this.stats.evictions += evicted;
  }

  /** Bytes currently cached (tests, debug info). */
  bytes(): Promise<number> {
    return this.d.state.tx(["chunkCache", "meta"], (tx) => totalOf(tx), "readonly");
  }

  /** Drop everything (cap lowered to 0, rebuild). */
  async clear(): Promise<void> {
    await this.d.state.tx(["chunkCache", "meta"], async (tx) => {
      await tx.chunkCache.clear();
      await tx.meta.put({ k: TOTAL_KEY, v: 0 });
    });
  }
}

async function totalOf(tx: StateTx): Promise<number> {
  const m = await tx.meta.get(TOTAL_KEY);
  if (m && typeof m.v === "number") return m.v;
  // No running total yet (first use, or a DB from before the cache): count once.
  let n = 0;
  for (const row of await tx.chunkCache.getAll()) n += row.size;
  return n;
}
