// Error codes from design §4.13. Every failure the engine must branch on carries one of these codes.
export type CryptoErrorCode =
  | "WrongPassphrase"
  | "CorruptVaultInfo"
  | "TamperedVaultInfo"
  | "VaultInfoRollback"
  | "UnsupportedKdf"
  | "UpdateRequired"
  | "Locked"
  | "BlobIntegrity"
  | "RecordIntegrity"
  | "Replay"
  | "SelfTestFailed";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly detail: string | undefined;
  constructor(code: CryptoErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CryptoError";
    this.code = code;
    this.detail = detail;
  }
}

export function isCryptoError(e: unknown, code?: CryptoErrorCode): e is CryptoError {
  return e instanceof CryptoError && (code === undefined || e.code === code);
}
