// Keyring (§4.3, §4.13): non-extractable subkeys per kv plus the VMK_1 identifier keys.
import { assertHeader, KEY_CHECK_MESSAGE, PREFIX_SNAPSHOT, PREFIX_VAULT_INFO, type RecordHeader } from "./aad.js";
import { b64u, fromB64u, fromB64uLen } from "./b64u.js";
import { type Bytes, concat, ctEqual, utf8 } from "./bytes.js";
import { canon, without } from "./canon.js";
import {
  openBlobBody,
  openInlineRaw,
  openMetaRaw,
  parseBlobHeader,
  type SealBlobOptions,
  sealBlobRaw,
  sealInlineRaw,
  sealMetaRaw,
} from "./envelope.js";
import { CryptoError } from "./errors.js";
import { deriveBlobId, derivePathKey, deriveReservedFileId } from "./ids.js";
import { hkdfAesKey, hkdfBits, hkdfHmacKey, hmacSign, hmacVerify, importHkdfBase } from "./suite-sx1.js";
import type { UnsignedVaultInfo, VaultInfo } from "./types.js";

/** HKDF info labels (§4.3). */
export const HKDF_LABELS = {
  content: "shuttle/v1/content",
  meta: "shuttle/v1/meta",
  check: "shuttle/v1/check",
  info: "shuttle/v1/info",
  pathkey: "shuttle/v1/pathkey",
  blobid: "shuttle/v1/blobid",
  cdcGear: "shuttle/v1/cdc-gear",
  fileid: "shuttle/v1/fileid",
} as const;

export const GEAR_TABLE_BYTES = 1024;

interface KvKeys {
  content: CryptoKey;
  meta: CryptoKey;
  check: CryptoKey;
  info: CryptoKey;
}

export interface KeyringOptions {
  metaPadBucket?: number;
  /** Called for non-fatal findings, e.g. the pathKey consistency warning of §4.6.3. */
  onWarning?: (msg: string, detail: Record<string, unknown>) => void;
}

export interface Keyring {
  readonly vaultId: string;
  readonly activeKv: number;
  readonly kvs: readonly number[];
  pathKey(path: string): Promise<string>;
  blobId(chunk: Uint8Array): Promise<{ blobId: string; sha256: Uint8Array }>;
  gearTable(): Promise<Uint32Array>;
  sealBlob(chunk: Uint8Array, blobId: string, o: SealBlobOptions): Promise<Uint8Array>;
  openBlob(sealed: Uint8Array, blobId: string, expectedSize: number): Promise<Uint8Array>;
  sealMeta(meta: Record<string, unknown>, h: RecordHeader): Promise<string>;
  openMeta(b64: string, h: RecordHeader): Promise<Record<string, unknown>>;
  sealInline(body: Uint8Array, h: RecordHeader, o: { compress: boolean; pad: boolean }): Promise<{ ct: string; z: boolean; p: boolean }>;
  openInline(b64: string, h: RecordHeader, z: boolean, p: boolean, expectedSize: number): Promise<Uint8Array>;
  macVaultInfo(info: UnsignedVaultInfo): Promise<string>;
  verifyVaultInfo(info: VaultInfo): Promise<boolean>;
  macManifest(m: object): Promise<string>;
  verifyManifest(m: { mac?: unknown; kv?: unknown; [k: string]: unknown }): Promise<boolean>;
  keyCheck(kv: number): Promise<string>;
  verifyCheck(kv: number, check: string): Promise<boolean>;
}

export class SxKeyring implements Keyring {
  readonly kvs: readonly number[];
  private gear: Promise<Uint32Array> | null = null;

  private constructor(
    readonly vaultId: string,
    readonly activeKv: number,
    private readonly perKv: Map<number, KvKeys>,
    private readonly kPathkey: CryptoKey,
    private readonly kBlobid: CryptoKey,
    private readonly kFileid: CryptoKey,
    private readonly vmk1Base: CryptoKey,
    private readonly salt: Bytes,
    private readonly metaPadBucket: number,
    private readonly onWarning: KeyringOptions["onWarning"],
  ) {
    this.kvs = Object.freeze([...perKv.keys()].sort((a, b) => a - b));
  }

  /**
   * Imports raw VMKs (32 bytes each) as non-extractable HKDF base keys and derives all subkeys.
   * The input arrays are zeroed afterwards (best effort, §4.3).
   */
  static async fromVmks(vaultId: string, vmks: Map<number, Uint8Array>, activeKv: number, o: KeyringOptions = {}): Promise<SxKeyring> {
    const salt = fromB64uLen(vaultId, 16);
    if (!vmks.has(activeKv)) throw new CryptoError("Locked", `no key for activeKv ${activeKv}`);
    if (!vmks.has(1)) throw new CryptoError("Locked", "identifier keys need VMK_1");
    const perKv = new Map<number, KvKeys>();
    let vmk1Base: CryptoKey | null = null;
    for (const [kv, raw] of vmks) {
      if (raw.length !== 32) throw new CryptoError("CorruptVaultInfo", `VMK ${kv} is not 32 bytes`);
      const base = await importHkdfBase(raw);
      raw.fill(0);
      if (kv === 1) vmk1Base = base;
      perKv.set(kv, {
        content: await hkdfAesKey(base, salt, HKDF_LABELS.content),
        meta: await hkdfAesKey(base, salt, HKDF_LABELS.meta),
        check: await hkdfHmacKey(base, salt, HKDF_LABELS.check),
        info: await hkdfHmacKey(base, salt, HKDF_LABELS.info),
      });
    }
    const b1 = vmk1Base as CryptoKey;
    return new SxKeyring(
      vaultId,
      activeKv,
      perKv,
      await hkdfHmacKey(b1, salt, HKDF_LABELS.pathkey),
      await hkdfHmacKey(b1, salt, HKDF_LABELS.blobid),
      await hkdfHmacKey(b1, salt, HKDF_LABELS.fileid),
      b1,
      salt,
      o.metaPadBucket ?? 256,
      o.onWarning,
    );
  }

  private keys(kv: number, err: "BlobIntegrity" | "RecordIntegrity" | "Locked"): KvKeys {
    const k = this.perKv.get(kv);
    if (!k) throw new CryptoError(err, `key version ${kv} not in keyring`);
    return k;
  }

  private active(): KvKeys {
    return this.keys(this.activeKv, "Locked");
  }

  pathKey(path: string): Promise<string> {
    return derivePathKey(this.kPathkey, path);
  }

  blobId(chunk: Uint8Array): Promise<{ blobId: string; sha256: Uint8Array }> {
    return deriveBlobId(this.kBlobid, chunk);
  }

  /** RESERVED, unused in v1 (fileIds are random). Exposed for the known-answer tests only. */
  reservedFileId(path: string): Promise<string> {
    return deriveReservedFileId(this.kFileid, path);
  }

  /** 256 x u32 big-endian from HKDF(VMK_1, "shuttle/v1/cdc-gear", 1024). */
  gearTable(): Promise<Uint32Array> {
    this.gear ??= hkdfBits(this.vmk1Base, this.salt, HKDF_LABELS.cdcGear, GEAR_TABLE_BYTES).then((b) => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) t[i] = dv.getUint32(i * 4, false);
      b.fill(0);
      return t;
    });
    return this.gear.then((t) => t.slice());
  }

  async sealBlob(chunk: Uint8Array, blobId: string, o: SealBlobOptions): Promise<Uint8Array> {
    return sealBlobRaw(this.active().content, this.activeKv, this.vaultId, chunk, blobId, o);
  }

  async openBlob(sealed: Uint8Array, blobId: string, expectedSize: number): Promise<Uint8Array> {
    const { kv, flags, nonce, ct } = parseBlobHeader(sealed);
    const keys = this.keys(kv, "BlobIntegrity");
    const chunk = await openBlobBody(keys.content, this.vaultId, blobId, flags, nonce, ct, expectedSize);
    const re = await this.blobId(chunk);
    if (re.blobId !== blobId) throw new CryptoError("BlobIntegrity", "blobId mismatch");
    return chunk;
  }

  private assertWriteKv(h: RecordHeader): KvKeys {
    if (h.kv !== this.activeKv) throw new Error(`record kv ${h.kv} is not the active kv ${this.activeKv}`);
    return this.active();
  }

  async sealMeta(meta: Record<string, unknown>, h: RecordHeader): Promise<string> {
    const keys = this.assertWriteKv(h);
    assertHeader(h);
    // §2.3 / D11: meta.path is stored NFC and must be the path the header's pathKey was derived from.
    const p = meta.path;
    if (typeof p !== "string" || p !== p.normalize("NFC")) throw new Error("sealMeta: meta.path must be an NFC string");
    if ((await this.pathKey(p)) !== h.pathKey) throw new Error("sealMeta: pathKey(meta.path) does not match the record header");
    return sealMetaRaw(keys.meta, this.vaultId, h, meta, this.metaPadBucket);
  }

  async openMeta(b64: string, h: RecordHeader): Promise<Record<string, unknown>> {
    const m = await openMetaRaw(this.keys(h.kv, "RecordIntegrity").meta, this.vaultId, h, b64);
    const pk = await this.pathKey(m.path as string);
    if (pk !== h.pathKey) this.onWarning?.("pathKey mismatch: using meta.path", { fileId: h.fileId, recordPathKey: h.pathKey, computed: pk });
    return m;
  }

  async sealInline(body: Uint8Array, h: RecordHeader, o: { compress: boolean; pad: boolean }): Promise<{ ct: string; z: boolean; p: boolean }> {
    return sealInlineRaw(this.assertWriteKv(h).content, this.vaultId, h, body, o);
  }

  async openInline(b64: string, h: RecordHeader, z: boolean, p: boolean, expectedSize: number): Promise<Uint8Array> {
    return openInlineRaw(this.keys(h.kv, "RecordIntegrity").content, this.vaultId, h, b64, z, p, expectedSize);
  }

  private infoKey(kv: number): CryptoKey {
    return this.keys(kv, "Locked").info;
  }

  /** b64u(HMAC(K_info(activeKv of the info), "shuttle/vault-info/v1\0" || canon(info - infoMac))). */
  async macVaultInfo(info: UnsignedVaultInfo): Promise<string> {
    const body = canon(without(info as Record<string, unknown>, "infoMac"));
    return b64u(await hmacSign(this.infoKey(info.activeKv), concat(utf8(PREFIX_VAULT_INFO), utf8(body))));
  }

  async verifyVaultInfo(info: VaultInfo): Promise<boolean> {
    if (!this.perKv.has(info.activeKv)) return false;
    let mac: Uint8Array;
    let body: string;
    try {
      mac = fromB64uLen(info.infoMac, 32);
      body = canon(without(info as Record<string, unknown>, "infoMac"));
    } catch {
      return false;
    }
    return hmacVerify(this.infoKey(info.activeKv), mac, concat(utf8(PREFIX_VAULT_INFO), utf8(body)));
  }

  /**
   * S3 snapshot manifest MAC (§4.9.3). The manifest carries `kv` inside the MAC'd body and is signed
   * with K_info(m.kv), which must be this keyring's activeKv, so manifests written before a rotation
   * still verify afterwards.
   */
  async macManifest(m: object): Promise<string> {
    const kv = (m as { kv?: unknown }).kv;
    if (kv !== this.activeKv) throw new Error(`manifest kv ${String(kv)} is not the active kv ${this.activeKv}`);
    const body = canon(without(m as Record<string, unknown>, "mac"));
    return b64u(await hmacSign(this.infoKey(this.activeKv), concat(utf8(PREFIX_SNAPSHOT), utf8(body))));
  }

  /** Verifies with K_info(m.kv); a kv this keyring does not hold (unknown or retired) fails. */
  async verifyManifest(m: { mac?: unknown; kv?: unknown; [k: string]: unknown }): Promise<boolean> {
    const kv = m.kv;
    if (typeof kv !== "number" || !Number.isSafeInteger(kv) || !this.perKv.has(kv)) return false;
    let mac: Uint8Array;
    let body: string;
    try {
      mac = fromB64uLen(m.mac, 32);
      body = canon(without(m as Record<string, unknown>, "mac"));
    } catch {
      return false;
    }
    return hmacVerify(this.infoKey(kv), mac, concat(utf8(PREFIX_SNAPSHOT), utf8(body)));
  }

  /** check = b64u(HMAC(K_check(kv), "shuttle key check v1")[0..16]). */
  async keyCheck(kv: number): Promise<string> {
    return b64u((await hmacSign(this.keys(kv, "Locked").check, utf8(KEY_CHECK_MESSAGE))).subarray(0, 16));
  }

  /**
   * subtle.verify cannot check a truncated tag, so the full HMAC is computed and its first
   * 16 bytes are compared in constant time (deviation from the §4.5.3 step 6 wording).
   */
  async verifyCheck(kv: number, check: string): Promise<boolean> {
    let want: Uint8Array;
    try {
      want = fromB64u(check);
    } catch {
      return false;
    }
    if (want.length !== 16 || !this.perKv.has(kv)) return false;
    const full = await hmacSign(this.keys(kv, "Locked").check, utf8(KEY_CHECK_MESSAGE));
    return ctEqual(full.subarray(0, 16), want);
  }
}

