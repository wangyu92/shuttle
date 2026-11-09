// Test temp directories under ~/tmp/claude/shuttle-p1/headless-test (never the system temp dir: it is
// RAM on the NAS and production prefixes are refused). Paths stay short so unix sockets fit (108 bytes).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TEST_ROOT = path.join(os.homedir(), "tmp/claude/shuttle-p1/hl");

export async function tempDir(prefix: string): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  return mkdtemp(path.join(TEST_ROOT, `${prefix}-`));
}

export async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` with real sleeps until it is true or `timeoutMs` passes. */
export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 20_000, stepMs = 50, what = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}
