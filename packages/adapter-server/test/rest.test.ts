// REST error mapping, URL normalization, timeouts and REST-side adapter calls on a scripted HttpClient.
import { describe, expect, it } from "vitest";
import { CloseCode, DEFAULT_LIMITS } from "@shuttle/protocol";
import { closeAction, codeFromStatus, errorFromResponse, networkError, normalizeBaseUrls, wsUrlOf } from "../src/index";
import { harness, json, VID } from "./fakes";

const enc = new TextEncoder();
const raw = (status: number, text: string, headers: Record<string, string> = {}) => ({ status, headers, body: enc.encode(text).buffer as ArrayBuffer });

describe("error mapping", () => {
  it.each([
    [401, "UNAUTHENTICATED", "UNAUTHENTICATED", false],
    [401, "REVOKED", "REVOKED", false],
    [401, "BAD_CREDENTIALS", "UNAUTHENTICATED", false],
    [403, "FORBIDDEN", "FORBIDDEN", false],
    [404, "VAULT_NOT_FOUND", "VAULT_NOT_FOUND", false],
    [404, "NOT_FOUND", "NOT_FOUND", false],
    [409, "VAULT_EXISTS", "ALREADY_EXISTS", false],
    [409, "NAME_TAKEN", "ALREADY_EXISTS", false],
    [409, "EXISTS", "ALREADY_EXISTS", false],
    [409, "SNAPSHOT_REQUIRED", "SNAPSHOT_REQUIRED", false],
    [410, "CODE_EXPIRED", "NOT_FOUND", false],
    [412, "PRECONDITION_FAILED", "PRECONDITION_FAILED", false],
    [413, "TOO_LARGE", "TOO_LARGE", false],
    [422, "HASH_MISMATCH", "HASH_MISMATCH", true],
    [429, "RATE_LIMITED", "RATE_LIMITED", true],
    [500, "SERVER", "SERVER", true],
    [503, "UNAVAILABLE", "UNAVAILABLE", true],
    [507, "QUOTA", "QUOTA", true],
    [400, "INVALID", "PROTOCOL", false],
  ])("HTTP %i %s → %s", (status, wire, code, retry) => {
    const e = errorFromResponse(json(status, { error: { code: wire, message: "m" } }), "op");
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retry);
  });

  it("keeps retryAfterMs and details", () => {
    const e = errorFromResponse(json(429, { error: { code: "RATE_LIMITED", retryAfterMs: 1234 } }), "op");
    expect(e.retryAfterMs).toBe(1234);
    const p = errorFromResponse(json(412, { error: { code: "PRECONDITION_FAILED", details: { etag: "\"x\"" } } }), "op");
    expect(p.details).toEqual({ etag: "\"x\"" });
  });

  it("falls back to the status for non-Shuttle bodies", () => {
    expect(errorFromResponse(raw(502, "<html>bad gateway</html>"), "op").code).toBe("UNAVAILABLE");
    expect(errorFromResponse(raw(500, ""), "op").code).toBe("SERVER");
    expect(errorFromResponse(raw(413, "nginx says no"), "op").code).toBe("TOO_LARGE");
    expect(errorFromResponse(raw(429, "", { "Retry-After": "3" }), "op").retryAfterMs).toBe(3000);
    expect(codeFromStatus(418)).toBe("PROTOCOL");
  });

  it("maps thrown client errors to NETWORK or TIMEOUT", () => {
    expect(networkError(new Error("ECONNREFUSED"), "x").code).toBe("NETWORK");
    expect(networkError(new Error("request timed out"), "x").code).toBe("TIMEOUT");
  });

  it("close codes", () => {
    expect(closeAction(CloseCode.UNAUTHENTICATED, "", null)).toMatchObject({ kind: "stop", state: "auth-error" });
    expect(closeAction(CloseCode.FORBIDDEN, "", null)).toMatchObject({ kind: "stop", error: { code: "FORBIDDEN" } });
    expect(closeAction(CloseCode.VAULT_NOT_FOUND, "", null)).toMatchObject({ kind: "stop", error: { code: "VAULT_NOT_FOUND" } });
    expect(closeAction(CloseCode.SUPERSEDED, "", null)).toMatchObject({ kind: "stop", state: "offline" });
    expect(closeAction(CloseCode.GOING_AWAY, "", null)).toEqual({ kind: "reconnect", delay: "jitter" });
    expect(closeAction(CloseCode.RESTART, "", null)).toEqual({ kind: "reconnect", delay: "restart" });
    for (const c of [1006, 4400, 4408, 4429, 4500]) expect(closeAction(c, "", null)).toEqual({ kind: "reconnect", delay: "backoff" });
  });
});

describe("URLs", () => {
  it("normalizes and derives the WebSocket URL, keeping a path prefix", () => {
    expect(normalizeBaseUrls(["https://sync.example.com/", "https://sync.example.com/shuttle//"], false))
      .toEqual(["https://sync.example.com", "https://sync.example.com/shuttle"]);
    expect(wsUrlOf("https://sync.example.com/shuttle")).toBe("wss://sync.example.com/shuttle/v1/ws");
    expect(wsUrlOf("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/v1/ws");
    expect(() => normalizeBaseUrls([], false)).toThrow();
    expect(() => normalizeBaseUrls(["ftp://sync.example.com"], false)).toThrow();
    expect(() => normalizeBaseUrls(["https://sync.example.com/?token=x"], false)).toThrow();
    expect(normalizeBaseUrls(["http://localhost:8787"], false)).toEqual(["http://localhost:8787"]);
  });
});

describe("REST calls", () => {
  it("connect() on a missing vault returns the remote-empty info", async () => {
    const h = harness();
    h.http.routes.push((r) => r.url.endsWith("/v1/me")
      ? json(200, { user: { userId: "u", username: "alice", role: "owner" }, device: { deviceId: "D".repeat(22), name: "n", platform: "linux", clientVersion: null, createdAt: 1, lastSeenAt: null, revoked: false, current: true } })
      : null);
    h.http.routes.push((r) => r.url.endsWith("/info") ? json(404, { error: { code: "VAULT_NOT_FOUND" } }) : null);
    const info = await h.adapter.connect();
    expect(info).toMatchObject({ deviceId: "D".repeat(22), headSeq: 0, minSeq: 0, infoEtag: null });
    expect(h.http.log.find((r) => r.url.endsWith("/v1/me"))!.headers!["Authorization"]).toBe("Bearer sxd_test");
    expect(h.pool.sockets).toHaveLength(0); // connect() does not start the feed
  });

  it("connect() reads limits from /v1/me (else /v1/health) so REST commits respect them before subscribe", async () => {
    const meBody = { user: { userId: "u", username: "alice", role: "owner" }, device: { deviceId: "D".repeat(22), name: "n", platform: "linux", clientVersion: null, createdAt: 1, lastSeenAt: null, revoked: false, current: true } };
    const op = { op: "del" as const, fileId: "a".repeat(32), base: 1, pathKey: "cGF0aA", rc: "note" as const, kv: 1, meta: "bWV0YQ" };
    const commitCalls = (h: ReturnType<typeof harness>) => h.http.log.filter((r) => r.url.endsWith("/commit")).length;
    for (const where of ["me", "health"] as const) {
      const h = harness();
      const small = { ...DEFAULT_LIMITS, maxCommitOps: 2, maxBlobSize: 4096 };
      if (where === "health") h.http.healthLimits = { ...small };
      h.http.routes.push((r) => r.url.endsWith("/v1/me") ? json(200, where === "me" ? { ...meBody, limits: small } : meBody) : null);
      h.http.routes.push((r) => r.url.endsWith("/info") ? json(404, { error: { code: "VAULT_NOT_FOUND" } }) : null);
      h.http.routes.push((r) => r.url.endsWith("/commit")
        ? json(200, { cid: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", headSeq: 1, replayed: false, results: [{ i: 0, ok: true, seqs: [1] }] })
        : null);
      expect(h.adapter.capabilities.limits.maxCommitOps).toBe(DEFAULT_LIMITS.maxCommitOps);
      const info = await h.adapter.connect();
      expect(info.capabilities.limits).toMatchObject({ maxCommitOps: 2, maxBlobSize: 4096 });
      expect(h.adapter.capabilities.limits.maxCommitOps).toBe(2);
      await expect(h.adapter.commit({ cid: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", ops: [op, op, op] })).rejects.toMatchObject({ code: "TOO_LARGE" });
      expect(commitCalls(h)).toBe(0); // refused locally, nothing sent
      await expect(h.adapter.commit({ cid: "6f9619ff-8b86-4011-b42d-00cf4fc964ff", ops: [op] })).resolves.toMatchObject({ headSeq: 1 });
      expect(commitCalls(h)).toBe(1);
    }
  });

  it("connect() keeps the protocol defaults when the server sends no limits", async () => {
    const h = harness();
    h.http.routes.push((r) => r.url.endsWith("/v1/me")
      ? json(200, { user: { userId: "u", username: "alice", role: "owner" }, device: { deviceId: "D".repeat(22), name: "n", platform: "linux", clientVersion: null, createdAt: 1, lastSeenAt: null, revoked: false, current: true } })
      : null);
    h.http.routes.push((r) => r.url.endsWith("/info") ? json(404, { error: { code: "VAULT_NOT_FOUND" } }) : null);
    const info = await h.adapter.connect();
    expect(info.capabilities.limits.maxCommitOps).toBe(DEFAULT_LIMITS.maxCommitOps);
  });

  it("a 404 NOT_FOUND on vault-info is not mistaken for an empty remote", async () => {
    const h = harness();
    h.http.routes.push((r) => r.url.endsWith("/info") ? json(404, { error: { code: "NOT_FOUND" } }) : null);
    await expect(h.adapter.getVaultInfo()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("times out a request that never answers and re-probes next time", async () => {
    const h = harness({ timeouts: { requestMs: 1000 } });
    let hang = true;
    h.http.routes.push((r) => r.url.includes("/usage") && hang ? new Promise(() => { /* never */ }) : null);
    h.http.routes.push((r) => r.url.includes("/usage") ? json(200, { liveBytes: 1, historyBytes: 2, blobCount: 3, fileCount: 4, quotaBytes: null, largest: [] }) : null);
    const p = h.adapter.usage().catch((e: unknown) => e);
    await h.advance(1000);
    expect(await p).toMatchObject({ code: "TIMEOUT", retryable: true });
    hang = false;
    const healthBefore = h.http.log.filter((r) => r.url.endsWith("/health")).length;
    await expect(h.adapter.usage()).resolves.toMatchObject({ liveBytes: 1, exact: true });
    expect(h.http.log.filter((r) => r.url.endsWith("/health")).length).toBe(healthBefore + 1);
  });

  it("putBlob retries HASH_MISMATCH at most 3 times and sends the body hash", async () => {
    const h = harness();
    let puts = 0;
    h.http.routes.push((r) => {
      if (r.method !== "PUT" || !r.url.includes("/blobs/")) return null;
      puts++;
      return json(422, { error: { code: "HASH_MISMATCH" } });
    });
    await expect(h.adapter.putBlob("a".repeat(64), new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    expect(puts).toBe(3);
    const put = h.http.log.find((r) => r.method === "PUT")!;
    expect(put.headers!["X-Shuttle-Sha256"]).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    expect(put.url).toBe(`https://sync.example.com/v1/vaults/${VID}/blobs/${"a".repeat(64)}`);
  });

  it("commit without a subscription goes over POST /commit and checks the answer", async () => {
    const h = harness();
    h.http.routes.push((r) => r.url.endsWith("/commit") ? json(200, { cid: "other", headSeq: 1, replayed: false, results: [] }) : null);
    await expect(h.adapter.commit({ cid: "6f1c3a52-6a2e-4d61-9a5e-2b1b8a1f0c11", ops: [] })).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("runMaintenance is a no-op on the own server", async () => {
    await expect(harness().adapter.runMaintenance()).resolves.toEqual({ ran: false });
  });
});
