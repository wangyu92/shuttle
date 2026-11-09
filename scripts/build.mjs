// esbuild targets per docs/private/design/v1-design.md §8.3.
// Usage: node scripts/build.mjs [plugin|headless|server|spike ...] [--dev]
// Type checking is separate (`npm run lint` = tsc -b, declarations only into .tsbuild/).
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const ALL = ["plugin", "headless", "server", "spike"];
const wanted = args.filter((a) => !a.startsWith("--"));
for (const t of wanted) if (!ALL.includes(t)) throw new Error(`unknown target: ${t}`);
const targets = wanted.length ? wanted : ALL;

const p = (...s) => path.join(root, ...s);
const define = { __SHUTTLE_TEST_HOOKS__: dev ? "true" : "false" };

// Obsidian plugin bundle: cjs / browser / es2020, Obsidian-provided modules external.
async function obsidianPlugin(pkgDir, outDir) {
  const out = p("dist", outDir);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: [p("packages", pkgDir, "src", "index.ts")],
    outfile: path.join(out, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    minify: false,
    sourcemap: dev ? "inline" : false,
    legalComments: "linked",
    define,
    logLevel: "warning",
  });
  for (const f of ["manifest.json", "styles.css"]) {
    await copyFile(p("packages", pkgDir, f), path.join(out, f));
  }
}

// Node bundles: esm / node / node22, everything bundled.
// The banner gives bundled CommonJS deps (ws) a working `require`.
const nodeBanner = {
  js: 'import { createRequire as __shuttleCreateRequire } from "node:module"; const require = __shuttleCreateRequire(import.meta.url);',
};
async function nodeBundle(outDir, entries) {
  const out = p("dist", outDir);
  await rm(out, { recursive: true, force: true });
  await build({
    entryPoints: entries.map(([name, src]) => ({ in: src, out: name })),
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: "linked",
    legalComments: "linked",
    banner: nodeBanner,
    define,
    logLevel: "warning",
  });
}

const jobs = {
  plugin: () => obsidianPlugin("plugin", "plugin"),
  spike: () => obsidianPlugin("spike", "spike"),
  headless: () => nodeBundle("headless", [["shuttle-headless", p("packages/headless/src/index.ts")]]),
  server: () =>
    nodeBundle("server", [
      ["shuttle-server", p("packages/server/src/index.ts")],
      ["shuttle-admin", p("packages/server/src/admin.ts")],
    ]),
};

for (const t of targets) {
  await jobs[t]();
  console.log(`built ${t}${dev ? " (dev)" : ""}`);
}
