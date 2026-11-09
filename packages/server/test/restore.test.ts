// I29 server side: restoring an older shuttle.db (design §2.6.1, §2.6.6). With a newer hwm.json the
// head is raised on start; when hwm.json was restored too, hello.seenMaxSeq raises it.
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAdmin } from "../src/adminCli";
import { readHwm } from "../src/hwm";
import type { RunningServer } from "../src/server";
import { TestWs, fileId, fixture, pathKey, putOp, removeDir, silentIo, start, tempDir, type Client } from "./helpers";

let srv: RunningServer | null = null;
let dir: string | undefined;

afterEach(async () => {
  await srv?.close();
  srv = null;
  await removeDir(dir);
});

async function commitN(c: Client, vid: string, n: number): Promise<number> {
  const ws = await TestWs.open(srv!);
  await ws.connect(c.token, vid);
  const r = await ws.commit(Array.from({ length: n }, () => putOp(fileId(), null, pathKey())));
  ws.close();
  return r.headSeq;
}

async function snapshotDb(name: string): Promise<void> {
  await copyFile(path.join(dir!, "shuttle.db"), path.join(dir!, name));
}

async function restoreDb(name: string): Promise<void> {
  for (const s of ["-wal", "-shm"]) await rm(path.join(dir!, `shuttle.db${s}`), { force: true });
  await copyFile(path.join(dir!, name), path.join(dir!, "shuttle.db"));
}

describe("restore (I29)", () => {
  it("older DB + newer hwm.json → head raised, snapshotRequired{rollback}, ack clears it, no seq reuse", async () => {
    dir = await tempDir("restore");
    srv = await start(dir);
    const { c, vid } = await fixture(srv, dir);
    expect(await commitN(c, vid, 5)).toBe(5);
    await srv.close();
    await snapshotDb("backup.db");
    srv = await start(dir);
    expect(await commitN(c, vid, 5)).toBe(10);
    await srv.close();
    expect(readHwm(dir, vid)).toEqual({ epoch: 1, headSeq: 10 });
    await restoreDb("backup.db");
    srv = await start(dir);

    const ws = await TestWs.open(srv);
    ws.hello(c.token, vid, { since: 10, seenMaxSeq: 10 });
    const welcome = await ws.type("welcome");
    expect(welcome.headSeq).toBe(10);
    const sr = await ws.type("snapshotRequired");
    expect(sr).toMatchObject({ reason: "rollback" });
    expect(typeof sr.rollbackAt).toBe("number");
    // A cursor at or below restored_seq is not affected.
    const { changes } = await ws.connect(c.token, vid, { since: 5, rollbackAck: null });
    expect(changes.at(-1)).toMatchObject({ to: 10, more: false });
    // After the snapshot reconcile the client acks the rollback.
    const ws2 = await TestWs.open(srv);
    const ok = await ws2.connect(c.token, vid, { since: 10, rollbackAck: sr.rollbackAt });
    expect(ok.changes.at(-1)).toMatchObject({ from: 10, to: 10, more: false });
    const r = await ws2.commit([putOp(fileId(), null, pathKey())]);
    expect((r.results[0] as { seqs: number[] }).seqs[0]).toBe(11);
    ws2.close();
    // The ack is stored: the rule no longer applies to that device.
    const ws3 = await TestWs.open(srv);
    const again = await ws3.connect(c.token, vid, { since: 11 });
    expect(again.changes.length).toBeGreaterThan(0);
    expect(ws3.frames.find((f) => f.type === "snapshotRequired")).toBeUndefined();
    ws3.close();
    ws.close();
  }, 30_000);

  it("DB and hwm.json both restored → hello.seenMaxSeq raises the head and starts the rule", async () => {
    dir = await tempDir("restore2");
    srv = await start(dir);
    const { c, vid } = await fixture(srv, dir);
    await commitN(c, vid, 3);
    await srv.close();
    await snapshotDb("backup.db");
    await copyFile(path.join(dir, "vaults", vid, "hwm.json"), path.join(dir, "hwm-backup.json"));
    srv = await start(dir);
    await commitN(c, vid, 4);
    await srv.close();
    await restoreDb("backup.db");
    await copyFile(path.join(dir, "hwm-backup.json"), path.join(dir, "vaults", vid, "hwm.json"));
    srv = await start(dir);
    const ws = await TestWs.open(srv);
    ws.hello(c.token, vid, { since: 7, seenMaxSeq: 7 });
    await ws.type("welcome");
    expect(await ws.type("snapshotRequired")).toMatchObject({ reason: "rollback" });
    const snap = await fetch(`${srv.url}/v1/vaults/${vid}/snapshot`, { headers: c.auth }).then((r) => r.json());
    expect(snap.headSeq).toBe(7);
    ws.close();
  });

  it("restore-finish revokes every token and prints new enroll codes", async () => {
    dir = await tempDir("restore3");
    srv = await start(dir);
    const { c, vid } = await fixture(srv, dir);
    const ws = await TestWs.open(srv);
    await ws.connect(c.token, vid);
    const { io, out } = silentIo(dir);
    expect(await runAdmin(["restore-finish"], io)).toBe(0);
    expect(out[0]).toBe("revoked 1 device token(s)");
    expect(out.some((l) => /^alice\tSXE-/.test(l))).toBe(true);
    expect(out.join("\n")).not.toContain(c.token);
    srv.core.sweepRevoked();
    expect((await ws.waitClose()).code).toBe(4403);
    const code = out.find((l) => l.startsWith("alice\t"))!.split("\t")[1]!;
    const e = await fetch(`${srv.url}/v1/auth/enroll`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device: { name: "laptop", platform: "linux", clientVersion: "0.1.0" } }),
    });
    expect(e.status).toBe(200);
  });
});
