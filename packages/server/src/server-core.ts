// Server state and the operations shared by REST and WebSocket (design §2.8, §2.9). AGPL-3.0-only.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CloseCode, MAX_SEQ } from "@shuttle/protocol";
import type { CommitRequest, VaultInfoEnvelope, VersionRecord } from "@shuttle/protocol";
import { FailureLimiter, TokenBuckets, newDeviceToken, tokenHash } from "./auth";
import { BlobStore } from "./blobs";
import type { ResolvedConfig } from "./config";
import { Stmts, openDb, txImmediate } from "./db";
import { HwmWriter, readHwm, reconcileHwm } from "./hwm";
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

/** Largest raise of head_seq one client report can cause outside a high-water mark (lead decision D9). */
export const SEEN_RAISE_MAX = 1_000_000;

export type SeenOutcome = "none" | "raised" | "ignored";

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
    this.blobs = new BlobStore(d, this.s, cfg.now, (vid, delta) => this.store.stored.add(vid, delta));
    this.hub = new Hub(cfg.coalesceMs);
    this.hwm = new HwmWriter(this.s, d, cfg.log);
    this.loginLimiter = new FailureLimiter(cfg.rates.loginFailuresPerMin, MINUTE_MS, cfg.now);
    this.commitBuckets = new TokenBuckets(cfg.rates.commitsPerSec, cfg.now);
    this.blobBuckets = new TokenBuckets(cfg.rates.blobReqPerSec, cfg.now);
    for (const r of reconcileHwm(this.s, d, cfg.now())) {
      cfg.log(`restore detected: vault head raised ${r.from} -> ${r.to} from hwm.json; rollback rule on`);
    }
  }

  // ---------------- client-reported seqs ----------------

  /**
   * A device reports the highest seq it has seen (hello `max(since, seenMaxSeq)`, or REST GET /changes
   * `max(since, seenMaxSeq)`). design §2.6.1 raises head_seq to it so no seq is reused after a restore.
   * Lead decision D9 limits how far a client value is trusted (it is not authenticated data):
   *   - the value is already a safe integer <= MAX_SEQ (validators reject anything else, no state change);
   *   - a raise is honoured only while a restore is known: rollback_at is set, or hwm.json holds a mark
   *     above the DB head;
   *   - it is capped at max(hwm mark, head_seq + SEEN_RAISE_MAX), and never past MAX_SEQ;
   *   - outside a restore the value is logged and ignored. The device itself still sees
   *     welcome.headSeq < seen.maxSeq and raises RemoteRolledBack (design §3.13, §4.9.2).
   * Returns the vault row to use from here on.
   */
  noteSeen(v: VaultRow, seen: number, via: "hello" | "changes"): { v: VaultRow; outcome: SeenOutcome } {
    if (!Number.isSafeInteger(seen) || seen < 0 || seen > MAX_SEQ) throw new HttpError("INVALID", "bad seq");
    if (seen <= v.head_seq) return { v, outcome: "none" };
    const mark = readHwm(this.cfg.dataDir, v.vault_id);
    const markAbove = mark !== null && mark.headSeq > v.head_seq;
    if (v.rollback_at === null && !markAbove) {
      // Never echo the value or ids beyond the gap size: logs stay small and free of client data.
      this.cfg.log(`${via}: a device reported seqs ${seen - v.head_seq} above the head outside a restore; ignored`);
      return { v, outcome: "ignored" };
    }
    const cap = Math.min(MAX_SEQ, Math.max(mark?.headSeq ?? 0, v.head_seq + SEEN_RAISE_MAX));
    const to = Math.min(seen, cap);
    if (to <= v.head_seq || !this.store.raiseHeadForSeen(v.vault_id, to)) return { v, outcome: "none" };
    this.cfg.log(`${via}: device has seen seqs above the head during a restore; head raised by ${to - v.head_seq}${to < seen ? " (capped)" : ""}`);
    this.hwm.mark(v.vault_id);
    return { v: this.store.vault(v.vault_id) ?? v, outcome: "raised" };
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
            // The commit's own writes (and any cached usage delta) are undone; the others in the group stay.
            this.store.stored.drop(it.vid);
            this.db.exec("ROLLBACK TO c");
            this.db.exec("RELEASE c");
            results.push(e instanceof Error ? e : new Error(String(e)));
          }
          // SQLite rolls the whole transaction back on some errors (SQLITE_FULL, IOERR, NOMEM). Later
          // statements would then autocommit one by one outside the group; abort the group instead so
          // nothing is acked that the final COMMIT did not cover.
          if (!this.db.isTransaction) throw new Error("group transaction was rolled back by SQLite");
        }
      });
    } catch (e) {
      // The outer COMMIT (or the group) failed: nothing of the batch is durable, so nobody gets an ack.
      this.cfg.log(`group commit failed: ${String(e)}`);
      for (const it of batch) this.store.stored.drop(it.vid);
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

  /**
   * design §2.11 step 3: new info + epoch atomically, drop history rows, keep head_seq. Step 5: only
   * the OTHER devices get snapshotRequired{epoch}; the caller's own sockets adopt the new epoch and keep
   * their feed so step 4's uploads go out on the same connection.
   */
  rebuild(v: VaultRow, info: VaultInfoEnvelope, callerDeviceId: string | null): { epoch: number; headSeq: number } {
    const out = txImmediate(this.db, () => {
      const cur = this.store.vault(v.vault_id);
      if (!cur) throw new HttpError("VAULT_NOT_FOUND");
      const old = JSON.parse(cur.info_json) as VaultInfoEnvelope;
      if (info.vaultId !== cur.vault_id) throw new HttpError("INVALID", "vaultId does not match");
      if (info.epoch !== cur.epoch + 1) throw new HttpError("INVALID", `info.epoch must be ${cur.epoch + 1}`);
      if (info.infoRev <= old.infoRev) throw new HttpError("INVALID", "infoRev did not increase");
      const json = JSON.stringify(info);
      const vid = cur.vault_id;
      // design §2.11 step 3 drops versions, files, version_blobs and blob rows.
      for (const t of ["version_blobs", "versions", "files", "blobs"]) {
        this.s.run(`DELETE FROM ${t} WHERE vault_id = ?`, vid);
      }
      // v1 is silent on `commits` and `device_cursors`. Commits: the cid rows are kept but marked with
      // the epoch they belong to, so a resend of a pre-rebuild cid is refused with SNAPSHOT_REQUIRED.
      // It is neither answered `replayed:true` with seqs that no longer exist (the device would think
      // its change is on the remote) nor re-run against the new epoch (a stale plan applied blindly).
      this.s.run("UPDATE commits SET result_json = ? WHERE vault_id = ? AND result_json NOT LIKE '{\"staleEpoch\":%'",
        JSON.stringify({ staleEpoch: cur.epoch }), vid);
      // Cursors: seqs are monotonic and head_seq is kept, so acked_seq stays meaningful; the rollback
      // rule ends with the rebuild (rollback_at is cleared below), so its acks go.
      this.s.run("UPDATE device_cursors SET rollback_ack = NULL WHERE vault_id = ?", vid);
      this.s.run(
        `UPDATE vaults SET info_json = ?, info_etag = ?, epoch = ?, min_seq = head_seq, restored_seq = NULL, rollback_at = NULL
         WHERE vault_id = ?`, json, etagOf(json), info.epoch, vid);
      // Orphaned blob files are removed by the next orphan scan (design §2.7.6 step 5).
      this.s.run("DELETE FROM meta WHERE k = ?", `orphan_scan:${vid}`);
      return { epoch: info.epoch, headSeq: cur.head_seq };
    });
    this.store.stored.drop(v.vault_id);
    this.hwm.mark(v.vault_id);
    void this.hwm.flushAll();
    for (const c of this.hub.ofVault(v.vault_id)) {
      if (callerDeviceId !== null && c.deviceId === callerDeviceId) c.adoptEpoch(out.epoch);
      else c.park("epoch", null);
    }
    return out;
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
