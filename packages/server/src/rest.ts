// REST endpoints (design §2.8.4, §2.8.5). AGPL-3.0-only.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CHANGES_LIMIT_DEFAULT, CHANGES_WAIT_MAX_SEC, ENROLL_CODE_TTL_SEC, ENROLL_URI_ACTION, HEADER_CONFIRM, HEADER_REQUEST_ID,
  HEADER_SERVER, HEADER_SHA256, LIVE_MAX_BYTES, PACK_CONTENT_TYPE, PAIRING_TTL_SEC, PackError, SNAPSHOT_PAGE_DEFAULT,
  SNAPSHOT_PAGE_MAX, SUPPORTED_PROTOCOLS, checkCommitLimits, decodePack, encodePack, isBlobId, isDeviceId, isFileId,
  isPairId, isSha256Hex, isVaultId, validateAckRequest, validateCommitRequest, validateCreateVaultRequest,
  validateEnrollCodeRequest, validateEnrollRequest, validateLoginRequest, validateMissingBlobsRequest,
  validatePackGetRequest, validatePairingBody, validateRebuildRequest, validateRenameDeviceRequest,
  validateVaultInfoEnvelope,
} from "@shuttle/protocol";
import type {
  AuthResponse, ChangesResponse, CreateVaultResponse, DeviceDescriptor, DeviceInfo, EnrollCodeResponse, ErrorBody,
  HealthResponse, MeResponse, PackEntry, SnapshotReason, SnapshotResponse, UserInfo, Validation, VaultSummary, WelcomeLimits,
} from "@shuttle/protocol";
import { enrollCodeHash, newEnrollCode, normalizeEnrollCode, verifyPassword } from "./auth";
import { looksSealed } from "./blobs";
import { txImmediate } from "./db";
import type { DeviceRow, Server, UserRow } from "./server-core";
import { CommitProtocolError, type VaultRow } from "./store";
import { HttpError, errText } from "./util";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  ip: string;
  url: URL;
  method: string;
}

interface Authed { device: DeviceRow; user: UserRow }

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function originAllowed(srv: Server, origin: string | undefined): boolean {
  return origin === undefined || srv.cfg.allowedOrigins === null || srv.cfg.allowedOrigins.includes(origin);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(data.length), ...extra });
  res.end(data);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Length": "0" });
  res.end();
}

function sendError(res: ServerResponse, e: HttpError): void {
  if (res.headersSent) { res.destroy(); return; }
  const body: ErrorBody = { error: { code: e.code, message: e.message } };
  if (e.extra.retryAfterMs !== undefined) body.error.retryAfterMs = e.extra.retryAfterMs;
  if (e.extra.details !== undefined) body.error.details = e.extra.details;
  const extra: Record<string, string> = {};
  if (e.extra.retryAfterMs !== undefined) extra["Retry-After"] = String(Math.ceil(e.extra.retryAfterMs / 1000));
  sendJson(res, e.status, body, extra);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > max) { req.resume(); throw new HttpError("TOO_LARGE", `body exceeds ${max} bytes`); }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) { req.resume(); throw new HttpError("TOO_LARGE", `body exceeds ${max} bytes`); }
    chunks.push(c);
  }
  return Buffer.concat(chunks, n);
}

async function readJson<T>(srv: Server, req: IncomingMessage, validate: (v: unknown) => Validation<T>, max = srv.cfg.limits.maxRequestBody): Promise<{ value: T; bytes: number }> {
  const buf = await readBody(req, max);
  let v: unknown;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError("INVALID", "body is not JSON");
  }
  const r = validate(v);
  if (!r.ok) throw new HttpError("INVALID", `invalid body at ${r.path}: ${r.reason}`);
  return { value: r.value, bytes: buf.length };
}

function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const s = url.searchParams.get(name);
  if (s === null || s === "") return def;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) throw new HttpError("INVALID", `bad ${name}`);
  return Math.min(n, max);
}

function userInfo(u: UserRow): UserInfo {
  return { userId: u.user_id, username: u.username, role: u.role };
}

function deviceInfo(d: DeviceRow, currentId: string): DeviceInfo {
  return {
    deviceId: d.device_id, name: d.name, platform: d.platform, clientVersion: d.client_version, createdAt: d.created_at,
    lastSeenAt: d.last_seen_at, revoked: d.revoked_at !== null, current: d.device_id === currentId,
  };
}

function descriptor(d: DeviceDescriptor): { name: string; platform: string; clientVersion: string | null } {
  return { name: d.name, platform: d.platform, clientVersion: d.clientVersion ?? null };
}

/** Entry point for one HTTP request. Never throws. */
export async function handleRest(srv: Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader(HEADER_SERVER, srv.version);
  const rid = req.headers[HEADER_REQUEST_ID.toLowerCase()];
  if (typeof rid === "string" && rid.length <= 128) res.setHeader(HEADER_REQUEST_ID, rid);
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const ctx: Ctx = { req, res, ip: clientIp(req, srv.cfg.trustProxy), url, method };
  try {
    if (!originAllowed(srv, req.headers.origin)) throw new HttpError("FORBIDDEN", "origin not allowed");
    await route(srv, ctx);
  } catch (e) {
    if (!req.complete) req.resume();
    if (e instanceof HttpError) sendError(res, e);
    else {
      srv.cfg.log(`error ${method} ${url.pathname}${typeof rid === "string" ? ` rid=${rid.slice(0, 64)}` : ""}: ${errText(e)}`);
      sendError(res, new HttpError("SERVER", "internal error"));
    }
  }
}

function segments(pathname: string): string[] {
  const parts = pathname.split("/").slice(1);
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    throw new HttpError("BAD_ID", "malformed percent-encoding");
  }
}

function methodNotAllowed(): never {
  throw new HttpError("INVALID", "method not allowed", { status: 405 });
}

async function route(srv: Server, c: Ctx): Promise<void> {
  const seg = segments(c.url.pathname);
  if (seg[0] !== "v1") throw new HttpError("NOT_FOUND", "no such endpoint");
  const [, a, b, cc, d, e, f] = seg;
  const m = c.method;
  if (a === "health" && seg.length === 2) {
    if (m !== "GET") methodNotAllowed();
    // `limits` is additive (not yet in the protocol's HealthResponse): adapters learn them before subscribe.
    const body: HealthResponse & { limits: WelcomeLimits } = {
      ok: true, server: srv.version, protocols: [...SUPPORTED_PROTOCOLS], time: Date.now(), source: srv.cfg.sourceUrl,
      limits: { ...srv.cfg.limits },
    };
    return sendJson(c.res, 200, body);
  }
  if (a === "auth" && seg.length === 3) {
    if (m !== "POST") methodNotAllowed();
    if (b === "login") return login(srv, c);
    if (b === "enroll") return enroll(srv, c);
    if (b === "logout") {
      const au = authenticate(srv, c);
      srv.revokeDevice(au.device.device_id);
      return sendEmpty(c.res, 204);
    }
  }
  const au = authenticate(srv, c);
  if (a === "me" && seg.length === 2) {
    if (m !== "GET") methodNotAllowed();
    const body: MeResponse & { limits: WelcomeLimits } = {
      user: userInfo(au.user), device: deviceInfo(au.device, au.device.device_id), limits: { ...srv.cfg.limits },
    };
    return sendJson(c.res, 200, body);
  }
  if (a === "enroll-codes" && seg.length === 2) {
    if (m !== "POST") methodNotAllowed();
    return createEnrollCode(srv, c, au);
  }
  if (a === "devices") {
    if (seg.length === 2) {
      if (m !== "GET") methodNotAllowed();
      const rows = au.user.role === "owner"
        ? srv.s.all<DeviceRow>("SELECT * FROM devices ORDER BY created_at")
        : srv.s.all<DeviceRow>("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at", au.user.user_id);
      return sendJson(c.res, 200, { devices: rows.map((r) => deviceInfo(r, au.device.device_id)) });
    }
    if (seg.length === 3 && b !== undefined) return deviceById(srv, c, au, b);
  }
  if (a === "vaults") {
    if (seg.length === 2) {
      if (m === "GET") return listVaults(srv, c, au);
      if (m === "POST") return createVault(srv, c, au);
      methodNotAllowed();
    }
    if (b === undefined || !isVaultId(b)) { c.req.resume(); throw new HttpError("BAD_ID", "bad vaultId"); }
    const v = vaultFor(srv, b, au);
    if (seg.length === 3) {
      if (m !== "DELETE") methodNotAllowed();
      requireOwner(srv, v, au);
      if (c.req.headers[HEADER_CONFIRM.toLowerCase()] !== v.name) throw new HttpError("INVALID", `${HEADER_CONFIRM} must carry the vault name`);
      srv.softDeleteVault(v);
      return sendEmpty(c.res, 202);
    }
    switch (cc) {
      case "info": if (seg.length === 4) return info(srv, c, v); break;
      case "rebuild": if (seg.length === 4) {
        if (m !== "POST") methodNotAllowed();
        requireOwner(srv, v, au);
        const { value } = await readJson(srv, c.req, validateRebuildRequest);
        return sendJson(c.res, 200, srv.rebuild(v, value.info));
      } break;
      case "usage": if (seg.length === 4) {
        if (m !== "GET") methodNotAllowed();
        return sendJson(c.res, 200, { ...srv.store.usage(v.vault_id), quotaBytes: v.quota_bytes });
      } break;
      case "blobs": return blobs(srv, c, au, v, seg.slice(4));
      case "snapshot": if (seg.length === 4) return snapshot(srv, c, v);
      break;
      case "changes": if (seg.length === 4) return changes(srv, c, au, v);
      break;
      case "commit": if (seg.length === 4) return commit(srv, c, au, v);
      break;
      case "ack": if (seg.length === 4) {
        if (m !== "POST") methodNotAllowed();
        const { value } = await readJson(srv, c.req, validateAckRequest);
        srv.store.ackCursor(v.vault_id, au.device.device_id, Math.min(value.upTo, v.head_seq));
        return sendEmpty(c.res, 204);
      } break;
      case "files": if (d !== undefined && isFileId(d) && e === "versions") return history(srv, c, v, d, f, seg.length);
      break;
      case "deleted": if (seg.length === 4) {
        if (m !== "GET") methodNotAllowed();
        const before = intParam(c.url, "before", Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
        return sendJson(c.res, 200, srv.store.deleted(v.vault_id, before, intParam(c.url, "limit", 100, 1, 1000)));
      } break;
      case "pairing": if (seg.length === 5 && d !== undefined) return pairing(srv, c, au, v, d);
      break;
    }
  }
  c.req.resume();
  throw new HttpError("NOT_FOUND", "no such endpoint");
}

// ---------------- auth ----------------

function authenticate(srv: Server, c: Ctx): Authed {
  const h = c.req.headers.authorization;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  if (!m) { c.req.resume(); throw new HttpError("UNAUTHENTICATED", "missing bearer token"); }
  const r = srv.authToken(m[1]!, c.ip);
  if (!r.ok) { c.req.resume(); throw new HttpError(r.code, r.code === "REVOKED" ? "this device was removed" : "not logged in"); }
  srv.touchDevice(r.device.device_id, c.ip);
  return { device: r.device, user: r.user };
}

async function login(srv: Server, c: Ctx): Promise<void> {
  const { value } = await readJson(srv, c.req, validateLoginRequest, 64 * 1024);
  const keys = [`ip:${c.ip}`, `user:${value.username}`];
  const wait = Math.max(...keys.map((k) => srv.loginLimiter.blockedFor(k)));
  if (wait > 0) throw new HttpError("RATE_LIMITED", "too many failed logins", { retryAfterMs: wait });
  const user = srv.s.get<UserRow>("SELECT * FROM users WHERE username = ?", value.username);
  const ok = await verifyPassword(value.password, user?.pw_hash ?? null, srv.cfg.scrypt);
  if (!ok || !user) {
    for (const k of keys) srv.loginLimiter.fail(k);
    throw new HttpError("BAD_CREDENTIALS", "wrong username or password");
  }
  const created = srv.createDevice(user.user_id, descriptor(value.device));
  const body: AuthResponse = { token: created.token, deviceId: created.deviceId, user: userInfo(user) };
  sendJson(c.res, 200, body, { "Cache-Control": "no-store" });
}

async function enroll(srv: Server, c: Ctx): Promise<void> {
  const { value } = await readJson(srv, c.req, validateEnrollRequest, 64 * 1024);
  const ipKey = `ip:${c.ip}`;
  const wait = srv.loginLimiter.blockedFor(ipKey);
  if (wait > 0) throw new HttpError("RATE_LIMITED", "too many failed attempts", { retryAfterMs: wait });
  const norm = normalizeEnrollCode(value.code);
  const now = srv.cfg.now();
  const out = norm === null ? null : txImmediate(srv.db, () => {
    const row = srv.s.get<{ user_id: string; expires_at: number; used_at: number | null }>(
      "SELECT user_id, expires_at, used_at FROM enroll_codes WHERE code_hash = ?", enrollCodeHash(norm));
    if (!row || row.used_at !== null || row.expires_at <= now) return null;
    const user = srv.s.get<UserRow>("SELECT * FROM users WHERE user_id = ?", row.user_id);
    if (!user) return null;
    const created = srv.createDevice(user.user_id, descriptor(value.device));
    srv.s.run("UPDATE enroll_codes SET used_at = ?, used_by = ? WHERE code_hash = ?", now, created.deviceId, enrollCodeHash(norm));
    return { created, user };
  });
  if (!out) {
    srv.loginLimiter.fail(ipKey);
    throw new HttpError("CODE_EXPIRED", "enroll code expired, used or unknown");
  }
  const body: AuthResponse = { token: out.created.token, deviceId: out.created.deviceId, user: userInfo(out.user) };
  sendJson(c.res, 200, body, { "Cache-Control": "no-store" });
}

export function issueEnrollCode(srv: Server, userId: string, createdBy: string | null, ttlSec: number): { code: string; expiresAt: number } {
  const code = newEnrollCode();
  const expiresAt = srv.cfg.now() + ttlSec * 1000;
  srv.s.run("INSERT INTO enroll_codes (code_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
    enrollCodeHash(normalizeEnrollCode(code)!), userId, createdBy, expiresAt);
  return { code, expiresAt };
}

async function createEnrollCode(srv: Server, c: Ctx, au: Authed): Promise<void> {
  if (au.user.role !== "owner") { c.req.resume(); throw new HttpError("FORBIDDEN", "owner only"); }
  const { value } = await readJson(srv, c.req, validateEnrollCodeRequest, 4096);
  const ttl = Math.min(value.ttlSec ?? ENROLL_CODE_TTL_SEC, 86_400);
  const { code, expiresAt } = issueEnrollCode(srv, au.user.user_id, au.device.device_id, ttl);
  const base = srv.cfg.publicUrl ?? requestBase(c);
  const link = `obsidian://${ENROLL_URI_ACTION}?server=${encodeURIComponent(base)}&code=${encodeURIComponent(code)}`;
  const body: EnrollCodeResponse = { code, expiresAt, link };
  sendJson(c.res, 200, body, { "Cache-Control": "no-store" });
}

function requestBase(c: Ctx): string {
  const proto = (c.req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  const host = (c.req.headers["x-forwarded-host"] as string | undefined) ?? c.req.headers.host ?? "127.0.0.1";
  return `${proto}://${host}`;
}

async function deviceById(srv: Server, c: Ctx, au: Authed, id: string): Promise<void> {
  if (!isDeviceId(id)) { c.req.resume(); throw new HttpError("BAD_ID", "bad deviceId"); }
  const d = srv.s.get<DeviceRow>("SELECT * FROM devices WHERE device_id = ?", id);
  // A user manages their own devices; an owner manages every device on the server.
  if (!d || (d.user_id !== au.user.user_id && au.user.role !== "owner")) { c.req.resume(); throw new HttpError("NOT_FOUND", "no such device"); }
  if (c.method === "PATCH") {
    const { value } = await readJson(srv, c.req, validateRenameDeviceRequest, 4096);
    srv.s.run("UPDATE devices SET name = ? WHERE device_id = ?", value.name, id);
    return sendEmpty(c.res, 204);
  }
  if (c.method === "DELETE") {
    srv.revokeDevice(id);
    return sendEmpty(c.res, 204);
  }
  methodNotAllowed();
}

// ---------------- vaults ----------------

function vaultFor(srv: Server, vid: string, au: Authed): VaultRow {
  const v = srv.store.vault(vid);
  if (!v) { throw new HttpError("VAULT_NOT_FOUND", "vault not found"); }
  if (srv.store.memberRole(vid, au.user.user_id) === null) throw new HttpError("FORBIDDEN", "not a member of this vault");
  return v;
}

function requireOwner(srv: Server, v: VaultRow, au: Authed): void {
  if (srv.store.memberRole(v.vault_id, au.user.user_id) !== "owner") throw new HttpError("FORBIDDEN", "vault owner only");
}

function listVaults(srv: Server, c: Ctx, au: Authed): void {
  const rows = srv.s.all<VaultRow & { role: string }>(
    `SELECT v.*, m.role FROM vaults v JOIN vault_members m ON m.vault_id = v.vault_id
     WHERE m.user_id = ? AND v.deleted_at IS NULL ORDER BY v.created_at`, au.user.user_id);
  const vaults: VaultSummary[] = rows.map((v) => ({
    vaultId: v.vault_id, name: v.name, role: v.role, createdAt: v.created_at, headSeq: v.head_seq,
    usage: { liveBytes: srv.store.usage(v.vault_id).liveBytes, totalBytes: srv.store.storedBytes(v.vault_id) },
  }));
  sendJson(c.res, 200, { vaults });
}

async function createVault(srv: Server, c: Ctx, au: Authed): Promise<void> {
  const { value } = await readJson(srv, c.req, validateCreateVaultRequest);
  const out: CreateVaultResponse = srv.createVault(au.user.user_id, value.name, value.info);
  sendJson(c.res, 201, out);
}

async function info(srv: Server, c: Ctx, v: VaultRow): Promise<void> {
  if (c.method === "GET") {
    const data = Buffer.from(v.info_json);
    c.res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(data.length), ETag: v.info_etag, "Cache-Control": "no-cache" });
    c.res.end(data);
    return;
  }
  if (c.method === "PUT") {
    const { value } = await readJson(srv, c.req, validateVaultInfoEnvelope);
    const ifMatch = c.req.headers["if-match"];
    const etag = srv.putInfo(v, value, typeof ifMatch === "string" ? ifMatch : null);
    return sendJson(c.res, 200, { etag }, { ETag: etag });
  }
  methodNotAllowed();
}

// ---------------- blobs ----------------

function blobRate(srv: Server, c: Ctx, au: Authed): void {
  const wait = srv.blobBuckets.take(au.device.device_id);
  if (wait > 0) { c.req.resume(); throw new HttpError("RATE_LIMITED", "too many blob requests", { retryAfterMs: wait }); }
}

async function blobs(srv: Server, c: Ctx, au: Authed, v: VaultRow, rest: string[]): Promise<void> {
  if (rest.length !== 1) throw new HttpError("NOT_FOUND", "no such endpoint");
  const id = rest[0]!;
  const vid = v.vault_id;
  blobRate(srv, c, au);
  const lim = srv.cfg.limits;
  if (id === "missing") {
    if (c.method !== "POST") methodNotAllowed();
    const { value } = await readJson(srv, c.req, validateMissingBlobsRequest);
    const missing = [...new Set(value.ids)].filter((b) => srv.blobs.row(vid, b)?.state !== "live");
    return sendJson(c.res, 200, { missing });
  }
  if (id === "pack-get") {
    if (c.method !== "POST") methodNotAllowed();
    const { value } = await readJson(srv, c.req, validatePackGetRequest);
    if (value.ids.length > srv.cfg.maxPackEntries) throw new HttpError("TOO_LARGE", `more than ${srv.cfg.maxPackEntries} ids`);
    const maxBytes = Math.min(value.maxBytes, lim.maxPackBytes);
    const entries: PackEntry[] = [];
    let total = 9;
    let haveOne = false;
    // Request order until the next entry would exceed maxBytes; at least one present blob if any exists.
    for (const b of value.ids) {
      const size = srv.blobs.readableSize(vid, b);
      if (haveOne && total + 36 + (size ?? 0) > maxBytes) break;
      let bytes: Uint8Array | null = null;
      if (size !== null) {
        try { bytes = await readFile(srv.blobs.blobPath(vid, b)); } catch { bytes = null; }
      }
      entries.push({ id: b, bytes });
      total += 36 + (bytes ? bytes.length : 0);
      if (bytes) haveOne = true;
    }
    const pack = encodePack(entries, { allowMissing: true, maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: srv.cfg.maxPackEntries });
    c.res.writeHead(200, { "Content-Type": PACK_CONTENT_TYPE, "Content-Length": String(pack.length) });
    c.res.end(pack);
    return;
  }
  if (id === "pack-put") {
    if (c.method !== "POST") methodNotAllowed();
    return packPut(srv, c, v);
  }
  if (!isBlobId(id)) { c.req.resume(); throw new HttpError("BAD_ID", "bad blobId"); }
  if (c.method === "PUT") return putBlob(srv, c, v, id);
  if (c.method === "GET" || c.method === "HEAD") {
    const size = srv.blobs.readableSize(vid, id);
    if (size === null) throw new HttpError("NOT_FOUND", "blob not found");
    c.res.writeHead(200, {
      "Content-Type": "application/octet-stream", "Content-Length": String(size), ETag: `"${id}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    if (c.method === "HEAD") { c.res.end(); return; }
    await new Promise<void>((resolve) => {
      const rs = createReadStream(srv.blobs.blobPath(vid, id));
      rs.on("error", () => { c.res.destroy(); resolve(); });
      c.res.on("close", () => { rs.destroy(); resolve(); });
      rs.pipe(c.res);
    });
    return;
  }
  methodNotAllowed();
}

async function putBlob(srv: Server, c: Ctx, v: VaultRow, id: string): Promise<void> {
  const max = srv.cfg.limits.maxBlobSize;
  const declared = c.req.headers["content-length"];
  if (declared !== undefined && Number(declared) > max) { c.req.resume(); throw new HttpError("TOO_LARGE", `blob exceeds ${max} bytes`); }
  const shaHeader = c.req.headers[HEADER_SHA256.toLowerCase()];
  const expected = typeof shaHeader === "string" ? shaHeader.toLowerCase() : undefined;
  if (!isSha256Hex(expected)) { c.req.resume(); throw new HttpError("INVALID", `missing or malformed ${HEADER_SHA256}`); }
  if (v.quota_bytes !== null && declared !== undefined) srv.blobs.checkQuota(v.quota_bytes, srv.store.storedBytes(v.vault_id), Number(declared));
  const { tmp, size } = await srv.blobs.stage(c.req, max, expected);
  let landed: "stored" | "present";
  try {
    // From here to the response write: synchronous (design §2.6.2 final step).
    const cur = srv.store.vault(v.vault_id);
    if (!cur) throw new HttpError("VAULT_NOT_FOUND", "vault not found");
    if (cur.quota_bytes !== null && !srv.blobs.row(cur.vault_id, id)) srv.blobs.checkQuota(cur.quota_bytes, srv.store.storedBytes(cur.vault_id), size);
    landed = srv.blobs.land(cur.vault_id, id, tmp, size);
  } catch (e) {
    srv.blobs.discard(tmp);
    throw e;
  }
  sendJson(c.res, landed === "stored" ? 201 : 200, { blobId: id, size, created: landed === "stored" });
}

async function packPut(srv: Server, c: Ctx, v: VaultRow): Promise<void> {
  const lim = srv.cfg.limits;
  const buf = await readBody(c.req, lim.maxPackBytes);
  const shaHeader = c.req.headers[HEADER_SHA256.toLowerCase()];
  if (typeof shaHeader === "string") {
    if (createHash("sha256").update(buf).digest("hex") !== shaHeader.toLowerCase()) throw new HttpError("HASH_MISMATCH", "body sha256 does not match");
  }
  let entries: PackEntry[];
  try {
    entries = decodePack(buf, { maxEntries: srv.cfg.maxPackEntries, maxBytes: lim.maxPackBytes });
  } catch (e) {
    if (e instanceof PackError) throw new HttpError("BAD_BLOB", `malformed pack: ${e.message}`);
    throw e;
  }
  for (const e of entries) {
    if (e.bytes === null) throw new HttpError("BAD_BLOB", "missing marker in pack-put");
    if (e.bytes.length > lim.maxBlobSize) throw new HttpError("TOO_LARGE", `blob exceeds ${lim.maxBlobSize} bytes`);
    if (!looksSealed(e.bytes, e.bytes.length)) throw new HttpError("BAD_BLOB", "not a sealed blob (magic or length)");
  }
  const vid = v.vault_id;
  const fresh = entries.filter((e) => !srv.blobs.row(vid, e.id));
  if (v.quota_bytes !== null) srv.blobs.checkQuota(v.quota_bytes, srv.store.storedBytes(vid), fresh.reduce((n, e) => n + e.bytes!.length, 0));
  const staged: Array<{ id: string; tmp: string; size: number }> = [];
  try {
    for (const e of entries) staged.push({ id: e.id, tmp: await srv.blobs.stageBytes(e.bytes!), size: e.bytes!.length });
  } catch (e) {
    for (const s of staged) srv.blobs.discard(s.tmp);
    throw e;
  }
  let stored = 0;
  let present = 0;
  const seen = new Set<string>();
  for (const s of staged) {
    if (seen.has(s.id)) { srv.blobs.discard(s.tmp); present++; continue; }
    seen.add(s.id);
    if (srv.blobs.land(vid, s.id, s.tmp, s.size) === "stored") stored++; else present++;
  }
  sendJson(c.res, 200, { stored, present });
}

// ---------------- feed over REST ----------------

function snapshot(srv: Server, c: Ctx, v: VaultRow): void {
  if (c.method !== "GET") methodNotAllowed();
  const limit = intParam(c.url, "limit", SNAPSHOT_PAGE_DEFAULT, 1, SNAPSHOT_PAGE_MAX);
  const t = c.url.searchParams.get("tombstones");
  const tombstones = t === "1" || t === "true";
  const after = c.url.searchParams.get("after");
  if (after !== null && after !== "" && !isFileId(after)) throw new HttpError("INVALID", "bad after");
  // headSeq is read before the page query (v is the row read for this request).
  const page = srv.store.snapshotPage(v.vault_id, after ?? "", limit, tombstones);
  const body: SnapshotResponse = { headSeq: v.head_seq, minSeq: v.min_seq, epoch: v.epoch, records: page.records, next: page.next };
  sendJson(c.res, 200, body);
}

function snapshotRequired(v: VaultRow, reason: SnapshotReason): HttpError {
  return new HttpError("SNAPSHOT_REQUIRED", `snapshot required (${reason})`, {
    details: { minSeq: v.min_seq, epoch: v.epoch, reason, rollbackAt: reason === "rollback" ? v.rollback_at : null },
  });
}

async function changes(srv: Server, c: Ctx, au: Authed, v: VaultRow): Promise<void> {
  if (c.method !== "GET") methodNotAllowed();
  const sinceText = c.url.searchParams.get("since");
  const since = Number(sinceText);
  if (sinceText === null || sinceText === "" || !Number.isSafeInteger(since) || since < 0) throw new HttpError("INVALID", "bad since");
  const limit = intParam(c.url, "limit", CHANGES_LIMIT_DEFAULT, 1, CHANGES_LIMIT_DEFAULT);
  const wait = intParam(c.url, "wait", 0, 0, CHANGES_WAIT_MAX_SEC);
  const epochText = c.url.searchParams.get("epoch");
  const ackText = c.url.searchParams.get("rollbackAck");
  if (epochText !== null && Number(epochText) !== v.epoch) throw snapshotRequired(v, "epoch");
  if (since < v.min_seq) throw snapshotRequired(v, "cursor-too-old");
  if (v.rollback_at !== null && v.restored_seq !== null && since > v.restored_seq) {
    if (ackText !== null && Number(ackText) === v.rollback_at) srv.store.setRollbackAck(v.vault_id, au.device.device_id, v.rollback_at, since);
    else if (srv.store.rollbackAckOf(v.vault_id, au.device.device_id) !== v.rollback_at) throw snapshotRequired(v, "rollback");
  }
  const read = (): ChangesResponse => {
    const cur = srv.store.vault(v.vault_id) ?? v;
    const page = srv.store.headsSince(cur.vault_id, since, limit, LIVE_MAX_BYTES);
    const to = page.full ? page.lastSeq! : Math.max(cur.head_seq, since);
    return { from: since, to, headSeq: Math.max(cur.head_seq, to), minSeq: cur.min_seq, records: page.records, more: page.full };
  };
  let body = read();
  if (body.records.length === 0 && body.to === since && wait > 0) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); unsub(); resolve(); };
      const t = setTimeout(finish, wait * 1000);
      const unsub = srv.hub.waitFor(v.vault_id, finish);
      c.res.on("close", finish);
    });
    if (c.res.destroyed) return;
    body = read();
  }
  sendJson(c.res, 200, body);
}

async function commit(srv: Server, c: Ctx, au: Authed, v: VaultRow): Promise<void> {
  if (c.method !== "POST") methodNotAllowed();
  const { value, bytes } = await readJson(srv, c.req, validateCommitRequest);
  const wait = srv.commitBuckets.take(au.device.device_id);
  if (wait > 0) throw new HttpError("RATE_LIMITED", "too many commits", { retryAfterMs: wait });
  const lim = checkCommitLimits(value, bytes, srv.cfg.limits);
  if (lim) throw new HttpError("TOO_LARGE", lim.message);
  try {
    const out = await srv.commitAsync(v.vault_id, au.device.device_id, value);
    sendJson(c.res, 200, out.response);
  } catch (e) {
    if (e instanceof CommitProtocolError) throw new HttpError("PROTOCOL", e.message);
    throw e;
  }
}

function history(srv: Server, c: Ctx, v: VaultRow, fileId: string, seqText: string | undefined, n: number): void {
  if (c.method !== "GET") methodNotAllowed();
  if (n === 6) {
    const before = intParam(c.url, "before", Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
    return sendJson(c.res, 200, srv.store.versionsOf(v.vault_id, fileId, before, intParam(c.url, "limit", 50, 1, 500)));
  }
  if (n === 7 && seqText !== undefined) {
    const seq = Number(seqText);
    if (!Number.isSafeInteger(seq) || seq <= 0) throw new HttpError("INVALID", "bad seq");
    const rec = srv.store.versionOf(v.vault_id, fileId, seq);
    if (!rec) throw new HttpError("NOT_FOUND", "version not found");
    return sendJson(c.res, 200, rec);
  }
  throw new HttpError("NOT_FOUND", "no such endpoint");
}

// ---------------- pairing mailbox (design §2.8.5, §4.12.2) ----------------

async function pairing(srv: Server, c: Ctx, au: Authed, v: VaultRow, pairId: string): Promise<void> {
  if (!isPairId(pairId)) { c.req.resume(); throw new HttpError("BAD_ID", "bad pairId"); }
  requireOwner(srv, v, au);
  const now = srv.cfg.now();
  if (c.method === "PUT") {
    const buf = await readBody(c.req, 4096);
    const r = validatePairingBody(buf.toString("utf8"));
    if (!r.ok) throw new HttpError("INVALID", r.reason);
    txImmediate(srv.db, () => {
      const row = srv.s.get<{ expires_at: number }>("SELECT expires_at FROM pairing WHERE vault_id = ? AND pair_id = ?", v.vault_id, pairId);
      if (row && row.expires_at > now) throw new HttpError("EXISTS", "pairing slot in use");
      srv.s.run(
        `INSERT INTO pairing (vault_id, pair_id, body, created_by, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (vault_id, pair_id) DO UPDATE SET body = excluded.body, created_by = excluded.created_by, expires_at = excluded.expires_at`,
        v.vault_id, pairId, r.value, au.device.device_id, now + PAIRING_TTL_SEC * 1000);
    });
    return sendEmpty(c.res, 201);
  }
  if (c.method === "GET") {
    const out = txImmediate(srv.db, () => {
      const row = srv.s.get<{ body: string; expires_at: number }>("SELECT body, expires_at FROM pairing WHERE vault_id = ? AND pair_id = ?", v.vault_id, pairId);
      if (!row) return null;
      srv.s.run("DELETE FROM pairing WHERE vault_id = ? AND pair_id = ?", v.vault_id, pairId);
      return row;
    });
    if (!out) throw new HttpError("NOT_FOUND", "no such pairing");
    if (out.expires_at <= now) throw new HttpError("CODE_EXPIRED", "pairing expired");
    const data = Buffer.from(out.body);
    c.res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(data.length), "Cache-Control": "no-store" });
    c.res.end(data);
    return;
  }
  methodNotAllowed();
}
