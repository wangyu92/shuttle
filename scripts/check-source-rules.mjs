// Source rules the TypeScript compiler does not check (design §8.2, §8.8, §5): no regex lookbehind
// (older iOS WebViews reject it at parse time) and no innerHTML/outerHTML/insertAdjacentHTML in the
// packages that run inside Obsidian or are bundled into it. Stands in for the ESLint rule until CI.
// The built bundles are checked as well by packages/testkit/repoRules.test.ts (npm test).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER = ["protocol", "crypto", "engine", "adapter-server", "adapter-s3", "plugin", "spike"];
const RULES = [
  [/\(\?<[=!]/, "regex lookbehind"],
  [/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/, "innerHTML/outerHTML/insertAdjacentHTML"],
];

async function files(dir) {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === "@eaDir") continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(f)));
    else if (/\.(?:[cm]?ts|tsx|[cm]?js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(f);
  }
  return out;
}

const problems = [];
for (const pkg of BROWSER) {
  for (const f of await files(path.join(root, "packages", pkg, "src"))) {
    const lines = (await readFile(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of RULES) if (re.test(line)) problems.push(`${path.relative(root, f)}:${i + 1}: ${why}`);
    });
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check-source-rules: ok (${BROWSER.length} packages)`);
