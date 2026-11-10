// design §7.2 H3: the project's setup file installed this file's output capture (no per-suite code).
import { expect, it } from "vitest";
import { guardOutput, hasFileGuard } from "./h3";

it("every test file runs under the setup-installed output guard", () => {
  expect(hasFileGuard()).toBe(true);
  guardOutput([{ name: "suite secret", value: "suite-secret-value-123" }]);
  console.info("h3 setup marker line");
});
