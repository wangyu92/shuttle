// D1 (lead decision, 클로드 제안(미승인)): torn or interrupted merge writes. The merged plaintext is
// staged with its push op and the write intent before the file is written, so after a crash at ANY
// point, or a non-atomic write that tears, the file ends as the merged text: never the remote head
// and never the torn bytes (I6, I30, design §3.8.4, §3.10.2). Lead decision D8: the merge write goes
// through a same-folder temp and a rename, so a tear hits the temp and the note keeps its pre-merge
// text until the merged bytes are in place.

import { describe, expect, it } from "vitest";
import type { VersionRecord, WriteIntent } from "@shuttle/protocol";
import { decodeRecord, isReplaceTemp } from "../src/index";
import { Crash } from "./harness";
import { sha256HexSync } from "./sha256";
import { Node, isCrashLike, makeWorld, serverMap, syncAll } from "./engineHarness";

const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i} of the note${tag}\n`);
const BASE = lines(12).join("");
const REMOTE_EDIT = (() => { const l = lines(12); l[1] = "line 1 EDITED ON ALPHA\n"; return l.join(""); })();
const LOCAL_EDIT = (() => { const l = lines(12); l[9] = "line 9 EDITED ON BETA\n"; return l.join(""); })();
const MERGED = (() => { const l = lines(12); l[1] = "line 1 EDITED ON ALPHA\n"; l[9] = "line 9 EDITED ON BETA\n"; return l.join(""); })();
const enc = (s: string) => new TextEncoder().encode(s);

async function setup(seed: string): Promise<{ w: Awaited<ReturnType<typeof makeWorld>>; a: Node; b: Node }> {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  const b = new Node(w, { name: "beta" });
  a.fs.seed({ "doc.md": BASE });
  await a.start();
  await b.start();
  await syncAll([a, b]);
  w.clock.tick(1000);
  a.fs.external.write("doc.md", REMOTE_EDIT, { mtime: w.clock.now() });
  a.engine.requestScan();
  await a.sync();
  w.clock.tick(1000);
  // beta edits offline-style (no event: the scan finds it) while alpha's version is on the server.
  b.fs.seed({ "doc.md": LOCAL_EDIT }, { mtime: w.clock.now() });
  b.engine.requestScan();
  return { w, a, b };
}

async function everyRecordHash(w: Awaited<ReturnType<typeof makeWorld>>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of w.server.inspect().log as VersionRecord[]) {
    const h = (await decodeRecord(w.ring, r)).head;
    if (h?.contentHash) out.add(h.contentHash);
  }
  return out;
}

async function expectMerged(w: Awaited<ReturnType<typeof makeWorld>>, a: Node, b: Node, torn: string | null): Promise<void> {
  expect(b.fs.readText("doc.md")).toBe(MERGED);
  expect(a.fs.readText("doc.md")).toBe(MERGED);
  expect([...b.fs.files().keys()], "a clean merge makes no conflict copy").toEqual(["doc.md"]);
  expect((await serverMap(w)).get("doc.md")).toBe(sha256HexSync(enc(MERGED)));
  if (torn) expect([...(await everyRecordHash(w))]).not.toContain(torn);
}

describe("D1 torn merge writes", () => {
  it("baseline: the two edits merge cleanly (dmp3) on both devices", async () => {
    const { w, a, b } = await setup("d1-base");
    await syncAll([a, b]);
    await expectMerged(w, a, b, null);
  });

  it("crash at every point of the merge; tear the file wherever an intent survived; restart ends merged", async () => {
    let tornRuns = 0;
    let stagedRuns = 0;
    let k = 1;
    for (; k < 80; k++) {
      const { w, a, b } = await setup(`d1-${k}`);
      b.points = [];
      b.crashAt = k;
      try {
        await syncAll([b]);
      } catch (e) {
        if (!isCrashLike(e)) throw e;
      }
      const crashed = b.crashed;
      const dump = b.store.dump() as unknown as { intents?: WriteIntent[]; staging?: unknown[] };
      const intents = (dump.intents ?? []).filter((i) => i.path === "doc.md");
      let torn: string | null = null;
      if (crashed && intents.length > 0) {
        stagedRuns++;
        // Model the non-atomic platform: the write was in flight, a prefix of the merged bytes landed.
        const half = MERGED.slice(0, Math.floor(MERGED.length / 3));
        b.fs.seed({ "doc.md": half }, { mtime: w.clock.now() + 5 });
        torn = sha256HexSync(enc(half));
        tornRuns++;
      }
      await b.restart();
      await syncAll([a, b], 60);
      await expectMerged(w, a, b, torn);
      if (!crashed) break;
    }
    expect(k, "the crash loop reached the end of the merge").toBeGreaterThan(3);
    expect(stagedRuns, "some crash left the staged merge and its intent").toBeGreaterThan(0);
    expect(tornRuns).toBeGreaterThan(0);
  }, 300_000);

  it("the merge write itself tears and the process dies with it: restart re-applies the staged merge", async () => {
    const { w, a, b } = await setup("d1-tear-kill");
    let half = "";
    let tornPath = "";
    b.fs.tearNextWrite({
      path: "doc.md", fraction: 0.4,
      onTear: (p) => {
        tornPath = p;
        half = b.fs.readText(p) ?? "";
        b.crashed = true;
        b.store.crash();
        throw new Crash("torn write");
      },
    });
    await syncAll([b]).catch((e: unknown) => { if (!isCrashLike(e)) throw e; });
    expect(b.fs.torn.length).toBe(1);
    expect(half.length).toBeGreaterThan(0);
    expect(MERGED.startsWith(half)).toBe(true);
    // D8: the tear hit the same-folder temp; the note still holds the pre-merge local edit.
    expect(isReplaceTemp(tornPath)).toBe(true);
    expect(b.fs.readText("doc.md")).toBe(LOCAL_EDIT);
    await b.restart();
    await syncAll([a, b], 60);
    await expectMerged(w, a, b, sha256HexSync(enc(half)));
  });

  it("the merge write fails with EIO in session (no crash): the note is never torn, the merge is planned again", async () => {
    const { w, a, b } = await setup("d1-tear-eio");
    b.fs.tearNextWrite({ path: "doc.md", keep: 10 });
    await syncAll([a, b], 60);
    expect(b.fs.torn.length).toBe(1);
    // D8: only the temp was torn (and removed); the note went from the local edit to the merge.
    expect(isReplaceTemp(b.fs.torn[0]!.path)).toBe(true);
    await expectMerged(w, a, b, sha256HexSync(enc(MERGED.slice(0, 10))));
  });

  it("the merge write fails before any byte lands: the staged merge is dropped and planned again", async () => {
    const { w, a, b } = await setup("d1-eio-pre");
    b.fs.failNext("write", "ENOSPC", { path: "doc.md" });
    await syncAll([a, b], 60);
    await expectMerged(w, a, b, null);
  });

  it("an external edit over an unfinished merge is kept as a user edit (never overwritten)", async () => {
    const { w, a, b } = await setup("d1-user");
    b.crashAt = 0;
    let crashedAtStage = false;
    const d = b.fs.before((op, p) => {
      if (op === "write" && (p === "doc.md" || isReplaceTemp(p)) && !crashedAtStage) {
        crashedAtStage = true;
        b.crashed = true;
        b.store.crash();
        throw new Crash("before write");
      }
    });
    await syncAll([b]).catch((e: unknown) => { if (!isCrashLike(e)) throw e; });
    d.dispose();
    expect(crashedAtStage).toBe(true);
    // While the app is down the user rewrites the note in another editor.
    const USER = "a different text written while the app was closed\n";
    b.fs.seed({ "doc.md": USER }, { mtime: w.clock.now() + 50 });
    await b.restart();
    await syncAll([a, b], 60);
    expect(b.fs.readText("doc.md")).toBe(USER);
    expect(a.fs.readText("doc.md")).toBe(USER);
    // alpha's version stays in the remote history (the user's text supersedes it, as any edit would).
    expect(await everyRecordHash(w)).toContain(sha256HexSync(enc(REMOTE_EDIT)));
    expect((await serverMap(w)).get("doc.md")).toBe(sha256HexSync(enc(USER)));
  });
});
