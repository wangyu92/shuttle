// Shared helpers for the scripted sim scenarios (design §7.2 sim rows, §7.4).
import { expect } from "vitest";
import { Sim, type SimDevice, type SimDeviceConfig, type SimFailure, type SimOptions } from "../src/index";
import { guardOutput, noteSecret, type OutputGuard } from "../../testkit/test/outputGuard";
import type { NamedSecret } from "@shuttle/testkit";

/** The FakeKeyring secret of a seed's world (src/world.ts makeSimWorld). */
const ringSecret = (seed: number): NamedSecret => ({ name: `keyring secret of seed ${seed}`, value: `sim-${seed}` });

/**
 * design §7.2 H3: every sim suite holds a keyring. Console output is scanned in afterAll for the
 * keyring secret of each seed it runs (scripted() registers its own). Secrets shorter than the
 * scanner's minimum (seeds 0-9) are skipped.
 */
export function guardSim(...seeds: number[]): OutputGuard {
  return guardOutput(...seeds.map(ringSecret));
}

/** A started sim without random actions; scenarios drive it through the public helpers. */
export async function scripted(seed: number, devices = 3, o: Partial<SimOptions> = {}, cfg: Array<Partial<SimDeviceConfig>> = []): Promise<Sim> {
  const sim = new Sim({ seed, devices, steps: 0, ...o });
  noteSecret(ringSecret(seed));
  // Scripted scenarios set every device explicitly: no random excluded folder unless asked.
  const plain = Array.from({ length: devices }, (_, i) => ({ settings: { excludedFolders: [] }, ...(cfg[i] ?? {}) }));
  await sim.setup(plain);
  return sim;
}

export function by(sim: Sim, name: string): SimDevice {
  const d = sim.devices.find((x) => x.name === name);
  if (!d) throw new Error(`no device ${name}`);
  return d;
}

/** Commits sent by `d` since `from` (index into sim.commits). */
export function commitsOf(sim: Sim, d: SimDevice, from = 0): number {
  return sim.commits.slice(from).filter((c) => c.device === d.name).length;
}

/** Quiesce + every oracle; fail the test with the oracle report. */
export async function checkpoint(sim: Sim): Promise<void> {
  sim.step++;
  await sim.checkpoint();
  expectNoFailures(sim.failures);
}

export function expectNoFailures(f: readonly SimFailure[]): void {
  expect(f.map((x) => `${x.inv} @${x.step}: ${x.detail}`)).toEqual([]);
}

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
