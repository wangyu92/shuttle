// Wiring check: the plugin entry loads with the obsidian stub.
import { describe, expect, it } from "vitest";
import ShuttlePlugin, { PACKAGE_NAME } from "../src/index";

describe("shuttle (plugin)", () => {
  it("loads its entry", () => {
    expect(PACKAGE_NAME).toBe("shuttle");
    expect(typeof ShuttlePlugin).toBe("function");
  });
});
