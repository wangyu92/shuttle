// Seeded PRNG for deterministic tests and the simulator (design §7). Not for cryptography.
// sfc32 state, seeded through splitmix32 so nearby seeds give unrelated streams.

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number | string = 1) {
    this.seed = typeof seed === "string" ? seedFromString(seed) : seed >>> 0;
    const sm = splitmix32(this.seed);
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.u32() / 0x100000000;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`int(n): n must be a positive integer, got ${n}`);
    if (n <= 0x100000000) {
      // Rejection sampling avoids modulo bias.
      const limit = Math.floor(0x100000000 / n) * n;
      let x = this.u32();
      while (x >= limit) x = this.u32();
      return x % n;
    }
    return Math.floor(this.float() * n);
  }

  /** Uniform integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  bool(p = 0.5): boolean {
    return this.float() < p;
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new RangeError("pick from an empty array");
    return xs[this.int(xs.length)] as T;
  }

  /** Fisher-Yates, returns a new array. */
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = out[i] as T;
      out[i] = out[j] as T;
      out[j] = t;
    }
    return out;
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 4) {
      let x = this.u32();
      for (let k = 0; k < 4 && i + k < n; k++) { out[i + k] = x & 0xff; x >>>= 8; }
    }
    return out;
  }

  /** `nBytes` random bytes as lowercase hex (e.g. hex(16) for a fileId). */
  hex(nBytes: number): string {
    let s = "";
    for (const b of this.bytes(nBytes)) s += b.toString(16).padStart(2, "0");
    return s;
  }

  /** `nBytes` random bytes as unpadded base64url (e.g. b64u(16) for a vaultId or pathKey). */
  b64u(nBytes: number): string {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const b = this.bytes(nBytes);
    let s = "";
    for (let i = 0; i < b.length; i += 3) {
      const x = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
      const chars = i + 2 < b.length ? 4 : i + 1 < b.length ? 3 : 2;
      for (let k = 0; k < chars; k++) s += A[(x >>> (18 - 6 * k)) & 63];
    }
    return s;
  }

  /** RFC 4122 v4 layout (deterministic, for cids in tests). */
  uuid(): string {
    const b = this.bytes(16);
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** An independent child stream (e.g. one per simulated device). */
  fork(label = ""): Prng {
    return new Prng((this.u32() ^ seedFromString(label)) >>> 0);
  }
}
