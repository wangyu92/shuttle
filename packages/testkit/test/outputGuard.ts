// design §7.2 H3 (no secrets in output): a suite that handles keys, tokens or passwords captures what
// it prints and scans it in afterAll. Captured: console.log/info/warn/error/debug of the test file,
// plus anything a test routes through guardLog (server logs, client logs). Cheap on purpose: one
// indexOf per secret encoding over a small text, once per file.
import { afterAll } from "vitest";
import { MIN_SECRET_LENGTH, OutputCapture, assertNoSecrets, type SecretInput } from "../src/secretScan";

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
type Method = (typeof METHODS)[number];

export interface OutputGuard {
  /** Add secrets found at run time (a token returned by login, a generated key). */
  add(...secrets: SecretInput[]): void;
  /** Record one more chunk of output (a log line). */
  write(chunk: unknown): void;
  readonly text: string;
  /** Throws if any secret is in the captured output; the message never contains a secret. */
  check(): void;
  /** Put the console back. */
  uninstall(): void;
}

/** Guards created in this module instance that are still installed (one per test file). */
const active = new Set<OutputGuard>();

function lengthOf(s: SecretInput): number {
  const v = typeof s === "string" || s instanceof Uint8Array ? s : s.value;
  return typeof v === "string" ? v.length : v.length * 2;
}

function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
  try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
}

/** A guard without test hooks (tests of the guard itself). */
export function createOutputGuard(initial: readonly SecretInput[] = []): OutputGuard {
  const capture = new OutputCapture();
  const secrets: SecretInput[] = [];
  const saved = new Map<Method, (...args: unknown[]) => void>();
  const g: OutputGuard = {
    add(...more) {
      // Shorter values cannot be scanned for reliably (secretScan refuses them); test tokens are longer.
      for (const s of more) if (lengthOf(s) >= MIN_SECRET_LENGTH && !secrets.includes(s)) secrets.push(s);
    },
    write: (chunk) => capture.write(chunk),
    get text() { return capture.text; },
    check() { assertNoSecrets(capture.text, secrets); },
    uninstall() {
      for (const [m, f] of saved) console[m] = f;
      saved.clear();
      active.delete(g);
    },
  };
  g.add(...initial);
  for (const m of METHODS) {
    const orig = console[m] as (...args: unknown[]) => void;
    saved.set(m, orig);
    console[m] = (...args: unknown[]) => {
      capture.write(args.map(fmt).join(" "));
      orig.apply(console, args);
    };
  }
  active.add(g);
  return g;
}

/** Install a guard for this test file and scan its output in afterAll (design §7.2 H3). */
export function guardOutput(...initial: SecretInput[]): OutputGuard {
  const g = createOutputGuard(initial);
  afterAll(() => {
    g.uninstall();
    g.check();
  });
  return g;
}

/** Register secrets with every installed guard (no-op when the importing suite has none). */
export function noteSecret(...secrets: SecretInput[]): void {
  for (const g of active) g.add(...secrets);
}

/** Route one log line into every installed guard (no-op when none is installed). */
export function guardLog(line: string): void {
  for (const g of active) g.write(line);
}
