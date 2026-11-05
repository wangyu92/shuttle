// Runtime self-test (§4.15 required suite 1): known-answer checks on the iter-1000 vectors,
// run before the first unlock each launch. Failure -> the device refuses to sync.
import V from "../vectors/vectors-v1.json" with { type: "json" };
import { b64u, fromB64u } from "./b64u.js";
import { fromHex, toHex, utf8 } from "./bytes.js";
import { unwrapVmk } from "./envelope.js";
import { CryptoError } from "./errors.js";
import { deriveKek, validateKdf } from "./kdf.js";
import type { RecordHeader } from "./aad.js";
import type { VaultInfo } from "./types.js";
import { unlockWithKdfFloor } from "./vault-info.js";

export interface SelfTestReport {
  mode: "kat" | "bench";
  ok: boolean;
  failures: string[];
  ms: number;
  /** bench only: PBKDF2-SHA256 at the default 600000 iterations (the 600k KEK then unwraps the vector VMK1). */
  kdfMs?: number;
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export function vectorPassphrase(): string {
  return JSON.parse(V.inputs.passphraseJsEscaped) as string;
}

/** Rebuilds a vault-info object from a vector's canonical string plus its MAC. */
export function vectorVaultInfo(which: "vaultInfo" | "vaultInfoRotated" | "vaultInfoUnknownFields"): VaultInfo {
  const row = V[which];
  return { ...(JSON.parse(row.canonical) as object), infoMac: row.infoMac } as VaultInfo;
}

async function rejects(p: () => Promise<unknown>): Promise<boolean> {
  try {
    await p();
    return false;
  } catch {
    return true;
  }
}

async function kat(fail: (m: string) => void): Promise<void> {
  const pass = vectorPassphrase();
  const { ring } = await unlockWithKdfFloor(pass, vectorVaultInfo("vaultInfo"), null, {}, 1000);
  const eq = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(name);
  };
  eq("pathKey", await ring.pathKey(V.ids.path1), V.ids.pathKey1);
  eq("pathKeyUpper", await ring.pathKey(V.ids.path1.toUpperCase()), V.ids.pathKey1Upper);
  eq("pathKeyNfd", await ring.pathKey(JSON.parse(V.ids.path2JsEscaped) as string), V.ids.pathKey2);
  const chunk = fromHex(V.blob.chunkHex);
  eq("blobId", (await ring.blobId(chunk)).blobId, V.blob.blobId);
  eq("openBlob0", toHex(await ring.openBlob(fromHex(V.blob.sealedFlags0Hex), V.blob.blobId, chunk.length)), V.blob.chunkHex);
  eq("openBlob2", toHex(await ring.openBlob(fromHex(V.blob.sealedFlags2PadmeHex), V.blob.blobId, chunk.length)), V.blob.chunkHex);
  const zLen = V.blobCompressed.chunkLen;
  const zOpen = await ring.openBlob(fromHex(V.blobCompressed.sealedFlags3Hex), V.blobCompressed.blobId, zLen);
  eq("openBlob3", toHex(zOpen), toHex(utf8(V.blobCompressed.textRepeated.line.repeat(V.blobCompressed.textRepeated.times))));
  if (!(await rejects(() => ring.openBlob(fromHex(V.blob.sealedFlags0Hex), "0".repeat(64), chunk.length)))) fail("blobWrongId");
  const h = V.record.header as RecordHeader;
  eq("openMeta", await ring.openMeta(V.record.metaB64u, h), JSON.parse(V.record.metaJson));
  eq("openInline", toHex(await ring.openInline(V.record.inlineB64u, h, false, false, 12)), V.record.inlinePlainHex);
  if (!(await rejects(() => ring.openMeta(V.record.metaB64u, { ...h, base: 18010 })))) fail("metaWrongBase");
  eq("keyCheck", await ring.keyCheck(1), V.keyCheck.kv1);
  eq("gear", Array.from((await ring.gearTable()).subarray(0, 4)), V.subkeys.gearFirst4U32BE);
  eq("manifestMac", await ring.macManifest(JSON.parse(V.manifest.canonical) as object), V.manifest.mac);
  // §4.15 negative vectors: passphrase + trailing space, flipped last tag byte.
  if (!(await rejects(() => unlockWithKdfFloor(pass + " ", vectorVaultInfo("vaultInfo"), null, {}, 1000)))) fail("negTrailingSpace");
  const kek = await deriveKek({ alg: "PBKDF2-SHA256", iter: 1000, salt: b64u(fromHex(V.inputs.saltHex)) }, pass);
  const wrapped = fromB64u(V.kdf["1000"].wrappedVmk1B64u);
  wrapped[wrapped.length - 1]! ^= 0x01;
  if (!(await rejects(() => unwrapVmk(kek, V.inputs.vaultId, 1, b64u(fromHex(V.inputs.wrapNonceHex)), b64u(wrapped))))) fail("negFlippedTag");
}

export async function selfTest(mode: "kat" | "bench"): Promise<SelfTestReport> {
  const t0 = now();
  const failures: string[] = [];
  try {
    await kat((m) => failures.push(m));
  } catch (e) {
    failures.push(`exception: ${e instanceof Error ? e.message : String(e)}`);
  }
  const report: SelfTestReport = { mode, ok: failures.length === 0, failures, ms: 0 };
  if (mode === "bench" && report.ok) {
    const kdf = { alg: "PBKDF2-SHA256" as const, iter: 600000, salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" };
    validateKdf(kdf);
    const t1 = now();
    const kek = await deriveKek(kdf, vectorPassphrase());
    report.kdfMs = Math.round(now() - t1);
    try {
      const vmk1 = await unwrapVmk(kek, V.inputs.vaultId, 1, b64u(fromHex(V.inputs.wrapNonceHex)), V.kdf["600000"].wrappedVmk1B64u);
      if (toHex(vmk1) !== V.inputs.vmk1Hex) failures.push("unwrap600k");
    } catch {
      failures.push("unwrap600k");
    }
    report.ok = failures.length === 0;
  }
  report.ms = Math.round(now() - t0);
  return report;
}

/** Throws SelfTestFailed unless the KAT passes. */
export async function assertSelfTest(): Promise<void> {
  const r = await selfTest("kat");
  if (!r.ok) throw new CryptoError("SelfTestFailed", r.failures.join(", "));
}
