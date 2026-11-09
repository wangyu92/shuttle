// Unit tests for the server's pure helpers, plus group commit behavior.
import { describe, expect, it } from "vitest";
import { FailureLimiter, TokenBuckets, enrollCodeHash, hashPassword, newDeviceToken, newEnrollCode, normalizeEnrollCode, verifyPassword } from "../src/auth";
import { optionsFromEnv, resolveConfig } from "../src/config";
import { etagMatches } from "../src/server-core";
import { b64uDecodeStrict } from "../src/util";
import { FAST_SCRYPT, TestWs, cid, fileId, fixture, login, pathKey, putOp, removeDir, start, tempDir } from "./helpers";

describe("auth helpers", () => {
  it("enroll codes carry 100 bits and normalize Crockford aliases", () => {
    const code = newEnrollCode();
    expect(code).toMatch(/^SXE-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    const n = normalizeEnrollCode(code)!;
    expect(n).toHaveLength(20);
    expect(normalizeEnrollCode(code.toLowerCase())).toBe(n);
    expect(normalizeEnrollCode("SXE-OOOO-IIII-LLLL-0000-1111")).toBe("00001111111100001111");
    expect(normalizeEnrollCode("SXE-UUUU-0000-0000-0000-0000")).toBeNull();
    expect(normalizeEnrollCode("SXE-0000")).toBeNull();
    expect(enrollCodeHash(n).equals(enrollCodeHash(normalizeEnrollCode(code)!))).toBe(true);
    expect(new Set(Array.from({ length: 50 }, newEnrollCode)).size).toBe(50);
  });

  it("device tokens are sxd_ + 32 random bytes", () => {
    const t = newDeviceToken();
    expect(t).toMatch(/^sxd_[A-Za-z0-9_-]{43}$/);
  });

  it("scrypt hashes record their params and verify", async () => {
    const h = await hashPassword("secret-pass", FAST_SCRYPT);
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await verifyPassword("secret-pass", h, FAST_SCRYPT)).toBe(true);
    expect(await verifyPassword("wrong", h, FAST_SCRYPT)).toBe(false);
    expect(await verifyPassword("x", null, FAST_SCRYPT)).toBe(false);
    expect(await verifyPassword("x", "garbage", FAST_SCRYPT)).toBe(false);
  });

  it("default scrypt params (N=2^15, r=8) run despite Node's 32 MiB maxmem default", async () => {
    const h = await hashPassword("pw-longer", { N: 1 << 15, r: 8, p: 1 });
    expect(await verifyPassword("pw-longer", h, FAST_SCRYPT)).toBe(true);
  });

  it("failure limiter: 5 per minute, sliding", () => {
    let t = 0;
    const l = new FailureLimiter(5, 60_000, () => t);
    for (let i = 0; i < 5; i++) { expect(l.blockedFor("k")).toBe(0); l.fail("k"); t += 1000; }
    expect(l.blockedFor("k")).toBe(55_000);
    t = 60_001;
    expect(l.blockedFor("k")).toBe(0);
  });

  it("token bucket: burst = rate, then refills", () => {
    let t = 0;
    const b = new TokenBuckets(20, () => t);
    for (let i = 0; i < 20; i++) expect(b.take("d")).toBe(0);
    expect(b.take("d")).toBeGreaterThan(0);
    t += 100;
    expect(b.take("d")).toBe(0);
    expect(b.take("d")).toBe(0);
    expect(b.take("d")).toBeGreaterThan(0);
  });
});

describe("misc helpers", () => {
  it("etag matching ignores quotes and W/, rejects *", () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches("abc", '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches("*", '"abc"')).toBe(false);
    expect(etagMatches('""', '"abc"')).toBe(false);
  });

  it("strict b64u rejects non-canonical trailing bits", () => {
    expect(b64uDecodeStrict("AQ")).not.toBeNull();
    expect(b64uDecodeStrict("AR")).toBeNull();
  });

  it("env options: limits, port 0, proxy and origins", () => {
    const o = optionsFromEnv({
      SHUTTLE_DATA: "/data", SHUTTLE_PORT: "0", SHUTTLE_MAX_BLOB: "1000", SHUTTLE_MAX_COMMIT_OPS: "50",
      SHUTTLE_TRUST_PROXY: "1", SHUTTLE_ALLOWED_ORIGINS: "app://obsidian.md, capacitor://localhost", SHUTTLE_PUBLIC_URL: "https://sync.example.com",
    });
    expect(o).toMatchObject({ host: "0.0.0.0", port: 0, trustProxy: true, publicUrl: "https://sync.example.com", allowedOrigins: ["app://obsidian.md", "capacitor://localhost"] });
    const cfg = resolveConfig(o);
    expect(cfg.limits).toMatchObject({ maxBlobSize: 1000, maxCommitOps: 50, maxPackBytes: 8 * 1024 * 1024 });
    expect(cfg.limits.maxRequestBody).toBe(8 * 1024 * 1024 + 256 * 1024);
    expect(() => optionsFromEnv({ SHUTTLE_MAX_BLOB: "-1" })).toThrow();
    expect(resolveConfig({ dataDir: "/x" }).limits.maxRequestBody).toBe(8650752);
  });
});

describe("group commit", () => {
  it("concurrent commits from several devices share transactions; seqs are unique and dense; a bad commit fails alone", async () => {
    const dir = await tempDir("group");
    const srv = await start(dir);
    try {
      const { c, vid } = await fixture(srv, dir);
      const sockets: TestWs[] = [];
      for (let i = 0; i < 4; i++) {
        const d = i === 0 ? c : await login(srv, "alice", `dev-${i}`);
        const w = await TestWs.open(srv);
        await w.connect(d.token, vid);
        sockets.push(w);
      }
      const dupCid = cid();
      await sockets[0]!.commit([putOp(fileId(), null, pathKey())], { cid: dupCid });
      // 4 per socket = maxInFlightCommits (design §2.9.4); more would be refused RATE_LIMITED.
      const all = await Promise.all(sockets.flatMap((w) => Array.from({ length: 4 }, () => w.commit([putOp(fileId(), null, pathKey()), putOp(fileId(), null, pathKey())]))));
      const seqs = all.flatMap((r) => r.results.map((x) => (x as { seqs: number[] }).seqs[0]!)).sort((a, b) => a - b);
      expect(seqs).toHaveLength(32);
      expect(new Set(seqs).size).toBe(32);
      expect(seqs[31]! - seqs[0]!).toBe(31);
      // Same cid, different digest, queued together with good commits: only that socket fails.
      const rid = sockets[0]!.nextRid();
      sockets[0]!.send({ type: "commit", rid, cid: dupCid, ops: [putOp(fileId(), null, pathKey())] });
      const ok = await sockets[1]!.commit([putOp(fileId(), null, pathKey())]);
      expect(ok.results[0]!.ok).toBe(true);
      expect((await sockets[0]!.waitClose()).code).toBe(4400);
      for (const w of sockets) w.close();
    } finally {
      await srv.close();
      await removeDir(dir);
    }
  });
});
