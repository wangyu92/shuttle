// Vault data: record mapping, feeds, snapshot, history and commit processing (design §2.5, §2.8.3,
// §2.8.5, §2.9.6, §2.9.7). Every method is synchronous. AGPL-3.0-only.
import {
  ENCSIZE_SLACK,
  MAX_SEQ,
  checkOpSizes,
  opsDigestPreimage,
  validateRetention,
} from "@shuttle/protocol";
import type {
  BlobId, CommitOp, CommitRequest, CommitResponse, FileId, OpResult, PathKey, Retention, Seq,
  VaultInfoEnvelope, VersionRecord, WelcomeLimits,
} from "@shuttle/protocol";
import { Stmts, txImmediate, type SqlArg } from "./db";
import { HttpError, b64u, b64uDecodeStrict, sha256 } from "./util";

export interface VaultRow {
  vault_id: string; name: string; owner_user: string; info_json: string; info_etag: string;
  head_seq: number; min_seq: number; epoch: number; restored_seq: number | null; rollback_at: number | null;
  quota_bytes: number | null; created_at: number; deleted_at: number | null;
}

interface RecordRow {
  seq: number; file_id: string; path_key: string; base_seq: number | null; kind: string; rc: string; kv: number;
  meta: Uint8Array; inline: Uint8Array | null; enc_size: number; device_id: string; ts: number; cid: string | null;
  blobs: string | null;
}

export const DEFAULT_RETENTION: Required<Retention> = Object.freeze({
  noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90, thinAfterHours: 24, thinBucketMinutes: 60,
});

const REC_COLS = `v.seq, v.file_id, v.path_key, v.base_seq, v.kind, v.rc, v.kv, v.meta, v.inline, v.enc_size,
  v.device_id, v.ts, v.cid,
  (SELECT group_concat(b.blob_id, ',' ORDER BY b.ord) FROM version_blobs b WHERE b.vault_id = v.vault_id AND b.seq = v.seq) AS blobs`;
const HEAD_JOIN = "files f JOIN versions v ON v.vault_id = f.vault_id AND v.seq = f.head_seq";

export function rowToRecord(r: RecordRow): VersionRecord {
  const rec: VersionRecord = {
    seq: r.seq, fileId: r.file_id, pathKey: r.path_key, base: r.base_seq, kind: r.kind as VersionRecord["kind"],
    rc: r.rc as VersionRecord["rc"], kv: r.kv, meta: b64u(r.meta), blobs: r.blobs ? r.blobs.split(",") : [],
    encSize: r.enc_size, device: r.device_id, ts: r.ts,
  };
  if (r.inline !== null) rec.inline = b64u(r.inline);
  if (r.cid !== null) rec.cid = r.cid;
  return rec;
}

/** Approximate wire size of a record (all fields are ASCII). */
export function recordBytes(r: VersionRecord): number {
  return JSON.stringify(r).length + 1;
}

/**
 * Per-vault stored-bytes counter (blob rows plus inline bodies), so a commit does not run two SUMs over
 * the vault. Filled lazily from SQL. Writers that add bytes call `add` (a no-op while the entry is not
 * cached); everything that deletes rows or rolls a transaction back calls `drop`, and the next read
 * recomputes. `drop` is always safe; a missing `add` or `drop` only skews the quota, never data.
 */
export class StoredBytes {
  private cache = new Map<string, number>();
  constructor(private readonly s: Stmts) {}

  get(vid: string): number {
    const c = this.cache.get(vid);
    if (c !== undefined) return c;
    const n = this.sum(vid);
    this.cache.set(vid, n);
    return n;
  }

  /** The uncached value (tests, admin). */
  sum(vid: string): number {
    const b = this.s.get<{ n: number | null }>("SELECT SUM(size) AS n FROM blobs WHERE vault_id = ?", vid)?.n ?? 0;
    const i = this.s.get<{ n: number | null }>("SELECT SUM(length(inline)) AS n FROM versions WHERE vault_id = ? AND inline IS NOT NULL", vid)?.n ?? 0;
    return b + i;
  }

  add(vid: string, delta: number): void {
    const c = this.cache.get(vid);
    if (c !== undefined && delta !== 0) this.cache.set(vid, c + delta);
  }

  /** Forget one vault, or every vault when `vid` is omitted. */
  drop(vid?: string): void {
    if (vid === undefined) this.cache.clear(); else this.cache.delete(vid);
  }
}

/** Thrown for a same-cid / different-digest commit (design §2.9.5 X2). Maps to PROTOCOL. */
export class CommitProtocolError extends Error {}

/** Ops whose cached result is re-evaluated on a same-cid resend (design §2.9.3 "resend … re-evaluated"). */
const RETRY_ON_RESEND: ReadonlySet<string> = new Set(["MISSING_BLOB", "QUOTA", "ABORTED"]);

export interface CommitOutcome { response: CommitResponse; applied: VersionRecord[] }

export interface PageResult { records: VersionRecord[]; lastSeq: Seq | null; full: boolean }

interface DecodedOp { meta: Buffer; inline: Buffer | null }

export class Store {
  private infoCache = new Map<string, { etag: string; activeKv: number; retention: Required<Retention> }>();

  readonly stored: StoredBytes;

  constructor(readonly s: Stmts, private readonly now: () => number, private readonly limits: WelcomeLimits) {
    this.stored = new StoredBytes(s);
  }

  // ---------------- vaults ----------------

  vault(vid: string): VaultRow | undefined {
    return this.s.get<VaultRow>("SELECT * FROM vaults WHERE vault_id = ? AND deleted_at IS NULL", vid);
  }

  vaultAny(vid: string): VaultRow | undefined {
    return this.s.get<VaultRow>("SELECT * FROM vaults WHERE vault_id = ?", vid);
  }

  memberRole(vid: string, userId: string): string | null {
    return this.s.get<{ role: string }>("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?", vid, userId)?.role ?? null;
  }

  /** activeKv and retention from the stored vault-info (cached per etag). */
  infoOf(v: VaultRow): { activeKv: number; retention: Required<Retention> } {
    const c = this.infoCache.get(v.vault_id);
    if (c && c.etag === v.info_etag) return c;
    const info = JSON.parse(v.info_json) as VaultInfoEnvelope & { retention?: unknown };
    const ret = validateRetention(info.retention);
    const retention: Required<Retention> = { ...DEFAULT_RETENTION, ...(ret.ok ? ret.value : {}) };
    const entry = { etag: v.info_etag, activeKv: info.activeKv, retention };
    this.infoCache.set(v.vault_id, entry);
    return entry;
  }

  // ---------------- records ----------------

  recordAt(vid: string, seq: Seq): VersionRecord | null {
    const r = this.s.get<RecordRow>(`SELECT ${REC_COLS} FROM versions v WHERE v.vault_id = ? AND v.seq = ?`, vid, seq);
    return r ? rowToRecord(r) : null;
  }

  headRow(vid: string, fileId: FileId): { head_seq: number; head_kind: "put" | "del"; path_key: string } | undefined {
    return this.s.get("SELECT head_seq, head_kind, path_key FROM files WHERE vault_id = ? AND file_id = ?", vid, fileId);
  }

  headRecord(vid: string, fileId: FileId): VersionRecord | null {
    const r = this.s.get<RecordRow>(`SELECT ${REC_COLS} FROM ${HEAD_JOIN} WHERE f.vault_id = ? AND f.file_id = ?`, vid, fileId);
    return r ? rowToRecord(r) : null;
  }

  livePathHolder(vid: string, pk: PathKey): FileId | undefined {
    return this.s.get<{ file_id: string }>(
      "SELECT file_id FROM files WHERE vault_id = ? AND path_key = ? AND head_kind = 'put'", vid, pk)?.file_id;
  }

  /**
   * Coalesced heads with head_seq > since, in seq order (design §2.9.6 step 2): at most `limit` records
   * and about `maxBytes` of JSON (at least one record). `full` = stopped by a limit, more may follow.
   */
  headsSince(vid: string, since: Seq, limit: number, maxBytes: number): PageResult {
    const out: VersionRecord[] = [];
    let bytes = 0;
    let full = false;
    const it = this.s.q(`SELECT ${REC_COLS} FROM ${HEAD_JOIN} WHERE f.vault_id = ? AND f.head_seq > ? ORDER BY f.head_seq LIMIT ?`)
      .iterate(vid, since, limit + 1) as IterableIterator<RecordRow>;
    for (const row of it) {
      if (out.length === limit) { full = true; break; }
      const rec = rowToRecord(row);
      const n = recordBytes(rec);
      if (out.length > 0 && bytes + n > maxBytes) { full = true; break; }
      out.push(rec);
      bytes += n;
    }
    return { records: out, lastSeq: out.length ? out[out.length - 1]!.seq : null, full };
  }

  /** Snapshot page ordered by fileId (design §2.8.5); heads only. */
  snapshotPage(vid: string, after: string, limit: number, tombstones: boolean): { records: VersionRecord[]; next: string | null } {
    const rows = this.s.all<RecordRow>(
      `SELECT ${REC_COLS} FROM ${HEAD_JOIN} WHERE f.vault_id = ? AND f.file_id > ? ${tombstones ? "" : "AND f.head_kind = 'put'"}
       ORDER BY f.file_id LIMIT ?`, vid, after, limit + 1);
    const more = rows.length > limit;
    const records = rows.slice(0, limit).map(rowToRecord);
    return { records, next: more ? records[records.length - 1]!.fileId : null };
  }

  versionsOf(vid: string, fileId: FileId, before: Seq, limit: number): { records: VersionRecord[]; next: Seq | null } {
    const rows = this.s.all<RecordRow>(
      `SELECT ${REC_COLS} FROM versions v WHERE v.vault_id = ? AND v.file_id = ? AND v.seq < ? ORDER BY v.seq DESC LIMIT ?`,
      vid, fileId, before, limit + 1);
    const records = rows.slice(0, limit).map(rowToRecord);
    return { records, next: rows.length > limit ? records[records.length - 1]!.seq : null };
  }

  versionOf(vid: string, fileId: FileId, seq: Seq): VersionRecord | null {
    const r = this.s.get<RecordRow>(`SELECT ${REC_COLS} FROM versions v WHERE v.vault_id = ? AND v.seq = ? AND v.file_id = ?`, vid, seq, fileId);
    return r ? rowToRecord(r) : null;
  }

  deleted(vid: string, before: Seq, limit: number): { records: VersionRecord[]; next: Seq | null } {
    const rows = this.s.all<RecordRow>(
      `SELECT ${REC_COLS} FROM ${HEAD_JOIN} WHERE f.vault_id = ? AND f.head_kind = 'del' AND f.head_seq < ?
       ORDER BY f.head_seq DESC LIMIT ?`, vid, before, limit + 1);
    const records = rows.slice(0, limit).map(rowToRecord);
    return { records, next: rows.length > limit ? records[records.length - 1]!.seq : null };
  }

  /** Bytes stored for the vault: blob files plus inline bodies. Quota counts this (cached, see StoredBytes). */
  storedBytes(vid: string): number {
    return this.stored.get(vid);
  }

  usage(vid: string): { liveBytes: number; historyBytes: number; blobCount: number; fileCount: number; largest: Array<{ fileId: string; encSize: number }> } {
    const live = this.s.get<{ n: number | null; c: number }>(
      `SELECT SUM(v.enc_size) AS n, COUNT(*) AS c FROM ${HEAD_JOIN} WHERE f.vault_id = ? AND f.head_kind = 'put'`, vid);
    const heads = this.s.get<{ n: number | null }>(`SELECT SUM(v.enc_size) AS n FROM ${HEAD_JOIN} WHERE f.vault_id = ?`, vid)?.n ?? 0;
    const all = this.s.get<{ n: number | null }>("SELECT SUM(enc_size) AS n FROM versions WHERE vault_id = ?", vid)?.n ?? 0;
    const blobCount = this.s.get<{ c: number }>("SELECT COUNT(*) AS c FROM blobs WHERE vault_id = ?", vid)?.c ?? 0;
    const largest = this.s.all<{ file_id: string; enc_size: number }>(
      `SELECT f.file_id, v.enc_size FROM ${HEAD_JOIN} WHERE f.vault_id = ? AND f.head_kind = 'put' ORDER BY v.enc_size DESC LIMIT 20`, vid)
      .map((r) => ({ fileId: r.file_id, encSize: r.enc_size }));
    return { liveBytes: live?.n ?? 0, historyBytes: all - heads, blobCount, fileCount: live?.c ?? 0, largest };
  }

  // ---------------- cursors ----------------

  ackCursor(vid: string, deviceId: string, upTo: Seq): void {
    this.s.run(
      `INSERT INTO device_cursors (vault_id, device_id, acked_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (vault_id, device_id) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at`,
      vid, deviceId, upTo, this.now());
  }

  rollbackAckOf(vid: string, deviceId: string): number | null {
    return this.s.get<{ rollback_ack: number | null }>(
      "SELECT rollback_ack FROM device_cursors WHERE vault_id = ? AND device_id = ?", vid, deviceId)?.rollback_ack ?? null;
  }

  setRollbackAck(vid: string, deviceId: string, at: number, cursor: Seq): void {
    this.s.run(
      `INSERT INTO device_cursors (vault_id, device_id, acked_seq, updated_at, rollback_ack) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (vault_id, device_id) DO UPDATE SET rollback_ack = excluded.rollback_ack, updated_at = excluded.updated_at`,
      vid, deviceId, cursor, this.now(), at);
  }

  /**
   * A device has seen seqs above the server's head (design §2.6.1, restore that also restored hwm.json):
   * raise head_seq so no seq is reused and start the rollback rule.
   */
  raiseHeadForSeen(vid: string, seen: Seq): boolean {
    return txImmediate(this.s.db, () => {
      const v = this.vault(vid);
      if (!v || seen <= v.head_seq) return false;
      this.s.run(
        `UPDATE vaults SET restored_seq = COALESCE(MIN(restored_seq, head_seq), head_seq), head_seq = ?, rollback_at = ?
         WHERE vault_id = ?`, seen, this.now(), vid);
      return true;
    });
  }

  // ---------------- commits ----------------

  /**
   * §2.9.7 commit processing in one BEGIN IMMEDIATE transaction. Frame-level limits (op count, bytes)
   * are checked by the caller. Throws CommitProtocolError for a same-cid / different-digest resend.
   */
  commit(vid: string, deviceId: string, req: CommitRequest): CommitOutcome {
    try {
      return txImmediate(this.s.db, () => this.commitInTx(vid, deviceId, req));
    } catch (e) {
      this.stored.drop(vid);
      throw e;
    }
  }

  /**
   * The body of §2.9.7 without BEGIN/COMMIT: the caller holds the write transaction (group commit runs
   * each commit in its own SAVEPOINT inside one BEGIN IMMEDIATE … COMMIT, so one fsync covers a batch).
   */
  commitInTx(vid: string, deviceId: string, req: CommitRequest, expectEpoch?: number): CommitOutcome {
    const digest = sha256(opsDigestPreimage(req.ops));
    {
      const v = this.vault(vid);
      if (!v) throw new HttpError("VAULT_NOT_FOUND", "vault not found");
      if (expectEpoch !== undefined && v.epoch !== expectEpoch) throw new HttpError("SNAPSHOT_REQUIRED", "snapshot required (epoch)");
      const cached = this.s.get<{ ops_digest: Uint8Array; result_json: string }>(
        "SELECT ops_digest, result_json FROM commits WHERE vault_id = ? AND device_id = ? AND cid = ?", vid, deviceId, req.cid);
      const atomic = req.atomic === true;
      let reuse: Array<OpResult | null> = req.ops.map(() => null);
      if (cached) {
        if (!Buffer.from(cached.ops_digest).equals(digest)) throw new CommitProtocolError("same cid with a different ops digest");
        const stored = JSON.parse(cached.result_json) as CommitResponse | { staleEpoch: number };
        // A cid from before a rebuild (server-core rebuild): its seqs are gone and its plan targets the old
        // epoch. Neither replayed nor re-run: the device must bootstrap the new epoch and plan again.
        if ("staleEpoch" in stored) {
          throw new HttpError("SNAPSHOT_REQUIRED", `snapshot required (epoch): cid is from epoch ${stored.staleEpoch}`, {
            details: { minSeq: v.min_seq, epoch: v.epoch, reason: "epoch", rollbackAt: null },
          });
        }
        const prev = stored.results;
        const retry = (r: OpResult): boolean => !r.ok && RETRY_ON_RESEND.has(r.code);
        if (atomic) {
          const allRetryable = prev.every((r) => r.ok || retry(r)) && prev.some((r) => !r.ok);
          if (!allRetryable) reuse = prev.map((r) => r);
        } else {
          reuse = prev.map((r) => (retry(r) ? null : r));
        }
        if (reuse.every((r) => r !== null)) {
          return { response: { cid: req.cid, headSeq: v.head_seq, replayed: true, results: prev }, applied: [] };
        }
      }
      if (v.head_seq + req.ops.length > MAX_SEQ) {
        // Never allocate a seq past MAX_SEQ (a bogus hello.seenMaxSeq can raise the head that far):
        // refuse the commit instead of storing a seq node:sqlite cannot read back.
        throw new HttpError("INVALID", "seq space of this vault is exhausted");
      }
      const plan = new CommitPlan(this, v, deviceId, req.cid, atomic, this.now(), this.limits);
      const results: OpResult[] = req.ops.map((op, i) => reuse[i] ?? plan.evaluate(op, i));
      if (atomic) {
        plan.finalPathCheck(req.ops, results);
        if (results.some((r) => !r.ok)) {
          for (let i = 0; i < results.length; i++) {
            if (results[i]!.ok) results[i] = { i, ok: false, code: "ABORTED", message: "atomic commit aborted" };
          }
        } else plan.applyStaged(results);
      }
      const headSeq = plan.head;
      if (headSeq !== v.head_seq) this.s.run("UPDATE vaults SET head_seq = ? WHERE vault_id = ?", headSeq, vid);
      const stored: CommitResponse = { cid: req.cid, headSeq, replayed: false, results };
      this.s.run(
        `INSERT INTO commits (vault_id, device_id, cid, ops_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (vault_id, device_id, cid) DO UPDATE SET result_json = excluded.result_json`,
        vid, deviceId, req.cid, digest, JSON.stringify(stored), this.now());
      return { response: { ...stored, replayed: cached !== undefined }, applied: plan.applied };
    }
  }
}

/**
 * Evaluates one commit (design §2.5 CAS table). Non-atomic: each op is checked and written in order,
 * so later ops see earlier ones. Atomic: ops are checked against a working view and staged; pathKey
 * uniqueness is checked on the final state (swaps and rename chains pass), then all are written or none.
 */
class CommitPlan {
  head: Seq;
  readonly applied: VersionRecord[] = [];
  private readonly activeKv: number;
  private quotaLeft: number;
  /** Atomic only: fileId → working head (seq null = staged in this commit). */
  private work = new Map<FileId, { kind: "put" | "del"; pathKey: PathKey; seq: Seq | null }>();
  private staged: Array<{ i: number; op: CommitOp; dec: DecodedOp; encSize: number }> = [];

  constructor(
    private readonly st: Store, private readonly v: VaultRow, private readonly device: string,
    private readonly cid: string, private readonly atomic: boolean, private readonly ts: number,
    private readonly limits: WelcomeLimits,
  ) {
    this.head = v.head_seq;
    this.activeKv = st.infoOf(v).activeKv;
    this.quotaLeft = v.quota_bytes === null ? Infinity : v.quota_bytes - st.storedBytes(v.vault_id);
  }

  private casHead(f: FileId): { seq: Seq | null; kind: "put" | "del" } | null {
    const w = this.work.get(f);
    if (w) return w;
    const h = this.st.headRow(this.v.vault_id, f);
    return h ? { seq: h.head_seq, kind: h.head_kind } : null;
  }

  evaluate(op: CommitOp, i: number): OpResult {
    const vid = this.v.vault_id;
    // design §2.9.7 step 1, D5: kv must be the active key version (remote-spec's "not retired" loses to v1).
    if (op.kv !== this.activeKv) return { i, ok: false, code: "KEY_VERSION", message: `kv ${op.kv} is not the active kv ${this.activeKv}` };
    const size = checkOpSizes(op);
    if (size) return { i, ok: false, code: "INVALID", message: size.message };
    const meta = b64uDecodeStrict(op.meta);
    const inlineText = op.op !== "del" && typeof op.inline === "string" ? op.inline : null;
    const inline = inlineText === null ? null : b64uDecodeStrict(inlineText);
    if (!meta || (inlineText !== null && !inline)) return { i, ok: false, code: "INVALID", message: "non-canonical base64url" };

    const H = this.casHead(op.fileId);
    const current = (): VersionRecord | null => this.st.headRecord(vid, op.fileId);
    if (op.op === "put") {
      if (op.base === null ? H !== null : (H === null || H.seq !== op.base)) return { i, ok: false, code: "CONFLICT", current: current() };
    } else if (op.op === "del") {
      if (H === null || H.kind === "del" || H.seq !== op.base) return { i, ok: false, code: "CONFLICT", current: current() };
    } else {
      if (H === null) return { i, ok: false, code: "INVALID", message: "archive for a fileId without a head" };
      if (H.seq !== null && op.base > H.seq) return { i, ok: false, code: "INVALID", message: "archive base above the head" };
    }
    if (op.op === "put" && !this.atomic) {
      const holder = this.st.livePathHolder(vid, op.pathKey);
      if (holder !== undefined && holder !== op.fileId) return { i, ok: false, code: "PATH_TAKEN", current: this.st.headRecord(vid, holder) };
    }

    // Blobs must have a live row (design §2.9.7; doomed → MISSING_BLOB, the client re-PUTs). encSize is recomputed.
    let encSize = 0;
    if (op.op !== "del") {
      const missing: BlobId[] = [];
      for (const b of op.blobs) {
        const row = this.st.s.get<{ size: number; state: string }>("SELECT size, state FROM blobs WHERE vault_id = ? AND blob_id = ?", vid, b);
        if (!row || row.state !== "live") { if (!missing.includes(b)) missing.push(b); } else encSize += row.size;
      }
      if (missing.length > 0) return { i, ok: false, code: "MISSING_BLOB", missing };
      if (inline) encSize += inline.length;
    }
    if (encSize > this.limits.maxFileSize + ENCSIZE_SLACK) return { i, ok: false, code: "TOO_LARGE", message: "file exceeds maxFileSize" };
    const inlineBytes = inline ? inline.length : 0;
    if (op.op !== "del" && inlineBytes > this.quotaLeft) return { i, ok: false, code: "QUOTA", message: "vault limit exceeded" };
    if (op.op !== "del" && this.quotaLeft !== Infinity && this.quotaLeft <= 0) return { i, ok: false, code: "QUOTA", message: "vault limit exceeded" };
    this.quotaLeft -= inlineBytes;

    const dec: DecodedOp = { meta, inline };
    if (!this.atomic) {
      const seq = this.write(op, dec, encSize);
      if (op.op !== "archive") this.upsertFile(op, seq);
      return { i, ok: true, seqs: [seq] };
    }
    this.staged.push({ i, op, dec, encSize });
    if (op.op !== "archive") this.work.set(op.fileId, { kind: op.op, pathKey: op.pathKey, seq: null });
    return { i, ok: true, seqs: [0] }; // placeholder; applyStaged assigns the seq
  }

  /** fileIds live at `pk` after the staged ops. */
  private liveHoldersAfter(pk: PathKey): FileId[] {
    const out = new Set<FileId>();
    const holder = this.st.livePathHolder(this.v.vault_id, pk);
    if (holder !== undefined) {
      const w = this.work.get(holder);
      if (!w || (w.kind === "put" && w.pathKey === pk)) out.add(holder);
    }
    for (const [f, w] of this.work) if (w.kind === "put" && w.pathKey === pk) out.add(f);
    return [...out];
  }

  finalPathCheck(ops: readonly CommitOp[], results: OpResult[]): void {
    ops.forEach((op, i) => {
      if (op.op !== "put" || !results[i]!.ok) return;
      const other = this.liveHoldersAfter(op.pathKey).find((f) => f !== op.fileId);
      if (other === undefined) return;
      results[i] = { i, ok: false, code: "PATH_TAKEN", current: this.st.headRecord(this.v.vault_id, other) };
    });
  }

  applyStaged(results: OpResult[]): void {
    const finalRows = new Map<FileId, { op: CommitOp; seq: Seq }>();
    for (const { i, op, dec, encSize } of this.staged) {
      const seq = this.write(op, dec, encSize);
      results[i] = { i, ok: true, seqs: [seq] };
      if (op.op !== "archive") finalRows.set(op.fileId, { op, seq });
    }
    // The partial unique index files_live_path is checked per statement, not deferred: delete every
    // touched row first, then insert the final rows (validated by finalPathCheck), so swaps pass.
    for (const f of finalRows.keys()) this.st.s.run("DELETE FROM files WHERE vault_id = ? AND file_id = ?", this.v.vault_id, f);
    for (const { op, seq } of finalRows.values()) this.upsertFile(op, seq);
  }

  private upsertFile(op: CommitOp, seq: Seq): void {
    this.st.s.run(
      `INSERT INTO files (vault_id, file_id, head_seq, head_kind, path_key, rc) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (vault_id, file_id) DO UPDATE SET head_seq = excluded.head_seq, head_kind = excluded.head_kind,
         path_key = excluded.path_key, rc = excluded.rc`,
      this.v.vault_id, op.fileId, seq, op.op, op.pathKey, op.rc);
  }

  private write(op: CommitOp, dec: DecodedOp, encSize: number): Seq {
    const vid = this.v.vault_id;
    const seq = ++this.head;
    const blobs = op.op === "del" ? [] : op.blobs;
    const args: SqlArg[] = [vid, seq, op.fileId, op.pathKey, op.base, op.op, op.rc, op.kv, dec.meta, dec.inline, encSize, this.device, this.ts, this.cid];
    this.st.s.run(
      `INSERT INTO versions (vault_id, seq, file_id, path_key, base_seq, kind, rc, kv, meta, inline, enc_size, device_id, ts, cid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...args);
    if (dec.inline) this.st.stored.add(vid, dec.inline.length);
    blobs.forEach((b, ord) => this.st.s.run("INSERT INTO version_blobs (vault_id, seq, ord, blob_id) VALUES (?, ?, ?, ?)", vid, seq, ord, b));
    for (const b of new Set(blobs)) this.st.s.run("UPDATE blobs SET touched_at = ? WHERE vault_id = ? AND blob_id = ?", this.ts, vid, b);
    const rec: VersionRecord = {
      seq, fileId: op.fileId, pathKey: op.pathKey, base: op.base, kind: op.op, rc: op.rc, kv: op.kv, meta: op.meta,
      blobs: [...blobs], encSize, device: this.device, ts: this.ts, cid: this.cid,
    };
    if (op.op !== "del" && typeof op.inline === "string") rec.inline = op.inline;
    this.applied.push(rec);
    return seq;
  }
}
