// One redact() for log, debug info and notices (design §4.10.1). No lookbehind (iOS < 16.4).

const PATTERNS: RegExp[] = [
  /sxd_[A-Za-z0-9_-]{20,}/g,                  // device tokens
  /SXE-[0-9A-Z-]{16,}/g,                      // enrollment codes
  /Authorization:\s*\S+(\s+\S+)?/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /Signature=[0-9a-fA-F]+/g,
  /X-Amz-Credential=[^&\s]+/gi,
];

/** Replace secrets with `[redacted]`. `extra` are exact values known to be secret (keys, passwords). */
export function redact(text: string, extra: readonly string[] = []): string {
  let s = text;
  for (const re of PATTERNS) s = s.replace(re, "[redacted]");
  for (const x of extra) if (x && x.length >= 8) s = s.split(x).join("[redacted]");
  return s;
}

/** First 4 and last 3 characters of an id (design §5.4.3 debug info). */
export function shortId(id: string | null | undefined): string {
  if (!id) return "-";
  if (id.length <= 8) return id.slice(0, 2) + "…";
  return `${id.slice(0, 4)}…${id.slice(-3)}`;
}

const SUSPECT_VALUE = /^(sxd_|SXE-)|secret|passphrase|vmk/i;
const B64U_LONG = /^[A-Za-z0-9_-]{43,}$/;

/**
 * data.json guard (design §4.10.1): throws when any value looks like a secret, or is a long b64u
 * string under a key other than the allowed ones.
 */
export function assertNoSecrets(value: unknown, allowedLongKeys: readonly string[] = [], path = "$"): void {
  if (typeof value === "string") {
    const key = path.slice(path.lastIndexOf(".") + 1);
    if (SUSPECT_VALUE.test(value)) throw new Error(`refusing to save a secret-looking value at ${path}`);
    if (B64U_LONG.test(value) && !allowedLongKeys.includes(key)) throw new Error(`refusing to save key-like material at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, allowedLongKeys, `${path}.${i}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SUSPECT_VALUE.test(k)) throw new Error(`refusing to save a secret-looking key at ${path}.${k}`);
      assertNoSecrets(v, allowedLongKeys, `${path}.${k}`);
    }
  }
}
