// FakeKeyring: a deterministic, fast stand-in for SxKeyring that implements the protocol Keyring
// contract (design §4.13). Use it in FakeRemote worlds (engine, sim, 10k-file tests) where real
// AES-GCM and HKDF would dominate the run time. NOT encryption: plaintext is stored next to a keyed
// SHA-256 tag. The real-server e2e tests keep SxKeyring.
//
// What it keeps from the real keyring, so engine paths behave the same:
//  - pathKey: 16 bytes b64u (22 chars), NFC + lower case inside, keyed by the vault and secret;
//  - blobId: lowercase hex64, keyed, over the raw chunk; openBlob re-derives it (BlobIntegrity);
//  - meta/inline are bound to the record header (fileId, kv, kind, base, rc, blobs, pathKey): a
//    changed header or body fails with CryptoError('RecordIntegrity'); sealMeta enforces kv ==
//    activeKv and pathKey(meta.path) == header.pathKey like the real one;
//  - an unknown kv fails (BlobIntegrity / RecordIntegrity), so key-version tests still work;
//  - vault-info and manifest MACs are b64u of 32 bytes over canon(info - infoMac).
// Two FakeKeyrings open each other's data only when vaultId, secret and the kv set agree.

import { CryptoError, b64u, canon, fromB64u } from "@shuttle/crypto";
import type { Keyring, RecordHeader, SealBlobOptions, UnsignedVaultInfo, VaultInfo } from "@shuttle/protocol";
import { Prng } from "./prng";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const BLOB_MAGIC = [0x46, 0x4b, 0x42, 0x31]; // "FKB1"
const TAG = 16;

export interface FakeKeyringOptions {
  vaultId: string;
  /** Key versions held (default [1]). */
  kvs?: readonly number[];
  /** Active kv (default: the highest of `kvs`). */
  activeKv?: number;
  /** Stands in for the VMKs: keyrings with different secrets cannot open each other's data. */
  secret?: string;
}

async function sha256(...parts: Array<Uint8Array | string>): Promise<Uint8Array> {
  let n = 0;
  const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  for (const b of bufs) n += b.length + 4;
  const all = new Uint8Array(n);
  let off = 0;
  for (const b of bufs) {
    // length-prefixed, so ("ab","c") and ("a","bc") differ
    all[off] = (b.length >>> 24) & 255; all[off + 1] = (b.length >>> 16) & 255; all[off + 2] = (b.length >>> 8) & 255; all[off + 3] = b.length & 255;
    all.set(b, off + 4);
    off += b.length + 4;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", all));
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

function headerCanon(h: RecordHeader): string {
  return canon({ fileId: h.fileId, kv: h.kv, kind: h.kind, base: h.base, rc: h.rc, blobs: [...h.blobs], pathKey: h.pathKey });
}

function without(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const { [k]: _drop, ...rest } = o;
  return rest;
}

export class FakeKeyring implements Keyring {
  readonly vaultId: string;
  readonly activeKv: number;
  readonly kvs: readonly number[];
  private readonly secret: string;
  private gear: Uint32Array | null = null;
  /** Calls per method (performance assertions). */
  readonly stats = { seals: 0, opens: 0 };

  constructor(o: FakeKeyringOptions) {
    this.vaultId = o.vaultId;
    const kvs = [...new Set(o.kvs ?? [1])].sort((a, b) => a - b);
    if (kvs.length === 0) throw new Error("FakeKeyring needs at least one kv");
    this.kvs = Object.freeze(kvs);
    this.activeKv = o.activeKv ?? (kvs[kvs.length - 1] as number);
    if (!kvs.includes(this.activeKv)) throw new CryptoError("Locked", `no key for activeKv ${this.activeKv}`);
    this.secret = o.secret ?? "fake-secret";
  }

  /** The same keys with another active kv (rotation tests). */
  withKeys(kvs: readonly number[], activeKv?: number): FakeKeyring {
    return new FakeKeyring({ vaultId: this.vaultId, kvs, secret: this.secret, ...(activeKv !== undefined ? { activeKv } : {}) });
  }

  private key(kv: number, err: "BlobIntegrity" | "RecordIntegrity" | "Locked"): string {
    if (!this.kvs.includes(kv)) throw new CryptoError(err, `key version ${kv} not in keyring`);
    return `${this.secret}|${this.vaultId}|kv${kv}`;
  }

  async pathKey(path: string): Promise<string> {
    const d = await sha256("pathkey", this.secret, this.vaultId, path.normalize("NFC").toLowerCase());
    return b64u(d.subarray(0, 16));
  }

  async blobId(chunk: Uint8Array): Promise<{ blobId: string; sha256: Uint8Array }> {
    const s = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", chunk as Uint8Array<ArrayBuffer>));
    const id = await sha256("blobid", this.secret, this.vaultId, s);
    return { blobId: hex(id), sha256: s };
  }

  async gearTable(): Promise<Uint32Array> {
    if (!this.gear) {
      const r = new Prng(`gear|${this.secret}|${this.vaultId}`);
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) t[i] = r.u32();
      this.gear = t;
    }
    return this.gear.slice();
  }

  async sealBlob(chunk: Uint8Array, blobId: string, _o: SealBlobOptions): Promise<Uint8Array> {
    this.stats.seals++;
    this.key(this.activeKv, "Locked");
    const id = fromHex(blobId);
    const out = new Uint8Array(4 + 1 + 32 + chunk.length);
    out.set(BLOB_MAGIC, 0);
    out[4] = this.activeKv;
    out.set(id, 5);
    out.set(chunk, 37);
    return out;
  }

  async openBlob(sealed: Uint8Array, blobId: string, expectedSize: number): Promise<Uint8Array> {
    this.stats.opens++;
    if (sealed.length < 37 || BLOB_MAGIC.some((b, i) => sealed[i] !== b)) throw new CryptoError("BlobIntegrity", "not a fake blob");
    this.key(sealed[4] as number, "BlobIntegrity");
    if (hex(sealed.subarray(5, 37)) !== blobId) throw new CryptoError("BlobIntegrity", "blobId mismatch");
    const body = sealed.slice(37);
    if (body.length !== expectedSize) throw new CryptoError("BlobIntegrity", "size mismatch");
    if ((await this.blobId(body)).blobId !== blobId) throw new CryptoError("BlobIntegrity", "blobId mismatch");
    return body;
  }

  async sealMeta(meta: Record<string, unknown>, h: RecordHeader): Promise<string> {
    this.stats.seals++;
    if (h.kv !== this.activeKv) throw new Error(`record kv ${h.kv} is not the active kv ${this.activeKv}`);
    const p = meta.path;
    if (typeof p !== "string" || p !== p.normalize("NFC")) throw new Error("sealMeta: meta.path must be an NFC string");
    if ((await this.pathKey(p)) !== h.pathKey) throw new Error("sealMeta: pathKey(meta.path) does not match the record header");
    const body = enc.encode(canon(meta));
    const tag = await sha256("meta", this.key(h.kv, "Locked"), headerCanon(h), body);
    return b64u(concat(tag.subarray(0, TAG), body));
  }

  async openMeta(b64: string, h: RecordHeader): Promise<Record<string, unknown>> {
    this.stats.opens++;
    const k = this.key(h.kv, "RecordIntegrity");
    const raw = decodeB64u(b64, "RecordIntegrity");
    if (raw.length < TAG) throw new CryptoError("RecordIntegrity", "meta too short");
    const body = raw.subarray(TAG);
    const tag = await sha256("meta", k, headerCanon(h), body);
    if (!eq(tag.subarray(0, TAG), raw.subarray(0, TAG))) throw new CryptoError("RecordIntegrity", "meta does not open");
    try {
      const m = JSON.parse(dec.decode(body)) as unknown;
      if (typeof m !== "object" || m === null || Array.isArray(m)) throw new Error("not an object");
      return m as Record<string, unknown>;
    } catch {
      throw new CryptoError("RecordIntegrity", "meta is not JSON");
    }
  }

  async sealInline(body: Uint8Array, h: RecordHeader, _o: { compress: boolean; pad: boolean }): Promise<{ ct: string; z: boolean; p: boolean }> {
    this.stats.seals++;
    if (h.kv !== this.activeKv) throw new Error(`record kv ${h.kv} is not the active kv ${this.activeKv}`);
    const tag = await sha256("inline", this.key(h.kv, "Locked"), headerCanon(h), body);
    return { ct: b64u(concat(tag.subarray(0, TAG), body)), z: false, p: false };
  }

  async openInline(b64: string, h: RecordHeader, z: boolean, p: boolean, expectedSize: number): Promise<Uint8Array> {
    this.stats.opens++;
    const k = this.key(h.kv, "RecordIntegrity");
    if (z || p) throw new CryptoError("RecordIntegrity", "fake inline is never compressed or padded");
    const raw = decodeB64u(b64, "RecordIntegrity");
    if (raw.length < TAG) throw new CryptoError("RecordIntegrity", "inline too short");
    const body = raw.slice(TAG);
    const tag = await sha256("inline", k, headerCanon(h), body);
    if (!eq(tag.subarray(0, TAG), raw.subarray(0, TAG))) throw new CryptoError("RecordIntegrity", "inline does not open");
    if (body.length !== expectedSize) throw new CryptoError("RecordIntegrity", "inline size mismatch");
    return body;
  }

  async macVaultInfo(info: UnsignedVaultInfo): Promise<string> {
    const body = canon(without(info as unknown as Record<string, unknown>, "infoMac"));
    return b64u(await sha256("vault-info", this.key(info.activeKv, "Locked"), body));
  }

  async verifyVaultInfo(info: VaultInfo): Promise<boolean> {
    if (!this.kvs.includes(info.activeKv) || typeof info.infoMac !== "string") return false;
    try {
      return (await this.macVaultInfo(info as unknown as UnsignedVaultInfo)) === info.infoMac;
    } catch {
      return false;
    }
  }

  async macManifest(m: object): Promise<string> {
    const kv = (m as { kv?: unknown }).kv;
    if (kv !== this.activeKv) throw new Error(`manifest kv ${String(kv)} is not the active kv ${this.activeKv}`);
    const body = canon(without(m as Record<string, unknown>, "mac"));
    return b64u(await sha256("manifest", this.key(this.activeKv, "Locked"), body));
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function fromHex(s: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("blobId must be lowercase hex64");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeB64u(s: string, err: "RecordIntegrity"): Uint8Array {
  try {
    return fromB64u(s);
  } catch {
    throw new CryptoError(err, "bad b64u");
  }
}
