// Crypto probes with inline WebCrypto (P0-C1, C3..C9, C11, M1..M3, M17).
// The KAT against @shuttle/crypto lives in crypto-kat.ts so only one module depends on that package.
import { Platform } from "obsidian";
import type { Probe, ProbeOutcome } from "../types.js";
import { GapMonitor, MiB, errMsg, fromHex, median, now, randomBytes, round, sha256hex, toHex, withTimeout } from "../util.js";

// Source: packages/crypto/vectors/vectors-v1.json (inputs.passphraseNfcUtf8Hex, inputs.saltHex,
// kdf["600000"].kekHex). That file is the only normative copy (design §4.15).
export const KDF_PASS_NFC_HEX =
  "636f727265637420686f727365206261747465727920737461706c6520e29c9320ed959ceab880";
export const KDF_SALT_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
export const KDF_600K_KEK_HEX = "fae50eaca7e8bbc4afbb59595de66c051a9bca0b9b41022b2f3a5eba2fcf2689";
// inputs.passphraseJsEscaped from the same file: the passphrase in NFD.
const PASS_NFD_JSON = '"correct horse battery staple \\u2713 \\u1112\\u1161\\u11ab\\u1100\\u1173\\u11af"';

export async function pbkdf2(passUtf8: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey("raw", passUtf8, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 256);
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv, ct };
}

// The >= 30 MB/s phone criterion applies to every mobile app except an iPad: an unfolded Fold can
// report isTablet, and it must still be held to the phone number.
const isPhone = () => Platform.isMobileApp && !(Platform.isIosApp && Platform.isTablet);

export const cryptoProbes: Probe[] = [
  {
    id: "P0-C1",
    title: "crypto.subtle, getRandomValues, isSecureContext",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const data = {
        subtle: typeof globalThis.crypto?.subtle?.encrypt === "function",
        getRandomValues: typeof globalThis.crypto?.getRandomValues === "function",
        randomUUID: typeof (globalThis.crypto as { randomUUID?: unknown } | undefined)?.randomUUID === "function",
        isSecureContext: globalThis.isSecureContext === true,
        origin: globalThis.location?.origin ?? null,
      };
      const ok = data.subtle && data.getRandomValues && data.isSecureContext;
      return { status: ok ? "pass" : "fail", summary: JSON.stringify(data), data };
    },
  },
  {
    id: "M1/P0-C5",
    title: "AES-256-GCM 4 MiB seal/open; 4 in flight; 24 MiB in flight",
    safe: true,
    async run(ctx): Promise<ProbeOutcome> {
      const key = await aesKey();
      const buf = randomBytes(4 * MiB);
      const wantHash = await sha256hex(buf);
      const sealMs: number[] = [];
      const openMs: number[] = [];
      let roundTripOk = true;
      for (let i = 0; i < 3; i++) {
        ctx.progress(`M1: single 4 MiB run ${i + 1}/3`);
        const t0 = now();
        const { iv, ct } = await seal(key, buf);
        const t1 = now();
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
        const t2 = now();
        sealMs.push(t1 - t0);
        openMs.push(t2 - t1);
        if ((await sha256hex(pt)) !== wantHash) roundTripOk = false;
      }
      const single = median(sealMs) + median(openMs);
      ctx.progress("M1: 4 x 4 MiB in flight");
      const four = Array.from({ length: 4 }, () => randomBytes(4 * MiB));
      const t3 = now();
      await Promise.all(four.map((b) => seal(key, b)));
      const fourMs = now() - t3;
      const fourMBps = (16 * MiB) / 1e6 / (fourMs / 1000);
      ctx.progress("M1: 6 x 4 MiB (24 MiB) in flight");
      let big: { ok: boolean; ms: number; error?: string };
      try {
        const six = [...four, randomBytes(4 * MiB), randomBytes(4 * MiB)];
        const t4 = now();
        const sealed = await Promise.all(six.map((b) => seal(key, b)));
        await Promise.all(sealed.map((s) => crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv }, key, s.ct)));
        big = { ok: true, ms: round(now() - t4) };
      } catch (e) {
        big = { ok: false, ms: 0, error: errMsg(e) };
      }
      const singleMBps = (4 * MiB) / 1e6 / (median(sealMs) / 1000);
      const data = {
        sealMsMedian: round(median(sealMs)),
        openMsMedian: round(median(openMs)),
        sealOpenMs: round(single),
        singleSealMBps: round(singleMBps),
        fourInFlightMs: round(fourMs),
        fourInFlightMBps: round(fourMBps),
        inFlight24MiB: big,
        roundTripOk,
        isTablet: Platform.isTablet,
        phoneCriterion: isPhone(),
      };
      // §10.2 pass: iPhone < 150 ms, iPad mini < 300 ms (seal+open of 4 MiB), >= 30 MB/s on phones.
      let status: ProbeOutcome["status"] = "info";
      let limit: number | null = null;
      if (Platform.isIosApp) limit = Platform.isTablet ? 300 : 150;
      const okCore = roundTripOk && big.ok;
      if (!okCore) status = "fail";
      else if (limit !== null) status = single < limit && (!isPhone() || singleMBps >= 30) ? "pass" : "fail";
      else if (isPhone()) status = singleMBps >= 30 ? "pass" : "fail";
      return {
        status,
        summary: `seal+open ${data.sealOpenMs} ms${limit ? ` (limit ${limit})` : ""}, ${data.singleSealMBps} MB/s, 4 in flight ${data.fourInFlightMBps} MB/s, 24 MiB ${big.ok ? "ok" : "FAILED"}`,
        data,
      };
    },
  },
  {
    id: "M2/P0-C3",
    title: "PBKDF2-SHA256 600k timing",
    safe: true,
    async run(ctx): Promise<ProbeOutcome> {
      ctx.progress("M2: PBKDF2 600k");
      const t0 = now();
      const kek = await pbkdf2(fromHex(KDF_PASS_NFC_HEX), fromHex(KDF_SALT_HEX), 600000);
      const ms = now() - t0;
      const match = toHex(kek) === KDF_600K_KEK_HEX;
      const at2s = Math.floor((600000 * 2000) / ms);
      const suggestedIter = ms < 2000 ? 600000 : Math.max(310000, at2s);
      const data = { ms: round(ms), kekMatchesVector: match, iterAt2s: at2s, suggestedIter };
      return {
        status: !match ? "fail" : ms < 2000 ? "pass" : "fail",
        summary: `${data.ms} ms${ms >= 2000 ? `; 2 s point ~${at2s} iter, use ${suggestedIter} (floor 310k)` : ""}`,
        data,
      };
    },
  },
  {
    id: "M3",
    title: "HMAC-SHA256 pathKeys for 10k paths",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const key = await crypto.subtle.importKey("raw", randomBytes(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const enc = new TextEncoder();
      const paths = Array.from({ length: 10000 }, (_, i) => enc.encode(`folder ${i % 37}/sub ${i % 11}/노트 ${i}.md`.normalize("NFC").toLowerCase()));
      const t0 = now();
      for (const p of paths) await crypto.subtle.sign("HMAC", key, p);
      const seqMs = now() - t0;
      const t1 = now();
      for (let i = 0; i < paths.length; i += 256) {
        await Promise.all(paths.slice(i, i + 256).map((p) => crypto.subtle.sign("HMAC", key, p)));
      }
      const parMs = now() - t1;
      const best = Math.min(seqMs, parMs);
      const data = { sequentialMs: round(seqMs), batched256Ms: round(parMs) };
      return { status: best < 1000 ? "pass" : "fail", summary: `sequential ${data.sequentialMs} ms, batched ${data.batched256Ms} ms`, data };
    },
  },
  {
    id: "P0-C4",
    title: "HKDF -> AES-GCM and HMAC (non-extractable), deriveBits 8192",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const ikm = await crypto.subtle.importKey("raw", randomBytes(32), "HKDF", false, ["deriveKey", "deriveBits"]);
      const params = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(info) });
      const checks: Record<string, unknown> = {};
      const aes = await crypto.subtle.deriveKey(params("shuttle/v1/content"), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = randomBytes(12);
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode("probe"));
      const pt = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, ct));
      checks.aesRoundTrip = pt === "probe";
      checks.aesExtractable = aes.extractable;
      const hmac = await crypto.subtle.deriveKey(params("shuttle/v1/pathkey"), ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
      const sig = await crypto.subtle.sign("HMAC", hmac, new Uint8Array([1, 2, 3]));
      checks.hmacSigLen = sig.byteLength;
      checks.hmacVerify = await crypto.subtle.verify("HMAC", hmac, sig, new Uint8Array([1, 2, 3]));
      checks.hmacExtractable = hmac.extractable;
      try {
        await crypto.subtle.exportKey("raw", aes);
        checks.exportBlocked = false;
      } catch {
        checks.exportBlocked = true;
      }
      try {
        const bits = await crypto.subtle.deriveBits(params("shuttle/v1/gear"), ikm, 8192);
        checks.deriveBits8192Len = bits.byteLength;
      } catch (e) {
        checks.deriveBits8192Len = errMsg(e);
      }
      const ok = checks.aesRoundTrip === true && checks.aesExtractable === false && checks.hmacSigLen === 32 &&
        checks.hmacVerify === true && checks.hmacExtractable === false && checks.exportBlocked === true &&
        checks.deriveBits8192Len === 1024;
      return { status: ok ? "pass" : "fail", summary: JSON.stringify(checks), data: checks };
    },
  },
  {
    id: "P0-C6",
    title: "normalize('NFC') on the NFD vector; toLowerCase on newest Unicode vs V8",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const nfd = JSON.parse(PASS_NFD_JSON) as string;
      const nfcHex = toHex(new TextEncoder().encode(nfd.normalize("NFC")));
      const nfcOk = nfcHex === KDF_PASS_NFC_HEX;
      const cpHex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" ");
      const diffs: Record<string, { got: { lower: string; upper: string }; node: { lower: string; upper: string } }> = {};
      for (const [k, ref] of Object.entries(NODE_CASE_REF)) {
        const s = k === "SIGMA" ? null : String.fromCodePoint(parseInt(k, 16));
        const got = s === null
          ? { lower: cpHex("ΟΔΟΣ".toLowerCase()), upper: cpHex("οδος".toUpperCase()) }
          : { lower: cpHex(s.toLowerCase()), upper: cpHex(s.toUpperCase()) };
        if (got.lower !== ref.lower || got.upper !== ref.upper) diffs[k] = { got, node: ref };
      }
      const nDiff = Object.keys(diffs).length;
      return {
        status: nfcOk ? (nDiff === 0 ? "pass" : "info") : "fail",
        summary: `NFC ${nfcOk ? "equal" : "DIFFERENT"}; casing differs from Node 22.23.2 (Unicode 17.0, ICU 78.3) on ${nDiff}/${Object.keys(NODE_CASE_REF).length}${nDiff ? ": " + Object.keys(diffs).join(", ") : ""}`,
        data: { nfcHex, nfcOk, caseDiffs: diffs },
      };
    },
  },
  {
    id: "P0-C7",
    title: "ECDH P-256 generateKey/deriveBits",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const alg = { name: "ECDH", namedCurve: "P-256" } as const;
      const t0 = now();
      const a = await crypto.subtle.generateKey(alg, false, ["deriveBits"]);
      const b = await crypto.subtle.generateKey(alg, false, ["deriveBits"]);
      const ab = await crypto.subtle.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 256);
      const ba = await crypto.subtle.deriveBits({ name: "ECDH", public: a.publicKey }, b.privateKey, 256);
      const ok = toHex(ab) === toHex(ba);
      return { status: ok ? "pass" : "fail", summary: `shared secret ${ok ? "equal" : "DIFFERENT"}, ${round(now() - t0)} ms`, data: { ms: round(now() - t0) } };
    },
  },
  {
    id: "P0-C8",
    title: "WASM in a Blob-URL Worker with 64 MiB memory (Argon2id not bundled)",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      // Minimal module: (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
      const wasmHex = "0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b";
      const src = `
        self.onmessage = async (ev) => {
          const out = {};
          try {
            const bytes = new Uint8Array(ev.data.match(/../g).map((h) => parseInt(h, 16)));
            out.validate = WebAssembly.validate(bytes);
            const { instance } = await WebAssembly.instantiate(bytes);
            out.add = instance.exports.add(40, 2);
            const t0 = performance.now();
            const mem = new WebAssembly.Memory({ initial: 1024, maximum: 1024 });
            const u = new Uint8Array(mem.buffer);
            for (let i = 0; i < u.length; i += 65536) u[i] = 1;
            let sum = 0; for (let i = 0; i < u.length; i += 65536) sum += u[i];
            out.memBytes = mem.buffer.byteLength; out.pagesTouched = sum; out.memMs = performance.now() - t0;
          } catch (e) { out.error = String(e); }
          self.postMessage(out);
        };`;
      let url: string | null = null;
      let worker: Worker | null = null;
      try {
        url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        worker = new Worker(url);
        const w = worker;
        const res = await withTimeout(
          new Promise<Record<string, unknown>>((resolve, reject) => {
            w.onmessage = (ev) => resolve(ev.data as Record<string, unknown>);
            w.onerror = (ev) => reject(new Error(`worker error: ${ev.message || "unknown (CSP?)"}`));
            w.postMessage(wasmHex);
          }),
          5000,
        );
        const ok = res.add === 42 && res.memBytes === 64 * MiB && res.error === undefined;
        return {
          status: ok ? "pass" : "fail",
          summary: `worker ok, wasm add=${String(res.add)}, memory ${String(res.memBytes)} B${res.error ? `, error ${String(res.error)}` : ""}; Argon2id UNVERIFIED (hash-wasm not bundled)`,
          data: { ...res, argon2id: "not bundled" },
        };
      } catch (e) {
        return { status: "fail", summary: `Blob-URL worker failed: ${errMsg(e)}`, data: { error: errMsg(e) } };
      } finally {
        worker?.terminate();
        if (url) URL.revokeObjectURL(url);
      }
    },
  },
  {
    id: "M17/P0-C9",
    title: "CompressionStream('deflate-raw')",
    safe: true,
    async run(): Promise<ProbeOutcome> {
      const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
      const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
      if (!CS || !DS) return { status: "fail", summary: "CompressionStream missing: use fflate", data: { present: false } };
      try {
        const text = new TextEncoder().encode("Shuttle spike line with some repetition. 한글 줄도 넣는다.\n".repeat(20000));
        const pipe = async (data: Uint8Array<ArrayBuffer>, ts: CompressionStream | DecompressionStream) =>
          new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ts as unknown as TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>)).arrayBuffer());
        const t0 = now();
        const z = await pipe(text, new CS("deflate-raw" as CompressionFormat));
        const t1 = now();
        const back = await pipe(z, new DS("deflate-raw" as CompressionFormat));
        const t2 = now();
        const ok = (await sha256hex(back)) === (await sha256hex(text));
        const data = { present: true, inBytes: text.length, outBytes: z.length, deflateMs: round(t1 - t0), inflateMs: round(t2 - t1), roundTrip: ok };
        return { status: ok ? "pass" : "fail", summary: `present; ${text.length} -> ${z.length} B in ${data.deflateMs} ms, round trip ${ok}`, data };
      } catch (e) {
        return { status: "fail", summary: `deflate-raw failed: ${errMsg(e)} (use fflate)`, data: { present: true, error: errMsg(e) } };
      }
    },
  },
  {
    id: "P0-C11",
    title: "Main-thread long tasks during PBKDF2 600k and 4 MiB GCM",
    safe: true,
    async run(ctx): Promise<ProbeOutcome> {
      const mon = new GapMonitor();
      ctx.progress("P0-C11: PBKDF2 600k under monitor");
      mon.start();
      await pbkdf2(fromHex(KDF_PASS_NFC_HEX), fromHex(KDF_SALT_HEX), 600000);
      const kdf = await mon.stop();
      ctx.progress("P0-C11: 4 MiB GCM under monitor");
      const key = await aesKey();
      const buf = randomBytes(4 * MiB);
      mon.start();
      const { iv, ct } = await seal(key, buf);
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      const gcm = await mon.stop();
      const worst = Math.max(kdf.maxGapMs, gcm.maxGapMs, kdf.maxLongTaskMs, gcm.maxLongTaskMs);
      return {
        status: worst <= 200 ? "pass" : "fail",
        summary: `max blocking: PBKDF2 ${kdf.maxGapMs} ms, GCM ${gcm.maxGapMs} ms (interval gap); longtask API ${kdf.longtaskSupported ? "yes" : "no"}`,
        data: { pbkdf2: kdf, gcm },
      };
    },
  },
];

// Reference outputs computed with Node 22.23.2 (V8 12.4.254.21-node.56, ICU 78.3, Unicode 17.0) on
// 2026-11-05: code point -> toLowerCase()/toUpperCase() as space-separated hex code points.
// "SIGMA" is "ΟΔΟΣ".toLowerCase() and "οδος".toUpperCase() (final-sigma rule).
const NODE_CASE_REF: Record<string, { lower: string; upper: string }> = {
  "130": { lower: "0069 0307", upper: "0130" },
  "10570": { lower: "10597", upper: "10570" },
  "1C89": { lower: "1C8A", upper: "1C89" },
  A7CB: { lower: "0264", upper: "A7CB" },
  A7CC: { lower: "A7CD", upper: "A7CC" },
  A7CD: { lower: "A7CD", upper: "A7CC" },
  A7DA: { lower: "A7DB", upper: "A7DA" },
  A7DC: { lower: "019B", upper: "A7DC" },
  "10D50": { lower: "10D70", upper: "10D50" },
  A7C0: { lower: "A7C1", upper: "A7C0" },
  "2C2F": { lower: "2C5F", upper: "2C2F" },
  DF: { lower: "00DF", upper: "0053 0053" },
  "1E9E": { lower: "00DF", upper: "1E9E" },
  A7CE: { lower: "A7CF", upper: "A7CE" },
  A7D2: { lower: "A7D3", upper: "A7D2" },
  "16EA0": { lower: "16EBB", upper: "16EA0" },
  "1E900": { lower: "1E922", upper: "1E900" },
  SIGMA: { lower: "03BF 03B4 03BF 03C2", upper: "039F 0394 039F 03A3" },
};
