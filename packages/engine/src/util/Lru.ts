// Small LRU map (design §3.1 util/Lru.ts). Insertion-ordered Map; get() refreshes recency.

export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new RangeError("Lru capacity must be >= 1");
  }
  get size(): number { return this.map.size; }
  has(k: K): boolean { return this.map.has(k); }
  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k) as V;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  delete(k: K): boolean { return this.map.delete(k); }
  clear(): void { this.map.clear(); }
}
