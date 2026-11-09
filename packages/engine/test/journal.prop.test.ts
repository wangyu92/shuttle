// I4 one op per file (design §3.7.1, §3.18, §7.2): a command model over edit, delete, runStep, crash,
// restart, ackFromServer and netError. After every command: at most one non-terminal put/delete op per
// fileId (I4) and every synced version exists on the server with that hash (I1); at the end the device
// converges with the server.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FileEntry, Op } from "@shuttle/protocol";
import { remoteError } from "@shuttle/protocol";
import { decodeRecord } from "../src/index";
import { Node, isCrashLike, makeWorld, serverMap, sortedEntries, syncAll, type World } from "./engineHarness";

type Cmd =
  | { t: "edit"; f: number; v: number }
  | { t: "delete"; f: number }
  | { t: "run" }
  | { t: "ack" }
  | { t: "net" }
  | { t: "crash"; at: number }
  | { t: "restart" };

const PATHS = ["x.md", "y.md", "z/w.txt"];

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant("edit" as const), f: fc.nat(PATHS.length - 1), v: fc.nat(50) }), weight: 4 },
  { arbitrary: fc.record({ t: fc.constant("delete" as const), f: fc.nat(PATHS.length - 1) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("run" as const) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant("ack" as const) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant("net" as const) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("crash" as const), at: fc.integer({ min: 1, max: 6 }) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("restart" as const) }), weight: 1 },
);

function checkI4(n: Node): void {
  const ops = ((n.store.dump() as unknown as { journal?: Op[] }).journal ?? []).filter((o) => o.kind !== "archive");
  const seen = new Set<string>();
  for (const o of ops) {
    expect(seen.has(o.fileId), `two ops for ${o.fileId}`).toBe(false);
    seen.add(o.fileId);
  }
}

async function checkI1(w: World, n: Node): Promise<void> {
  const files = (n.store.dump() as unknown as { files?: FileEntry[] }).files ?? [];
  const log = new Map(w.server.inspect().log.map((r) => [r.seq, r]));
  for (const e of files) {
    if (!e.synced) continue;
    const r = log.get(e.synced.version);
    expect(r, `record ${e.synced.version}`).toBeDefined();
    expect(r!.fileId).toBe(e.fileId);
    expect((await decodeRecord(w.ring, r!)).head?.contentHash).toBe(e.synced.hash);
  }
}

describe("I4 journal command model", () => {
  it("one non-terminal op per fileId after every command", async () => {
    let seed = 0;
    await fc.assert(fc.asyncProperty(fc.array(cmd, { minLength: 3, maxLength: 15 }), async (cmds) => {
      const w = await makeWorld(`i4-${seed++}`);
      const a = new Node(w, { name: "alpha" });
      await a.start();
      let dead = false;
      for (const c of cmds) {
        w.clock.tick(1000);
        try {
          switch (c.t) {
            case "edit": a.fs.external.write(PATHS[c.f]!, `${PATHS[c.f]} v${c.v}\n`, { mtime: w.clock.now() }); if (!dead) a.engine.requestScan(); break;
            case "delete": if (a.fs.exists(PATHS[c.f]!)) a.fs.external.remove(PATHS[c.f]!); if (!dead) a.engine.requestScan(); break;
            case "run": if (!dead) { await a.flushEvents(); await a.engine.runOnce(); } break;
            case "ack": await w.server.settle(); break;
            case "net": w.server.injectFault({ device: a.deviceId, method: "commit", when: "before", error: remoteError("NETWORK", "net") }); break;
            case "crash": if (!dead) { a.points = []; a.crashAt = c.at; await a.flushEvents(); await a.engine.runOnce(); } break;
            case "restart": await a.restart(); dead = false; break;
          }
        } catch (e) {
          if (!isCrashLike(e)) throw e;
        }
        if (a.crashed) dead = true;
        checkI4(a);
        await checkI1(w, a);
      }
      w.server.clearFaults();
      await a.restart();
      a.engine.requestScan();
      await syncAll([a]);
      checkI4(a);
      await checkI1(w, a);
      expect(sortedEntries(await a.diskMap())).toEqual(sortedEntries(await serverMap(w)));
    }), { numRuns: 25, seed: 44 });
  }, 180_000);
});
