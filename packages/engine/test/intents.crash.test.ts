// I30 torn write (design §3.8.4 S9, §3.18): killing the engine during its own write never produces a
// push of the torn content. Crash at every crash point of an apply; wherever a write intent survived,
// tear the file on disk (partial bytes, the non-atomic platform case), restart, and check that the torn
// bytes never reach the server and the file ends as the remote head.

import { describe, expect, it } from "vitest";
import type { VersionRecord, WriteIntent } from "@shuttle/protocol";
import { decodeRecord } from "../src/index";
import { sha256HexSync } from "./sha256";
import { Node, isCrashLike, makeWorld, syncAll } from "./engineHarness";

const V1 = "version one of the document\n";
const V2 = "version two of the document, which is a good deal longer than the first one\n".repeat(20);

describe("I30 torn engine writes", () => {
  it("crash at every point of an apply; a torn file is rewritten, never pushed", async () => {
    let tornRuns = 0;
    for (let k = 1; k < 60; k++) {
      const w = await makeWorld(`i30-${k}`);
      const a = new Node(w, { name: "alpha" });
      const b = new Node(w, { name: "beta" });
      a.fs.seed({ "doc.md": V1 });
      await a.start();
      await b.start();
      await syncAll([a, b]);
      w.clock.tick(1000);
      a.fs.external.write("doc.md", V2, { mtime: w.clock.now() });
      a.engine.requestScan();
      await a.sync();
      b.points = [];
      b.crashAt = k;
      try {
        await syncAll([b]);
      } catch (e) {
        if (!isCrashLike(e)) throw e;
      }
      const crashed = b.crashed;
      const intents = ((b.store.dump() as unknown as { intents?: WriteIntent[] }).intents ?? []).filter((i) => i.path === "doc.md");
      let torn: string | null = null;
      if (crashed && intents.length > 0) {
        // The write was in flight: leave half of the new bytes on disk (no events: the process is dead).
        const half = V2.slice(0, Math.floor(V2.length / 2));
        b.fs.seed({ "doc.md": half }, { mtime: w.clock.now() + 5 });
        torn = sha256HexSync(new TextEncoder().encode(half));
        tornRuns++;
      }
      const before = w.server.inspect().log.length;
      await b.restart();
      await syncAll([a, b]);
      expect(b.fs.readText("doc.md")).toBe(V2);
      const mine = (w.server.inspect().log as VersionRecord[]).slice(before).filter((r) => r.device === b.deviceId);
      expect(mine, "the receiver commits nothing").toEqual([]);
      if (torn) {
        for (const r of w.server.inspect().log as VersionRecord[]) {
          const h = (await decodeRecord(w.ring, r)).head;
          expect(h?.contentHash).not.toBe(torn);
        }
      }
      if (!crashed) break;
    }
    expect(tornRuns).toBeGreaterThan(0);
  }, 120_000);
});
