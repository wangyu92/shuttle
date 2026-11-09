#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// @shuttle/headless: the headless client (design §6.1). Library exports for tests and tooling; when
// run as the bundle entry (dist/headless/shuttle-headless.mjs) it is the `shuttle-headless` CLI.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { processIo, runCli } from "./cli";

export const PACKAGE_NAME = "@shuttle/headless";

export { runCli, processIo, EXIT_CODES, type CliIo } from "./cli";
export { Daemon, StartupError, FileLocalRecordStore, SecretsSeenStore, buildKeyring, EXIT, HEADLESS_VERSION, nodeWs, realScheduler, type DaemonOptions } from "./main";
export * from "./config";
export * from "./NodeLocalFs";
export { SqliteStateStore, SQLITE_LAYOUT_VERSION, type SqliteStateStoreOptions } from "./state/SqliteStateStore";
export { Watcher, type WatchMode, type WatcherOptions, type WatcherStats } from "./watch/Watcher";
export { inotifyBudget, countWatchedDirs, procProbe, type InotifyBudget, type InotifyProbe } from "./watch/inotifyBudget";
export * from "./secrets";
export * from "./pair";
export * from "./health";
export * from "./prodGuard";
export * from "./supervisor";
export { createLogger, memoryLogger, redact, addSecret, type Logger, type LogFormat, type LogLine } from "./log";
export { ControlServer, type ControlHandlers } from "./control/ControlServer";
export { ControlClient, ControlUnreachable } from "./control/ControlClient";
export { wrapRemote, type RemoteProgress } from "./remote";

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = await runCli(process.argv.slice(2), processIo());
  // `sync --continuous` resolves only when the supervisor exits the process itself.
  process.exitCode = code;
}
