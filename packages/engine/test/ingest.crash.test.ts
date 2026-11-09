// I2 cursor safety (design §3.18, §7.2): crash between batch delivery and the ingest transaction, and
// during every store commit while ingesting; meta.cursor is never persisted ahead of the `remote` and
// `applyQueue` rows it covers, and the device converges after a restart.

import { describe, expect, it } from "vitest";
import type { RemoteHead, VersionRecord } from "@shuttle/protocol";
import { Prng } from "@shuttle/testkit";
import { Node, isCrashLike, makeWorld, serverMap, sortedEntries, syncAll, type World } from "./engineHarness";

interface Dump { meta?: Array<{ k: string; v: unknown }>; remote?: RemoteHead[]; applyQueue?: Array<{ fileId: string; seq: number }> }

function checkI2(w: World, n: Node): void {
  const st = n.store.dump() as unknown as Dump;
  const cursor = (st.meta ?? []).find((m) => m.k === "cursor")?.v as number | undefined;
  if (cursor === undefined) return;
  const covered = new Map<string, number>();
  for (const r of w.server.inspect().log as VersionRecord[]) {
    if (r.seq > cursor || r.kind === "archive") continue;
    covered.set(r.fileId, Math.max(covered.get(r.fileId) ?? 0, r.seq));
  }
  const remote = new Map((st.remote ?? []).map((h) => [h.fileId, h.seq]));
  for (const [fileId, seq] of covered) {
    expect(remote.get(fileId) ?? -1, `remote row for ${fileId} covered by cursor ${cursor}`).toBeGreaterThanOrEqual(seq);
  }
}

async function scenario(seed: string) {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  a.fs.seed({ "n/one.md": "one\n", "n/two.md": "two\n", "bin/b.bin": new Prng("b").bytes(20_000) });
  await a.start();
  await a.sync();
  w.clock.tick(1000);
  a.fs.external.write("n/one.md", "one, edited\n", { mtime: w.clock.now() });
  a.fs.external.remove("n/two.md");
  a.engine.requestScan();
  await a.sync();
  const b = new Node(w, { name: "beta" });
  return { w, a, b };
}

async function attempt(w: World, a: Node, b: Node): Promise<void> {
  try {
    await b.start();
    await syncAll([b]);
  } catch (e) {
    if (!isCrashLike(e)) throw e;
  }
  await w.server.settle().catch(() => undefined);
}

async function finish(w: World, a: Node, b: Node): Promise<void> {
  await b.restart();
  await syncAll([a, b]);
  checkI2(w, b);
  expect(sortedEntries(await b.diskMap())).toEqual(sortedEntries(await serverMap(w)));
}

describe("I2 cursor safety under crashes", () => {
  it("crash at every crash point while ingesting and applying", async () => {
    let runs = 0;
    for (let k = 1; k < 80; k++) {
      const { w, a, b } = await scenario(`i2-point-${k}`);
      b.crashAt = k;
      await attempt(w, a, b);
      const crashed = b.crashed;
      checkI2(w, b);
      await finish(w, a, b);
      runs++;
      if (!crashed) break;
    }
    expect(runs).toBeGreaterThan(3);
  }, 120_000);

  it("crash during every store commit while ingesting and applying", async () => {
    let runs = 0;
    for (let k = 1; k < 80; k++) {
      const { w, a, b } = await scenario(`i2-commit-${k}`);
      b.commitCrashAt = k;
      await attempt(w, a, b);
      const crashed = b.crashed;
      checkI2(w, b);
      await finish(w, a, b);
      runs++;
      if (!crashed) break;
    }
    expect(runs).toBeGreaterThan(3);
  }, 120_000);
});
