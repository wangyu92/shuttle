// Key provisioning by pairing (design §4.12.2): no passphrase on the NAS or in chat.
//
// Headless side (pair-init): ephemeral ECDH P-256 (skH, pkH) and a 16-byte pairId; skH stays in memory.
// The link `obsidian://shuttle-pair?v=1&vid=<vaultId>&id=<pairId>&pk=<b64u raw 65-byte pkH>` goes to the
// user over the trusted channel (it carries only a public key). The unlocked plugin answers through
// the mailbox with {pkP, nonce, ct}:
//   Z  = ECDH(skP, pkH)
//   K  = HKDF-SHA256(Z, salt = pairId bytes, info = "shuttle/pair/v1|" + vaultId + "|" + b64u(pkH) + "|" + b64u(pkP), 256)
//   ct = AES-GCM(K, nonce, JSON{vaultId, keys:{kv: b64u VMK}, infoRev}, AAD = "shuttle/pair/v1|" + vaultId + "|" + pairId)
// The headless client takes the envelope, decrypts, and runs design §4.5.3 checks 6-8 against the live
// vault-info (key check per kv, infoMac, rollback) before anything is written. A substituted envelope
// fails one of them: nothing is written.
//
// sealPairingEnvelope() is the plugin side, kept here so both sides share one definition (the plugin
// and the tests import it).

import { b64u, fromB64u, fromCache, type Seen, type VaultInfo as CryptoVaultInfo } from "@shuttle/crypto";
import type { RemoteAdapter, VaultInfo } from "@shuttle/protocol";

export const PAIR_VERSION = 1;
const LABEL = "shuttle/pair/v1";
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export class PairingError extends Error {
  constructor(readonly reason: "timeout" | "malformed" | "decrypt" | "vault" | "validation", message: string) {
    super(message);
    this.name = "PairingError";
  }
}

export interface PairingSession {
  pairId: string;
  pkH: string;
  vaultId: string;
  link: string;
  /** Decrypt an envelope taken from the mailbox. */
  open(body: string): Promise<{ vaultId: string; keys: Record<string, string>; infoRev: number }>;
  /** Drop the private key reference. */
  dispose(): void;
}

export interface PairingPayload { vaultId: string; keys: Record<string, string>; infoRev: number }

function buf(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function deriveK(z: ArrayBuffer, pairId: string, vaultId: string, pkH: string, pkP: string, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await subtle().importKey("raw", z, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(fromB64u(pairId)), info: buf(te.encode(`${LABEL}|${vaultId}|${pkH}|${pkP}`)) },
    ikm, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}

export function pairingLink(vaultId: string, pairId: string, pkH: string): string {
  // `vid`, not `vault`: Obsidian reads `vault=` in any obsidian:// link as the local vault to open
  // ("Vault not found" on the Mac, 0.1.0-dev.2 field report).
  const q = new URLSearchParams({ v: String(PAIR_VERSION), vid: vaultId, id: pairId, pk: pkH });
  return `obsidian://shuttle-pair?${q.toString()}`;
}

/** pair-init step 2: ephemeral key pair, pairId, link. */
export async function startPairing(vaultId: string): Promise<PairingSession> {
  let kp: CryptoKeyPair | null = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
  const pkH = b64u(new Uint8Array(await subtle().exportKey("raw", kp.publicKey)));
  const pairId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  return {
    pairId, pkH, vaultId, link: pairingLink(vaultId, pairId, pkH),
    async open(body: string): Promise<PairingPayload> {
      if (!kp) throw new PairingError("decrypt", "pairing session closed");
      let env: { pkP?: unknown; nonce?: unknown; ct?: unknown };
      try {
        env = JSON.parse(body) as typeof env;
      } catch {
        throw new PairingError("malformed", "pairing envelope is not JSON");
      }
      if (typeof env.pkP !== "string" || typeof env.nonce !== "string" || typeof env.ct !== "string") {
        throw new PairingError("malformed", "pairing envelope fields missing");
      }
      let plain: ArrayBuffer;
      try {
        const pkP = await subtle().importKey("raw", buf(fromB64u(env.pkP)), { name: "ECDH", namedCurve: "P-256" }, false, []);
        const z = await subtle().deriveBits({ name: "ECDH", public: pkP }, kp.privateKey, 256);
        const k = await deriveK(z, pairId, vaultId, pkH, env.pkP, "decrypt");
        plain = await subtle().decrypt(
          { name: "AES-GCM", iv: buf(fromB64u(env.nonce)), additionalData: buf(te.encode(`${LABEL}|${vaultId}|${pairId}`)) },
          k, buf(fromB64u(env.ct)),
        );
      } catch {
        throw new PairingError("decrypt", "pairing envelope does not decrypt with this session's key");
      }
      let p: Partial<PairingPayload>;
      try {
        p = JSON.parse(td.decode(plain)) as Partial<PairingPayload>;
      } catch {
        throw new PairingError("malformed", "pairing payload is not JSON");
      }
      if (p.vaultId !== vaultId) throw new PairingError("vault", "pairing payload names another vault");
      if (!p.keys || typeof p.keys !== "object" || typeof p.infoRev !== "number") throw new PairingError("malformed", "pairing payload fields missing");
      for (const [kv, v] of Object.entries(p.keys)) {
        if (!/^[1-9]\d*$/.test(kv) || typeof v !== "string") throw new PairingError("malformed", "pairing keys malformed");
      }
      return { vaultId, keys: { ...p.keys }, infoRev: p.infoRev };
    },
    dispose() { kp = null; },
  };
}

/** The plugin side of step 3: seal the key bundle to pkH. */
export async function sealPairingEnvelope(link: { vaultId: string; pairId: string; pkH: string }, payload: PairingPayload): Promise<string> {
  const kp = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
  const pkP = b64u(new Uint8Array(await subtle().exportKey("raw", kp.publicKey)));
  const pkHKey = await subtle().importKey("raw", buf(fromB64u(link.pkH)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const z = await subtle().deriveBits({ name: "ECDH", public: pkHKey }, kp.privateKey, 256);
  const k = await deriveK(z, link.pairId, link.vaultId, link.pkH, pkP, "encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: buf(nonce), additionalData: buf(te.encode(`${LABEL}|${link.vaultId}|${link.pairId}`)) },
    k, buf(te.encode(JSON.stringify(payload))),
  );
  return JSON.stringify({ pkP, nonce: b64u(nonce), ct: b64u(new Uint8Array(ct)) });
}

/** Parse a pairing link (plugin side and tests). */
export function parsePairingLink(link: string): { vaultId: string; pairId: string; pkH: string } {
  const u = new URL(link);
  const vaultId = u.searchParams.get("vid") ?? u.searchParams.get("vault");
  const pairId = u.searchParams.get("id");
  const pkH = u.searchParams.get("pk");
  if (u.protocol !== "obsidian:" || u.searchParams.get("v") !== String(PAIR_VERSION) || !vaultId || !pairId || !pkH) {
    throw new PairingError("malformed", "not a shuttle pairing link");
  }
  return { vaultId, pairId, pkH };
}

/**
 * design §4.5.3 checks 6-8 of the delivered keys against the live vault-info: key check of every kv,
 * infoMac, rollback against `seen`. Returns the new `seen`. Throws PairingError('validation').
 */
export async function validatePairedKeys(payload: PairingPayload, info: VaultInfo, seen: Seen | null): Promise<{ seen: Seen; pullOnly: boolean }> {
  const kvs: Record<number, string> = {};
  for (const [k, v] of Object.entries(payload.keys)) kvs[Number(k)] = v;
  try {
    const r = await fromCache({ vaultId: payload.vaultId, kvs }, info as unknown as CryptoVaultInfo, seen);
    return {
      seen: { epoch: info.epoch, infoRev: info.infoRev, activeKv: info.activeKv, maxSeq: seen?.maxSeq ?? 0, maxEntryKey: seen?.maxEntryKey ?? null },
      pullOnly: r.pullOnly,
    };
  } catch (e) {
    throw new PairingError("validation", `delivered keys fail the vault-info checks (${(e as { code?: string }).code ?? (e as Error).name})`);
  }
}

/** pair-init step 4: poll the mailbox until an envelope arrives or the timeout passes. */
export async function waitForEnvelope(remote: Pick<RemoteAdapter, "pairingTake">, pairId: string, o: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<string> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + o.timeoutMs;
  for (;;) {
    const body = await remote.pairingTake?.(pairId).catch(() => null);
    if (body) return body;
    if (now() >= end) throw new PairingError("timeout", "no pairing answer before the timeout");
    await sleep(Math.min(o.intervalMs ?? 2000, Math.max(0, end - now())));
  }
}
