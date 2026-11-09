// Ingest: the engine's ChangeSink (design §3.8.1, §3.8.6, §4.9.1, §4.14; engine-spec §5.1).
//
// onChanges(batch):
//  1. Outside any transaction: per record, the freshness check (§4.9.1) against the last known head
//     (including earlier records of the same batch), then openMeta with the header as received.
//     Failures are quarantined, never thrown: the cursor still advances (§4.14).
//  2. ONE transaction (through FileIndex.write, so the in-memory mirror follows the store): heads
//     (max seq kept, §3.6.3), applyQueue rows, history hints, integrity rows + integrity holds,
//     purged tombstones, and the cursor/minSeq. The cursor is never persisted without the records it
//     covers (I2); a crash before this transaction makes the adapter re-deliver the batch.
//  3. seen.maxSeq (localStorage, §4.9.2) and a loop kick, after the commit.
//
// Own records: a record whose cid belongs to a batch still in our journal is mirrored but not queued
// for apply; the ack transaction marks the file synced (design §3.7.3, S18).
//
// headOf / liveHeadByPathKey (S3 CAS, design §2.10.3) answer from persisted state: the raw head record
// of each fileId is kept in the `history` store next to the archive hints (one non-archive row per
// fileId, the one whose seq equals the mirrored head) and reloaded by load() after a restart. A head
// learned from our own ack before its record arrived is answered from the mirrored RemoteHead (exact
// CAS fields; `meta` is not known there and is empty).

import { checkRecordFreshness } from "@shuttle/crypto";
import type {
  ChangeBatch, ChangeSink, ConnectionState, FileId, Keyring, PathKey, RemoteAdapter, RemoteError, RemoteHead, RetentionClass, Seq,
  SnapshotRequiredInfo, StateTx, VersionRecord,
} from "@shuttle/protocol";
import { IntegrityError, LockedError } from "../errors";
import type { FileIndex, IndexWriter } from "../index/FileIndex";
import { getMeta, setMeta } from "../state/StateStore";
import { crashPoint } from "../testing/crashPoint";
import type { DirtyKey, DirtyReason, PlanMode } from "../types";
import type { EngineHooks } from "@shuttle/protocol";
import { decodeRecord, isApprovedTombstone } from "./records";

export interface IngestDeps {
  index: FileIndex;
  keyring(): Keyring | null;
  remote: RemoteAdapter;
  now(): number;
  hooks?: EngineHooks;
  markDirty(key: DirtyKey, reason: DirtyReason): void;
  /** seen.maxSeq (localStorage, design §4.9.2). */
  onSeen?(maxSeq: Seq): void;
  /** The loop should drain the apply queue. */
  kick?(reason: 'remote'): void;
  onSnapshotRequired?(info: SnapshotRequiredInfo): void;
  onVaultInfoChanged?(etag: string): void;
  onState?(state: ConnectionState, detail?: string): void;
  onError?(err: RemoteError): void;
  log?(e: { key: string; cat: 'error' | 'general'; params?: Record<string, string | number | boolean | null>; fileId?: FileId }): void;
  /** Retention class of a path, for heads stored before they carried `rc` (headOf fallback). */
  rcOf?(path: string): RetentionClass;
  /** A tombstone the sender's user approved through its mass-delete guard (design §3.13). */
  onApprovedDelete?(fileId: FileId, seq: Seq): void;
}

export interface Quarantined { rec: VersionRecord; reason: string; stage: string }

export interface ResyncResult { changed: FileId[]; purged: FileId[]; cursor: Seq; quarantined: number }

/** Modes of design §3.8.6: keep the max seq, or replace the mirror (epoch change, accepted rollback). */
export type ResyncMode = Extract<PlanMode, 'snapshotResync' | 'epoch' | 'rebuild'> | 'rollback';

export class Ingest implements ChangeSink {
  /** Raw head records seen live (S3 adapters' CAS lookups; memory only). */
  private readonly raw = new Map<FileId, VersionRecord>();
  private readonly rawByPk = new Map<PathKey, FileId>();

  constructor(private readonly d: IngestDeps) {}

  private ring(): Keyring {
    const r = this.d.keyring();
    if (!r) throw new LockedError();
    return r;
  }

  async onChanges(batch: ChangeBatch): Promise<void> {
    // Locked: reject, so the adapter does not ack; the batch is re-delivered after unlock.
    const ring = this.ring();
    const heads = new Map<FileId, RemoteHead>();
    const raws = new Map<FileId, VersionRecord>();
    const hist: VersionRecord[] = [];
    const bad: Quarantined[] = [];
    for (const rec of batch.records) {
      const known = heads.get(rec.fileId) ?? this.d.index.remote.byFileId(rec.fileId);
      try {
        if (checkRecordFreshness(rec, known) === "ignore") {
          // Our own acked head arriving through the feed: keep its raw record for headOf.
          if (rec.kind !== "archive" && known && known.seq === rec.seq && this.raw.get(rec.fileId)?.seq !== rec.seq) raws.set(rec.fileId, rec);
          continue;
        }
        const dec = await decodeRecord(ring, rec);
        if (dec.head === null) {
          hist.push(rec);
          continue;
        }
        if (dec.head.deleted && isApprovedTombstone(dec.meta)) this.d.onApprovedDelete?.(rec.fileId, rec.seq);
        heads.set(rec.fileId, dec.head);
        raws.set(rec.fileId, rec);
      } catch (err) {
        bad.push({ rec, reason: reasonOf(err), stage: stageOf(err) });
      }
    }
    await crashPoint(this.d.hooks, "ingest:decoded");
    const queued: FileId[] = [];
    const held: FileId[] = [];
    let stored: VersionRecord[] = [];
    await this.d.index.write(["applyQueue", "history", "integrity", "meta", "batches"], async (w) => {
      const tx = w.tx;
      for (const h of heads.values()) {
        if (!(await w.upsertRemote(h))) continue;
        const own = h.cid !== undefined && (await tx.batches.get(h.cid)) !== undefined;
        if (own) continue;
        await tx.applyQueue.put({ fileId: h.fileId, seq: h.seq, enqueuedAt: this.d.now(), attempts: 0 });
        queued.push(h.fileId);
      }
      for (const r of hist) await tx.history.put(r);
      stored = await storeRawHeadsIn(w, raws.values());
      for (const q of bad) if (await quarantineIn(w, q)) held.push(q.rec.fileId);
      await purgeTombstonesIn(w, batch.minSeq);
      const cur = (await getMeta(tx, "cursor")) ?? 0;
      if (batch.to > cur) {
        await setMeta(tx, "cursor", batch.to);
        await setMeta(tx, "cursorAt", this.d.now());
      }
      await setMeta(tx, "minSeq", batch.minSeq);
    });
    await crashPoint(this.d.hooks, "ingest:committed");
    for (const r of stored) this.rememberRaw(r);
    for (const q of bad) this.d.log?.({ key: "log.integrityQuarantined", cat: "error", params: { seq: q.rec.seq, stage: q.stage }, fileId: q.rec.fileId });
    this.d.onSeen?.(batch.headSeq);
    if (queued.length > 0 || held.length > 0) this.d.kick?.("remote");
  }

  /** Reload the raw head records from the state store (engine start, after a restart). */
  async load(): Promise<number> {
    const rows = await this.d.index.state.tx(["history"], (tx) => tx.history.getAll(), "readonly");
    this.raw.clear();
    this.rawByPk.clear();
    let n = 0;
    for (const rec of rows) {
      if (rec.kind === "archive") continue;
      const R = this.d.index.remote.byFileId(rec.fileId);
      if (!R || R.seq !== rec.seq) continue;
      this.rememberRaw(rec);
      n++;
    }
    return n;
  }

  /**
   * The current materialized head of `fileId` (design §2.12 ChangeSink.headOf): the mirrored head's
   * raw record when known, else a record built from the persisted RemoteHead. Never a stale record:
   * the answer always has the mirrored head's seq.
   */
  headOf(fileId: FileId): VersionRecord | null {
    const R = this.d.index.remote.byFileId(fileId);
    if (!R) return null;
    const raw = this.raw.get(fileId);
    if (raw && raw.seq === R.seq) return raw;
    return this.recordOf(R);
  }

  liveHeadByPathKey(pk: PathKey): VersionRecord | null {
    const R = this.d.index.remote.liveByPathKey(pk);
    return R && !R.deleted ? this.headOf(R.fileId) : null;
  }

  /** VersionRecord view of a mirrored head (CAS fields exact; meta ciphertext unknown, encSize 0). */
  private recordOf(R: RemoteHead): VersionRecord {
    const rec: VersionRecord = {
      seq: R.seq, fileId: R.fileId, pathKey: R.pathKey, base: R.base, kind: R.deleted ? "del" : "put",
      rc: R.rc ?? this.d.rcOf?.(R.path) ?? "note", kv: R.kv, meta: "", blobs: R.deleted ? [] : [...R.blobs], encSize: 0,
      device: R.deviceId, ts: R.ts,
    };
    if (R.cid !== undefined) rec.cid = R.cid;
    if (!R.deleted && R.inline !== undefined) rec.inline = R.inline;
    return rec;
  }

  onSnapshotRequired(info: SnapshotRequiredInfo): void {
    this.d.onSnapshotRequired?.(info);
  }

  onVaultInfoChanged(etag: string): void {
    this.d.onVaultInfoChanged?.(etag);
  }

  onState(state: ConnectionState, detail?: string): void {
    this.d.onState?.(state, detail);
  }

  onError(err: RemoteError): void {
    this.d.onError?.(err);
  }

  private rememberRaw(rec: VersionRecord, replace = false): void {
    const prev = this.raw.get(rec.fileId);
    if (prev && prev.seq >= rec.seq && !replace) return;
    if (prev && this.rawByPk.get(prev.pathKey) === rec.fileId) this.rawByPk.delete(prev.pathKey);
    this.raw.set(rec.fileId, rec);
    if (rec.kind === "put") this.rawByPk.set(rec.pathKey, rec.fileId);
  }

  /**
   * design §3.8.6 snapshot resync: stream the snapshot (tombstones included) into a temporary map,
   * catch up from the first page's headSeq, then in one transaction update changed heads (enqueue
   * applies), delete purged heads, and persist the cursor. Purged fileIds and every changed fileId
   * with a local entry are marked dirty; the caller runs that pass with ctx.mode = `mode`.
   */
  async snapshotResync(mode: ResyncMode): Promise<ResyncResult> {
    const ring = this.ring();
    const map = new Map<FileId, RemoteHead>();
    const raws = new Map<FileId, VersionRecord>();
    const bad: Quarantined[] = [];
    let token: string | null = null;
    let firstHead: Seq | null = null;
    let minSeq = 0;
    for (;;) {
      const page = await this.d.remote.snapshot({ pageToken: token, tombstones: true });
      if (firstHead === null) {
        firstHead = page.headSeq;
        minSeq = page.minSeq;
      }
      for (const rec of page.records) await this.decodeInto(ring, rec, map, bad, raws);
      token = page.next;
      if (!token) break;
    }
    let cursor = firstHead ?? 0;
    for (;;) {
      const b = await this.d.remote.pull(cursor);
      for (const rec of b.records) {
        if (rec.kind === "archive") continue;
        const known = map.get(rec.fileId) ?? null;
        if (known && rec.seq <= known.seq) continue;
        await this.decodeInto(ring, rec, map, bad, raws);
      }
      minSeq = b.minSeq;
      cursor = Math.max(cursor, b.to);
      if (!b.more) break;
    }
    await crashPoint(this.d.hooks, "resync:decoded");
    const changed: FileId[] = [];
    const purged: FileId[] = [];
    const replace = mode === "epoch" || mode === "rollback" || mode === "rebuild";
    let stored: VersionRecord[] = [];
    await this.d.index.write(["applyQueue", "integrity", "meta", "history"], async (w) => {
      const tx = w.tx;
      for (const h of map.values()) {
        const prev = w.remote(h.fileId);
        if (prev && prev.seq === h.seq && !replace) continue;
        if (prev && sameHead(prev, h)) continue;
        if (replace && prev) await w.deleteRemote(h.fileId);
        if (!(await w.upsertRemote(h))) continue;
        await tx.applyQueue.put({ fileId: h.fileId, seq: h.seq, enqueuedAt: this.d.now(), attempts: 0 });
        changed.push(h.fileId);
      }
      for (const prev of [...this.d.index.remote.all()]) {
        if (map.has(prev.fileId)) continue;
        if (!replace && prev.seq > (firstHead ?? 0)) continue;
        await w.deleteRemote(prev.fileId);       // XS-08: purged on the remote
        await tx.applyQueue.delete(prev.fileId);
        await dropRawHeadsIn(tx, prev.fileId, Infinity);
        purged.push(prev.fileId);
      }
      stored = await storeRawHeadsIn(w, raws.values());
      for (const q of bad) await quarantineIn(w, q);
      await setMeta(tx, "cursor", cursor);
      await setMeta(tx, "cursorAt", this.d.now());
      await setMeta(tx, "minSeq", minSeq);
    });
    await crashPoint(this.d.hooks, "resync:committed");
    for (const id of purged) {
      const old = this.raw.get(id);
      if (old && this.rawByPk.get(old.pathKey) === id) this.rawByPk.delete(old.pathKey);
      this.raw.delete(id);
    }
    for (const r of stored) this.rememberRaw(r, true);
    for (const id of [...changed, ...purged]) {
      const e = this.d.index.byFileId(id);
      if (e) this.d.markDirty({ fileId: id, path: e.path }, "remote");
    }
    this.d.onSeen?.(cursor);
    this.d.kick?.("remote");
    return { changed, purged, cursor, quarantined: bad.length };
  }

  private async decodeInto(ring: Keyring, rec: VersionRecord, map: Map<FileId, RemoteHead>, bad: Quarantined[], raws: Map<FileId, VersionRecord>): Promise<void> {
    try {
      const dec = await decodeRecord(ring, rec);
      if (dec.head?.deleted && isApprovedTombstone(dec.meta)) this.d.onApprovedDelete?.(rec.fileId, rec.seq);
      if (dec.head) {
        const prev = map.get(rec.fileId);
        if (!prev || prev.seq < dec.head.seq) {
          map.set(rec.fileId, dec.head);
          raws.set(rec.fileId, rec);
        }
      }
    } catch (err) {
      bad.push({ rec, reason: reasonOf(err), stage: stageOf(err) });
    }
  }
}

function sameHead(a: RemoteHead, b: RemoteHead): boolean {
  return a.seq === b.seq && a.deleted === b.deleted && a.contentHash === b.contentHash && a.path === b.path;
}

/**
 * Persist raw head records whose seq equals the mirrored head (after this transaction's upserts), and
 * drop that fileId's older raw heads. Archive hints are never touched. Returns the records stored.
 */
async function storeRawHeadsIn(w: IndexWriter, recs: Iterable<VersionRecord>): Promise<VersionRecord[]> {
  const out: VersionRecord[] = [];
  for (const rec of recs) {
    if (rec.kind === "archive") continue;
    const R = w.remote(rec.fileId);
    if (!R || R.seq !== rec.seq) continue;
    await dropRawHeadsIn(w.tx, rec.fileId, rec.seq);
    await w.tx.history.put(rec);
    out.push(rec);
  }
  return out;
}

/** Delete the raw head records (not archives) of `fileId` with seq below `below`. */
async function dropRawHeadsIn(tx: StateTx, fileId: FileId, below: Seq): Promise<void> {
  for (const r of await tx.history.getAll({ index: "fileId", only: fileId })) {
    if (r.kind !== "archive" && r.seq < below) await tx.history.delete(r.seq);
  }
}

/** Integrity row + integrity hold on the entry (design §4.9.1 REJECT, §4.14). Returns true if an entry is held. */
async function quarantineIn(w: IndexWriter, q: Quarantined): Promise<boolean> {
  await w.tx.integrity.put({ seq: q.rec.seq, fileId: q.rec.fileId, reason: q.reason, stage: q.stage });
  const e = w.entry(q.rec.fileId);
  if (!e || e.integrityHold) return false;
  await w.putEntry({ ...e, integrityHold: true });
  return true;
}

/**
 * S3 (design §3.8.1): tombstones at or below minSeq were purged on the remote. A tombstone is dropped
 * only when nothing local still depends on it (no entry, no pending apply): an entry with a base and no
 * head would otherwise read as "R absent" (INTEGRITY_ERROR) before its delete is applied.
 */
async function purgeTombstonesIn(w: IndexWriter, minSeq: Seq): Promise<void> {
  if (minSeq <= 0) return;
  // Read from the committed mirror plus this transaction's view.
  const tx = w.tx;
  for (const h of (await tx.remote.getAll({ index: "deleted", only: true }))) {
    if (h.seq > minSeq) continue;
    if (w.entry(h.fileId)) continue;
    if ((await tx.applyQueue.get(h.fileId)) !== undefined) continue;
    await w.deleteRemote(h.fileId);
    await dropRawHeadsIn(tx, h.fileId, Infinity);
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

function stageOf(err: unknown): string {
  if (err instanceof IntegrityError) return err.stage;
  if (err instanceof Error && err.name === "CryptoError" && (err as { code?: string }).code === "Replay") return "freshness";
  return "meta";
}
