// Shutdown and crash safety (design §2.6, §2.8.9, §7.5): SIGTERM during commits is all-or-nothing and
// closes sockets 4503; kill -9 during writes leaves an intact DB with no dangling version_blobs; the
// tmp/ staging dir is swept on start. The server runs as a child process built from src with esbuild.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readHwm } from "../src/hwm";
import { TEST_ROOT, TestWs, addUser, blobId, cid, createVault, fileId, login, pathKey, putBlob, putOp, removeDir, sealed, start, tempDir, guardSuite } from "./helpers";
import type { RunningServer } from "../src/server";

// design §7.2 H3: logs, admin output and console are scanned for the password and tokens.
guardSuite();

const BUNDLE = path.join(TEST_ROOT, "bundle", "shuttle-server.mjs");

beforeAll(async () => {
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../src/index.ts")],
    outfile: BUNDLE, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "warning",
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
}, 60_000);

afterAll(async () => {
  await removeDir(path.dirname(BUNDLE));
});

interface Child { proc: ChildProcess; port: number; url: string; output: string[] }

async function spawnServer(dataDir: string): Promise<Child> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BUNDLE], {
    env: { ...process.env, SHUTTLE_DATA: dataDir, SHUTTLE_PORT: "0", SHUTTLE_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no listen line: ${output.join("")}`)), 20_000);
    const onData = (d: Buffer) => {
      output.push(String(d));
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output.join(""));
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (d: Buffer) => output.push(String(d)));
    proc.once("exit", (code) => { clearTimeout(t); reject(new Error(`exited ${code}: ${output.join("")}`)); });
  });
  return { proc, port, url: `http://127.0.0.1:${port}`, output };
}

const asServer = (ch: Child) => ({ url: ch.url, port: ch.port }) as unknown as RunningServer;

function checkDb(dataDir: string): { headSeq: number; maxSeq: number; cids: Map<string, number> } {
  const db = new DatabaseSync(path.join(dataDir, "shuttle.db"));
  try {
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    expect((db.prepare("PRAGMA foreign_key_check").all()).length).toBe(0);
    const dangling = db.prepare(`SELECT COUNT(*) AS c FROM version_blobs vb
      WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.vault_id = vb.vault_id AND v.seq = vb.seq)`).get() as { c: number };
    expect(dangling.c).toBe(0);
    const noBlobRow = db.prepare(`SELECT COUNT(*) AS c FROM version_blobs vb
      WHERE NOT EXISTS (SELECT 1 FROM blobs b WHERE b.vault_id = vb.vault_id AND b.blob_id = vb.blob_id)`).get() as { c: number };
    expect(noBlobRow.c).toBe(0);
    const badHead = db.prepare(`SELECT COUNT(*) AS c FROM files f
      WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.vault_id = f.vault_id AND v.seq = f.head_seq)`).get() as { c: number };
    expect(badHead.c).toBe(0);
    const h = db.prepare("SELECT head_seq AS h FROM vaults").get() as { h: number };
    const m = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM versions").get() as { m: number };
    expect(h.h).toBeGreaterThanOrEqual(m.m);
    const cids = new Map<string, number>();
    for (const r of db.prepare("SELECT cid, COUNT(*) AS n FROM versions GROUP BY cid").all() as Array<{ cid: string; n: number }>) cids.set(r.cid, r.n);
    return { headSeq: h.h, maxSeq: m.m, cids };
  } finally {
    db.close();
  }
}

async function setup(dataDir: string, ch: Child) {
  const s = asServer(ch);
  await addUser(dataDir, "alice");
  const c = await login(s, "alice");
  const vid = await createVault(s, c, "v");
  return { s, c, vid };
}

describe("crash and shutdown", () => {
  it("kill -9 during commits and uploads: DB intact, acknowledged commits durable, tmp/ swept on start", async () => {
    const dir = await tempDir("kill9");
    const ch = await spawnServer(dir);
    const { s, c, vid } = await setup(dir, ch);
    const ws = await TestWs.open(s);
    await ws.connect(c.token, vid);
    const acked = new Map<string, number>();
    let stop = false;
    const committer = (async () => {
      while (!stop) {
        const ids = [blobId(), blobId()];
        try {
          for (const id of ids) await putBlob(s, c, vid, id, sealed(20_000));
          const id = cid();
          const ops = [putOp(fileId(), null, pathKey(), { blobs: ids }), putOp(fileId(), null, pathKey())];
          const r = await ws.commit(ops, { cid: id, atomic: true });
          if (r.results.every((x) => x.ok)) acked.set(id, ops.length);
        } catch { return; }
      }
    })();
    const uploader = (async () => {
      while (!stop) { try { await putBlob(s, c, vid, blobId(), sealed(200_000)); } catch { return; } }
    })();
    const t0 = Date.now();
    while (acked.size < 3 && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    ch.proc.kill("SIGKILL");
    stop = true;
    await Promise.allSettled([committer, uploader]);
    await new Promise<void>((r) => (ch.proc.exitCode !== null || ch.proc.signalCode !== null ? r() : ch.proc.once("exit", () => r())));
    expect(acked.size).toBeGreaterThan(0);
    const st = checkDb(dir);
    for (const [id, n] of acked) expect(st.cids.get(id)).toBe(n);
    for (const n of st.cids.values()) expect(n).toBe(2); // atomic commits: all ops or none
    // Leftover staging file from a crashed upload is swept on start.
    await mkdir(path.join(dir, "tmp"), { recursive: true });
    await writeFile(path.join(dir, "tmp", "leftover"), "x");
    const srv = await start(dir);
    expect(srv.core.tmpEntries()).toEqual([]);
    await srv.close();
    await removeDir(dir);
  }, 60_000);

  it("SIGTERM during commits: exit 0, sockets close 4503, each commit all or nothing, hwm.json = head", async () => {
    const dir = await tempDir("sigterm");
    const ch = await spawnServer(dir);
    const { s, c, vid } = await setup(dir, ch);
    const ws = await TestWs.open(s);
    await ws.connect(c.token, vid);
    const acked = new Set<string>();
    let stop = false;
    const committer = (async () => {
      while (!stop) {
        const id = cid();
        try {
          const r = await ws.commit(Array.from({ length: 20 }, () => putOp(fileId(), null, pathKey())), { cid: id });
          if (r.results.every((x) => x.ok)) acked.add(id);
        } catch { return; }
      }
    })();
    await new Promise((r) => setTimeout(r, 800));
    const exited = new Promise<number | null>((r) => ch.proc.once("exit", (code) => r(code)));
    ch.proc.kill("SIGTERM");
    const close = await ws.waitClose(15_000);
    stop = true;
    await committer;
    expect(close.code).toBe(4503);
    expect(await exited).toBe(0);
    const st = checkDb(dir);
    for (const id of acked) expect(st.cids.get(id)).toBe(20);
    for (const n of st.cids.values()) expect(n).toBe(20);
    expect(readHwm(dir, vid)).toEqual({ epoch: 1, headSeq: st.headSeq });
    await removeDir(dir);
  }, 60_000);
});
