// Vault lifecycle (§4.5.3, §4.11): create, unlock, unlock from cache, passphrase change,
// rotation, rebuild, rollback and replay checks.
import { isKv, isVaultId } from "./aad.js";
import { b64u, fromB64u, fromB64uLen } from "./b64u.js";
import { CryptoError } from "./errors.js";
import { unwrapVmk, wrapVmk } from "./envelope.js";
import { newVaultId } from "./ids.js";
import { assertNewPassphrase, deriveKek, type Kdf, PBKDF2_DEFAULT_ITER, SALT_LEN, validateKdf } from "./kdf.js";
import { type KeyringOptions, SxKeyring } from "./keyring.js";
import { randomBytes } from "./rng.js";
import { type CachedSecrets, DEFAULT_FEATURES, DEFAULT_PARAMS, DEFAULT_RETENTION, type Seen, type UnsignedVaultInfo, type VaultInfo, type VaultKey, type VaultParams } from "./types.js";

/** Feature strings this build understands (v1 knows none yet). */
export const KNOWN_REQUIRES: ReadonlySet<string> = new Set<string>();
export const KNOWN_UNLOCK_REQUIRES: ReadonlySet<string> = new Set<string>();

export type UnlockOptions = KeyringOptions;

export interface Unlocked {
  ring: SxKeyring;
  cache: CachedSecrets;
  /** §4.5.3 step 9: unknown `requires` -> open read-only (pull-only). */
  pullOnly: boolean;
}

const isInt = (v: unknown, lo = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo;

/** §4.5.3 step 1 (format, version, vaultId) plus the shape the later steps rely on. */
export function validateShape(info: VaultInfo): void {
  const bad = (why: string) => {
    throw new CryptoError("CorruptVaultInfo", why);
  };
  if (typeof info !== "object" || info === null) bad("not an object");
  if (info.format !== "shuttle.vault-info") bad("format");
  if (info.formatVersion !== 1) bad("formatVersion");
  if (!isVaultId(info.vaultId)) bad("vaultId");
  try {
    fromB64uLen(info.vaultId, 16);
  } catch {
    bad("vaultId");
  }
  if (!isInt(info.infoRev, 1) || !isInt(info.epoch, 1) || !isKv(info.activeKv)) bad("infoRev, epoch or activeKv");
  if (!Array.isArray(info.keys) || info.keys.length === 0) bad("keys");
  const seen = new Set<number>();
  for (const k of info.keys) {
    if (!isKv(k?.kv) || seen.has(k.kv)) bad("keys[].kv");
    seen.add(k.kv);
    if (k.suite !== "sx1") bad("keys[].suite");
    if (!["active", "decrypt-only", "retired"].includes(k.status)) bad("keys[].status");
    try {
      fromB64uLen(k.nonce, 12);
      fromB64uLen(k.wrapped, 48);
      fromB64uLen(k.check, 16);
    } catch {
      bad(`keys[${k.kv}] encoding`);
    }
  }
  if (!seen.has(info.activeKv)) bad("activeKv not in keys");
  if (!seen.has(1)) bad("VMK_1 missing (identifier keys)");
  if (!Array.isArray(info.requires) || !Array.isArray(info.unlockRequires)) bad("requires");
  const b = info.params?.metaPadBucket;
  if (!isInt(b, 16) || b > 65536) bad("params.metaPadBucket");
}

/** §4.5.3 step 8. */
export function checkNotRolledBack(info: VaultInfo, seen: Seen | null): void {
  if (!seen) return;
  if (info.infoRev < seen.infoRev || info.epoch < seen.epoch || info.activeKv < seen.activeKv) {
    throw new CryptoError("VaultInfoRollback", `seen infoRev ${seen.infoRev}/epoch ${seen.epoch}/kv ${seen.activeKv}, got ${info.infoRev}/${info.epoch}/${info.activeKv}`);
  }
}

/** §4.9.1 per-record replay checks (same epoch). Throws Replay; returns "ignore" for already-applied seqs. */
export function checkRecordFreshness(r: { seq: number; base: number | null; kind: string }, known: { seq: number } | null): "apply" | "ignore" {
  if (known && r.seq <= known.seq) return "ignore";
  if (r.kind === "archive") {
    // History record: only require r.base <= current head of F (§4.9.1).
    if (known && (r.base === null || r.base > known.seq)) throw new CryptoError("Replay", "archive base beyond current head");
    return "apply";
  }
  if (known) {
    if (r.base === null) throw new CryptoError("Replay", "create over existing head");
    if (r.base < known.seq) throw new CryptoError("Replay", "stale base");
  }
  return "apply";
}

function ringOpts(info: VaultInfo, o: KeyringOptions): KeyringOptions {
  return { ...o, metaPadBucket: info.params.metaPadBucket };
}

function encodeCache(vaultId: string, vmks: Map<number, Uint8Array>): CachedSecrets {
  const kvs: Record<number, string> = {};
  for (const [kv, raw] of vmks) kvs[kv] = b64u(raw);
  return { vaultId, kvs };
}

async function finishValidation(info: VaultInfo, ring: SxKeyring, kvs: Iterable<number>, seen: Seen | null): Promise<boolean> {
  // Step 6: key check per kv.
  for (const kv of kvs) {
    const k = info.keys.find((x) => x.kv === kv) as VaultKey;
    if (!(await ring.verifyCheck(kv, k.check))) throw new CryptoError("CorruptVaultInfo", `key check failed for kv ${kv}`);
  }
  // Step 7: infoMac.
  if (!(await ring.verifyVaultInfo(info))) throw new CryptoError("TamperedVaultInfo");
  // Step 8: rollback.
  checkNotRolledBack(info, seen);
  // Step 9: unknown write requirements -> pull-only.
  return info.requires.some((r) => !KNOWN_REQUIRES.has(r));
}

/** §4.5.3 steps 1-9 with the passphrase. The caller persists `cache` and `seen` (step 10). */
export function unlock(pass: string, info: VaultInfo, seen: Seen | null, o: UnlockOptions = {}): Promise<Unlocked> {
  return unlockWithKdfFloor(pass, info, seen, o, undefined);
}

/**
 * INTERNAL (not re-exported from index.ts): `minIter` lowers the PBKDF2 floor so the iter-1000
 * known-answer vectors can be unlocked by selfTest and the tests. Production callers use unlock().
 */
export async function unlockWithKdfFloor(pass: string, info: VaultInfo, seen: Seen | null, o: UnlockOptions, minIter: number | undefined): Promise<Unlocked> {
  validateShape(info);
  for (const r of info.unlockRequires) if (!KNOWN_UNLOCK_REQUIRES.has(r)) throw new CryptoError("UpdateRequired", `unlock requires ${r}`);
  validateKdf(info.kdf, minIter);
  const kek = await deriveKek(info.kdf, pass);
  const vmks = new Map<number, Uint8Array>();
  const ordered = [...info.keys].sort((a, b) => (a.kv === info.activeKv ? -1 : b.kv === info.activeKv ? 1 : a.kv - b.kv));
  for (const k of ordered) {
    try {
      vmks.set(k.kv, await unwrapVmk(kek, info.vaultId, k.kv, k.nonce, k.wrapped));
    } catch {
      if (k.kv === info.activeKv) throw new CryptoError("WrongPassphrase");
      throw new CryptoError("CorruptVaultInfo", `unwrap failed for kv ${k.kv}`);
    }
  }
  const cache = encodeCache(info.vaultId, vmks);
  const kvs = [...vmks.keys()];
  const ring = await SxKeyring.fromVmks(info.vaultId, vmks, info.activeKv, ringOpts(info, o)); // zeroes vmks
  const pullOnly = await finishValidation(info, ring, kvs, seen);
  return { ring, cache, pullOnly };
}

/** §4.5.3 "From cache": skip 2-5, run 6-9 against the cached VMKs. Throws Locked when activeKv is not cached. */
export async function fromCache(cache: CachedSecrets, info: VaultInfo, seen: Seen | null, o: KeyringOptions = {}): Promise<{ ring: SxKeyring; pullOnly: boolean }> {
  validateShape(info);
  if (cache.vaultId !== info.vaultId) throw new CryptoError("Locked", "cache belongs to another vault");
  const vmks = new Map<number, Uint8Array>();
  for (const k of info.keys) {
    const v = cache.kvs[k.kv];
    if (v === undefined) continue;
    try {
      vmks.set(k.kv, fromB64uLen(v, 32));
    } catch {
      throw new CryptoError("Locked", `cached key ${k.kv} unreadable`);
    }
  }
  if (!vmks.has(info.activeKv)) throw new CryptoError("Locked", `activeKv ${info.activeKv} not cached`);
  const kvs = [...vmks.keys()];
  const ring = await SxKeyring.fromVmks(info.vaultId, vmks, info.activeKv, ringOpts(info, o));
  const pullOnly = await finishValidation(info, ring, kvs, seen);
  return { ring, pullOnly };
}

function newKdf(partial?: Partial<Kdf>): Kdf {
  const alg = partial?.alg ?? "PBKDF2-SHA256";
  if (alg !== "PBKDF2-SHA256") throw new CryptoError("UpdateRequired", `kdf ${alg} not supported by this build`);
  const iter = (partial as { iter?: number } | undefined)?.iter ?? PBKDF2_DEFAULT_ITER;
  const kdf: Kdf = { alg, iter, salt: b64u(randomBytes(SALT_LEN)) };
  validateKdf(kdf);
  return kdf;
}

async function wrapAll(kdf: Kdf, pass: string, vaultId: string, vmks: Map<number, Uint8Array>, keys: VaultKey[]): Promise<VaultKey[]> {
  const kek = await deriveKek(kdf, pass);
  const out: VaultKey[] = [];
  for (const k of keys) {
    const raw = vmks.get(k.kv);
    if (!raw) throw new CryptoError("Locked", `no VMK for kv ${k.kv}`);
    out.push({ ...k, ...(await wrapVmk(kek, vaultId, k.kv, raw)) });
  }
  return out;
}

async function seal(info: UnsignedVaultInfo, vmks: Map<number, Uint8Array>, o: KeyringOptions): Promise<{ info: VaultInfo; ring: SxKeyring }> {
  const copy = new Map([...vmks].map(([kv, v]) => [kv, v.slice()]));
  const ring = await SxKeyring.fromVmks(info.vaultId, copy, info.activeKv, { ...o, metaPadBucket: info.params.metaPadBucket });
  const keys: VaultKey[] = [];
  for (const k of info.keys) keys.push({ ...k, check: await ring.keyCheck(k.kv) });
  const withChecks = { ...info, keys };
  return { info: { ...withChecks, infoMac: await ring.macVaultInfo(withChecks) } as VaultInfo, ring };
}

/** Creates a new vault-info with VMK_1 (§4.13 "Creating a vault"). The caller sends it with createVaultInfo. */
export async function createVault(
  pass: string,
  o: { kdf?: Partial<Kdf>; params?: Partial<VaultParams>; now?: number } & KeyringOptions = {},
): Promise<{ info: VaultInfo; ring: SxKeyring; cache: CachedSecrets }> {
  assertNewPassphrase(pass);
  const kdf = newKdf(o.kdf);
  const vaultId = newVaultId();
  const vmk1 = randomBytes(32);
  const now = o.now ?? Date.now();
  const vmks = new Map([[1, vmk1]]);
  const keys = await wrapAll(kdf, pass, vaultId, vmks, [{ kv: 1, status: "active", suite: "sx1", nonce: "", wrapped: "", check: "", createdAt: now }]);
  const draft: UnsignedVaultInfo = {
    format: "shuttle.vault-info",
    formatVersion: 1,
    vaultId,
    createdAt: now,
    infoRev: 1,
    epoch: 1,
    kdf,
    keys,
    activeKv: 1,
    params: { ...DEFAULT_PARAMS, ...o.params },
    retention: { ...DEFAULT_RETENTION },
    requires: [],
    unlockRequires: [],
    features: [...DEFAULT_FEATURES],
  };
  const cache = encodeCache(vaultId, vmks);
  const { info, ring } = await seal(draft, vmks, o);
  vmk1.fill(0);
  return { info, ring, cache };
}

async function reunlockRaw(pass: string, info: VaultInfo, o: UnlockOptions): Promise<Map<number, Uint8Array>> {
  const { cache } = await unlock(pass, info, null, o);
  const vmks = new Map<number, Uint8Array>();
  for (const [kv, v] of Object.entries(cache.kvs)) vmks.set(Number(kv), fromB64u(v));
  return vmks;
}

/** §4.11.1: requires the current passphrase even when cached; new salt and KEK; rewraps every kv. */
export async function changePassphrase(_ring: SxKeyring, info: VaultInfo, oldPass: string, newPass: string, kdf?: Partial<Kdf>, o: UnlockOptions = {}): Promise<VaultInfo> {
  assertNewPassphrase(newPass);
  const vmks = await reunlockRaw(oldPass, info, o);
  const k = newKdf(kdf ?? { alg: info.kdf.alg, ...(info.kdf.alg === "PBKDF2-SHA256" ? { iter: Math.max(info.kdf.iter, PBKDF2_DEFAULT_ITER) } : {}) } as Partial<Kdf>);
  const keys = await wrapAll(k, newPass, info.vaultId, vmks, info.keys);
  const { infoMac: _m, ...rest } = info;
  const out = await seal({ ...rest, kdf: k, keys, infoRev: info.infoRev + 1 }, vmks, o);
  for (const v of vmks.values()) v.fill(0);
  return out.info;
}

/** §4.11.4 step 2: new VMK_{n+1} active, old active -> decrypt-only, new salt and KEK. */
export async function rotateKey(_ring: SxKeyring, info: VaultInfo, oldPass: string, newPass: string, o: UnlockOptions & { now?: number; kdf?: Partial<Kdf> } = {}): Promise<{ info: VaultInfo; cache: CachedSecrets }> {
  assertNewPassphrase(newPass);
  const vmks = await reunlockRaw(oldPass, info, o);
  const next = Math.max(...info.keys.map((k) => k.kv)) + 1;
  if (!isKv(next)) throw new RangeError("key versions exhausted");
  vmks.set(next, randomBytes(32));
  const now = o.now ?? Date.now();
  const kdf = newKdf(o.kdf ?? (info.kdf.alg === "PBKDF2-SHA256" ? { iter: Math.max(info.kdf.iter, PBKDF2_DEFAULT_ITER) } : undefined));
  const keyList: VaultKey[] = [
    ...info.keys.map((k): VaultKey => (k.status === "active" ? { ...k, status: "decrypt-only" } : k)),
    { kv: next, status: "active", suite: "sx1", nonce: "", wrapped: "", check: "", createdAt: now },
  ];
  const keys = await wrapAll(kdf, newPass, info.vaultId, vmks, keyList);
  const { infoMac: _m, ...rest } = info;
  const cache = encodeCache(info.vaultId, vmks);
  const out = await seal({ ...rest, kdf, keys, activeKv: next, infoRev: info.infoRev + 1 }, vmks, o);
  for (const v of vmks.values()) v.fill(0);
  return { info: out.info, cache };
}

/** §4.11.5: same keys, epoch+1, infoRev+1, new MAC. Verifies the current MAC first. */
export async function markRebuild(ring: SxKeyring, info: VaultInfo): Promise<VaultInfo> {
  if (!(await ring.verifyVaultInfo(info))) throw new CryptoError("TamperedVaultInfo");
  const { infoMac: _m, ...rest } = info;
  const next = { ...rest, epoch: info.epoch + 1, infoRev: info.infoRev + 1 };
  return { ...next, infoMac: await ring.macVaultInfo(next) } as VaultInfo;
}
