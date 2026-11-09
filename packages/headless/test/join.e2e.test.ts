// A fresh device joining a populated vault (design §2.9.1: hello since = null before the first
// bootstrap, so the server answers no-cursor, never epoch). Regression: it used to send since = 0 with
// epoch = null, got snapshotRequired{epoch}, ran an epoch resync and tripped the epoch guard (exit 4).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { converge, createTestVault, diskMap, provisionNode, startNode, startWorld, stopNode, stopWorld, type World } from "./e2eHarness";
import { waitFor } from "./tmp";

let w: World;
afterAll(async () => { await stopWorld(w); });

it("a fresh device joining a populated vault downloads it without tripping a guard", async () => {
  w = await startWorld("join");
  const v = await createTestVault(w, "join");
  const a = await provisionNode(w, v, "join-a");
  await startNode(a);
  await mkdir(path.join(a.dirs.vault, "d"), { recursive: true });
  for (let i = 0; i < 120; i++) await writeFile(path.join(a.dirs.vault, i % 3 ? `d/n${i}.md` : `n${i}.md`), `note ${i}\n`);
  await converge([a], 120_000);
  await stopNode(a);
  const b = await provisionNode(w, v, "join-b");
  await startNode(b);
  let tripped: unknown[] = [];
  try {
    await waitFor(async () => {
      tripped = b.daemon!.listGuards();
      return tripped.length > 0 || (await diskMap(b.dirs.vault)).size === 120;
    }, 150_000, 250, "B join");
    expect(tripped).toEqual([]);
    expect((await diskMap(b.dirs.vault)).size).toBe(120);
  } finally {
    await stopNode(b);
  }
}, 300_000);
