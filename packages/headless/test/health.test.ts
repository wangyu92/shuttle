// H2 health honesty (design §6.1.9, §7.2): health measures progress against the server, not process
// liveness. A pull pipeline that stalls while the server head keeps advancing must turn `status` down
// (exit 1, restart fixes it) within 11 minutes of fake time, while the process, the socket and the
// loop all stay alive. A device that keeps up stays ok over the same fake time.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangeBatch, ChangeSink, RemoteAdapter, Seq } from "@shuttle/protocol";
import { ControlClient } from "../src/control/ControlClient";
import type { HealthJson } from "../src/health";
import {
  converge, createTestVault, provisionNode, startNode, startWorld, stopNode, stopWorld, type HeadlessNode, type World,
} from "./e2eHarness";
import { waitFor } from "./tmp";

const T = 300_000;
const MIN = 60_000;
let w: World;
const nodes: HeadlessNode[] = [];

beforeAll(async () => { w = await startWorld("health"); }, T);
afterAll(async () => {
  for (const n of nodes) await stopNode(n).catch(() => undefined);
  await stopWorld(w);
}, T);

/** A gate in front of the engine's feed and pulls; the progress tracker outside it still sees every head. */
class Stall {
  on = false;
  private waiters: Array<() => void> = [];
  async pass(): Promise<void> {
    while (this.on) await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    this.on = false;
    for (const r of this.waiters.splice(0)) r();
  }
  wrap(inner: RemoteAdapter): RemoteAdapter {
    const pass = () => this.pass();
    const overrides: Partial<RemoteAdapter> = {
      async pull(since: Seq, limit?: number): Promise<ChangeBatch> {
        const b = await inner.pull(since, limit);
        await pass();
        return b;
      },
      subscribe(since: Seq | null, sink: ChangeSink) {
        return inner.subscribe(since, { ...bindAll(sink), onChanges: async (b) => { await pass(); await sink.onChanges(b); } });
      },
    };
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in overrides) return (overrides as Record<string, unknown>)[prop];
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
}

function bindAll(sink: ChangeSink): ChangeSink {
  return {
    onChanges: (b) => sink.onChanges(b), headOf: (id) => sink.headOf(id), liveHeadByPathKey: (pk) => sink.liveHeadByPathKey(pk),
    onSnapshotRequired: (i) => sink.onSnapshotRequired(i), onVaultInfoChanged: (e) => sink.onVaultInfoChanged(e),
    onError: (e) => sink.onError(e), onState: (s, d) => sink.onState(s, d),
  };
}

describe("health honesty (H2)", () => {
  let a: HeadlessNode;
  let b: HeadlessNode;
  let skew = 0;
  const stall = new Stall();

  async function health(): Promise<HealthJson> {
    await a.daemon!.tick();
    const r = await new ControlClient(a.daemon!.socketPath).get("/health");
    expect(r.status).toBe(200);
    return r.data as HealthJson;
  }

  beforeAll(async () => {
    const v = await createTestVault(w, "h2");
    // Scans every hour and a watchdog of an hour: only the lag rule can fire inside the 11 minutes.
    const patch = { watch: { mode: "hybrid" as const, pollIntervalSec: 3600 }, watchdog: { stallSec: 3600 } };
    a = await provisionNode(w, v, "h2-a", "bidirectional", patch);
    b = await provisionNode(w, v, "h2-b");
    nodes.push(a, b);
    await startNode(a, { now: () => Date.now() + skew, remoteHook: (r) => stall.wrap(r), healthEveryMs: 60 * MIN });
    await startNode(b);
    await writeFile(path.join(b.dirs.vault, "first.md"), "first\n");
    await converge([a, b], 90_000);
  }, T);

  it("keeping up: ok across 11 minutes of fake time while the head advances", async () => {
    expect((await health()).status).toBe("ok");
    await writeFile(path.join(b.dirs.vault, "kept-up.md"), "kept up\n");
    await converge([a, b], 90_000);
    skew += 11 * MIN;
    const h = await health();
    expect(h.status).toBe("ok");
    expect(h.lagSeq).toBe(0);
    expect(h.exitCode).toBe(0);
  }, T);

  it("pull stalled while the head advances: still ok at 5 min, down (exit 1) by 11 min, ok again after the stall clears", async () => {
    stall.on = true;
    const head0 = b.daemon!.progress.serverHeadSeq!;
    for (let i = 0; i < 3; i++) await writeFile(path.join(b.dirs.vault, `while-stalled-${i}.md`), `stalled ${i}\n`);
    await waitFor(() => (b.daemon!.progress.serverHeadSeq ?? 0) >= head0 + 3, 60_000, 100, "B committed its three notes");
    // The head reaches A through the feed (the progress tracker sits outside the stall; flow control
    // holds later frames behind the stalled one, so A sees at least the first new head), the cursor
    // does not move.
    await waitFor(() => (a.daemon!.progress.serverHeadSeq ?? 0) > head0, 30_000, 100, "A sees a new head");
    let h = await health();
    expect(h.lagSeq).toBeGreaterThan(0);
    expect(h.status).toBe("ok");
    expect(a.daemon!.engine.isConnected()).toBe(true);

    skew += 5 * MIN;
    h = await health();
    expect(h.status, JSON.stringify(h)).toBe("ok");

    skew += 6 * MIN;   // 11 min after the lag was first observed
    h = await health();
    expect(h.status, JSON.stringify(h)).toBe("down");
    expect(h.exitCode).toBe(1);
    expect(h.reasons.join(" ")).toMatch(/behind for more than 10 min/);
    expect(JSON.parse(await readFile(a.daemon!.healthFile, "utf8")) as HealthJson).toMatchObject({ status: "down", exitCode: 1 });

    stall.release();
    await converge([a, b], 90_000);
    h = await health();
    expect(h.status).toBe("ok");
    expect(h.lagSeq).toBe(0);
  }, T);
});
