// design §7.2 H3 (no secrets in output) for a package that cannot import @shuttle/testkit (testkit
// depends on this package). A minimal copy of testkit's secretScan: the console of the test file is
// captured and scanned in afterAll for each secret as raw text and as hex / base64 / base64url of its
// bytes. The failure message names the secret, never its value. h3.setup.ts (the project's setupFiles
// entry) installs the capture for every test file; suites only register their secrets.
import { afterAll } from "vitest";

export interface Secret { name: string; value: string | Uint8Array }

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
const MIN_LENGTH = 6;

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function base64(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/=+$/, "");
}

function forms(v: string | Uint8Array): Array<[string, string]> {
  const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
  const b64 = base64(bytes);
  const out: Array<[string, string]> = [
    ["hex", hex(bytes)], ["HEX", hex(bytes).toUpperCase()], ["base64", b64], ["base64url", b64.replace(/\+/g, "-").replace(/\//g, "_")],
  ];
  if (typeof v === "string") out.unshift(["raw", v], ["json", JSON.stringify(v).slice(1, -1)]);
  return out.filter(([, t]) => t.length >= MIN_LENGTH);
}

function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
  try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
}

interface FileGuard { parts: string[]; secrets: Secret[] }

/** The capture installed for the current test file by h3.setup.ts (the project's setupFiles entry). */
let fileGuard: FileGuard | null = null;

function install(secrets: readonly Secret[]): FileGuard {
  const g: FileGuard = { parts: [], secrets: [...secrets] };
  const saved = METHODS.map((m) => [m, console[m]] as const);
  for (const m of METHODS) {
    const orig = console[m] as (...args: unknown[]) => void;
    console[m] = (...args: unknown[]) => { g.parts.push(args.map(fmt).join(" ")); orig.apply(console, args); };
  }
  afterAll(() => {
    for (const [m, f] of saved) console[m] = f;
    if (fileGuard === g) fileGuard = null;
    const text = g.parts.join("\n");
    const hits: string[] = [];
    for (const s of g.secrets) for (const [enc, t] of forms(s.value)) if (text.includes(t)) hits.push(`${s.name} as ${enc}`);
    if (hits.length > 0) throw new Error(`secrets found in output: ${hits.join("; ")}`);
  });
  return g;
}

/** Called once from h3.setup.ts: every test file's console is captured and scanned in afterAll. */
export function installFileGuard(secrets: readonly Secret[] = []): void {
  fileGuard = install(secrets);
}

/** Register this file's secrets (with the setup guard; without it, a capture is installed here). */
export function guardOutput(secrets: readonly Secret[]): void {
  if (fileGuard) fileGuard.secrets.push(...secrets);
  else install(secrets);
}

/** True when the setup file installed this file's guard (test of the setup itself). */
export function hasFileGuard(): boolean {
  return fileGuard !== null;
}
