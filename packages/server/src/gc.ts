// Retention, thinning, tombstone purge, blob GC and backups (design §2.6.5, §2.7). AGPL-3.0-only.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { CID_CACHE_DAYS } from "@shuttle/protocol";
import { metaGet, metaSet, txImmediate } from "./db";
import type { Server } from "./server-core";
import { DAY_MS, HOUR_MS, MINUTE_MS, errText } from "./util";

const TX_ROWS = 2000;           // design §2.7.2: transactions ≤ 2000 rows
const BLOB_GRACE_MS = DAY_MS;   // design §2.7.1: 24 h after last upload or touch
const PHASE_B_DELAY_MS = HOUR_MS;
const ORPHAN_SCAN_EVERY_MS = 7 * DAY_MS;
const SOFT_DELETE_KEEP_MS = 30 * DAY_MS;
const BACKUPS_KEPT = 7;

export interface GcStats {
  versionsDeleted: number;
  tombstonesPurged: number;
  blobsDoomed: number;
  blobsDeleted: number;
  orphanFilesRemoved: number;
  commitsPruned: number;
  vaultsPurged: number;
  backup: string | null;
}

const yieldTick = () => new Promise<void>((r) => setImmediate(r));

interface VerRow { seq: number; file_id: string; kind: string; rc: string; ts: number }
interface HeadRow { file_id: string; head_seq: number; head_kind: string; base_seq: number | null; ts: number }

export class Maintenance {
  private running: Promise<GcStats> | null = null;

  constructor(private readonly srv: Server) {}

  /** One maintenance run; concurrent calls share the run in progress. */
  run(opts: { backup?: boolean } = {}): Promise<GcStats> {
    if (!this.running) {
      this.running = this.runOnce(opts.backup ?? false).finally(() => { this.running = null; });
    }
    return this.running;
  }

  private async runOnce(backup: boolean): Promise<GcStats> {
    const srv = this.srv;
    const stats: GcStats = {
      versionsDeleted: 0, tombstonesPurged: 0, blobsDoomed: 0, blobsDeleted: 0, orphanFilesRemoved: 0,
      commitsPruned: 0, vaultsPurged: 0, backup: null,
    };
    const vaults = srv.s.all<{ vault_id: string }>("SELECT vault_id FROM vaults WHERE deleted_at IS NULL");
    for (const { vault_id } of vaults) {
      try {
        await this.retention(vault_id, stats);
        await this.tombstones(vault_id, stats);
        this.blobSweep(vault_id, stats);
        this.orphanScan(vault_id, stats);
      } catch (e) {
        srv.cfg.log(`maintenance failed for a vault: ${errText(e)}`);
      }
      await yieldTick();
    }
    this.prune(stats);
    await this.purgeDeletedVaults(stats);
    srv.commitBuckets.sweep();
    srv.blobBuckets.sweep();
    if (backup) stats.backup = this.backup();
    return stats;
  }

  /** design §2.7.2 step 1: thinning and retention of non-head versions; the head's base is always kept. */
  private async retention(vid: string, stats: GcStats): Promise<void> {
    const srv = this.srv;
    const now = srv.cfg.now();
    const v = srv.store.vault(vid);
    if (!v) return;
    const ret = srv.store.infoOf(v).retention;
    const days: Record<string, number> = { note: ret.noteDays, attachment: ret.attachmentDays, config: ret.configDays };
    const thinAfter = ret.thinAfterHours * HOUR_MS;
    const bucketMs = Math.max(1, ret.thinBucketMinutes) * MINUTE_MS;
    const heads = new Map<string, HeadRow>();
    for (const h of srv.s.all<HeadRow>(
      `SELECT f.file_id, f.head_seq, f.head_kind, v.base_seq, v.ts FROM files f
       JOIN versions v ON v.vault_id = f.vault_id AND v.seq = f.head_seq WHERE f.vault_id = ?`, vid)) heads.set(h.file_id, h);

    const doomed: number[] = [];
    let group: VerRow[] = [];
    const flushGroup = () => {
      if (group.length === 0) return;
      const h = heads.get(group[0]!.file_id);
      const keep = new Set<number>();
      if (h) { keep.add(h.head_seq); if (h.base_seq !== null) keep.add(h.base_seq); }
      const buckets = new Map<number, number>(); // bucket → newest thinnable put seq
      for (const r of group) {
        if (keep.has(r.seq)) continue;
        const age = now - r.ts;
        if (age >= (days[r.rc] ?? ret.noteDays) * DAY_MS) { doomed.push(r.seq); continue; }
        if (r.kind === "put" && age > thinAfter) {
          const b = Math.floor(r.ts / bucketMs);
          const prev = buckets.get(b);
          if (prev === undefined) buckets.set(b, r.seq);
          else if (r.seq > prev) { doomed.push(prev); buckets.set(b, r.seq); } else doomed.push(r.seq);
        }
      }
      group = [];
    };
    const it = srv.s.q("SELECT seq, file_id, kind, rc, ts FROM versions WHERE vault_id = ? ORDER BY file_id, seq").iterate(vid) as IterableIterator<VerRow>;
    for (const r of it) {
      if (group.length > 0 && group[0]!.file_id !== r.file_id) flushGroup();
      group.push(r);
    }
    flushGroup();
    for (let i = 0; i < doomed.length; i += TX_ROWS) {
      const chunk = doomed.slice(i, i + TX_ROWS);
      txImmediate(srv.db, () => {
        for (const seq of chunk) {
          // Re-check inside the transaction: never delete a head (cannot become one, but stay safe).
          const r = srv.s.run(
            "DELETE FROM versions WHERE vault_id = ? AND seq = ? AND NOT EXISTS (SELECT 1 FROM files WHERE vault_id = ? AND head_seq = ?)",
            vid, seq, vid, seq);
          if (Number(r.changes) > 0) {
            srv.s.run("DELETE FROM version_blobs WHERE vault_id = ? AND seq = ?", vid, seq);
            stats.versionsDeleted++;
          }
        }
      });
      srv.store.stored.drop(vid); // inline bodies went with the versions
      await yieldTick();
    }
  }

  /** design §2.7.2 step 2: tombstones older than tombstoneDays take their whole fileId with them; minSeq advances. */
  private async tombstones(vid: string, stats: GcStats): Promise<void> {
    const srv = this.srv;
    const v = srv.store.vault(vid);
    if (!v) return;
    const cutoff = srv.cfg.now() - srv.store.infoOf(v).retention.tombstoneDays * DAY_MS;
    const old = srv.s.all<{ file_id: string }>(
      `SELECT f.file_id FROM files f JOIN versions v ON v.vault_id = f.vault_id AND v.seq = f.head_seq
       WHERE f.vault_id = ? AND f.head_kind = 'del' AND v.ts < ?`, vid, cutoff);
    for (let i = 0; i < old.length; i += 200) {
      const chunk = old.slice(i, i + 200);
      txImmediate(srv.db, () => {
        let maxSeq = 0;
        for (const { file_id } of chunk) {
          // Re-check: a resurrect may have landed since the query.
          const still = srv.s.get<{ head_seq: number }>(
            `SELECT f.head_seq FROM files f JOIN versions v ON v.vault_id = f.vault_id AND v.seq = f.head_seq
             WHERE f.vault_id = ? AND f.file_id = ? AND f.head_kind = 'del' AND v.ts < ?`, vid, file_id, cutoff);
          if (!still) continue;
          const m = srv.s.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM versions WHERE vault_id = ? AND file_id = ?", vid, file_id)?.m ?? 0;
          maxSeq = Math.max(maxSeq, m, still.head_seq);
          srv.s.run("DELETE FROM version_blobs WHERE vault_id = ? AND seq IN (SELECT seq FROM versions WHERE vault_id = ? AND file_id = ?)", vid, vid, file_id);
          srv.s.run("DELETE FROM versions WHERE vault_id = ? AND file_id = ?", vid, file_id);
          srv.s.run("DELETE FROM files WHERE vault_id = ? AND file_id = ?", vid, file_id);
          stats.tombstonesPurged++;
        }
        if (maxSeq > 0) srv.s.run("UPDATE vaults SET min_seq = MAX(min_seq, ?) WHERE vault_id = ?", maxSeq, vid);
      });
      srv.store.stored.drop(vid);
      await yieldTick();
    }
  }

  /**
   * design §2.7.2 step 3 and §2.7.7. Phase (b) runs ≥ 1 h after phase (a) marked rows doomed, in one
   * synchronous block: delete still-doomed unreferenced rows, then renameSync each file to graveyard/.
   * A blob PUT's final step is synchronous too, so it can never land between the two.
   */
  blobSweep(vid: string, stats: GcStats): void {
    const srv = this.srv;
    const now = srv.cfg.now();
    const key = `gc_phase_a:${vid}`;
    const doomedCount = srv.s.get<{ c: number }>("SELECT COUNT(*) AS c FROM blobs WHERE vault_id = ? AND state = 'doomed'", vid)?.c ?? 0;
    if (doomedCount > 0) {
      const markedAt = Number(metaGet(srv.s, key) ?? 0);
      if (now - markedAt < PHASE_B_DELAY_MS) return; // phase (b) not due; do not re-mark (that would starve it)
      this.phaseB(vid, stats);
    }
    const r = txImmediate(srv.db, () => {
      const res = srv.s.run(
        `UPDATE blobs SET state = 'doomed' WHERE vault_id = ? AND state = 'live' AND touched_at < ?
         AND NOT EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.vault_id = blobs.vault_id AND vb.blob_id = blobs.blob_id)`,
        vid, now - BLOB_GRACE_MS);
      if (Number(res.changes) > 0) metaSet(srv.s, key, String(now));
      return Number(res.changes);
    });
    stats.blobsDoomed += r;
  }

  /** Phase (b) alone, synchronous from start to the last rename (exported for the S13 tests). */
  phaseB(vid: string, stats?: GcStats): string[] {
    const srv = this.srv;
    const runId = `${srv.cfg.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const ids = txImmediate(srv.db, () => srv.s.all<{ blob_id: string }>(
      `DELETE FROM blobs WHERE vault_id = ? AND state = 'doomed'
       AND NOT EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.vault_id = blobs.vault_id AND vb.blob_id = blobs.blob_id)
       RETURNING blob_id`, vid).map((r) => r.blob_id));
    srv.store.stored.drop(vid);
    const moved: string[] = [];
    for (const id of ids) {
      const dest = path.join(srv.blobs.graveyard, `${id}.${runId}`);
      try {
        renameSync(srv.blobs.blobPath(vid, id), dest);
        moved.push(dest);
      } catch { /* already gone */ }
    }
    if (stats) stats.blobsDeleted += ids.length;
    for (const f of moved) void rm(f, { force: true });
    return ids;
  }

  /** design §2.7.6 step 5: weekly, remove blob files with no row that are older than 24 h. */
  private orphanScan(vid: string, stats: GcStats, force = false): void {
    const srv = this.srv;
    const now = srv.cfg.now();
    const key = `orphan_scan:${vid}`;
    const last = Number(metaGet(srv.s, key) ?? 0);
    if (!force && now - last < ORPHAN_SCAN_EVERY_MS) return;
    const root = path.join(srv.blobs.vaultDir(vid), "blobs");
    const wallCutoff = Math.min(now, Date.now()) - BLOB_GRACE_MS;
    if (existsSync(root)) {
      for (const a of readdirSync(root)) {
        for (const b of safeReaddir(path.join(root, a))) {
          for (const id of safeReaddir(path.join(root, a, b))) {
            const f = path.join(root, a, b, id);
            // Synchronous per file: check row, check age, unlink. No PUT can land in between.
            if (srv.blobs.row(vid, id)) continue;
            try {
              if (statSync(f).mtimeMs >= wallCutoff) continue;
              unlinkSync(f);
              stats.orphanFilesRemoved++;
            } catch { /* vanished */ }
          }
        }
      }
    }
    metaSet(srv.s, key, String(now));
  }

  /** design §2.7.2 step 4. */
  private prune(stats: GcStats): void {
    const srv = this.srv;
    const now = srv.cfg.now();
    txImmediate(srv.db, () => {
      stats.commitsPruned += Number(srv.s.run("DELETE FROM commits WHERE created_at < ?", now - CID_CACHE_DAYS * DAY_MS).changes);
      srv.s.run("DELETE FROM enroll_codes WHERE expires_at < ?", now - DAY_MS);
      srv.s.run("DELETE FROM pairing WHERE expires_at < ?", now - DAY_MS);
    });
  }

  private async purgeDeletedVaults(stats: GcStats): Promise<void> {
    const srv = this.srv;
    const gone = srv.s.all<{ vault_id: string }>("SELECT vault_id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < ?",
      srv.cfg.now() - SOFT_DELETE_KEEP_MS);
    for (const { vault_id } of gone) {
      txImmediate(srv.db, () => {
        for (const t of ["version_blobs", "versions", "files", "blobs", "commits", "device_cursors", "pairing", "vault_members", "vaults"]) {
          srv.s.run(`DELETE FROM ${t} WHERE vault_id = ?`, vault_id);
        }
        srv.s.run("DELETE FROM meta WHERE k IN (?, ?)", `gc_phase_a:${vault_id}`, `orphan_scan:${vault_id}`);
      });
      srv.store.stored.drop(vault_id);
      await rm(srv.blobs.vaultDir(vault_id), { recursive: true, force: true });
      stats.vaultsPurged++;
    }
  }

  /** design §2.6.5: VACUUM INTO backups/shuttle-YYYYMMDD.db once per day, keep 7. */
  backup(): string | null {
    const srv = this.srv;
    const d = new Date(srv.cfg.now());
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const dir = path.join(srv.cfg.dataDir, "backups");
    const file = path.join(dir, `shuttle-${stamp}.db`);
    if (existsSync(file)) return null;
    srv.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const all = readdirSync(dir).filter((f) => /^shuttle-\d{8}\.db$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) {
      try { unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
    }
    return file;
  }

  /** Test hook: run the orphan scan now regardless of the weekly schedule. */
  forceOrphanScan(vid: string): number {
    const stats = { orphanFilesRemoved: 0 } as GcStats;
    this.orphanScan(vid, stats, true);
    return stats.orphanFilesRemoved;
  }
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
