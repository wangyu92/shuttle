// Repo rules from docs/private/design/v1-design.md §8.1, §8.2, §8.6 that are not import-scanner rules:
// - every package's `license` field and LICENSE file (server AGPL-3.0-only, everything else MIT);
// - no MIT package depends on @shuttle/server;
// - the plugin and spike bundles contain no server code, no `ws`, no Node builtins, and none of the
//   syntax the mobile WebViews or the community review reject (regex lookbehind, innerHTML, eval).
// Bundles are built in memory with the same options as scripts/build.mjs (nothing is written to dist/).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packagesDir = path.join(root, "packages");
const pkgDirs = readdirSync(packagesDir).filter((d) => d !== "@eaDir" && statSync(path.join(packagesDir, d)).isDirectory());

interface PkgJson {
  name: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
const pkgJson = (d: string) => JSON.parse(readFileSync(path.join(packagesDir, d, "package.json"), "utf8")) as PkgJson;

describe("licenses (§8.6)", () => {
  for (const d of pkgDirs) {
    it(`${d}: license field and LICENSE file`, () => {
      const want = d === "server" ? "AGPL-3.0-only" : "MIT";
      expect(pkgJson(d).license).toBe(want);
      const lic = readFileSync(path.join(packagesDir, d, "LICENSE"), "utf8");
      if (want === "MIT") expect(lic).toMatch(/MIT License|Permission is hereby granted, free of charge/);
      else expect(lic).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/);
    });
  }

  it("no MIT package depends on @shuttle/server", () => {
    for (const d of pkgDirs) {
      if (d === "server") continue;
      const j = pkgJson(d);
      const deps = { ...j.dependencies, ...j.devDependencies, ...j.peerDependencies };
      expect(Object.keys(deps), d).not.toContain("@shuttle/server");
    }
  });
});

// Same options as obsidianPlugin() in scripts/build.mjs (production define).
async function bundle(pkg: "plugin" | "spike") {
  const r = await build({
    entryPoints: [path.join(packagesDir, pkg, "src", "index.ts")],
    bundle: true,
    write: false,
    metafile: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    define: { __SHUTTLE_TEST_HOOKS__: "false" },
    logLevel: "silent",
    absWorkingDir: root,
  });
  const text = r.outputFiles.map((f) => f.text).join("\n");
  const inputs = Object.keys(r.metafile.inputs);
  return { text, inputs };
}

/** Problems in a browser bundle; exported so the self-test below can prove each rule fires. */
export function bundleProblems(text: string, inputs: string[]): string[] {
  const out: string[] = [];
  for (const i of inputs) {
    const n = i.split(path.sep).join("/");
    if (/(^|\/)packages\/server\//.test(n) || /node_modules\/@shuttle\/server\//.test(n)) out.push(`server source bundled: ${i}`);
    if (/node_modules\/ws\//.test(n)) out.push(`ws bundled: ${i}`);
  }
  const requires = [...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  for (const r of requires) if (r !== "obsidian" && r !== "electron" && !r.startsWith("@codemirror/") && !r.startsWith("@lezer/")) out.push(`require("${r}")`);
  const banned: Array<[RegExp, string]> = [
    [/\(\?<[=!]/, "regex lookbehind (unsupported on older iOS WebViews, §8.2)"],
    [/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/, "innerHTML/outerHTML/insertAdjacentHTML (§5, community review)"],
    [/\beval\s*\(|\bnew Function\s*\(/, "eval / new Function"],
    [/\bcreateServer\s*\(|\bWebSocketServer\b|["']node:http["']/, "server code"],
  ];
  for (const [re, why] of banned) if (re.test(text)) out.push(why);
  return out;
}

describe("browser bundles carry no server code (§8.1, §8.6)", () => {
  for (const pkg of ["plugin", "spike"] as const) {
    it(`${pkg} bundle`, async () => {
      const { text, inputs } = await bundle(pkg);
      expect(inputs.length).toBeGreaterThan(0);
      expect(bundleProblems(text, inputs)).toEqual([]);
    }, 60_000);
  }

  it("the bundle checker catches each rule", () => {
    const bad = [
      'const r = /(?<=a)b/;',
      "el.innerHTML = x;",
      "eval(s);",
      "http.createServer(() => {});",
      'require("node:fs");',
    ].join("\n");
    const p = bundleProblems(bad, ["packages/server/src/server.ts", "node_modules/ws/index.js", "packages/crypto/src/aad.ts"]);
    expect(p).toHaveLength(7);
    expect(bundleProblems('require("obsidian"); el.setText("innerHTML");', ["packages/plugin/src/index.ts"])).toEqual([]);
  });

  it("dist copies, when present, match the rules too", () => {
    for (const pkg of ["plugin", "spike"]) {
      const f = path.join(root, "dist", pkg, "main.js");
      if (!existsSync(f)) continue;
      expect(bundleProblems(readFileSync(f, "utf8"), []), f).toEqual([]);
    }
  });
});
