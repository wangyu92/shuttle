// Import rules from docs/private/design/v1-design.md §8.1:
// - engine, protocol, crypto, adapter-* import neither `obsidian` nor `node:*`;
// - only plugin and spike import `obsidian`;
// - only headless, server, testkit, sim import `node:*` (bare Node builtins such as `fs` count too);
// - nothing but the server imports @shuttle/server or server sources (AGPL code must not reach MIT bundles);
// - engine, protocol, crypto, adapter-*, plugin and spike do not import `ws` (adapters take an injected
//   WsFactory; the browser packages use the platform WebSocket).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OBSIDIAN_ALLOWED = new Set(["plugin", "spike"]);
const NODE_ALLOWED = new Set(["headless", "server", "testkit", "sim"]);
const ALL_PACKAGES = [
  "protocol",
  "crypto",
  "engine",
  "adapter-server",
  "adapter-s3",
  "plugin",
  "headless",
  "server",
  "testkit",
  "sim",
  "spike",
];

const WS_DENIED = new Set(["engine", "protocol", "crypto", "adapter-server", "adapter-s3", "plugin", "spike"]);

const builtins = new Set(builtinModules.filter((m) => !m.startsWith("_")));

// Static imports and re-exports, side-effect imports, dynamic import(), require().
const SPECIFIER_RES = [
  /\b(?:import|export)\s+(?:type\s+)?[^'"]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const re of SPECIFIER_RES) {
    for (const m of source.matchAll(re)) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

export function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  return builtins.has(spec.split("/")[0] ?? "");
}

export function isObsidian(spec: string): boolean {
  return spec === "obsidian" || spec.startsWith("obsidian/");
}

function sourceFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (name === "node_modules" || name === "@eaDir") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

export function isServerImport(spec: string, file: string): boolean {
  if (spec === "@shuttle/server" || spec.startsWith("@shuttle/server/")) return true;
  if (!spec.startsWith(".")) return false;
  const target = path.relative(packagesDir, path.resolve(path.dirname(file), spec)).split(path.sep);
  return target[0] === "server";
}

export function isWs(spec: string): boolean {
  return spec === "ws" || spec.startsWith("ws/");
}

export function violations(pkg: string, file: string, source: string): string[] {
  const rel = path.relative(packagesDir, file);
  const found: string[] = [];
  for (const spec of importSpecifiers(source)) {
    if (pkg !== "server" && isServerImport(spec, file)) found.push(`${rel}: imports "${spec}" (only server may use server code)`);
    if (isWs(spec) && WS_DENIED.has(pkg)) found.push(`${rel}: imports "${spec}" (ws is not allowed here; inject a WsFactory)`);
    if (isObsidian(spec) && !OBSIDIAN_ALLOWED.has(pkg)) found.push(`${rel}: imports "${spec}" (only plugin, spike may import obsidian)`);
    if (isNodeBuiltin(spec) && !NODE_ALLOWED.has(pkg)) found.push(`${rel}: imports "${spec}" (only headless, server, testkit, sim may import node builtins)`);
  }
  return found;
}

describe("import rules (§8.1)", () => {
  it("every package directory is known", () => {
    const dirs = readdirSync(packagesDir).filter(
      (d) => d !== "@eaDir" && statSync(path.join(packagesDir, d)).isDirectory(),
    );
    expect(dirs.sort()).toEqual([...ALL_PACKAGES].sort());
  });

  for (const pkg of ALL_PACKAGES) {
    it(`${pkg}/src follows the import rules`, () => {
      const files = sourceFiles(path.join(packagesDir, pkg, "src"));
      expect(files.length).toBeGreaterThan(0);
      const found = files.flatMap((f) => violations(pkg, f, readFileSync(f, "utf8")));
      expect(found).toEqual([]);
    });
  }

  it("the scanner catches each import form", () => {
    const src = [
      'import { Plugin } from "obsidian";',
      "import type { X } from 'node:fs';",
      'import "fs/promises";',
      'export * from "node:path";',
      'const m = await import("node:crypto");',
      'const w = require("ws");',
    ].join("\n");
    expect(importSpecifiers(src).sort()).toEqual(
      ["fs/promises", "node:crypto", "node:fs", "node:path", "obsidian", "ws"].sort(),
    );
    const v = violations("engine", path.join(packagesDir, "engine/src/x.ts"), src);
    expect(v.filter((s) => s.includes("obsidian"))).toHaveLength(1);
    expect(v.filter((s) => s.includes("node builtins"))).toHaveLength(4);
    expect(violations("plugin", path.join(packagesDir, "plugin/src/x.ts"), 'import "obsidian";')).toEqual([]);
    expect(violations("plugin", path.join(packagesDir, "plugin/src/x.ts"), 'import "node:fs";')).toHaveLength(1);
    expect(violations("server", path.join(packagesDir, "server/src/x.ts"), 'import "node:fs";')).toEqual([]);
    expect(v.filter((s) => s.includes("ws is not allowed"))).toHaveLength(1);
    const srv = 'import { startServer } from "@shuttle/server";\nimport "../../server/src/server.js";';
    expect(violations("plugin", path.join(packagesDir, "plugin/src/x.ts"), srv).filter((s) => s.includes("only server"))).toHaveLength(2);
    expect(violations("server", path.join(packagesDir, "server/src/x.ts"), 'import "./server.js";')).toEqual([]);
    expect(violations("headless", path.join(packagesDir, "headless/src/x.ts"), 'import { WebSocket } from "ws";')).toEqual([]);
    expect(violations("adapter-server", path.join(packagesDir, "adapter-server/src/x.ts"), 'import WebSocket from "ws";')).toHaveLength(1);
  });
});
