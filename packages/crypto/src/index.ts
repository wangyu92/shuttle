// @shuttle/crypto: suite sx1 on SubtleCrypto (design §4). No Node or Obsidian imports.
export const PACKAGE_NAME = "@shuttle/crypto";

export { CryptoError, type CryptoErrorCode, isCryptoError } from "./errors.js";
export { b64u, fromB64u } from "./b64u.js";
export { fromHex, toHex } from "./bytes.js";
export { canon, canonLoose } from "./canon.js";
export { blobsDigest, type RecordHeader, type RecordKind, type RetentionClass } from "./aad.js";
export { padme, padmeTarget, metaPadLen } from "./pad.js";
export { type Kdf, PBKDF2_DEFAULT_ITER, PBKDF2_MIN_ITER, validateKdf } from "./kdf.js";
export { newFileId, sha256hex } from "./ids.js";
export { BLOB_OVERHEAD, MAX_BLOB_SIZE } from "./envelope.js";
export { HKDF_LABELS, type Keyring, type KeyringOptions, SxKeyring } from "./keyring.js";
export type { CachedSecrets, Retention, Seen, UnsignedVaultInfo, VaultInfo, VaultKey, VaultParams } from "./types.js";
export {
  changePassphrase,
  checkNotRolledBack,
  checkRecordFreshness,
  createVault,
  fromCache,
  markRebuild,
  rotateKey,
  type Unlocked,
  unlock,
} from "./vault-info.js";
export { selfTest, type SelfTestReport } from "./selftest.js";
