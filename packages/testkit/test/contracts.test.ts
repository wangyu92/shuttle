// Compile-time and runtime checks that implementations match the @shuttle/protocol contracts.
// A drift between @shuttle/crypto's Keyring and the engine-facing protocol Keyring fails `npm run lint`.
import { describe, expect, it } from "vitest";
import type * as Crypto from "@shuttle/crypto";
import type {
  Clock, Keyring, LocalFs, RecordHeader, RemoteAdapter, Scheduler, StateStore,
} from "@shuttle/protocol";
import { FakeClock, FakeRemoteServer, FakeScheduler, MemLocalFs, MemStateStore } from "../src/index";

type Assignable<A, B> = [A] extends [B] ? true : false;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const yes = <T extends true>(): T => true as T;

// The crypto implementation satisfies the engine-facing interface.
yes<Assignable<Crypto.SxKeyring, Keyring>>();
yes<Assignable<Crypto.Keyring, Keyring>>();
// Both sides agree on the AAD header exactly.
yes<Equal<Crypto.RecordHeader, RecordHeader>>();

describe("contracts", () => {
  it("fakes implement the protocol interfaces", () => {
    const fs: LocalFs = new MemLocalFs();
    const state: StateStore = new MemStateStore();
    const remote: RemoteAdapter = new FakeRemoteServer().adapter();
    const clock: Clock = new FakeClock();
    const sched: Scheduler = new FakeScheduler();
    expect([fs, state, remote, clock, sched].every(Boolean)).toBe(true);
  });
});
