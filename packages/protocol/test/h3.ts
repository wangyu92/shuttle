// design §7.2 H3 (no secrets in output) for a package that cannot import @shuttle/testkit (testkit
// depends on this package). A minimal copy of testkit's secretScan: the console of the test file is
// captured and scanned in afterAll for each secret as raw text and as hex / base64 / base64url of its
// bytes. The failure message names the secret, never its value.
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

/** Capture this file's console and fail afterAll if any secret was printed. */
export function guardOutput(secrets: readonly Secret[]): void {
  const parts: string[] = [];
  const saved = METHODS.map((m) => [m, console[m]] as const);
  for (const m of METHODS) {
    const orig = console[m] as (...args: unknown[]) => void;
    console[m] = (...args: unknown[]) => { parts.push(args.map(fmt).join(" ")); orig.apply(console, args); };
  }
  afterAll(() => {
    for (const [m, f] of saved) console[m] = f;
    const text = parts.join("\n");
    const hits: string[] = [];
    for (const s of secrets) for (const [enc, t] of forms(s.value)) if (text.includes(t)) hits.push(`${s.name} as ${enc}`);
    if (hits.length > 0) throw new Error(`secrets found in output: ${hits.join("; ")}`);
  });
}
