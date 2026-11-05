// P0-C2: the only module that imports @shuttle/crypto. Spike builds therefore need the crypto package
// in the workspace (resolved through the npm workspace symlink, not a package.json dependency).
import { selfTest } from "@shuttle/crypto";
import type { Probe, ProbeOutcome } from "../types.js";
import { KDF_600K_KEK_HEX, KDF_PASS_NFC_HEX, KDF_SALT_HEX, pbkdf2 } from "./crypto.js";
import { errMsg, fromHex, now, round, toHex } from "../util.js";

export const katProbe: Probe = {
  id: "P0-C2",
  title: "Full KAT (@shuttle/crypto selfTest bench: iter-1000 rows, negatives, 600k unwrap) + 600000 KEK bytes",
  safe: true,
  async run(ctx): Promise<ProbeOutcome> {
    // selfTest("bench") = the iter-1000 KAT rows, the §4.15 negative vectors (trailing-space passphrase,
    // flipped tag byte) and the wrapped VMK1 at iter 600000 unwrapped with the 600k KEK.
    ctx.progress("P0-C2: @shuttle/crypto selfTest(bench)");
    let kat: { ok: boolean; failures: string[]; ms: number; kdfMs?: number } | { ok: false; failures: string[]; ms: number; error: string };
    try {
      const r = await selfTest("bench");
      kat = { ok: r.ok, failures: r.failures, ms: r.ms, ...(r.kdfMs !== undefined ? { kdfMs: r.kdfMs } : {}) };
    } catch (e) {
      kat = { ok: false, failures: ["exception"], ms: 0, error: errMsg(e) };
    }
    ctx.progress("P0-C2: PBKDF2 600000");
    const t0 = now();
    const kek = toHex(await pbkdf2(fromHex(KDF_PASS_NFC_HEX), fromHex(KDF_SALT_HEX), 600000));
    const kdfMs = round(now() - t0);
    const kek600kOk = kek === KDF_600K_KEK_HEX;
    const ok = kat.ok && kek600kOk;
    return {
      status: ok ? "pass" : "fail",
      summary: `selfTest ${kat.ok ? "ok" : "FAILED " + kat.failures.join(",")} (${kat.ms} ms); KEK@600k ${kek600kOk ? "byte-identical" : "DIFFERENT"} (${kdfMs} ms)`,
      data: { kat, kek600kOk, kek, kdfMs },
    };
  },
};
