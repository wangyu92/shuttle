// @shuttle/testkit: deterministic in-memory fakes and test helpers (design §7, ops-spec §3).
// No node:* imports in the fakes, so engine, sim and headless tests can all use them.
export const PACKAGE_NAME = "@shuttle/testkit";

export { Prng } from "./prng";
export { FAKE_EPOCH, FakeClock, type FakeClockOptions, FakeScheduler, drainMicrotasks } from "./clock";
export {
  type CommitFault, type CommitInfo, MemStateData, MemStateStore, type MemStateStoreOptions, compareKeys,
} from "./memStateStore";
export {
  type FsOp, LocalFsError, MemLocalFs, type MemLocalFsOptions, type TrashedItem, isLocalFsError, mergeEvents,
} from "./memLocalFs";
export {
  type DeviceRow, type FakeCall, type FakeMethod, FakeRemote, type FakeRemoteOptions, FakeRemoteServer, type FaultSpec,
} from "./fakeRemote";
export {
  MIN_SECRET_LENGTH, type NamedSecret, OutputCapture, type SecretEncoding, type SecretHit, type SecretInput,
  type SecretValue, assertNoSecrets, secretForms, secretScan,
} from "./secretScan";
export { TestIds } from "./fixtures";
