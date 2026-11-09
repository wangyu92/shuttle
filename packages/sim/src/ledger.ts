// Content ledger for I6 "no silent loss" (design §3.18 I6, §7.4, ops-spec §3.4).
//
// Every user action that produces content is recorded. Notes carry unique token lines ("tok-<n>"),
// so a clean 3-way merge, which produces neither side's exact bytes, still keeps every token: the
// ledger checks tokens for notes and whole-content hashes for binaries. An entry is retired only when
// the user removes it on purpose: deleting the token's line, overwriting or deleting the file that
// holds it on the device where the user acted.
//
// The evidence pool is where a surviving entry may be found: any file on any device (conflict copies
// and excluded folders included), the engine's trash on any device, and the content of every record
// the server has ever held (heads, older versions, archives). Records dropped by retention, by a
// remote rebuild or by a DB restore are captured before the sim drops them: losing history to
// retention is allowed by design; losing it in any other way is not something the server fake does.

import type { Keyring, RemoteHead, VersionRecord } from "@shuttle/protocol";
import type { FakeRemote, FakeRemoteServer } from "@shuttle/testkit";
import { BlobPipeline, decodeRecord, sha256Hex } from "@shuttle/engine";
import { SIM_PARAMS } from "./world";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });
const TOKEN_RE = /tok-\d+/g;

export function tokensOf(bytes: Uint8Array | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!bytes || bytes.length === 0) return out;
  const text = dec.decode(bytes);
  for (const m of text.matchAll(TOKEN_RE)) out.add(m[0]);
  return out;
}

export interface LedgerEntry {
  kind: 'token' | 'hash';
  value: string;
  device: string;
  path: string;
  step: number;
  retired: boolean;
}

export class Ledger {
  readonly entries = new Map<string, LedgerEntry>();
  private nextToken = 1;

  /** A fresh token line (unique within the run). */
  token(): string {
    return `tok-${this.nextToken++}`;
  }

  /** The user wrote `next` over `prev` (null = new file) at `path` on `device`. */
  async write(device: string, path: string, prev: Uint8Array | null, next: Uint8Array, step: number, note: boolean): Promise<void> {
    if (note) {
      const before = tokensOf(prev);
      const after = tokensOf(next);
      for (const t of before) if (!after.has(t)) this.retire(t);
      for (const t of after) if (!before.has(t) && !this.entries.has(t)) this.entries.set(t, { kind: "token", value: t, device, path, step, retired: false });
      return;
    }
    if (prev) await this.retireContent(prev);
    const h = await sha256Hex(next);
    const e = this.entries.get(h);
    if (e) e.retired = false;
    else this.entries.set(h, { kind: "hash", value: h, device, path, step, retired: false });
  }

  /** The user deleted (or overwrote) content on purpose. */
  async retireContent(bytes: Uint8Array): Promise<void> {
    for (const t of tokensOf(bytes)) this.retire(t);
    this.retire(await sha256Hex(bytes));
  }

  private retire(v: string): void {
    const e = this.entries.get(v);
    if (e) e.retired = true;
  }

  live(): LedgerEntry[] {
    return [...this.entries.values()].filter((e) => !e.retired);
  }
}

/** Content of every server record ever seen, plus a content cache keyed by sha256. */
export class Evidence {
  readonly serverTokens = new Set<string>();
  readonly serverHashes = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly byHash = new Map<string, Uint8Array>();
  private inspector: { server: FakeRemoteServer; ad: FakeRemote; pipe: BlobPipeline } | null = null;
  downloads = 0;

  constructor(private readonly ring: Keyring) {}

  /** Remember bytes seen anywhere (lookup aid only; not evidence by itself). */
  async remember(bytes: Uint8Array): Promise<string> {
    const h = await sha256Hex(bytes);
    if (!this.byHash.has(h)) this.byHash.set(h, bytes);
    return h;
  }

  /** Decode every record of `server` not captured yet (call before anything drops records). */
  async capture(server: FakeRemoteServer): Promise<void> {
    for (const rec of server.inspect().log) {
      const key = `${rec.seq}/${rec.fileId}/${rec.kind}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (rec.kind === "del") continue;
      const d = await decodeRecord(this.ring, rec);
      const m = d.meta as { hash: string; size: number };
      this.serverHashes.add(m.hash);
      let bytes = this.byHash.get(m.hash);
      if (!bytes) {
        bytes = await this.download(server, rec, d.meta as unknown as Meta);
        this.byHash.set(m.hash, bytes);
      }
      for (const t of tokensOf(bytes)) this.serverTokens.add(t);
    }
  }

  private async download(server: FakeRemoteServer, rec: VersionRecord, m: Meta): Promise<Uint8Array> {
    this.downloads++;
    if (rec.kind === "archive" && rec.inline !== undefined) {
      return this.ring.openInline(rec.inline, { fileId: rec.fileId, kv: rec.kv, kind: "archive", base: rec.base, rc: rec.rc, blobs: [], pathKey: rec.pathKey }, m.z, m.p, m.size);
    }
    if (!this.inspector || this.inspector.server !== server) {
      const ad = server.adapter("siminspector0000000000");
      await ad.connect();
      this.inspector = { server, ad, pipe: new BlobPipeline({ remote: ad, keyring: () => this.ring, params: () => SIM_PARAMS }) };
    }
    const head: RemoteHead = {
      fileId: rec.fileId, seq: rec.seq, base: rec.base, pathKey: rec.pathKey, path: m.path, deleted: false, size: m.size, mtime: m.mtime,
      contentHash: m.hash, chunkSizes: rec.blobs.length ? m.chunks : [], blobs: rec.blobs, kv: rec.kv, deviceId: rec.device, ts: rec.ts,
      rc: rec.rc, z: m.z, p: m.p, ...(rec.inline !== undefined ? { inline: rec.inline } : {}),
    };
    return this.inspector.pipe.download(head, rec.rc);
  }
}

interface Meta { path: string; size: number; mtime: number; hash: string; chunks: number[]; z: boolean; p: boolean }

/** Note bytes from lines. */
export function noteBytes(lines: readonly string[]): Uint8Array {
  return enc.encode(lines.length ? lines.join("\n") + "\n" : "");
}

export function noteLines(bytes: Uint8Array | null): string[] {
  if (!bytes || bytes.length === 0) return [];
  const t = dec.decode(bytes);
  const lines = t.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
