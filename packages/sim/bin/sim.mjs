#!/usr/bin/env node
// Bundles packages/sim/src/cli.ts with esbuild (TypeScript workspace sources cannot run in plain
// node) into .tsbuild/sim-cli/ and runs it with the same arguments. Crash-point hooks stay enabled.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const outfile = path.join(root, ".tsbuild", "sim-cli", "cli.mjs");
await build({
  entryPoints: [path.join(here, "..", "src", "cli.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: "inline",
  define: { __SHUTTLE_TEST_HOOKS__: "true" },
  banner: { js: 'import { createRequire as __simCreateRequire } from "node:module"; const require = __simCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
await import(pathToFileURL(outfile).href);
