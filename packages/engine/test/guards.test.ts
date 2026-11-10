// I22 guards trip (design §3.13, §3.18): an empty or unmounted vault root produces no remote deletes;
// deletes above max(25, 10 %) pause until answered, in both directions; answerGuard apply/pause.

import { describe, expect, it } from "vitest";
import type { GuardEvent } from "@shuttle/protocol";
import { DELETE_WINDOW_MS, GuardBoard, looksEmpty, massDeleteThreshold } from "../src/index";
import { Node, makeWorld, serverMap, syncAll } from "./engineHarness";

const deletes = (n: Node): number => n.w.server.inspect().log.filter((r) => r.kind === "del").length;

async function syncedVault(seed: string, files: number) {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  const init: Record<string, string> = {};
  for (let i = 0; i < files; i++) init[`n/f${String(i).padStart(3, "0")}.md`] = `file ${i}\n`;
  a.fs.seed(init);
  await a.start();
  await a.sync();
  expect((await serverMap(w)).size).toBe(files);
  const guards: GuardEvent[] = [];
  a.engine.on("guard", (g) => guards.push(g));
  return { w, a, init, guards };
}

describe("guard thresholds", () => {
  it("pure thresholds", () => {
    expect(massDeleteThreshold(0)).toBe(25);
    expect(massDeleteThreshold(1000)).toBe(100);
    expect(looksEmpty(0, 19)).toBe(false);
    expect(looksEmpty(0, 20)).toBe(true);
    expect(looksEmpty(1, 20)).toBe(true);
    expect(looksEmpty(2, 20)).toBe(false);
    expect(looksEmpty(99, 1000)).toBe(true);
  });

  it("GuardBoard dedupes by kind and normalizes choices", () => {
    const seen: GuardEvent[] = [];
    const b = new GuardBoard(() => 0, (g) => seen.push(g));
    const g1 = b.raise("massDeleteLocal", 30, ["a"]);
    const g2 = b.raise("massDeleteLocal", 31, ["b"]);
    expect(g1.id).toBe(g2.id);
    expect(seen.length).toBe(1);
    expect(b.take(g1.id, "accept")?.choice).toBe("pause");
    expect(b.take(g1.id, "apply")).toBeNull();
  });
});

describe("I22 guards trip", () => {
  it("emptyVault: an unmounted vault root produces no deletes and pauses", async () => {
    const { w, a, init, guards } = await syncedVault("guard-empty", 30);
    for (const p of Object.keys(init)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(deletes(a)).toBe(0);
    expect(a.engine.status()).toMatchObject({ status: "paused", reason: "emptyVault" });
    expect(guards.map((g) => g.kind)).toEqual(["emptyVault"]);
    expect(a.engine.log.entries().some((e) => e.key === "log.vaultLooksEmpty" && e.level === "error")).toBe(true);
    // The volume comes back; resume: nothing was lost anywhere.
    a.fs.seed(init);
    a.engine.answerGuard(guards[0]!.id, "pause");
    a.engine.resume();
    await a.engine.whenConnected();
    await a.sync();
    expect(deletes(a)).toBe(0);
    expect(a.engine.status().status).toBe("synced");
    expect((await serverMap(w)).size).toBe(30);
  });

  it("emptyVault apply: the user really emptied the vault (deletes still go through the mass-delete guard)", async () => {
    const { a, init, guards } = await syncedVault("guard-empty-apply", 30);
    for (const p of Object.keys(init)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    a.engine.answerGuard(guards[0]!.id, "apply");
    await a.sync();
    expect(deletes(a)).toBe(0);
    expect(guards.map((g) => g.kind)).toEqual(["emptyVault", "massDeleteLocal"]);
    a.engine.answerGuard(guards[1]!.id, "apply");
    await a.sync();
    expect(deletes(a)).toBe(30);
  });

  it("massDeleteLocal: above max(25, 10 %) nothing is deleted until apply", async () => {
    const { a, init, guards } = await syncedVault("guard-mass", 40);
    const victims = Object.keys(init).slice(0, 30);
    for (const p of victims) a.fs.external.remove(p);
    a.fs.external.write("n/new.md", "a new note\n");
    a.engine.requestScan();
    await a.sync();
    expect(deletes(a)).toBe(0);
    expect(a.engine.status()).toMatchObject({ status: "paused", reason: "massDeleteLocal" });
    expect(guards[0]).toMatchObject({ kind: "massDeleteLocal", n: 30 });
    expect(guards[0]!.sample.length).toBeGreaterThan(0);
    a.engine.answerGuard(guards[0]!.id, "apply");
    await a.sync();
    expect(deletes(a)).toBe(30);
    expect(a.engine.status().status).toBe("synced");
  });

  it("massDeleteLocal pause keeps the deletes held; a later resume asks again", async () => {
    const { a, init, guards } = await syncedVault("guard-mass-pause", 40);
    for (const p of Object.keys(init).slice(0, 26)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    a.engine.answerGuard(guards[0]!.id, "pause");
    expect(a.engine.status().status).toBe("paused");
    a.engine.resume();
    await a.engine.whenConnected();
    await a.sync();
    expect(deletes(a)).toBe(0);
    expect(guards.length).toBe(2);
  });

  it("deletes at or below the threshold are pushed without asking", async () => {
    const { a, init, guards } = await syncedVault("guard-few", 40);
    for (const p of Object.keys(init).slice(0, 25)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(deletes(a)).toBe(25);
    expect(guards).toEqual([]);
  });

  it("massDeleteRemote: a burst the sender's user approved is applied without a second question (§3.13)", async () => {
    const { w, a, init, guards } = await syncedVault("guard-remote", 40);
    const b = new Node(w, { name: "beta" });
    await b.start();
    await syncAll([a, b]);
    for (const p of Object.keys(init).slice(0, 30)) b.fs.external.remove(p);
    b.engine.requestScan();
    await b.sync();
    const bg = b.engine.guards.list()[0]!;
    expect(bg.kind).toBe("massDeleteLocal");
    b.engine.answerGuard(bg.id, "apply");
    await b.sync();
    expect(deletes(b)).toBe(30);
    await a.sync();
    // One answer for the pair: the receiver applies the approved burst (to the trash).
    expect(guards).toEqual([]);
    expect(a.fs.files().size).toBe(10);
    expect(a.fs.trash.length).toBe(30);
  });

  it("massDeleteRemote: incoming deletes nobody approved are held until apply (design §3.8.3)", async () => {
    const { w, a, init, guards } = await syncedVault("guard-remote2", 40);
    const b = new Node(w, { name: "beta" });
    await b.start();
    await syncAll([a, b]);
    // beta deletes in two passes, each at the threshold (no guard there); alpha does not run meanwhile.
    const victims = Object.keys(init).slice(0, 30);
    for (const p of victims.slice(0, 15)) b.fs.external.remove(p);
    b.engine.requestScan();
    await b.sync();
    // The passes are further apart than beta's own window (D12), so beta's local guard stays quiet.
    w.clock.tick(DELETE_WINDOW_MS + 1);
    for (const p of victims.slice(15)) b.fs.external.remove(p);
    b.engine.requestScan();
    await b.sync();
    expect(b.engine.guards.list()).toEqual([]);
    expect(deletes(b)).toBe(30);
    await a.sync();
    expect(a.fs.files().size).toBe(40);
    expect(guards.map((g) => g.kind)).toEqual(["massDeleteRemote"]);
    a.engine.answerGuard(guards[0]!.id, "apply");
    await a.sync();
    expect(a.fs.files().size).toBe(10);
    expect(a.fs.trash.length).toBe(30);
  });

  it("massDeleteLocal across loops: 20 then 10 deletes within the window trip the guard (D12)", async () => {
    const { w, a, init, guards } = await syncedVault("guard-window", 40);
    const victims = Object.keys(init).slice(0, 30);
    const t0 = w.clock.monotonic();
    for (const p of victims.slice(0, 20)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(guards).toEqual([]);
    expect(deletes(a)).toBe(20);
    for (const p of victims.slice(20)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(w.clock.monotonic() - t0).toBeLessThan(DELETE_WINDOW_MS);
    // Already pushed deletes are not recalled; the rest of the burst waits for an answer.
    expect(deletes(a)).toBe(20);
    expect(a.engine.status()).toMatchObject({ status: "paused", reason: "massDeleteLocal" });
    expect(guards.map((g) => g.kind)).toEqual(["massDeleteLocal"]);
    expect(guards[0]).toMatchObject({ n: 30 });
    a.engine.answerGuard(guards[0]!.id, "apply");
    await a.sync();
    expect(deletes(a)).toBe(30);
    expect(a.engine.status().status).toBe("synced");
  });

  it("massDeleteLocal across loops: a pause keeps the rest held after the window ages out (D12)", async () => {
    const { w, a, init, guards } = await syncedVault("guard-window-pause", 40);
    const victims = Object.keys(init).slice(0, 30);
    for (const p of victims.slice(0, 20)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    for (const p of victims.slice(20)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    a.engine.answerGuard(guards[0]!.id, "pause");
    w.clock.tick(DELETE_WINDOW_MS + 1);
    a.engine.resume();
    await a.engine.whenConnected();
    await a.sync();
    expect(deletes(a)).toBe(20);
    expect(guards.length).toBe(2);
    expect(guards[1]).toMatchObject({ kind: "massDeleteLocal", n: 30 });
  });

  it("massDeleteLocal across loops: halves more than the window apart do not trip (D12)", async () => {
    const { w, a, init, guards } = await syncedVault("guard-window-apart", 40);
    const victims = Object.keys(init).slice(0, 30);
    for (const p of victims.slice(0, 20)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    w.clock.tick(DELETE_WINDOW_MS + 1);
    for (const p of victims.slice(20)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(guards).toEqual([]);
    expect(deletes(a)).toBe(30);
  });

  it("massDeleteLocal: one answer covers the whole burst (watcher deletes keep arriving, §7.7)", async () => {
    const { a, init, guards } = await syncedVault("guard-burst", 60);
    const victims = Object.keys(init);
    for (const p of victims.slice(0, 30)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(guards.map((g) => g.kind)).toEqual(["massDeleteLocal"]);
    a.engine.answerGuard(guards[0]!.id, "apply");
    // More of the same `rm -r` is reported after the answer (10 files stay: not an empty vault).
    for (const p of victims.slice(30, 50)) a.fs.external.remove(p);
    a.engine.requestScan();
    await a.sync();
    expect(guards.map((g) => g.kind)).toEqual(["massDeleteLocal"]);
    expect(deletes(a)).toBe(50);
  });

  it("massConflict: a rebuild that would create more than 20 conflict copies pauses until apply", async () => {
    const { w, a, init } = await syncedVault("guard-conflict", 24);
    const b = new Node(w, { name: "beta" });
    await b.start();
    await syncAll([a, b]);
    // beta loses its state DB (eviction) and its files changed meanwhile: no-base pairs differ.
    await b.engine.stop();
    for (const p of Object.keys(init)) b.fs.seed({ [p]: `beta's own text for ${p}\n` }, { mtime: w.clock.now() + 1000 });
    const bg: GuardEvent[] = [];
    await b.restart({ wipeState: true });
    b.engine.on("guard", (g) => bg.push(g));
    await syncAll([b]);
    expect(bg.map((g) => g.kind)).toContain("massConflict");
    expect(b.engine.status()).toMatchObject({ status: "paused", reason: "massConflict" });
    const copiesBefore = [...b.fs.files().keys()].filter((p) => p.includes("Conflicted copy")).length;
    expect(copiesBefore).toBeLessThanOrEqual(20);
    b.engine.answerGuard(bg.find((g) => g.kind === "massConflict")!.id, "apply");
    await syncAll([a, b]);
    const copies = [...b.fs.files().keys()].filter((p) => p.includes("Conflicted copy"));
    expect(copies.length).toBe(24);
    for (const p of Object.keys(init)) expect(b.fs.readText(p)).toBe(init[p]);
    expect(deletes(b)).toBe(0);
  });
});
