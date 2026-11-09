// shuttle-admin commands (design §2.8.4, §2.6.6). Works on shuttle.db directly; safe while the server
// runs (SQLite WAL + busy_timeout). Never prints tokens or password hashes. AGPL-3.0-only.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ENROLL_CODE_TTL_SEC, validateVaultInfoEnvelope } from "@shuttle/protocol";
import { enrollCodeHash, hashPassword, newEnrollCode, normalizeEnrollCode } from "./auth";
import { DEFAULT_SCRYPT, type ScryptParams } from "./config";
import { Stmts, openDb, txImmediate } from "./db";
import { readHwm, reconcileHwm } from "./hwm";
import { etagOf } from "./server-core";
import { randomId16 } from "./util";

export interface AdminIo {
  dataDir: string;
  out(line: string): void;
  err(line: string): void;
  /** Reads a password (prompt on a TTY, or one line from stdin with --password-stdin). */
  readPassword(prompt: string): Promise<string>;
  now?: () => number;
  scrypt?: ScryptParams;
}

const USAGE = `usage: shuttle-admin <command>
  user add <username> [--owner] [--password-stdin]
  user passwd <username> [--password-stdin]
  user list
  enroll-code --user <username> [--ttl 15m]
  devices list [--user <username>]
  devices revoke <deviceId>
  vault list
  vault create <name> --owner <username> --info <vault-info.json>
  vault quota <name> <bytes|none>
  vault member add <name> <username> [--role owner|member]
  restore-finish [--ttl 15m]
  status
env: SHUTTLE_DATA (data directory)`;

export class AdminError extends Error {}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new AdminError(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

export function parseTtl(s: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(s.trim());
  if (!m) throw new AdminError(`bad ttl ${s} (use e.g. 900, 15m, 1h)`);
  const n = Number(m[1]);
  const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
  const sec = n * mult;
  if (sec <= 0 || sec > 7 * 86400) throw new AdminError("ttl must be between 1 s and 7 days");
  return sec;
}

function fmtTime(t: number | null): string {
  return t === null ? "-" : new Date(t).toISOString();
}

export async function runAdmin(argv: string[], io: AdminIo): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") { io.out(USAGE); return args.length === 0 ? 2 : 0; }
  const now = io.now ?? Date.now;
  mkdirSync(io.dataDir, { recursive: true });
  const db = openDb(path.join(io.dataDir, "shuttle.db"));
  const s = new Stmts(db);
  try {
    await dispatch(args, io, s, now);
    return 0;
  } catch (e) {
    if (e instanceof AdminError) { io.err(`error: ${e.message}`); return 1; }
    throw e;
  } finally {
    db.close();
  }
}

function userByName(s: Stmts, name: string): { user_id: string; role: string } {
  const u = s.get<{ user_id: string; role: string }>("SELECT user_id, role FROM users WHERE username = ?", name);
  if (!u) throw new AdminError(`no user ${name}`);
  return u;
}

function vaultByName(s: Stmts, name: string): { vault_id: string } {
  const v = s.get<{ vault_id: string }>("SELECT vault_id FROM vaults WHERE name = ? AND deleted_at IS NULL", name);
  if (!v) throw new AdminError(`no vault ${name}`);
  return v;
}

function issueCode(s: Stmts, userId: string, ttlSec: number, now: number): { code: string; expiresAt: number } {
  const code = newEnrollCode();
  const expiresAt = now + ttlSec * 1000;
  s.run("INSERT INTO enroll_codes (code_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
    enrollCodeHash(normalizeEnrollCode(code)!), userId, "admin", expiresAt);
  return { code, expiresAt };
}

async function readNewPassword(io: AdminIo, fromStdin: boolean): Promise<string> {
  const pw = await io.readPassword(fromStdin ? "" : "Password: ");
  if (pw.length < 8) throw new AdminError("password must have at least 8 characters");
  if (!fromStdin) {
    const again = await io.readPassword("Repeat: ");
    if (again !== pw) throw new AdminError("passwords do not match");
  }
  return pw;
}

async function dispatch(args: string[], io: AdminIo, s: Stmts, now: () => number): Promise<void> {
  const [cmd, sub] = args;
  const scrypt = io.scrypt ?? DEFAULT_SCRYPT;
  if (cmd === "user" && (sub === "add" || sub === "passwd")) {
    const rest = args.slice(2);
    const owner = flag(rest, "--owner");
    const stdin = flag(rest, "--password-stdin");
    const name = rest[0];
    if (!name || rest.length !== 1 || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new AdminError("username: 1-64 of A-Z a-z 0-9 . _ -");
    if (sub === "add" && s.get("SELECT 1 AS x FROM users WHERE username = ?", name)) throw new AdminError(`user ${name} exists`);
    if (sub === "passwd") userByName(s, name);
    const hash = await hashPassword(await readNewPassword(io, stdin), scrypt);
    if (sub === "add") {
      s.run("INSERT INTO users (user_id, username, pw_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
        randomId16(), name, hash, owner ? "owner" : "member", now());
      io.out(`user ${name} added (${owner ? "owner" : "member"})`);
    } else {
      s.run("UPDATE users SET pw_hash = ? WHERE username = ?", hash, name);
      io.out(`password changed for ${name}`);
    }
    return;
  }
  if (cmd === "user" && sub === "list") {
    for (const u of s.all<{ username: string; role: string; created_at: number; n: number }>(
      "SELECT u.username, u.role, u.created_at, (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.user_id AND d.revoked_at IS NULL) AS n FROM users u ORDER BY u.created_at")) {
      io.out(`${u.username}\t${u.role}\tdevices=${u.n}\tcreated=${fmtTime(u.created_at)}`);
    }
    return;
  }
  if (cmd === "enroll-code") {
    const rest = args.slice(1);
    const name = option(rest, "--user");
    const ttl = parseTtl(option(rest, "--ttl") ?? String(ENROLL_CODE_TTL_SEC));
    if (!name) throw new AdminError("--user is required");
    const u = userByName(s, name);
    const { code, expiresAt } = issueCode(s, u.user_id, ttl, now());
    io.out(code);
    io.err(`expires ${fmtTime(expiresAt)}`);
    return;
  }
  if (cmd === "devices" && sub === "list") {
    const rest = args.slice(2);
    const name = option(rest, "--user");
    const rows = s.all<{ device_id: string; username: string; name: string; platform: string; client_version: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }>(
      `SELECT d.device_id, u.username, d.name, d.platform, d.client_version, d.created_at, d.last_seen_at, d.revoked_at
       FROM devices d JOIN users u ON u.user_id = d.user_id ${name ? "WHERE u.username = ?" : ""} ORDER BY d.created_at`, ...(name ? [name] : []));
    for (const d of rows) {
      io.out(`${d.device_id}\t${d.username}\t${d.name}\t${d.platform}\t${d.client_version ?? "-"}\tlastSeen=${fmtTime(d.last_seen_at)}\t${d.revoked_at !== null ? "revoked" : "active"}`);
    }
    return;
  }
  if (cmd === "devices" && sub === "revoke") {
    const id = args[2];
    if (!id) throw new AdminError("devices revoke <deviceId>");
    const r = s.run("UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL", now(), id);
    if (Number(r.changes) === 0) throw new AdminError(`no active device ${id}`);
    io.out(`revoked ${id} (open sockets close within the server's sweep interval)`);
    return;
  }
  if (cmd === "vault" && sub === "list") {
    for (const v of s.all<{ vault_id: string; name: string; head_seq: number; min_seq: number; epoch: number; quota_bytes: number | null; rollback_at: number | null; deleted_at: number | null }>(
      "SELECT vault_id, name, head_seq, min_seq, epoch, quota_bytes, rollback_at, deleted_at FROM vaults ORDER BY created_at")) {
      io.out(`${v.vault_id}\t${v.name}\tepoch=${v.epoch}\thead=${v.head_seq}\tmin=${v.min_seq}\tquota=${v.quota_bytes ?? "none"}${v.rollback_at !== null ? `\trollbackAt=${v.rollback_at}` : ""}${v.deleted_at !== null ? "\tdeleted" : ""}`);
    }
    return;
  }
  if (cmd === "vault" && sub === "create") {
    const rest = args.slice(2);
    const ownerName = option(rest, "--owner");
    const infoFile = option(rest, "--info");
    const name = rest[0];
    if (!name || rest.length !== 1 || !ownerName || !infoFile) throw new AdminError("vault create <name> --owner <username> --info <vault-info.json>");
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(infoFile, "utf8")); } catch { throw new AdminError(`cannot read JSON from ${infoFile}`); }
    const v = validateVaultInfoEnvelope(parsed);
    if (!v.ok) throw new AdminError(`invalid vault-info at ${v.path}: ${v.reason}`);
    const u = userByName(s, ownerName);
    const json = JSON.stringify(v.value);
    txImmediate(s.db, () => {
      if (s.get("SELECT 1 AS x FROM vaults WHERE vault_id = ?", v.value.vaultId)) throw new AdminError("vault already exists");
      if (s.get("SELECT 1 AS x FROM vaults WHERE name = ?", name)) throw new AdminError("vault name is taken");
      s.run("INSERT INTO vaults (vault_id, name, owner_user, info_json, info_etag, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        v.value.vaultId, name, u.user_id, json, etagOf(json), v.value.epoch, now());
      s.run("INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, 'owner')", v.value.vaultId, u.user_id);
    });
    io.out(`vault ${name} created (${v.value.vaultId})`);
    return;
  }
  if (cmd === "vault" && sub === "quota") {
    const [, , name, val] = args;
    if (!name || val === undefined) throw new AdminError("vault quota <name> <bytes|none>");
    const q = val === "none" ? null : Number(val);
    if (q !== null && (!Number.isSafeInteger(q) || q <= 0)) throw new AdminError("quota must be a positive integer or none");
    const v = vaultByName(s, name);
    s.run("UPDATE vaults SET quota_bytes = ? WHERE vault_id = ?", q, v.vault_id);
    io.out(`quota of ${name}: ${q ?? "none"}`);
    return;
  }
  if (cmd === "vault" && sub === "member" && args[2] === "add") {
    const rest = args.slice(3);
    const role = option(rest, "--role") ?? "member";
    const [name, user] = rest;
    if (!name || !user || (role !== "owner" && role !== "member")) throw new AdminError("vault member add <name> <username> [--role owner|member]");
    const v = vaultByName(s, name);
    const u = userByName(s, user);
    s.run("INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (vault_id, user_id) DO UPDATE SET role = excluded.role",
      v.vault_id, u.user_id, role);
    io.out(`${user} is ${role} of ${name}`);
    return;
  }
  if (cmd === "restore-finish") {
    // design §2.6.6: (1) revoke every device token, (2) apply the hwm rule, (3) print new enroll codes.
    const rest = args.slice(1);
    const ttl = parseTtl(option(rest, "--ttl") ?? String(ENROLL_CODE_TTL_SEC));
    const t = now();
    const users = s.all<{ user_id: string; username: string }>(
      "SELECT DISTINCT u.user_id, u.username FROM users u JOIN devices d ON d.user_id = u.user_id WHERE d.revoked_at IS NULL ORDER BY u.username");
    const revoked = txImmediate(s.db, () => Number(s.run("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL", t).changes));
    io.out(`revoked ${revoked} device token(s)`);
    for (const r of reconcileHwm(s, io.dataDir, t)) io.out(`vault ${r.vaultId}: head raised ${r.from} -> ${r.to} (rollback rule on)`);
    for (const u of users) {
      const { code } = issueCode(s, u.user_id, ttl, t);
      io.out(`${u.username}\t${code}`);
    }
    io.out("each device re-enrolls with a code; local data and keys stay");
    return;
  }
  if (cmd === "status") {
    const schema = s.get<{ v: string }>("SELECT v FROM meta WHERE k = 'schema'")?.v ?? "?";
    const count = (sql: string) => s.get<{ c: number }>(sql)?.c ?? 0;
    io.out(`data ${io.dataDir}`);
    io.out(`schema ${schema}`);
    io.out(`users ${count("SELECT COUNT(*) AS c FROM users")}, devices ${count("SELECT COUNT(*) AS c FROM devices WHERE revoked_at IS NULL")} active / ${count("SELECT COUNT(*) AS c FROM devices")} total`);
    for (const v of s.all<{ vault_id: string; name: string; head_seq: number; min_seq: number; epoch: number; rollback_at: number | null; quota_bytes: number | null }>(
      "SELECT vault_id, name, head_seq, min_seq, epoch, rollback_at, quota_bytes FROM vaults WHERE deleted_at IS NULL ORDER BY created_at")) {
      const files = s.get<{ c: number }>("SELECT COUNT(*) AS c FROM files WHERE vault_id = ? AND head_kind = 'put'", v.vault_id)?.c ?? 0;
      const blobs = s.get<{ c: number; n: number | null }>("SELECT COUNT(*) AS c, SUM(size) AS n FROM blobs WHERE vault_id = ?", v.vault_id);
      const hwm = readHwm(io.dataDir, v.vault_id);
      io.out(`vault ${v.name} (${v.vault_id}) epoch=${v.epoch} head=${v.head_seq} min=${v.min_seq} hwm=${hwm?.headSeq ?? "-"} files=${files} blobs=${blobs?.c ?? 0} bytes=${blobs?.n ?? 0} quota=${v.quota_bytes ?? "none"}${v.rollback_at !== null ? ` rollbackAt=${fmtTime(v.rollback_at)}` : ""}`);
    }
    return;
  }
  throw new AdminError(`unknown command\n${USAGE}`);
}
