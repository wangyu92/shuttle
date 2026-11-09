/// <reference types="node" />
// The adapter runs inside Obsidian (desktop, iOS WebKit, Android): its src may not use Node APIs.
// tsc cannot catch this because the test files share the project and load Node types.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

describe("adapter-server src", () => {
  it("imports only @shuttle/protocol and local modules, and uses no Node globals", async () => {
    const problems: string[] = [];
    for (const f of await readdir(SRC)) {
      if (!f.endsWith(".ts")) continue;
      const text = await readFile(path.join(SRC, f), "utf8");
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec !== "@shuttle/protocol" && !spec.startsWith("./")) problems.push(`${f}: imports ${spec}`);
      }
      const code = text.split("\n").filter((l) => !l.trim().startsWith("//"));
      for (const [g, re] of [["Buffer", /(^|[^A-Za-z])Buffer\b/], ["process", /\bprocess\./], ["require", /\brequire\(/]] as const) {
        if (code.some((l) => re.test(l))) problems.push(`${f}: uses ${g}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
