// design §2.6.1 rollback rule with a lagging cursor (I29, I7). A device's commit is acked above the
// backup point, but the feed batch carrying that seq never reached it (cursor == restored_seq). After a
// DB restore it must still be told about the rollback: the client folds acked seqs into seenMaxSeq, the
// host passes engine.helloContext() to the adapter, and the server applies the rule on
// max(since, seenMaxSeq). Regression: A stayed 'synced' with an edit the server had lost.
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { ChangeSink, RemoteAdapter } from "@shuttle/protocol";
import { remoteError } from "@shuttle/protocol";
import { startServer } from "../../server/src/server";
import { testOptions } from "../../server/test/helpers";
import { converge, createTestVault, diskMap, ownerAdapter, provisionNode, startNode, startWorld, stopNode, stopWorld, type World } from "./e2eHarness";
import { sleep, waitFor } from "./tmp";

let w: World;
afterAll(async () => { await stopWorld(w); });

/** Drops feed batches and pulls while `flag.on` (the app closes before it persists them). */
function blockingHook(flag: { on: boolean }) {
  return (r: RemoteAdapter): RemoteAdapter => new Proxy(r, {
    get(t, k, recv) {
      if (k === "subscribe") return (since: number | null, sink: ChangeSink) => t.subscribe(since, new Proxy(sink, {
        get(s, kk) {
          if (kk === "onChanges") return async (b: unknown) => { if (flag.on) return; return s.onChanges(b as never); };
          return (s as unknown as Record<string | symbol, unknown>)[kk];
        },
      }));
      if (k === "pull") {
        return async (...a: unknown[]) => {
          if (flag.on) throw remoteError("NETWORK", "blocked by test", { retryAfterMs: 1000 });
          return (t.pull as (...x: unknown[]) => unknown)(...a);
        };
      }
      const v = Reflect.get(t, k, recv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

async function head(vaultId: string): Promise<number> {
  const ad = ownerAdapter(w, vaultId);
  try { return (await ad.connect()).headSeq; } finally { await ad.close(); }
}

it("an acked edit whose seq never came back through the feed is flagged as a rollback after a DB restore", async () => {
  w = await startWorld("rb-lag");
  const port = w.srv.port;
  const serverDir = path.join(w.dir, "server");
  const v = await createTestVault(w, "rb");
  const a = await provisionNode(w, v, "rb-a");
  const b = await provisionNode(w, v, "rb-b");
  await startNode(a); await startNode(b);
  await writeFile(path.join(a.dirs.vault, "f.md"), "version one\n");
  await converge([a, b], 120_000);
  await stopNode(a); await stopNode(b);
  // Operator backup (server stopped).
  await w.srv.close();
  await copyFile(path.join(serverDir, "shuttle.db"), path.join(serverDir, "backup.db"));
  w.srv = await startServer(testOptions(serverDir, { port, coalesceMs: 50, log: () => undefined }));
  const headBefore = await head(v.vaultId);

  // A edits f.md; the commit is acked but the feed batch carrying it is never persisted.
  const flag = { on: true };
  await startNode(a, { remoteHook: blockingHook(flag) });
  await writeFile(path.join(a.dirs.vault, "f.md"), "version two, edited after the backup\n");
  await waitFor(async () => (await head(v.vaultId)) > headBefore, 60_000, 200, "A's commit");
  await waitFor(() => a.daemon!.engine.status().pendingUp === 0, 30_000, 100, "A pendingUp 0");
  await sleep(500);
  await stopNode(a);

  // Restore the backup DB (hwm.json stays newer: head raised, rollback rule on).
  await w.srv.close();
  for (const s of ["-wal", "-shm"]) await rm(path.join(serverDir, "shuttle.db" + s), { force: true });
  await copyFile(path.join(serverDir, "backup.db"), path.join(serverDir, "shuttle.db"));
  w.srv = await startServer(testOptions(serverDir, { port, coalesceMs: 50, log: () => undefined }));

  await startNode(a); await startNode(b);
  // A must learn about the restore: a rollback guard waits for the user.
  await waitFor(() => a.daemon!.listGuards().some((g) => g.kind === "rollback"), 60_000, 200, "A rollback guard");
  const g = a.daemon!.listGuards().find((x) => x.kind === "rollback")!;
  a.daemon!.answerGuard(g.id, "accept");
  // After the accepted rollback the post-backup edit is the remote head or a conflict copy, and A and B agree (I29, I7).
  await converge([a, b], 120_000);
  const da = await diskMap(a.dirs.vault);
  const db = await diskMap(b.dirs.vault);
  expect([...db.keys()].sort()).toEqual([...da.keys()].sort());
  const texts = await Promise.all([...db.keys()].map((k) => readFile(path.join(b.dirs.vault, k), "utf8")));
  expect(texts.some((t) => t.includes("version two"))).toBe(true);
  await stopNode(a); await stopNode(b);
}, 300_000);
