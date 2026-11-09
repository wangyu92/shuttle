// I31 archive (design §3.10.4, §3.18): in every LWW remote-wins case the local bytes appear as an
// `archive` record or a conflict copy, including the INVALID and offline fallbacks (X5).

import { describe, expect, it } from "vitest";
import { Prng } from "@shuttle/testkit";
import { remoteError } from "@shuttle/protocol";
import { contentOf, recordsOf } from "./harness";
import { Node, makeWorld, syncAll } from "./engineHarness";

const bytes = (s: string, n = 9000): Uint8Array => new Prng(s).bytes(n);
const eq = (a: Uint8Array | undefined, b: Uint8Array): boolean => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

async function remoteWins(seed: string, n = 9000) {
  const w = await makeWorld(seed);
  const a = new Node(w, { name: "alpha" });
  const b = new Node(w, { name: "beta" });
  await a.start();
  await b.start();
  a.fs.external.write("img.bin", bytes("v0", n), { mtime: w.clock.now() });
  a.engine.requestScan();
  await syncAll([a, b]);
  w.clock.tick(1000);
  const t = w.clock.now();
  a.fs.external.write("img.bin", bytes("va", n), { mtime: t + 60_000 }); // newer: wins
  b.fs.external.write("img.bin", bytes("vb", n), { mtime: t });          // older: b archives its bytes
  a.engine.requestScan();
  b.engine.requestScan();
  await a.sync();
  return { w, a, b };
}

describe("I31 archive", () => {
  it("remote wins: the loser's bytes become an archive record", async () => {
    const { w, a, b } = await remoteWins("i31");
    await b.sync();
    await syncAll([a, b]);
    expect(eq(b.fs.files().get("img.bin"), bytes("va"))).toBe(true);
    const arch = recordsOf(w, (r) => r.kind === "archive");
    expect(arch.length).toBe(1);
    expect(eq(await contentOf(w, arch[0]!), bytes("vb"))).toBe(true);
  });

  it("archive refused for good (TOO_LARGE per op): the bytes survive as a local copy (X5)", async () => {
    const N = 100_000;
    const { w, b } = await remoteWins("i31-refused", N);
    // From now on the server refuses files of this size (beyond the 64 KiB encSize slack): b's archive
    // op fails with a final per-op result.
    (w.server.limits as { maxFileSize: number }).maxFileSize = 1000;
    await b.sync();
    expect(eq(b.fs.files().get("img.bin"), bytes("va", N))).toBe(true);
    expect(recordsOf(w, (r) => r.kind === "archive")).toEqual([]);
    const copies = [...b.fs.files().entries()].filter(([p]) => p !== "img.bin");
    expect(copies.length).toBe(1);
    expect(eq(copies[0]![1], bytes("vb", N))).toBe(true);
    expect(copies[0]![0]).toContain("archive");
  });

  it("offline while remote wins: nothing is lost, the archive goes out on reconnect", async () => {
    const { w, a, b } = await remoteWins("i31-offline");
    // b learns a's head, then loses the network before its archive commit.
    await w.server.settle();
    w.server.injectFault({ device: b.deviceId, method: "commit", when: "before", error: remoteError("NETWORK", "offline") });
    await b.engine.runOnce();
    expect(b.engine.status().pendingUp).toBeGreaterThan(0);
    await b.engine.whenConnected();
    w.clock.tick(10 * 60 * 1000);
    await b.sync();
    await syncAll([a, b]);
    const arch = recordsOf(w, (r) => r.kind === "archive");
    const archived = await Promise.all(arch.map((r) => contentOf(w, r)));
    const copies = [...b.fs.files().entries()].filter(([p]) => p !== "img.bin");
    expect(archived.some((c) => eq(c, bytes("vb"))) || copies.some(([, v]) => eq(v, bytes("vb")))).toBe(true);
  });
});
