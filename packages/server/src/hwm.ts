// Seq high-water mark (design §2.6.1, S1, ID-10). AGPL-3.0-only.
// vaults/<vid>/hwm.json = {"epoch":1,"headSeq":18240}, written (temp, fsync, rename) at most once per
// second after commits and at shutdown; it never exceeds the DB's committed head.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import type { Stmts } from "./db";
import { txImmediate } from "./db";

export interface Hwm { epoch: number; headSeq: number }

export function hwmPath(dataDir: string, vid: string): string {
  return path.join(dataDir, "vaults", vid, "hwm.json");
}

export function readHwm(dataDir: string, vid: string): Hwm | null {
  try {
    const v = JSON.parse(readFileSync(hwmPath(dataDir, vid), "utf8")) as Partial<Hwm>;
    if (Number.isSafeInteger(v.headSeq) && (v.headSeq as number) >= 0 && Number.isSafeInteger(v.epoch)) return v as Hwm;
  } catch { /* absent or unreadable: no high-water mark */ }
  return null;
}

export function writeHwm(dataDir: string, vid: string, hwm: Hwm): void {
  const file = hwmPath(dataDir, vid);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(hwm));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

/** Same as writeHwm, with the fsyncs on the thread pool so commits are not blocked behind them. */
export async function writeHwmAsync(dataDir: string, vid: string, hwm: Hwm): Promise<void> {
  const file = hwmPath(dataDir, vid);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(hwm));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  const dh = await open(dir, "r");
  try { await dh.sync(); } finally { await dh.close(); }
}

/**
 * Start-of-day check per vault: if the DB head is below hwm.headSeq (an older DB was restored), set
 * restored_seq = head_seq, raise head_seq to the mark (no seq is ever reused) and set rollback_at.
 * Returns the vaults that were raised.
 */
export function reconcileHwm(s: Stmts, dataDir: string, now: number): Array<{ vaultId: string; from: number; to: number }> {
  const raised: Array<{ vaultId: string; from: number; to: number }> = [];
  for (const v of s.all<{ vault_id: string; head_seq: number }>("SELECT vault_id, head_seq FROM vaults")) {
    const hwm = readHwm(dataDir, v.vault_id);
    if (!hwm || hwm.headSeq <= v.head_seq) continue;
    txImmediate(s.db, () => {
      s.run(
        `UPDATE vaults SET restored_seq = COALESCE(MIN(restored_seq, head_seq), head_seq), head_seq = ?, rollback_at = ?
         WHERE vault_id = ? AND head_seq < ?`, hwm.headSeq, now, v.vault_id, hwm.headSeq);
    });
    raised.push({ vaultId: v.vault_id, from: v.head_seq, to: hwm.headSeq });
  }
  return raised;
}

/** Throttled writer: at most one write per vault per second after commits; flushAll() at shutdown. */
export class HwmWriter {
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly s: Stmts, private readonly dataDir: string, private readonly log: (m: string) => void, private readonly intervalMs = 1000) {}

  mark(vid: string): void {
    this.dirty.add(vid);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flushAll(); }, this.intervalMs);
  }

  /** Writes every dirty mark; writes are serialized so an older value never lands after a newer one. */
  flushAll(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const vids = [...this.dirty];
    this.dirty.clear();
    // The value is read now, after the commits it covers are durable, so it never exceeds the DB head.
    const jobs = vids.map((vid) => ({ vid, v: this.s.get<{ head_seq: number; epoch: number }>("SELECT head_seq, epoch FROM vaults WHERE vault_id = ?", vid) }));
    this.inFlight = this.inFlight.then(async () => {
      for (const { vid, v } of jobs) {
        if (!v) continue;
        const prev = readHwm(this.dataDir, vid);
        if (prev && prev.headSeq >= v.head_seq && prev.epoch === v.epoch) continue;
        try {
          await writeHwmAsync(this.dataDir, vid, { epoch: v.epoch, headSeq: Math.max(v.head_seq, prev?.headSeq ?? 0) });
        } catch (e) {
          this.log(`hwm write failed for a vault: ${String(e)}`);
          this.dirty.add(vid);
        }
      }
    });
    return this.inFlight;
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
