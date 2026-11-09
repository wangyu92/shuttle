// @shuttle/sim: deterministic multi-device simulator (design §7.4, ops-spec §3.4).
export const PACKAGE_NAME = "@shuttle/sim";

export { installDeterministicRandom } from "./random";
export { CFG, SIM_PARAMS, makeSimWorld, type SimWorld } from "./world";
export { NO_FAULTS, SimNet, type CommitRecord, type NetFaultRates, type NetViolation } from "./net";
export { LocalStorageFake, SimCrash, SimDevice, isCrashLike, type GuardRecord, type SimDeviceConfig } from "./device";
export { Evidence, Ledger, noteBytes, noteLines, tokensOf, type LedgerEntry } from "./ledger";
export {
  ACTIONS, DEFAULT_WEIGHTS, Sim, replayCommand, runSim, shrinkSteps,
  type ActionName, type SimFailure, type SimOptions, type SimResult, type SimStats,
} from "./sim";
export { backupServer, restoreServer, type ServerBackup } from "./restore";
