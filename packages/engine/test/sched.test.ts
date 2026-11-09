// Scheduling and triggers (design §3.14) with the engine's own timers (manual: false), driven by the
// FakeScheduler: local change → debounce → loop; remote batch → coalesced kick; hidden → push-only flush
// and socket close; visible → reconnect; dropped feed → backoff reconnect.

import { describe, expect, it } from "vitest";
import { drainMicrotasks } from "@shuttle/testkit";
import { DEBOUNCE_SETTLE_MS, HIDDEN_CLOSE_MS, backoffDelay } from "../src/index";
import { Node, makeWorld, serverMap, type World } from "./engineHarness";

async function pump(w: World, nodes: readonly Node[], ms: number, steps = 6): Promise<void> {
  for (let i = 0; i < steps; i++) {
    for (const n of nodes) {
      await n.scheduler.advance(ms / steps);
      await n.engine.whenIdle();
    }
    await w.server.settle();
    for (const n of nodes) await n.engine.whenIdle();
  }
}

const auto = (name: string, extra: Partial<ConstructorParameters<typeof Node>[1]> = {}) =>
  ({ name, emitOwnEvents: true, opts: { manual: false, periodicScanMs: 0, configScanMs: 0 }, ...extra });

describe("§3.14 triggers", () => {
  it("startup, local change and remote batch drive the loop without explicit calls", async () => {
    const w = await makeWorld("sched-basic");
    const a = new Node(w, auto("alpha"));
    const b = new Node(w, auto("beta"));
    a.fs.seed({ "seed.md": "seed\n" });
    await a.start();
    await b.start();
    await pump(w, [a, b], 2000);
    expect([...(await serverMap(w)).keys()]).toEqual(["seed.md"]);
    expect(b.fs.readText("seed.md")).toBe("seed\n");
    w.clock.tick(1000);
    a.fs.external.write("live.md", "typed\n");
    await pump(w, [a, b], DEBOUNCE_SETTLE_MS + 2000);
    expect(b.fs.readText("live.md")).toBe("typed\n");
    expect(a.engine.log.entries().some((e) => e.key === "log.fullySynced")).toBe(true);
    expect(a.engine.status().status).toBe("synced");
    expect(a.scheduler.errors).toEqual([]);
    expect(b.scheduler.errors).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  });

  it("hidden: one push-only flush, then the socket closes; visible: reconnect and catch up", async () => {
    const w = await makeWorld("sched-hidden");
    const a = new Node(w, auto("alpha"));
    const b = new Node(w, auto("beta"));
    await a.start();
    await b.start();
    await pump(w, [a, b], 1000);
    // b has a remote change pending for a when a goes hidden; a has a local edit still in debounce.
    w.clock.tick(1000);
    b.fs.external.write("from-b.md", "b\n");
    await pump(w, [b], DEBOUNCE_SETTLE_MS + 1000);
    w.clock.tick(1000);
    a.fs.external.write("from-a.md", "a\n");
    await drainMicrotasks(); // MemLocalFs delivers events in a microtask
    a.fsOps.length = 0;
    a.engine.onVisibility(false);
    await a.engine.whenIdle();
    await w.server.settle();
    await a.scheduler.advance(HIDDEN_CLOSE_MS + 10);
    await a.engine.whenIdle();
    expect([...(await serverMap(w)).keys()].sort()).toEqual(["from-a.md", "from-b.md"]);
    expect(a.ops("write")).toEqual([]);
    expect(a.engine.isConnected()).toBe(false);
    a.engine.onVisibility(true);
    await a.engine.whenConnected();
    await pump(w, [a, b], 2000);
    expect(a.fs.readText("from-b.md")).toBe("b\n");
    expect(a.scheduler.errors).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  });

  it("a dropped feed reconnects after backoff and keeps syncing", async () => {
    const w = await makeWorld("sched-reconnect");
    const a = new Node(w, auto("alpha"));
    const b = new Node(w, auto("beta"));
    await a.start();
    await b.start();
    await pump(w, [a, b], 1000);
    w.server.disconnect(b.deviceId);
    await w.server.settle();
    await b.engine.whenIdle();
    expect(b.engine.isConnected()).toBe(false);
    w.clock.tick(1000);
    a.fs.external.write("after.md", "after\n");
    await pump(w, [a, b], DEBOUNCE_SETTLE_MS + backoffDelay(1, () => 0.5) * 2 + 2000, 10);
    expect(b.engine.isConnected()).toBe(true);
    expect(b.fs.readText("after.md")).toBe("after\n");
    expect(b.scheduler.errors).toEqual([]);
    await a.engine.stop();
    await b.engine.stop();
  });
});
