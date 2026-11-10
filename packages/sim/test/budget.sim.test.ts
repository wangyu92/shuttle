// I24 memory budget (design §3.18, §3.15, §7.2): in-flight blob bytes never exceed the platform
// budget except one admitted item <= maxFileBytes; upload/download concurrency stays at the cap.
import { describe, expect, it } from "vitest";
import { by, checkpoint, scripted, guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

describe("I24 budgets", () => {
  it("tiny caps: many multi-chunk files upload and download inside the budget", async () => {
    const budgets = { inFlightBytes: 24 * 1024, uploadConcurrency: 2, downloadConcurrency: 2 };
    const sim = await scripted(501, 3, {}, [{ budgets }, { budgets }, { budgets, platform: "ios" }]);
    const [a, b] = [by(sim, "alpha"), by(sim, "beta")];
    for (let i = 0; i < 8; i++) await sim.userWrite(a, `att/f${i}.png`, sim.prng.bytes(20_000 + i * 3000));
    await sim.userWrite(b, "att/huge.png", sim.prng.bytes(60_000));
    await checkpoint(sim);
    for (const d of sim.devices) {
      const p = d.budgetPeaks;
      expect(p.bytesCap).toBe(24 * 1024);
      // I24: in flight never above the cap, except one item admitted alone (<= maxFileBytes).
      expect(p.bytes).toBeLessThanOrEqual(Math.max(p.bytesCap, p.largestAlone));
      expect(p.largestAlone).toBeLessThanOrEqual(p.maxFileBytes);
      expect(p.upload).toBeLessThanOrEqual(2);
      expect(p.download).toBeLessThanOrEqual(2);
    }
    expect(by(sim, "alpha").budgetPeaks.upload).toBeGreaterThan(0);
    // Blob bytes really go through the byte budget, and the cap was reached.
    expect(by(sim, "alpha").budgetPeaks.bytes).toBeGreaterThan(16 * 1024);
    expect(by(sim, "gamma").budgetPeaks.download).toBeGreaterThan(0);
  }, 60_000);
});
