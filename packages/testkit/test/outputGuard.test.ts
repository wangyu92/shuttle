// The H3 output guard itself (design §7.2 H3): it captures the console, scans every encoding and
// reports a hit without echoing the secret.
import { afterEach, describe, expect, it } from "vitest";
import { createOutputGuard, currentFileGuard, guardLog, guardOutput, noteSecret, type OutputGuard } from "./outputGuard";

const SECRET = "sxd_alice-test-token-0123456789";
const KEY = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
let g: OutputGuard | null = null;

afterEach(() => { g?.uninstall(); g = null; });

describe("output guard", () => {
  it("passes when nothing secret was printed", () => {
    g = createOutputGuard([SECRET]);
    console.debug("syncing 3 files to https://sync.example.com");
    expect(() => g!.check()).not.toThrow();
    expect(g.text).toContain("syncing 3 files");
  });

  it("catches a secret in raw form, in a log line and in hex or base64 of key bytes, without echoing it", () => {
    g = createOutputGuard([SECRET]);
    noteSecret({ name: "vmk", value: KEY });
    guardLog(`connect failed, token ${SECRET}`);
    let msg = "";
    try { g.check(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/secret#1 as raw/);
    expect(msg).not.toContain(SECRET);

    for (const enc of [Buffer.from(KEY).toString("hex"), Buffer.from(KEY).toString("base64").replace(/=+$/, "")]) {
      g.uninstall();
      g = createOutputGuard([{ name: "vmk", value: KEY }]);
      g.write({ dump: `key=${enc}` });
      expect(() => g!.check()).toThrow(/vmk as (hex|base64)/);
    }
  });

  it("uninstall puts the console back; secrets below the scan minimum are ignored", () => {
    const before = console.warn;
    g = createOutputGuard(["abc"]);
    expect(console.warn).not.toBe(before);
    g.write("abc");
    expect(() => g!.check()).not.toThrow();
    g.uninstall();
    expect(console.warn).toBe(before);
  });

  it("the project setup file installed one guard for this file; suites only add secrets to it", () => {
    const fg = currentFileGuard();
    expect(fg).not.toBe(null);
    expect(guardOutput({ name: "suite secret", value: "suite-secret-value-123" })).toBe(fg);
    console.info("h3 setup marker line");
    guardLog("h3 routed log line");
    noteSecret("another-noted-secret-456");
    expect(fg!.text).toContain("h3 setup marker line");
    expect(fg!.text).toContain("h3 routed log line");
    expect(() => fg!.check()).not.toThrow();
  });
});
