// Server state and the operations shared by REST and WebSocket (design §2.8, §2.9). AGPL-3.0-only.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CloseCode } from "@shuttle/protocol";
import type { CommitRequest, SnapshotReason, VaultInfoEnvelope, VersionRecord } from "@shuttle/protocol";
import { FailureLimiter, TokenBuckets, newDeviceToken, tokenHash } from "./auth";
import { BlobStore } from "./blobs";
import type { ResolvedConfig } from "./config";
import { Stmts, openDb, txImmediate } from "./db";
import { HwmWriter, reconcileHwm } from "./hwm";
import { Store, type CommitOutcome, type VaultRow } from "./store";
import { HttpError, MINUTE_MS, randomId16, sha256Hex } from "./util";
import { Hub } from "./ws";

export const SERVER_VERSION = "0.1.0";
/** Commits per group-commit transaction. */
const MAX_GROUP = 256;

export interface DeviceRow {
  device_id: string; user_id: string; name: string; platform: string; client_version: string | null;
  created_at: number; last_seen_at: number | null; last_ip: string | null; revoked_at: number | null;
}
export interface UserRow { user_id: string; username: string; pw_hash: string | null; role: "owner" | "member"; created_at: number }

export type AuthResult = { ok: true; device: DeviceRow; user: UserRow } | { ok: false; code: "UNAUTHENTICATED" | "REVOKED" };

export function etagOf(infoJson: string): string {
  return `"${sha256Hex(infoJson).slice(0, 16)}"`;
}

export class Server {
  readonly db: DatabaseSync;
  readonly s: Stmts;
  readonly store: Store;
  readonly blobs: BlobStore;
  readonly hub: Hub;
  readonly hwm: HwmWriter;
  readonly loginLimiter: FailureLimiter;
  readonly commitBuckets: TokenBuckets;
  readonly blobBuckets: TokenBuckets;
  readonly version = SERVER_VERSION;
  private queue: Array<{ vid: string; deviceId: string; req: CommitRequest; expectEpoch: number | undefined; done: (r: CommitOutcome | Error) => void }> = [];
  private flushScheduled = false;
  private closing = false;

  constructor(readonly cfg: ResolvedConfig) {
    const d = cfg.dataDir;
    mkdirSync(d, { recursive: true });
    for (const sub of ["vaults", "backups"]) mkdirSync(path.join(d, sub), { recursive: true });
    // design §2.6.2 (S25): everything in tmp/ and graveyard/ is leftover from a previous run.
    for (const sub of ["tmp", "graveyard"]) {
      const dir = path.join(d, sub);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
    this.db = openDb(path.join(d, "shuttle.db"));
    this.s = new Stmts(this.db);
    this.store = new Store(this.s, cfg.now, cfg.limits);
    this.blobs = new BlobStore(d, this.s, cfg.now);
    this.hub = new Hub(cfg.coalesceMs);
    this.hwm = new HwmWriter(this.s, d, cfg.log);
    this.loginLimiter = new FailureLimiter(cfg.rates.loginFailuresPerMin, MINUTE_MS, cfg.now);
    this.commitBuckets = new TokenBuckets(cfg.rates.commitsPerSec, cfg.now);
    this.blobBuckets = new TokenBuckets(cfg.rates.blobReqPerSec, cfg.now);
    for (const r of reconcileHwm(this.s, d, cfg.now())) {
      cfg.log(`restore detected: vault head raised ${r.from} -> ${r.to} from hwm.json; rollback rule on`);
    }
  }

  // ---------------- auth ----------------

  authToken(token: string, _ip: string): AuthResult {
    const dev = this.s.get<DeviceRow>("SELECT * FROM devices WHERE token_hash = ?", tokenHash(token));
    if (!dev) return { ok: false, code: "UNAUTHENTICATED" };
    if (dev.revoked_at !== null) return { ok: false, code: "REVOKED" };
    const user = this.s.get<UserRow>("SELECT * FROM users WHERE user_id = ?", dev.user_id);
    if (!user) return { ok: false, code: "UNAUTHENTICATED" };
    return { ok: true, device: dev, user };
  }

  deviceRevoked(deviceId: string): boolean {
    const r = this.s.get<{ revoked_at: number | null }>("SELECT revoked_at FROM devices WHERE device_id = ?", deviceId);
    return !r || r.revoked_at !== null;
  }

  touchDevice(deviceId: string, ip: string, clientVersion?: string): void {
    const t = this.cfg.now();
    if (clientVersion !== undefined) {
      this.s.run("UPDATE devices SET last_seen_at = ?, last_ip = ?, client_version = ? WHERE device_id = ?", t, ip, clientVersion, deviceId);
    } else {
      this.s.run("UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE device_id = ? AND (last_seen_at IS NULL OR last_seen_at < ? OR last_ip IS NOT ?)",
        t, ip, deviceId, t - MINUTE_MS, ip);
    }
  }

  /** Creates a device row and returns its token (only the hash is stored). Runs inside the caller's tx if any. */
  createDevice(userId: string, d: { name: string; platform: string; clientVersion: string | null }): { token: string; deviceId: string } {
    const token = newDeviceToken();
    const deviceId = randomId16();
    this.s.run(
      `INSERT INTO devices (device_id, user_id, name, platform, client_version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      deviceId, userId, d.name, d.platform, d.clientVersion, tokenHash(token), this.cfg.now());
    return { token, deviceId };
  }

  revokeDevice(deviceId: string): void {
    this.s.run("UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL", this.cfg.now(), deviceId);
    for (const c of this.hub.ofDevice(deviceId)) c.fatal(null, "REVOKED", "this device was removed", CloseCode.FORBIDDEN);
  }

  /** Closes sockets of devices revoked out of band (admin CLI, restore-finish). */
  sweepRevoked(): void {
    for (const c of [...this.hub.conns]) {
      if (c.greeted && c.deviceId && this.deviceRevoked(c.deviceId)) c.fatal(null, "REVOKED", "this device was removed", CloseCode.FORBIDDEN);
      else if (c.greeted && c.vaultId && !this.store.vault(c.vaultId)) c.fatal(null, "VAULT_NOT_FOUND", "vault not found", CloseCode.VAULT_NOT_FOUND);
    }
  }

  // ---------------- vault operations ----------------

  /**
   * Group commit: commits queued in the same event-loop turn run in one BEGIN IMMEDIATE … COMMIT, each
   * in its own SAVEPOINT, so one fsync (synchronous=FULL) covers the batch. Results are delivered only
   * after the outer COMMIT returned, i.e. after they are durable. A commit that throws rolls back to its
   * savepoint alone. `expectEpoch` (WebSocket) refuses a commit whose connection epoch is stale.
   */
  enqueueCommit(vid: string, deviceId: string, req: CommitRequest, expectEpoch: number | undefined, done: (r: CommitOutcome | Error) => void): void {
    if (this.closing) { done(new HttpError("UNAVAILABLE", "server is shutting down")); return; }
    this.queue.push({ vid, deviceId, req, expectEpoch, done });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flushCommits());
    }
  }

  commitAsync(vid: string, deviceId: string, req: CommitRequest, expectEpoch?: number): Promise<CommitOutcome> {
    return new Promise((resolve, reject) => {
      this.enqueueCommit(vid, deviceId, req, expectEpoch, (r) => (r instanceof Error ? reject(r) : resolve(r)));
    });
  }

  /** Shutdown: refuse new commits and run every queued one now (synchronously). */
  drainCommits(): void {
    this.closing = true;
    while (this.queue.length > 0) this.flushCommits();
  }

  private flushCommits(): void {
    this.flushScheduled = false;
    const batch = this.queue.splice(0, MAX_GROUP);
    if (this.queue.length > 0) { this.flushScheduled = true; setImmediate(() => this.flushCommits()); }
    if (batch.length === 0) return;
    const results: Array<CommitOutcome | Error> = [];
    try {
      txImmediate(this.db, () => {
        for (const it of batch) {
          this.db.exec("SAVEPOINT c");
          try {
            results.push(this.store.commitInTx(it.vid, it.deviceId, it.req, it.expectEpoch));
            this.db.exec("RELEASE c");
          } catch (e) {
            this.db.exec("ROLLBACK TO c");
            this.db.exec("RELEASE c");
            results.push(e instanceof Error ? e : new Error(String(e)));
          }
        }
      });
    } catch (e) {
      // The outer COMMIT failed: nothing of the batch is durable.
      this.cfg.log(`group commit failed: ${String(e)}`);
      const err = new HttpError("SERVER", "commit failed");
      for (const it of batch) it.done(err);
      return;
    }
    const touched = new Map<string, VersionRecord[]>();
    batch.forEach((it, i) => {
      const r = results[i]!;
      if (!(r instanceof Error) && r.applied.length > 0) {
        const list = touched.get(it.vid) ?? [];
        list.push(...r.applied);
        touched.set(it.vid, list);
      }
    });
    // commitResult first (done callbacks), then the coalesced live fan-out (§2.9.2).
    batch.forEach((it, i) => it.done(results[i]!));
    for (const [vid, recs] of touched) {
      this.hub.onCommit(vid, recs);
      this.hwm.mark(vid);
    }
  }

  createVault(userId: string, name: string, info: VaultInfoEnvelope): { vaultId: string; etag: string } {
    const infoJson = JSON.stringify(info);
    const etag = etagOf(infoJson);
    return txImmediate(this.db, () => {
      if (this.s.get("SELECT 1 AS x FROM vaults WHERE vault_id = ?", info.vaultId)) throw new HttpError("VAULT_EXISTS", "vault already exists");
      if (this.s.get("SELECT 1 AS x FROM vaults WHERE name = ?", name)) throw new HttpError("NAME_TAKEN", "vault name is taken");
      this.s.run(
        `INSERT INTO vaults (vault_id, name, owner_user, info_json, info_etag, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        info.vaultId, name, userId, infoJson, etag, info.epoch, this.cfg.now());
      this.s.run("INSERT INTO vault_members (vault_id, user_id, role) VALUES (?, ?, 'owner')", info.vaultId, userId);
      return { vaultId: info.vaultId, etag };
    });
  }

  putInfo(v: VaultRow, info: VaultInfoEnvelope, ifMatch: string | null): string {
    const etag = txImmediate(this.db, () => {
      const cur = this.store.vault(v.vault_id);
      if (!cur) throw new HttpError("VAULT_NOT_FOUND");
      if (ifMatch === null || !etagMatches(ifMatch, cur.info_etag)) {
        throw new HttpError("PRECONDITION_FAILED", "vault-info changed", { details: { etag: cur.info_etag } });
      }
      const old = JSON.parse(cur.info_json) as VaultInfoEnvelope;
      if (info.vaultId !== cur.vault_id) throw new HttpError("INVALID", "vaultId does not match");
      if (info.epoch !== cur.epoch) throw new HttpError("INVALID", "info.epoch must equal the vault epoch");
      if (info.infoRev <= old.infoRev) throw new HttpError("INVALID", "infoRev did not increase");
      const json = JSON.stringify(info);
      const e = etagOf(json);
      this.s.run("UPDATE vaults SET info_json = ?, info_etag = ? WHERE vault_id = ?", json, e, cur.vault_id);
      return e;
    });
    this.hub.broadcast(v.vault_id, { type: "vaultInfoChanged", etag });
    return etag;
  }

  /** design §2.11 step 3: new info + epoch atomically, drop history rows, keep head_seq. */
  rebuild(v: VaultRow, info: VaultInfoEnvelope): { epoch: number; headSeq: number } {
    const out = txImmediate(this.db, () => {
      const cur = this.store.vault(v.vault_id);
      if (!cur) throw new HttpError("VAULT_NOT_FOUND");
      const old = JSON.parse(cur.info_json) as VaultInfoEnvelope;
      if (info.vaultId !== cur.vault_id) throw new HttpError("INVALID", "vaultId does not match");
      if (info.epoch !== cur.epoch + 1) throw new HttpError("INVALID", `info.epoch must be ${cur.epoch + 1}`);
      if (info.infoRev <= old.infoRev) throw new HttpError("INVALID", "infoRev did not increase");
      const json = JSON.stringify(info);
      const vid = cur.vault_id;
      for (const t of ["version_blobs", "versions", "files", "blobs", "commits", "device_cursors"]) {
        this.s.run(`DELETE FROM ${t} WHERE vault_id = ?`, vid);
      }
      this.s.run(
        `UPDATE vaults SET info_json = ?, info_etag = ?, epoch = ?, min_seq = head_seq, restored_seq = NULL, rollback_at = NULL
         WHERE vault_id = ?`, json, etagOf(json), info.epoch, vid);
      // Orphaned blob files are removed by the next orphan scan (design §2.7.6 step 5).
      this.s.run("DELETE FROM meta WHERE k = ?", `orphan_scan:${vid}`);
      return { epoch: info.epoch, headSeq: cur.head_seq };
    });
    this.hwm.mark(v.vault_id);
    void this.hwm.flushAll();
    this.parkVault(v.vault_id, "epoch");
    return out;
  }

  /** Every socket of the vault gets snapshotRequired (rebuild: including the caller's own device). */
  parkVault(vid: string, reason: SnapshotReason): void {
    for (const c of this.hub.ofVault(vid)) c.park(reason, null);
  }

  softDeleteVault(v: VaultRow): void {
    this.s.run("UPDATE vaults SET deleted_at = ? WHERE vault_id = ? AND deleted_at IS NULL", this.cfg.now(), v.vault_id);
    for (const c of this.hub.ofVault(v.vault_id)) c.fatal(null, "VAULT_NOT_FOUND", "vault deleted", CloseCode.VAULT_NOT_FOUND);
  }

  /** Remaining files under tmp/ (tests). */
  tmpEntries(): string[] {
    return readdirSync(this.blobs.tmpDir);
  }
}

/** If-Match comparison: the same opaque tag with or without quotes. `*` is not accepted (it would skip the CAS). */
export function etagMatches(header: string, etag: string): boolean {
  const strip = (s: string) => s.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return header.split(",").some((h) => strip(h) !== "" && strip(h) !== "*" && strip(h) === strip(etag));
}
