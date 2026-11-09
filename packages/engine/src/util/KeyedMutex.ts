// Per-key async mutex (design §3.4.2: one lock per fileId and one per foldKey; an action holds both).
// acquire() takes several keys at once in a fixed (sorted) order, so two callers asking for the same
// pair in different orders cannot deadlock. Locks are FIFO per key.

export type Unlock = () => void;

export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /** True while any holder or waiter exists for `key`. */
  isLocked(key: string): boolean {
    return this.tails.has(key);
  }

  async acquire(...keys: readonly string[]): Promise<Unlock> {
    const uniq = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];
    for (const k of uniq) releases.push(await this.lockOne(k));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (let i = releases.length - 1; i >= 0; i--) releases[i]!();
    };
  }

  private async lockOne(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
