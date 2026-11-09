// Crash-point hook (design §3.1 testing/crashPoint.ts, §7.4). Release builds define
// __SHUTTLE_TEST_HOOKS__=false through esbuild so the call folds away; tests inject EngineHooks
// whose crashPoint throws or kills the fake store at a named point.

import type { EngineHooks } from "@shuttle/protocol";

declare const __SHUTTLE_TEST_HOOKS__: boolean | undefined;

const HOOKS_ENABLED: boolean = typeof __SHUTTLE_TEST_HOOKS__ === "undefined" ? true : __SHUTTLE_TEST_HOOKS__;

/** Call at every await in OpRunner, RemoteApplier and the ack/apply/ingest transactions (part 2). */
export async function crashPoint(hooks: EngineHooks | undefined, name: string): Promise<void> {
  if (!HOOKS_ENABLED || !hooks) return;
  await hooks.crashPoint(name);
}
