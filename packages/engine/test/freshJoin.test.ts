// A fresh device joining a populated vault (design §2.9.1; headless review "remoteRebuilt on first
// join"): whatever reason the server gives for the first snapshot of a device that never bootstrapped,
// it bootstraps (snapshotResync). It must not take the epoch path, which logs log.remoteRebuilt and
// raises the epoch guard (exit code 4 on a headless daemon until a person answers).
import { describe, expect, it } from "vitest";
import type { ChangeSink, RemoteAdapter } from "@shuttle/protocol";
import { FakeScheduler, MemLocalFs, MemStateStore } from "@shuttle/testkit";
import { createEngine } from "../src/index";
import { CFG, Node, makeWorld, syncAll } from "./engineHarness";

describe("fresh join", () => {
  it("a server that answers the first hello with snapshotRequired{epoch} still gets a plain bootstrap", async () => {
    const w = await makeWorld("fresh-join");
    const a = new Node(w, { name: "alpha" });
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) files[`n${i}.md`] = `note ${i}\n`;
    a.fs.seed(files);
    await a.start();
    await syncAll([a]);

    // beta: a real server answers a hello without an epoch with reason 'epoch'; model that.
    const inner = w.server.adapter("fresh-beta-device", { name: "beta" });
    const remote = new Proxy(inner, {
      get(t, k, r) {
        if (k !== "subscribe") return Reflect.get(t, k, r);
        return (since: number | null, sink: ChangeSink) => t.subscribe(since, since !== null ? sink : {
          ...sink,
          onChanges: (b) => sink.onChanges(b),
          onState: (s, d) => sink.onState(s, d),
          onSnapshotRequired: (info) => sink.onSnapshotRequired({ ...info, reason: "epoch" }),
          onVaultInfoChanged: (e) => sink.onVaultInfoChanged(e),
          onError: (e) => sink.onError(e),
        } as ChangeSink);
      },
    }) as RemoteAdapter;
    const fs = new MemLocalFs({ clock: w.clock, emitOwnEvents: false, configDir: CFG, platform: "desktop", writeCreatesParents: false });
    const engine = createEngine({
      fs, state: new MemStateStore(), remote, keyring: w.ring, clock: w.clock, scheduler: new FakeScheduler(w.clock),
    }, { settings: { deviceName: "beta" }, manual: true, selfTest: async () => true, random: () => 0.5, tzOffset: () => 0 });
    await engine.start();
    await engine.whenConnected();
    for (let i = 0; i < 40; i++) {
      const r = await engine.runOnce();
      await w.server.settle();
      if (r.work === 0 && engine.dirty.size === 0 && engine.status().status === "synced") break;
      w.clock.tick(1000);
    }
    expect(engine.guards.list().map((g) => g.kind)).toEqual([]);
    expect(engine.log.entries().map((e) => e.key)).not.toContain("log.remoteRebuilt");
    expect([...fs.files().keys()].filter((p) => p.endsWith(".md")).length).toBe(120);
    await engine.stop();
  });
});
