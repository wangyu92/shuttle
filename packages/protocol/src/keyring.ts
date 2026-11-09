// Engine-facing Keyring contract (design §4.13). Types only.
// @shuttle/crypto's SxKeyring implements this; packages/testkit checks the assignment at compile time,
// so a drift between the two fails `npm run lint`.

import type { BlobId, FileId, PathKey, RecordKind, RetentionClass, Seq, UnsignedVaultInfo, VaultInfo } from "./types";

/** Record header bound into meta and inline AAD (design §4.6.3). */
export interface RecordHeader {
  fileId: FileId; kv: number; kind: RecordKind; base: Seq | null; rc: RetentionClass; blobs: BlobId[]; pathKey: PathKey;
}

export interface SealBlobOptions { compress: boolean; pad: boolean; chunkMax: number }

export interface Keyring {
  readonly vaultId: string;
  readonly activeKv: number;
  readonly kvs: readonly number[];
  /** NFC + toLowerCase inside (design §2.3). */
  pathKey(path: string): Promise<PathKey>;
  blobId(chunk: Uint8Array): Promise<{ blobId: BlobId; sha256: Uint8Array }>;
  gearTable(): Promise<Uint32Array>;
  sealBlob(chunk: Uint8Array, blobId: BlobId, o: SealBlobOptions): Promise<Uint8Array>;
  openBlob(sealed: Uint8Array, blobId: BlobId, expectedSize: number): Promise<Uint8Array>;
  sealMeta(meta: Record<string, unknown>, h: RecordHeader): Promise<string>;
  /** Also runs the pathKey consistency check. */
  openMeta(b64: string, h: RecordHeader): Promise<Record<string, unknown>>;
  sealInline(body: Uint8Array, h: RecordHeader, o: { compress: boolean; pad: boolean }): Promise<{ ct: string; z: boolean; p: boolean }>;
  openInline(b64: string, h: RecordHeader, z: boolean, p: boolean, expectedSize: number): Promise<Uint8Array>;
  macVaultInfo(info: UnsignedVaultInfo): Promise<string>;
  verifyVaultInfo(info: VaultInfo): Promise<boolean>;
  macManifest(m: object): Promise<string>;
}
