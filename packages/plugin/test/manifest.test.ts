import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildManifest, type ManifestAdapter } from "../src/util/manifest";

function fakeAdapter(files: Record<string, string>): ManifestAdapter & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async list(dir) {
      const base = dir === "/" ? "" : dir + "/";
      const out = { files: [] as string[], folders: [] as string[] };
      for (const p of Object.keys(files)) {
        if (!p.startsWith(base)) continue;
        const rest = p.slice(base.length);
        const i = rest.indexOf("/");
        if (i < 0) out.files.push(base + rest);
        else if (!out.folders.includes(base + rest.slice(0, i))) out.folders.push(base + rest.slice(0, i));
      }
      return out;
    },
    async readBinary(p) { reads.push(p); return new TextEncoder().encode(files[p]!).buffer as ArrayBuffer; },
  };
}

describe("buildManifest (design §6.2.2)", () => {
  it("lists every file as path, size, sha256, sorted, skipping the config folder and .trash", async () => {
    const a = fakeAdapter({ "b.md": "bee", "a/x.md": "ex", ".obsidian/app.json": "{}", ".trash/old.md": "old", "a/sub/y.png": "why" });
    const { text, files } = await buildManifest(a, ".obsidian");
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(files).toBe(3);
    expect(text).toBe(`a/sub/y.png\t3\t${h("why")}\na/x.md\t2\t${h("ex")}\nb.md\t3\t${h("bee")}\n`);
    expect(a.reads.some((p) => p.startsWith(".obsidian") || p.startsWith(".trash"))).toBe(false);
  });
  it("an empty vault gives an empty manifest", async () => {
    expect(await buildManifest(fakeAdapter({}), ".obsidian")).toEqual({ text: "", files: 0 });
  });
});
