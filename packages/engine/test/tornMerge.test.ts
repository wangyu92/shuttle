// Torn D1 merge writes (design §3.8.4, §3.18 I6 / I30; lead decisions D1, D5). A staged merge op holds
// the only copy of the pre-merge local edit while the merge write is torn: a later user edit, a CONFLICT
// on the staged op, or a restart must never drop it.
import { describe, expect, it } from "vitest";
import type { VersionRecord } from "@shuttle/protocol";
import { decodeRecord } from "../src/index";
import { Crash } from "./harness";
import { sha256HexSync } from "./sha256";
import { Node, makeWorld, syncAll } from "./engineHarness";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of the note\n`);
const BASE = lines(12).join("");
const REMOTE_EDIT = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; return l.join(""); })();
const REMOTE_EDIT2 = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; l[4] = "line 4 tok-A2 ON ALPHA\n"; return l.join(""); })();
const LOCAL_EDIT = (() => { const l = lines(12); l[9] = "line 9 tok-B ON BETA\n"; return l.join(""); })();
const enc = (s: string) => new TextEncoder().encode(s);

async function allText(w: any): Promise<string> {
  let s = "";
  for (const r of w.server.inspect().log as VersionRecord[]) {
    const d = await decodeRecord(w.ring, r);
    s += JSON.stringify(d.head) + JSON.stringify(d.meta.hash ?? null) + "\n";
  }
  return s;
}

async function historyHashes(w: any): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of w.server.inspect().log as VersionRecord[]) {
    // Archive records count: they are the file history (design §3.10.4).
    const d = await decodeRecord(w.ring, r);
    if (d.head?.contentHash) out.add(d.head.contentHash);
    if (typeof d.meta.hash === "string") out.add(d.meta.hash);
  }
  return out;
}

describe("review: torn merge + user edit", () => {
  it("user appends to the torn file before the next reconcile", async () => {
    const w = await makeWorld("rv-torn");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "doc.md": BASE });
    await a.start(); await b.start();
    await syncAll([a, b]);
    w.clock.tick(1000);
    a.fs.external.write("doc.md", REMOTE_EDIT, { mtime: w.clock.now() });
    a.engine.requestScan();
    await a.sync();
    w.clock.tick(1000);
    b.fs.seed({ "doc.md": LOCAL_EDIT }, { mtime: w.clock.now() });
    b.fs.tearNextWrite({ path: "doc.md", keep: 10, onTear: (p) => { b.fs.external.write(p, b.fs.readText(p) + "\nuser typed tok-C\n", { mtime: w.clock.now() + 1 }); } });
    b.engine.requestScan();
    // drive beta until the tear happened
    for (let i = 0; i < 20 && b.fs.torn.length === 0; i++) {
      await b.flushEvents();
      await b.engine.runOnce().catch(() => undefined);
    }
    expect(b.fs.torn.length).toBe(1);
    const torn = b.fs.readText("doc.md")!;
    // the user keeps typing into the (torn) note
    await syncAll([a, b], 60);
    const fin = b.fs.readText("doc.md")!;
    const hist = await allText(w);
    // I6: beta's tok-B (its unpushed edit) must survive somewhere (disk, copy). Check disks of both devices.
    const all = [...a.fs.files().values(), ...b.fs.files().values(), ...b.fs.trash.map((t: any) => t.bytes ?? new Uint8Array())].map((x) => new TextDecoder().decode(x)).join("|");
    const MERGED = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; l[9] = "line 9 tok-B ON BETA\n"; return l.join(""); })();
    const { sha256HexSync } = await import("./sha256");
    const mh = sha256HexSync(new TextEncoder().encode(MERGED));
    const lb = sha256HexSync(new TextEncoder().encode(LOCAL_EDIT));
    expect(all.includes("tok-B") || hist.includes(mh) || hist.includes(lb)).toBe(true);
    expect(all.includes("tok-C")).toBe(true);
  });
  it("crash variant: process dies with the torn merge write, user appends while down, restart", async () => {
    const w = await makeWorld("rv-torn");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "doc.md": BASE });
    await a.start(); await b.start();
    await syncAll([a, b]);
    w.clock.tick(1000);
    a.fs.external.write("doc.md", REMOTE_EDIT, { mtime: w.clock.now() });
    a.engine.requestScan();
    await a.sync();
    w.clock.tick(1000);
    b.fs.seed({ "doc.md": LOCAL_EDIT }, { mtime: w.clock.now() });
    b.fs.tearNextWrite({ path: "doc.md", keep: 10, onTear: (p) => { b.crashed = true; b.store.crash(); throw new Crash("torn"); } });
    b.engine.requestScan();
    // drive beta until the tear happened
    for (let i = 0; i < 20 && b.fs.torn.length === 0; i++) {
      await b.flushEvents();
      await b.engine.runOnce().catch(() => undefined);
    }
    expect(b.fs.torn.length).toBe(1);
    b.fs.seed({ "doc.md": b.fs.readText("doc.md") + "\nuser typed tok-C\n" }, { mtime: w.clock.now() + 50 });
    await b.restart();
    const torn = b.fs.readText("doc.md")!;
    // the user keeps typing into the (torn) note
    await syncAll([a, b], 60);
    const fin = b.fs.readText("doc.md")!;
    const hist = await allText(w);
    // I6: beta's tok-B (its unpushed edit) must survive somewhere (disk, copy). Check disks of both devices.
    const all = [...a.fs.files().values(), ...b.fs.files().values(), ...b.fs.trash.map((t: any) => t.bytes ?? new Uint8Array())].map((x) => new TextDecoder().decode(x)).join("|");
    const MERGED = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; l[9] = "line 9 tok-B ON BETA\n"; return l.join(""); })();
    const { sha256HexSync } = await import("./sha256");
    const mh = sha256HexSync(new TextEncoder().encode(MERGED));
    const lb = sha256HexSync(new TextEncoder().encode(LOCAL_EDIT));
    expect(all.includes("tok-B") || hist.includes(mh) || hist.includes(lb)).toBe(true);
    expect(all.includes("tok-C")).toBe(true);
  });
});

describe("review: torn merge + CONFLICT", () => {
  it("staged merge rejected with CONFLICT while the file is still torn", async () => {
    const w = await makeWorld("rv-torn-conflict");
    const a = new Node(w, { name: "alpha" });
    const b = new Node(w, { name: "beta" });
    a.fs.seed({ "doc.md": BASE });
    await a.start(); await b.start();
    await syncAll([a, b]);
    w.clock.tick(1000);
    a.fs.external.write("doc.md", REMOTE_EDIT, { mtime: w.clock.now() });
    a.engine.requestScan();
    await a.sync();
    w.clock.tick(1000);
    b.fs.seed({ "doc.md": LOCAL_EDIT }, { mtime: w.clock.now() });
    w.server.pauseFeed();
    a.fs.external.write("doc.md", REMOTE_EDIT2, { mtime: w.clock.now() });
    a.engine.requestScan();
    for (let i = 0; i < 5; i++) { await a.flushEvents(); await a.engine.runOnce(); }
    let torn = "";
    b.fs.tearNextWrite({ path: "doc.md", keep: 25, onTear: () => {
      torn = b.fs.readText("doc.md")!;
      // the file cannot be read for a while (e.g. the disk keeps failing), so the torn file is not repaired yet
      for (let i = 0; i < 6; i++) b.fs.failNext("read", "EIO", { path: "doc.md" });
      for (let i = 0; i < 6; i++) b.fs.failNext("stat", "EIO", { path: "doc.md" });
    } });
    b.engine.requestScan();
    for (let i = 0; i < 20 && b.fs.torn.length === 0; i++) {
      await b.flushEvents();
      await b.engine.runOnce().catch(() => undefined);
    }
    expect(b.fs.torn.length).toBe(1);
    w.server.resumeFeed();
    await syncAll([a, b], 80);
    const MERGED = (() => { const l = lines(12); l[1] = "line 1 tok-A ON ALPHA\n"; l[9] = "line 9 tok-B ON BETA\n"; return l.join(""); })();
    const hist = await historyHashes(w);
    const fin = b.fs.readText("doc.md")!;
    const all = [...a.fs.files().values(), ...b.fs.files().values(), ...b.fs.trash.map((t: any) => t.bytes ?? new Uint8Array())].map((x) => new TextDecoder().decode(x)).join("|");
    // I30: the torn bytes are never pushed
    expect(hist.has(sha256HexSync(enc(torn))), "I30 torn bytes pushed").toBe(false);
    // I6: beta's tok-B survives somewhere
    expect(all.includes("tok-B") || hist.has(sha256HexSync(enc(MERGED))) || hist.has(sha256HexSync(enc(LOCAL_EDIT))), "I6 tok-B lost").toBe(true);
    // The archived merge is restored from history onto beta's disk (note or conflict copy), not just
    // kept in history, and the newer head is not lost either.
    const betaText = [...b.fs.files().values()].map((x) => new TextDecoder().decode(x)).join("|");
    expect(betaText).toContain("tok-B");
    expect(betaText).toContain("tok-A2");
    expect(b.engine.log.entries().map((e: any) => e.key)).toContain("log.tornMergeRestored");
  });
});
