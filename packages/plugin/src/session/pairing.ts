// Plugin side of headless key provisioning by pairing (design §4.12.2, §5.5.9 "Add server mirror").
//
// The headless client shows `obsidian://shuttle-pair?v=1&vid=<vaultId>&id=<pairId>&pk=<b64u pkH>`.
// This device seals {vaultId, keys, infoRev} to pkH with ECDH P-256 + HKDF-SHA256 + AES-GCM and puts
// the envelope into the server mailbox; the headless client checks the keys against the live
// vault-info before it writes anything. The wire format is defined once in design §4.12.2; this file
// and the headless implementation are tested against each other through the published format only.

import { b64u, fromB64u, type CachedSecrets } from "@shuttle/crypto";

export const PAIR_VERSION = 1;
const LABEL = "shuttle/pair/v1";
const te = new TextEncoder();

export interface PairLink { vaultId: string; pairId: string; pkH: string }
export interface PairPayload { vaultId: string; keys: Record<string, string>; infoRev: number }

export class PairLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairLinkError";
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available");
  return s;
}

function buf(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

/** Parse a pairing link (or the protocol handler's params). */
export function parsePairLink(input: string | Record<string, string | undefined>): PairLink {
  let q: { get(k: string): string | null };
  if (typeof input === "string") {
    const t = input.trim();
    const prefix = "obsidian://shuttle-pair?";
    if (!t.startsWith(prefix)) throw new PairLinkError("not a shuttle pairing link");
    const sp = new URLSearchParams(t.slice(prefix.length));
    q = sp;
  } else {
    q = { get: (k) => input[k] ?? null };
  }
  // `vid` since 0.1.0-dev.3; `vault` (older headless builds) only when pasted, Obsidian swallows it.
  const vaultId = q.get("vid") ?? q.get("vault");
  const pairId = q.get("id");
  const pkH = q.get("pk");
  if (q.get("v") !== String(PAIR_VERSION) || !vaultId || !pairId || !pkH) throw new PairLinkError("not a shuttle pairing link");
  return { vaultId, pairId, pkH };
}

/** The key bundle for the payload: every cached kv. */
export function payloadOf(cache: CachedSecrets, infoRev: number): PairPayload {
  const keys: Record<string, string> = {};
  for (const [kv, v] of Object.entries(cache.kvs)) keys[String(kv)] = v;
  return { vaultId: cache.vaultId, keys, infoRev };
}

/** Seal `payload` to the headless client's public key (design §4.12.2 step 3). */
export async function sealPairingEnvelope(link: PairLink, payload: PairPayload): Promise<string> {
  if (payload.vaultId !== link.vaultId) throw new PairLinkError("the pairing link is for another vault");
  const s = subtle();
  const kp = await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
  const pkP = b64u(new Uint8Array(await s.exportKey("raw", kp.publicKey)));
  const pkHKey = await s.importKey("raw", buf(fromB64u(link.pkH)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const z = await s.deriveBits({ name: "ECDH", public: pkHKey }, kp.privateKey, 256);
  const ikm = await s.importKey("raw", z, "HKDF", false, ["deriveKey"]);
  const k = await s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(fromB64u(link.pairId)), info: buf(te.encode(`${LABEL}|${link.vaultId}|${link.pkH}|${pkP}`)) },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await s.encrypt(
    { name: "AES-GCM", iv: buf(nonce), additionalData: buf(te.encode(`${LABEL}|${link.vaultId}|${link.pairId}`)) },
    k, buf(te.encode(JSON.stringify(payload))),
  );
  return JSON.stringify({ pkP, nonce: b64u(nonce), ct: b64u(new Uint8Array(ct)) });
}
