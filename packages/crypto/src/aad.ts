// The ONLY place AAD strings and MAC domain prefixes are built (design D11, §4.6).
// The engine never builds these; it passes headers and gets sealed bytes back.
import { b64u } from "./b64u.js";
import { utf8 } from "./bytes.js";
import { sha256 } from "./suite-sx1.js";

export const LABEL_WRAP = "shuttle/wrap/v1";
export const LABEL_BLOB = "shuttle/blob/v1";
export const LABEL_META = "shuttle/meta/v1";
export const LABEL_INLINE = "shuttle/inline/v1";
export const LABEL_PAIR = "shuttle/pair/v1";
/** HMAC input prefixes; each ends in a NUL byte. */
export const PREFIX_VAULT_INFO = "shuttle/vault-info/v1\0";
export const PREFIX_SNAPSHOT = "shuttle/snap/v1\0";
/** HMAC message for the per-kv key check (no NUL). */
export const KEY_CHECK_MESSAGE = "shuttle key check v1";

export type RecordKind = "put" | "del" | "archive";
export type RetentionClass = "note" | "attachment" | "config";

/** Record header bound into meta and inline AAD (§4.6.3). */
export interface RecordHeader {
  fileId: string;
  kv: number;
  kind: RecordKind;
  base: number | null;
  rc: RetentionClass;
  blobs: string[];
  pathKey: string;
}

const RE_HEX32 = /^[0-9a-f]{32}$/;
const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_B64U22 = /^[A-Za-z0-9_-]{22}$/;
const KINDS = new Set(["put", "del", "archive"]);
const RCS = new Set(["note", "attachment", "config"]);

export function isKv(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= 255;
}
export function isBlobId(s: unknown): s is string {
  return typeof s === "string" && RE_HEX64.test(s);
}
export function isVaultId(s: unknown): s is string {
  return typeof s === "string" && RE_B64U22.test(s);
}

/**
 * Header fields are validated before they enter an AAD string so that no field can contain
 * the `|` separator and every header maps to exactly one AAD.
 */
export function assertHeader(h: RecordHeader): void {
  const bad = (f: string) => {
    throw new Error(`invalid record header field: ${f}`);
  };
  if (typeof h.fileId !== "string" || !RE_HEX32.test(h.fileId)) bad("fileId");
  if (!isKv(h.kv)) bad("kv");
  if (!KINDS.has(h.kind)) bad("kind");
  if (h.base !== null && !(Number.isSafeInteger(h.base) && h.base >= 0)) bad("base");
  if (!RCS.has(h.rc)) bad("rc");
  if (!Array.isArray(h.blobs) || !h.blobs.every(isBlobId)) bad("blobs");
  if (typeof h.pathKey !== "string" || !RE_B64U22.test(h.pathKey)) bad("pathKey");
}

export function wrapAad(vaultId: string, kv: number): string {
  return `${LABEL_WRAP}|${vaultId}|${kv}`;
}

export function blobAad(vaultId: string, blobId: string): string {
  return `${LABEL_BLOB}|${vaultId}|${blobId}`;
}

/** b64u(SHA-256(UTF-8(blobs.join(",")))); [] hashes the empty string. */
export async function blobsDigest(blobs: readonly string[]): Promise<string> {
  return b64u(await sha256(utf8(blobs.join(","))));
}

/** label|vaultId|fileId|kv|kind|(base ?? "-")|rc|blobsDigest|pathKey */
export async function recordAad(label: typeof LABEL_META | typeof LABEL_INLINE, vaultId: string, h: RecordHeader): Promise<string> {
  assertHeader(h);
  return [label, vaultId, h.fileId, String(h.kv), h.kind, h.base === null ? "-" : String(h.base), h.rc, await blobsDigest(h.blobs), h.pathKey].join("|");
}

export function pairAad(vaultId: string, pairIdB64u: string): string {
  return `${LABEL_PAIR}|${vaultId}|${pairIdB64u}`;
}
