// The production vault is never touched by development (design §7.8).
//
// design §7.8 lists literal production prefixes. This repository is public, so no real host paths are
// written here: the protected prefixes are read at runtime from
//   - SHUTTLE_PROD_PREFIXES (path-list separated by ':'), and
//   - the file named by SHUTTLE_PROD_PREFIXES_FILE (one prefix per line, '#' comments),
// plus one built-in, host-independent prefix: `$HOME/Obsidian` (the user's vaults live there; tests and
// development never need it). A vault, state or temp path whose realpath starts with a protected prefix
// is refused (exit 9) unless SHUTTLE_PROD=1. With SHUTTLE_PROD=1, a loopback or dev-port server URL is
// refused (design §7.8 item 2).

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXIT_PROD_GUARD = 9;
/** Dev server port (design §7.8 item 4). */
export const DEV_PORT = 8788;

export class ProdGuardError extends Error {
  readonly exitCode = EXIT_PROD_GUARD;
  constructor(message: string) {
    super(message);
    this.name = "ProdGuardError";
  }
}

export interface ProdGuardEnv {
  SHUTTLE_PROD?: string | undefined;
  SHUTTLE_PROD_PREFIXES?: string | undefined;
  SHUTTLE_PROD_PREFIXES_FILE?: string | undefined;
  HOME?: string | undefined;
}

/** Resolve symlinks of the longest existing ancestor, then re-append the rest. */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function protectedPrefixes(env: ProdGuardEnv = process.env): string[] {
  const out = new Set<string>();
  let home = env.HOME;
  if (home === undefined) {
    try { home = os.homedir(); } catch { home = undefined; }   // a container uid without a passwd entry
  }
  if (home) out.add(path.join(home, "Obsidian"));
  for (const p of (env.SHUTTLE_PROD_PREFIXES ?? "").split(":")) if (p.trim()) out.add(p.trim());
  if (env.SHUTTLE_PROD_PREFIXES_FILE) {
    let text = "";
    try {
      text = readFileSync(env.SHUTTLE_PROD_PREFIXES_FILE, "utf8");
    } catch {
      // A configured but unreadable list fails closed: everything outside the temp roots is suspect.
      throw new ProdGuardError(`prodGuard: cannot read SHUTTLE_PROD_PREFIXES_FILE`);
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) out.add(t);
    }
  }
  // Compare both the literal prefix and its realpath (aliases such as /var/services → /volume1).
  const all = new Set<string>();
  for (const p of out) {
    all.add(path.resolve(p));
    all.add(realpathLoose(p));
  }
  return [...all];
}

function under(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix.endsWith(path.sep) ? prefix : prefix + path.sep);
}

/** Throws ProdGuardError when any path is protected and SHUTTLE_PROD !== '1'. */
export function checkPaths(paths: readonly string[], env: ProdGuardEnv = process.env): void {
  if (env.SHUTTLE_PROD === "1") return;
  const prefixes = protectedPrefixes(env);
  for (const raw of paths) {
    const candidates = [path.resolve(raw), realpathLoose(raw)];
    for (const c of candidates) {
      const hit = prefixes.find((pre) => under(c, pre));
      if (hit) throw new ProdGuardError(`prodGuard: ${c} is a production path; refusing without SHUTTLE_PROD=1`);
    }
  }
}

/** With SHUTTLE_PROD=1, refuse loopback hosts and the dev port (design §7.8 item 2). */
export function checkServerUrls(urls: readonly string[], env: ProdGuardEnv = process.env): void {
  if (env.SHUTTLE_PROD !== "1") return;
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw new ProdGuardError(`prodGuard: invalid server URL`);
    }
    const h = url.hostname.replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1" || h.startsWith("127.") || url.port === String(DEV_PORT)) {
      throw new ProdGuardError(`prodGuard: SHUTTLE_PROD=1 with a development server URL (${url.host})`);
    }
  }
}
