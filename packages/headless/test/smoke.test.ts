// Wiring check: the package entry loads under its vitest project.
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

describe("@shuttle/headless", () => {
  it("loads its entry", () => {
    expect(PACKAGE_NAME).toBe("@shuttle/headless");
  });
});
