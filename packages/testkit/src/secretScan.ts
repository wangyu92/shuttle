// Secret scanner for test output (design §7.2 H3: logs, status, debug output and crash dumps must not
// contain the test token, passphrase or key bytes in base64 or hex). Pure: no I/O.
// Hits name the secret and the encoding but never echo the secret itself.

export type SecretValue = string | Uint8Array;
export interface NamedSecret { name: string; value: SecretValue }
export type SecretInput = SecretValue | NamedSecret;

export type SecretEncoding =
  | 'raw' | 'json' | 'uri' | 'utf8-hex' | 'utf8-HEX' | 'utf8-base64' | 'utf8-base64url'
  | 'hex' | 'HEX' | 'base64' | 'base64url';

export interface SecretHit { secret: string; encoding: SecretEncoding; source: string; offset: number }

/** Secrets shorter than this produce false positives and are rejected. */
export const MIN_SECRET_LENGTH = 6;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const x = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(x >>> 18) & 63];
    s += B64[(x >>> 12) & 63];
    s += i + 1 < b.length ? B64[(x >>> 6) & 63] : "=";
    s += i + 2 < b.length ? B64[x & 63] : "=";
  }
  return s;
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Every encoded form a secret is searched in. */
export function secretForms(value: SecretValue): Array<{ encoding: SecretEncoding; text: string }> {
  const out: Array<{ encoding: SecretEncoding; text: string }> = [];
  const add = (encoding: SecretEncoding, text: string): void => {
    if (text.length >= MIN_SECRET_LENGTH && !out.some((f) => f.text === text)) out.push({ encoding, text });
  };
  const bytesForms = (b: Uint8Array, prefix: '' | 'utf8-'): void => {
    const b64 = base64(b);
    const unpadded = b64.replace(/=+$/, "");
    add(`${prefix}hex` as SecretEncoding, hex(b));
    add(`${prefix}HEX` as SecretEncoding, hex(b).toUpperCase());
    add(`${prefix}base64` as SecretEncoding, unpadded);   // padded form contains the unpadded one
    add(`${prefix}base64url` as SecretEncoding, unpadded.replace(/\+/g, "-").replace(/\//g, "_"));
  };
  if (typeof value === "string") {
    add("raw", value);
    add("json", JSON.stringify(value).slice(1, -1));
    add("uri", encodeURIComponent(value));
    bytesForms(new TextEncoder().encode(value), "utf8-");
  } else {
    bytesForms(value, "");
  }
  return out;
}

function normalize(s: SecretInput, i: number): NamedSecret {
  if (typeof s === "string" || s instanceof Uint8Array) return { name: `secret#${i + 1}`, value: s };
  return s;
}

/**
 * Scan `texts` (a string, or source name → string) for every secret in every encoding.
 * Throws if a secret is too short to scan for reliably.
 */
export function secretScan(texts: string | Record<string, string>, secrets: readonly SecretInput[]): SecretHit[] {
  const sources = typeof texts === "string" ? { output: texts } : texts;
  const hits: SecretHit[] = [];
  secrets.map(normalize).forEach((s) => {
    const len = typeof s.value === "string" ? s.value.length : s.value.length * 2;
    if (len < MIN_SECRET_LENGTH) throw new Error(`secretScan: ${s.name} is too short to scan for`);
    const forms = secretForms(s.value);
    for (const [source, text] of Object.entries(sources)) {
      for (const f of forms) {
        const at = text.indexOf(f.text);
        if (at >= 0) hits.push({ secret: s.name, encoding: f.encoding, source, offset: at });
      }
    }
  });
  return hits;
}

/** Throw if any secret appears (for `afterAll` in every suite, design §7.2 H3). */
export function assertNoSecrets(texts: string | Record<string, string>, secrets: readonly SecretInput[]): void {
  const hits = secretScan(texts, secrets);
  if (hits.length > 0) {
    throw new Error(`secrets found in output: ${hits.map((h) => `${h.secret} as ${h.encoding} in ${h.source} at ${h.offset}`).join("; ")}`);
  }
}

/** Collects everything written through it (stand-in for stdout, a log sink or a crash dump). */
export class OutputCapture {
  private parts: string[] = [];
  write = (chunk: unknown): void => {
    this.parts.push(typeof chunk === "string" ? chunk : JSON.stringify(chunk) ?? String(chunk));
  };
  get text(): string {
    return this.parts.join("\n");
  }
  clear(): void {
    this.parts = [];
  }
}
