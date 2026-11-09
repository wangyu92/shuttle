// Auth primitives (design §2.8.4): scrypt password hashes, device tokens, enroll codes, rate limits.
// AGPL-3.0-only.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { DEVICE_TOKEN_PREFIX, ENROLL_CODE_PREFIX } from "@shuttle/protocol";
import type { ScryptParams } from "./config";
import { sha256 } from "./util";

const KEY_LEN = 32;

function scryptAsync(pw: string, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  // maxmem must cover 128*N*r*p plus overhead; Node's default (32 MiB) is too small for N=2^15, r=8.
  const maxmem = 128 * p.N * p.r * p.p * 2 + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scryptCb(pw, salt, KEY_LEN, { N: p.N, r: p.r, p: p.p, maxmem }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

/** `scrypt$N$r$p$salt$hash` with b64u salt and hash (design §2.8.3 users.pw_hash). */
export async function hashPassword(pw: string, p: ScryptParams): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, p);
  return `scrypt$${p.N}$${p.r}$${p.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Parameters used when no user matches, so an unknown username costs the same time as a wrong password. */
export async function verifyPassword(pw: string, stored: string | null, fallback: ScryptParams): Promise<boolean> {
  const parts = stored?.split("$");
  if (!parts || parts.length !== 6 || parts[0] !== "scrypt") {
    await scryptAsync(pw, Buffer.alloc(16), fallback);
    return false;
  }
  const [, n, r, p, saltText, hashText] = parts as [string, string, string, string, string, string];
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((x) => Number.isSafeInteger(x) && x > 0) || params.N > 1 << 20) return false;
  const want = Buffer.from(hashText, "base64url");
  const got = await scryptAsync(pw, Buffer.from(saltText, "base64url"), params);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** `sxd_` + b64u(32 random bytes). */
export function newDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): Buffer {
  return sha256(token);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Enroll code: 100 random bits as 20 Crockford base32 characters in groups of 4, `SXE-XXXX-…`
 * (design §2.8.4 says 100 bits; its example shows only 16 characters, see report).
 */
export function newEnrollCode(): string {
  const bytes = randomBytes(13); // 104 bits, the top 100 are used
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits >>= 4n;
  let s = "";
  for (let i = 0; i < 20; i++) {
    s = CROCKFORD[Number(bits & 31n)]! + s;
    bits >>= 5n;
  }
  return ENROLL_CODE_PREFIX + s.match(/.{4}/g)!.join("-");
}

/** Canonical form of a typed code: prefix and hyphens dropped, Crockford aliases folded. Null if malformed. */
export function normalizeEnrollCode(code: string): string | null {
  let s = code.trim().toUpperCase();
  if (s.startsWith(ENROLL_CODE_PREFIX)) s = s.slice(ENROLL_CODE_PREFIX.length);
  s = s.replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== 20) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

export function enrollCodeHash(normalized: string): Buffer {
  return sha256(`${ENROLL_CODE_PREFIX}${normalized}`);
}

/** Sliding-window failure counter (login: 5 failures/min per IP and per username). */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number) {}

  /** ms until `key` may try again, or 0. */
  blockedFor(key: string): number {
    const t = this.now();
    const list = this.prune(key, t);
    if (list.length < this.max) return 0;
    return Math.max(1, list[0]! + this.windowMs - t);
  }

  fail(key: string): void {
    const t = this.now();
    const list = this.prune(key, t);
    list.push(t);
    this.hits.set(key, list);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private prune(key: string, t: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }
}

/** Token bucket per key (20 commits/s, 200 blob requests/s per device; burst = one second's worth). */
export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly ratePerSec: number, private readonly now: () => number) {}

  /** Takes one token; returns 0 on success or the ms until a token is available. */
  take(key: string): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.ratePerSec, at: t };
    b.tokens = Math.min(this.ratePerSec, b.tokens + ((t - b.at) / 1000) * this.ratePerSec);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil(((1 - b.tokens) / this.ratePerSec) * 1000));
  }

  /** Drops idle buckets (called from the maintenance tick). */
  sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > 60_000) this.buckets.delete(k);
  }
}
