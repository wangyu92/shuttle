// I3 idempotent replay (design §3.7.4, §3.18, §7.2): lost commit responses and restarts replay the
// journal 1-5 times; a batch's op headers never change after it is sent (ID-6), each op yields exactly
// one remote record, and the final state is the same as without faults.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommitRequest } from "@shuttle/protocol";
import { Prng } from "@shuttle/testkit";
import { remoteError } from "@shuttle/protocol";
import { Node, isCrashLike, makeWorld, serverMap, sortedEntries, syncAll } from "./engineHarness";

const FILES = ["a.md", "b.md", "c/big.bin", "d.txt"];

describe("I3 replay", () => {
  it("replaying 1-5 times keeps headers per cid and one record per op", async () => {
    let seed = 0;
    await fc.assert(fc.asyncProperty(
      fc.subarray(FILES, { minLength: 1 }), fc.integer({ min: 1, max: 5 }), fc.boolean(),
      async (files, replays, restartBetween) => {
        const w = await makeWorld(`i3-${seed++}`);
        const a = new Node(w, { name: "alpha" });
        await a.start();
        const sent = new Map<string, string>();
        const mismatch: string[] = [];
        w.server.onCall = (c) => {
          if (c.method !== "commit") return;
          const req = c.args[0] as CommitRequest;
          // Op headers (design §2.9.3: meta/inline may be re-sealed on resend; the digest excludes ciphertext).
          const h = JSON.stringify(req.ops.map((o) => { const { meta: _m, ...hdr } = o as typeof o & { inline?: unknown }; delete hdr.inline; return hdr; }));
          const prev = sent.get(req.cid);
          if (prev !== undefined && prev !== h) mismatch.push(req.cid);
          sent.set(req.cid, h);
        };
        for (const p of files) a.fs.external.write(p, p.endsWith(".bin") ? new Prng(p).bytes(30_000) : `${p}\n`, { mtime: w.clock.now() });
        a.engine.requestScan();
        // The commit takes effect but the response is lost, `replays` times.
        w.server.injectFault({ device: a.deviceId, method: "commit", when: "after", error: remoteError("NETWORK", "lost"), times: replays });
        for (let i = 0; i < replays + 2; i++) {
          try {
            await a.engine.runOnce();
          } catch (e) {
            if (!isCrashLike(e)) throw e;
          }
          await w.server.settle();
          if (restartBetween) await a.restart();
          else await a.engine.whenConnected();
          w.clock.tick(10 * 60 * 1000);
        }
        await syncAll([a]);
        expect(mismatch).toEqual([]);
        const log = w.server.inspect().log.filter((r) => r.kind !== "archive");
        expect(log.length).toBe(files.length);
        expect(new Set(log.map((r) => r.fileId)).size).toBe(files.length);
        expect(sortedEntries(await a.diskMap())).toEqual(sortedEntries(await serverMap(w)));
        expect(a.engine.status().pendingUp).toBe(0);
        w.server.onCall = null;
      }), { numRuns: 12, seed: 33 });
  }, 120_000);
});
