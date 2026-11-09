// Secrets of the headless client (design §4.12.1): `<state>/secret/secrets.json`, directory 0700,
// file 0600, owned by the process uid. Startup refuses group/world-accessible or foreign-owned files
// (exit 3). Writes are temp → fsync → rename → fsync dir under umask 077.
//
// Secrets never come from env values, argv, compose files or logs. The only environment input is
// SHUTTLE_SECRETS_FILE, a *path* to secrets.json for setups whose secret directory is mounted
// elsewhere; the value itself is still read from that file with the same permission checks.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Seen } from "@shuttle/crypto";
import { addSecret } from "./log";

export const SECRETS_FORMAT = "shuttle.headless-secrets";
export const EXIT_STARTUP = 3;

export interface HeadlessSecrets {
  format: typeof SECRETS_FORMAT;
  v: 1;
  vaultId: string;
  deviceId: string;
  serverUrls: string[];
  /** Device token `sxd_…`. */
  token: string;
  /** kv → b64u VMK. Empty until pair-init (or unlock) provisioned the keys. */
  keys: Record<string, string>;
  seen: Seen | null;
  /**
   * Keyring parameters from the last validated vault-info (active kv, meta padding bucket), so the
   * daemon can build its keyring when the server is unreachable at startup. The engine re-validates
   * the vault-info (MAC, epoch, rotation → Locked) on every connect.
   */
  ring?: { activeKv: number; metaPadBucket: number };
}

export class SecretsError extends Error {
  readonly exitCode = EXIT_STARTUP;
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

export function secretDir(stateDir: string): string {
  return path.join(stateDir, "secret");
}

export function secretsPath(stateDir: string, env: { SHUTTLE_SECRETS_FILE?: string | undefined } = process.env): string {
  return env.SHUTTLE_SECRETS_FILE ? path.resolve(env.SHUTTLE_SECRETS_FILE) : path.join(secretDir(stateDir), "secrets.json");
}

const octal = (m: number): string => "0" + (m & 0o777).toString(8);

/** design §4.12.1: refuse when the directory or file is group/world-accessible or owned by another uid. */
export function checkSecretPermissions(file: string): void {
  const uid = process.getuid?.();
  const dir = path.dirname(file);
  let ds: import("node:fs").Stats;
  try {
    ds = statSync(dir);
  } catch {
    throw new SecretsError(`secret directory missing: ${dir}`);
  }
  if ((ds.mode & 0o077) !== 0) throw new SecretsError(`secret directory permissions too open (${octal(ds.mode)}); expected 0700`);
  if (uid !== undefined && ds.uid !== uid) throw new SecretsError("secret directory is owned by another user");
  let fs: import("node:fs").Stats;
  try {
    fs = statSync(file);
  } catch {
    throw new SecretsError("secrets.json missing: run setup (and pair-init)");
  }
  if ((fs.mode & 0o077) !== 0) throw new SecretsError(`secrets.json permissions too open (${octal(fs.mode)}); expected 0600`);
  if (uid !== undefined && fs.uid !== uid) throw new SecretsError("secrets.json is owned by another user");
}

function validate(raw: unknown): HeadlessSecrets {
  const o = raw as Partial<HeadlessSecrets> | null;
  const bad = (what: string): never => { throw new SecretsError(`secrets.json: ${what}`); };
  if (!o || typeof o !== "object") bad("not an object");
  const s = o as Partial<HeadlessSecrets>;
  if (s.format !== SECRETS_FORMAT || s.v !== 1) bad("unknown format");
  if (typeof s.vaultId !== "string" || !s.vaultId) bad("vaultId missing");
  if (typeof s.deviceId !== "string") bad("deviceId missing");
  if (!Array.isArray(s.serverUrls)) bad("serverUrls missing");
  if (typeof s.token !== "string" || !s.token) bad("token missing");
  if (!s.keys || typeof s.keys !== "object") bad("keys missing");
  for (const [k, v] of Object.entries(s.keys as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(k) || typeof v !== "string") bad("keys malformed");
  }
  if (s.seen !== null && s.seen !== undefined && typeof s.seen !== "object") bad("seen malformed");
  return { ...(s as HeadlessSecrets), seen: s.seen ?? null };
}

/** Read and check secrets.json. Registers the token and keys with the log redactor. */
export function readSecrets(file: string, o: { checkPermissions?: boolean } = {}): HeadlessSecrets {
  if (o.checkPermissions !== false) checkSecretPermissions(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new SecretsError("cannot read secrets.json");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SecretsError("secrets.json is not valid JSON");
  }
  const s = validate(raw);
  addSecret(s.token);
  for (const v of Object.values(s.keys)) addSecret(v);
  return s;
}

/** Atomic write with 0600/0700 (umask 077 for the duration). */
export function writeSecrets(file: string, s: HeadlessSecrets): void {
  const dir = path.dirname(file);
  const old = process.umask(0o077);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileAtomicSync(file, JSON.stringify(s, null, 2) + "\n", 0o600);
  } finally {
    process.umask(old);
  }
  addSecret(s.token);
  for (const v of Object.values(s.keys)) addSecret(v);
}

export function deleteSecrets(file: string): void {
  rmSync(file, { force: true });
}

/** temp → write → fsync → rename → fsync dir. */
export function writeFileAtomicSync(file: string, text: string, mode = 0o644): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {
    /* directory fsync unsupported: the rename is still atomic */
  }
}

/** CachedSecrets for @shuttle/crypto fromCache(). */
export function cachedSecretsOf(s: HeadlessSecrets): { vaultId: string; kvs: Record<number, string> } {
  const kvs: Record<number, string> = {};
  for (const [k, v] of Object.entries(s.keys)) kvs[Number(k)] = v;
  return { vaultId: s.vaultId, kvs };
}
