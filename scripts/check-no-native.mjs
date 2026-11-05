// Fails when node_modules contains a native addon that builds from source
// (binding.gyp) or an unexpected prebuilt .node binary (design §8.2).
// Allowed prebuilt toolchain binaries: esbuild, rollup/rolldown, lightningcss (vite), TypeScript native.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_PREBUILT = [
  /^@esbuild\//,
  /^@rollup\/rollup-/,
  /^@rolldown\/binding-/,
  /^lightningcss-/,
  /^@typescript\/typescript-/,
];

const problems = [];
const seenPrebuilt = new Set();

function pkgNameOf(rel) {
  const parts = rel.split(path.sep);
  const i = parts.lastIndexOf("node_modules");
  const a = parts[i + 1] ?? "";
  return a.startsWith("@") ? `${a}/${parts[i + 2] ?? ""}` : a;
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".bin" || e.name === "@eaDir") continue;
      await walk(full);
    } else if (e.isFile()) {
      const rel = path.relative(root, full);
      if (e.name === "binding.gyp") problems.push(`binding.gyp: ${rel}`);
      else if (e.name.endsWith(".node")) {
        const name = pkgNameOf(rel);
        if (ALLOWED_PREBUILT.some((r) => r.test(name))) seenPrebuilt.add(name);
        else problems.push(`native addon: ${rel} (${name})`);
      }
    }
  }
}

await walk(path.join(root, "node_modules"));
for (const ws of await readdir(path.join(root, "packages"))) {
  await walk(path.join(root, "packages", ws, "node_modules"));
}

if (seenPrebuilt.size) console.log(`allowed prebuilt binaries: ${[...seenPrebuilt].sort().join(", ")}`);
if (problems.length) {
  console.error(`check-no-native: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("check-no-native: ok");
