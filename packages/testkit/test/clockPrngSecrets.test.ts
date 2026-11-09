// FakeClock, FakeScheduler, Prng and secretScan.
import { describe, expect, it } from "vitest";
import { FakeClock, FakeScheduler, OutputCapture, Prng, assertNoSecrets, secretScan } from "../src/index";

describe("FakeClock and FakeScheduler", () => {
  it("time moves only when advanced; skewed clocks share monotonic time", () => {
    const c = new FakeClock({ start: 1_000_000 });
    expect(c.now()).toBe(1_000_000);
    c.tick(500);
    expect(c.monotonic()).toBe(500);
    const skew = c.skewed({ offsetMs: -3_600_000, drift: 0.001 });
    expect(skew.monotonic()).toBe(500);
    expect(skew.now()).toBe(Math.floor(1_000_000 - 3_600_000 + 500 * 1.001));
    expect(() => c.tick(-1)).toThrow();
  });

  it("fires timers in (due, creation) order and steps the clock to each due time", async () => {
    const s = new FakeScheduler();
    const log: string[] = [];
    s.setTimer(20, () => log.push(`b@${s.clock.monotonic()}`));
    s.setTimer(10, () => log.push(`a@${s.clock.monotonic()}`));
    s.setTimer(20, () => log.push(`c@${s.clock.monotonic()}`));
    const gone = s.setTimer(15, () => log.push("never"));
    s.clearTimer(gone);
    await s.advance(15);
    expect(log).toEqual(["a@10"]);
    expect(s.clock.monotonic()).toBe(15);
    await s.advance(100);
    expect(log).toEqual(["a@10", "b@20", "c@20"]);
    expect(s.clock.monotonic()).toBe(115);
    expect(s.pending).toBe(0);
  });

  it("runs async continuations at the timer's time and timers scheduled by timers", async () => {
    const s = new FakeScheduler();
    const log: number[] = [];
    s.setTimer(10, () => {
      void (async () => {
        await Promise.resolve();
        log.push(s.clock.monotonic());
        s.setTimer(5, () => log.push(s.clock.monotonic()));
      })();
    });
    await s.advance(100);
    expect(log).toEqual([10, 15]);
  });

  it("runAll stops runaway rescheduling; callback errors are collected", async () => {
    const s = new FakeScheduler();
    const again = (): void => { s.setTimer(1, again); };
    again();
    await expect(s.runAll(50)).rejects.toThrow(/more than 50/);
    const t = new FakeScheduler();
    t.setTimer(1, () => { throw new Error("cb"); });
    await t.runAll();
    expect(t.errors).toHaveLength(1);
  });

  it("counts yields", async () => {
    const s = new FakeScheduler();
    await s.yieldToUi();
    await s.idle();
    expect(s.stats).toMatchObject({ yields: 1, idles: 1 });
  });
});

describe("Prng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Prng(42), b = new Prng(42), c = new Prng(43);
    const xs = [a.u32(), a.u32(), a.u32()];
    expect([b.u32(), b.u32(), b.u32()]).toEqual(xs);
    expect([c.u32(), c.u32(), c.u32()]).not.toEqual(xs);
    expect(new Prng("alice").u32()).toBe(new Prng("alice").u32());
  });

  it("produces ids of the right shape and bounded ints", () => {
    const p = new Prng(7);
    expect(p.hex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(p.b64u(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(p.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (let i = 0; i < 1000; i++) {
      const n = p.int(7);
      expect(n >= 0 && n < 7).toBe(true);
    }
    expect(p.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    expect(() => p.int(0)).toThrow();
  });

  it("forks independent streams deterministically", () => {
    const a = new Prng(1).fork("dev-a"), b = new Prng(1).fork("dev-a"), c = new Prng(1).fork("dev-b");
    expect(a.u32()).toBe(b.u32());
    expect(new Prng(1).fork("dev-a").u32()).not.toBe(c.u32());
  });
});

describe("secretScan (design §7.2 H3)", () => {
  const token = "sxd_aGVsbG8td29ybGQtdG9rZW4";
  const pass = "correct horse battery staple";
  const key = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0xfe, 0xff]);

  it("finds raw, JSON-escaped, hex and base64 forms without echoing the secret", () => {
    const keyHex = "deadbeef010203feff";
    const keyB64 = btoa(String.fromCharCode(...key));
    const keyB64u = keyB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const out = {
      log: `connected with ${token}`,
      status: JSON.stringify({ k: keyHex.toUpperCase() }),
      dump: `key=${keyB64u} pass=${encodeURIComponent(pass)}`,
      ok: "nothing here",
    };
    const hits = secretScan(out, [{ name: "token", value: token }, { name: "pass", value: pass }, { name: "key", value: key }]);
    expect(hits.map((h) => `${h.secret}/${h.encoding}/${h.source}`).sort()).toEqual(
      ["key/HEX/status", "key/base64url/dump", "pass/uri/dump", "token/raw/log"].sort(),
    );
    let msg = "";
    try { assertNoSecrets(out, [token, pass, key]); } catch (e) { msg = String(e); }
    expect(msg).toContain("secrets found");
    expect(msg).not.toContain(token);
    expect(msg).not.toContain(pass);
  });

  it("passes clean output and rejects too-short secrets", () => {
    const cap = new OutputCapture();
    cap.write("status ok");
    cap.write({ cursor: 5 });
    expect(() => assertNoSecrets(cap.text, [token, key])).not.toThrow();
    expect(() => secretScan("x", ["abc"])).toThrow(/too short/);
  });
});
