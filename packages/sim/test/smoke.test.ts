// Wiring check: the package entry loads under its vitest project.
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";
import { guardSim } from "./helpers";

// design §7.2 H3: console output is scanned for each seed's keyring secret.
guardSim();

describe("@shuttle/sim", () => {
  it("loads its entry", () => {
    expect(PACKAGE_NAME).toBe("@shuttle/sim");
  });
});
