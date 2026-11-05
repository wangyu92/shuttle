// Vault-info shape (§2.2, §2.12). Kept structurally here until @shuttle/protocol owns it;
// the two must stay identical.
import type { Kdf } from "./kdf.js";

export type KeyStatus = "active" | "decrypt-only" | "retired";

export interface VaultKey {
  kv: number;
  status: KeyStatus;
  suite: "sx1";
  nonce: string;
  wrapped: string;
  check: string;
  createdAt: number;
}

export interface VaultParams {
  chunker: { alg: "fastcdc-k1"; min: number; avg: number; max: number };
  inlineMax: number;
  compression: "deflate-raw" | "none";
  padding: "none" | "padme";
  metaPadBucket: number;
}

export interface Retention {
  noteDays: number;
  attachmentDays: number;
  configDays: number;
  tombstoneDays: number;
  thinAfterHours?: number;
  thinBucketMinutes?: number;
}

/** Vault-info without its MAC (the MAC input, before canon). */
export interface UnsignedVaultInfo {
  format: "shuttle.vault-info";
  formatVersion: 1;
  vaultId: string;
  createdAt: number;
  infoRev: number;
  epoch: number;
  kdf: Kdf;
  keys: VaultKey[];
  activeKv: number;
  params: VaultParams;
  retention: Retention;
  requires: string[];
  unlockRequires: string[];
  features: string[];
  [k: string]: unknown;
}

export interface VaultInfo extends UnsignedVaultInfo {
  infoMac: string;
}

export interface Seen {
  epoch: number;
  infoRev: number;
  activeKv: number;
  maxSeq: number;
  maxEntryKey?: number | null;
}

/** Cached raw VMKs per kv, b64u (§4.10.1). */
export interface CachedSecrets {
  vaultId: string;
  kvs: Record<number, string>;
}

export const DEFAULT_PARAMS: VaultParams = {
  chunker: { alg: "fastcdc-k1", min: 262144, avg: 1048576, max: 4194304 },
  inlineMax: 4096,
  compression: "deflate-raw",
  padding: "none",
  metaPadBucket: 256,
};

export const DEFAULT_RETENTION: Retention = { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90, thinAfterHours: 24, thinBucketMinutes: 60 };
export const DEFAULT_FEATURES = ["history-v1", "archive-v1"];
