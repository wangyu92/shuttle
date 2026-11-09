// Fails when a tracked file contains a string listed in docs/private/leak-patterns.txt
// (gitignored, so the patterns themselves never reach the public repo). Skips when the file is absent.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let patterns;
try {
  patterns = (await readFile(path.join(root, "docs/private/leak-patterns.txt"), "utf8"))
    .split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
} catch {
  console.log("check-leaks: no pattern file, skipped");
  process.exit(0);
}
const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean);
const hits = [];
for (const f of tracked) {
  let text;
  try { text = await readFile(path.join(root, f), "utf8"); } catch { continue; }
  const lines = text.split("\n");
  lines.forEach((line, i) => { for (const p of patterns) if (line.includes(p)) hits.push(`${f}:${i + 1}: private string #${patterns.indexOf(p) + 1}`); });
}
if (hits.length) { console.error(hits.join("\n")); process.exit(1); }
console.log(`check-leaks: ok (${tracked.length} files, ${patterns.length} patterns)`);
