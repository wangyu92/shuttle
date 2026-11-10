// Concurrency limits and memory caps (design §3.15). Budget.bytes.acquire(n) blocks until
// inFlight + n <= cap; an item larger than the cap is admitted alone if n <= maxFileBytes (I24).
// Waiters are served in FIFO order, so a large item cannot starve behind a stream of small ones.

import type { LocalPlatform } from "@shuttle/protocol";
import { OOMError } from "../errors";

const MiB = 1024 * 1024;

export interface PlatformBudgets {
  uploadConcurrency: number;
  downloadConcurrency: number;
  commitBatchOps: number;
  inFlightBytes: number;
  hashConcurrency: number;
  hashBytes: number;
  maxChunkBytes: number;
  /** 0 = disabled. */
  chunkCacheBytes: number;
  maxFileBytes: number;
  pullPage: number;
  scanBatch: number;
  /**
   * Pull applies of distinct files in flight at once (design §3.8.2 leaves the apply order to the
   * BatchOrderer; ingest persisted the cursor with the queue rows, §3.8.1, so apply order never moves
   * the cursor). Deletes, moves and swap cycles still run alone. Desktop and mobile keep 1 (the Vault
   * API and editors); node uses 4 (part 5 measurement: one fsync'd write costs ~400 ms on the NAS).
   */
  applyConcurrency: number;
}

/** design §3.15 table (node values follow the 512 MiB container budget, §6.1.7). */
export const PLATFORM_BUDGETS: Readonly<Record<'desktop' | 'mobile' | 'node', Readonly<PlatformBudgets>>> = Object.freeze({
  desktop: Object.freeze({
    uploadConcurrency: 4, downloadConcurrency: 4, commitBatchOps: 50, inFlightBytes: 128 * MiB, hashConcurrency: 4, hashBytes: 64 * MiB,
    maxChunkBytes: 4 * MiB, chunkCacheBytes: 256 * MiB, maxFileBytes: 200 * MiB, pullPage: 500, scanBatch: 500, applyConcurrency: 1,
  }),
  mobile: Object.freeze({
    uploadConcurrency: 2, downloadConcurrency: 2, commitBatchOps: 20, inFlightBytes: 24 * MiB, hashConcurrency: 1, hashBytes: 16 * MiB,
    maxChunkBytes: 4 * MiB, chunkCacheBytes: 64 * MiB, maxFileBytes: 50 * MiB, pullPage: 200, scanBatch: 250, applyConcurrency: 1,
  }),
  node: Object.freeze({
    uploadConcurrency: 4, downloadConcurrency: 4, commitBatchOps: 100, inFlightBytes: 64 * MiB, hashConcurrency: 4, hashBytes: 128 * MiB,
    maxChunkBytes: 4 * MiB, chunkCacheBytes: 0, maxFileBytes: 200 * MiB, pullPage: 1000, scanBatch: 2000, applyConcurrency: 4,
  }),
});

export function budgetsFor(p: LocalPlatform, override?: Partial<PlatformBudgets>): PlatformBudgets {
  const base = p === "ios" || p === "android" ? PLATFORM_BUDGETS.mobile : p === "node" ? PLATFORM_BUDGETS.node : PLATFORM_BUDGETS.desktop;
  return { ...base, ...(override ?? {}) };
}

interface Waiter { n: number; resolve(): void }

/** Byte budget with the "admit one oversized item alone" rule. */
export class ByteBudget {
  private used = 0;
  private queue: Waiter[] = [];
  /** Highest inFlight ever observed and the largest item admitted alone (I24 instrumentation). */
  readonly stats = { peak: 0, admittedAlone: 0, largestAlone: 0, acquires: 0 };

  constructor(readonly cap: number, private readonly maxItem: () => number) {}

  get inFlight(): number {
    return this.used;
  }

  private fits(n: number): boolean {
    if (n > this.cap) return this.used === 0;
    return this.used + n <= this.cap;
  }

  acquire(n: number): Promise<void> {
    if (!(n >= 0) || !Number.isFinite(n)) return Promise.reject(new RangeError(`bad budget request ${n}`));
    if (n > this.cap && n > this.maxItem()) return Promise.reject(new OOMError(`item of ${n} bytes exceeds the budget and the file size cap`));
    this.stats.acquires++;
    if (this.queue.length === 0 && this.fits(n)) {
      this.take(n);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push({ n, resolve }));
  }

  private take(n: number): void {
    this.used += n;
    if (n > this.cap) {
      this.stats.admittedAlone++;
      this.stats.largestAlone = Math.max(this.stats.largestAlone, n);
    }
    this.stats.peak = Math.max(this.stats.peak, this.used);
  }

  release(n: number): void {
    this.used = Math.max(0, this.used - n);
    while (this.queue.length > 0) {
      const w = this.queue[0]!;
      if (!this.fits(w.n)) break;
      this.queue.shift();
      this.take(w.n);
      w.resolve();
    }
  }

  async run<T>(n: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(n);
    try {
      return await fn();
    } finally {
      this.release(n);
    }
  }
}

/** Counting semaphore (request concurrency). */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  readonly stats = { peak: 0 };

  constructor(readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      this.stats.peak = Math.max(this.stats.peak, this.active);
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/** Budget set of one engine: blob bytes (BlobPipeline) and hashing (Reconciler). */
export class Budget {
  readonly bytes: ByteBudget;
  readonly hashBytes: ByteBudget;
  readonly hashSlots: Semaphore;
  /** Concurrent blob uploads / downloads, engine-wide (design §3.15). */
  readonly uploadSlots: Semaphore;
  readonly downloadSlots: Semaphore;

  constructor(readonly limits: PlatformBudgets, maxFileBytes: () => number) {
    this.bytes = new ByteBudget(limits.inFlightBytes, maxFileBytes);
    this.hashBytes = new ByteBudget(limits.hashBytes, maxFileBytes);
    this.hashSlots = new Semaphore(limits.hashConcurrency);
    this.uploadSlots = new Semaphore(Math.max(1, limits.uploadConcurrency));
    this.downloadSlots = new Semaphore(Math.max(1, limits.downloadConcurrency));
  }

  async acquireHash(n: number): Promise<void> {
    await this.hashSlots.acquire();
    try {
      await this.hashBytes.acquire(n);
    } catch (e) {
      this.hashSlots.release();
      throw e;
    }
  }

  releaseHash(n: number): void {
    this.hashBytes.release(n);
    this.hashSlots.release();
  }
}
