// Enrollment codes and setup links (design §2.8.4, §5.5.2, §5.5.3). Pure.

import { ENROLL_CODE_PREFIX, ENROLL_URI_ACTION } from "@shuttle/protocol";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 20;

/**
 * Canonical `SXE-XXXX-XXXX-XXXX-XXXX-XXXX` form of a typed code: uppercase, prefix and dashes and
 * spaces optional, Crockford aliases folded (O→0, I/L→1). Null when malformed.
 */
export function normalizeEnrollCode(input: string): string | null {
  let s = input.trim().toUpperCase().replace(/[\s-]/g, "");
  const bare = ENROLL_CODE_PREFIX.replace("-", "");
  if (s.startsWith(bare)) s = s.slice(bare.length);
  let out = "";
  for (const c of s) {
    const f = c === "O" ? "0" : c === "I" || c === "L" ? "1" : c;
    if (!CROCKFORD.includes(f)) return null;
    out += f;
  }
  if (out.length !== CODE_CHARS) return null;
  const groups: string[] = [];
  for (let i = 0; i < out.length; i += 4) groups.push(out.slice(i, i + 4));
  return ENROLL_CODE_PREFIX + groups.join("-");
}

export interface EnrollLink { server: string | null; code: string | null; vault: string | null }

/** Parse `obsidian://shuttle-enroll?server=…&code=…[&vault=…]`. Null when it is not such a link. */
export function parseEnrollLink(text: string): EnrollLink | null {
  const t = text.trim();
  const prefix = `obsidian://${ENROLL_URI_ACTION}?`;
  if (!t.startsWith(prefix)) return null;
  const q = new URLSearchParams(t.slice(prefix.length));
  return fromParams({ server: q.get("server"), code: q.get("code"), vault: q.get("vault") });
}

/** Protocol-handler parameters (Obsidian passes the query as an object). */
export function fromParams(p: Record<string, string | null | undefined>): EnrollLink {
  const code = p["code"] ? normalizeEnrollCode(p["code"]) : null;
  return { server: p["server"] ? p["server"] : null, code, vault: p["vault"] ? p["vault"] : null };
}

/** "I have a setup link or code" (design §5.5.2): either a link or a bare code. */
export function parseSetupInput(text: string): EnrollLink | null {
  const link = parseEnrollLink(text);
  if (link) return link;
  const code = normalizeEnrollCode(text);
  return code ? { server: null, code, vault: null } : null;
}
