// Server address input (design §5.5.3, §4.10.3). Pure; no regex lookbehind.
//
// P0 bug (docs/p0-results.md): an address typed without a scheme failed with "unsupported URL". The
// wizard now adds https:// when no scheme is present and validates the result.

export type UrlCheck =
  | { ok: true; url: string; insecure: boolean; host: string }
  | { ok: false; error: "empty" | "invalid" | "scheme" | "httpNotAllowed" | "query" };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** True for hosts where plain http is acceptable when the user allows it (design §4.10.3). */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return false;
    const [a, b] = [o[0] ?? 0, o[1] ?? 0];
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                           // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true;    // RFC 1918
    if (a === 192 && b === 168) return true;             // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT, Tailscale)
    return false;
  }
  if (h.includes(":")) return false;                     // other IPv6 literals: not exempt
  // Single-label names (a Docker service name). `*.ts.net` is not exempt: it has real certificates.
  return h.length > 0 && !h.includes(".");
}

/**
 * Normalize a typed server address: trim, add `https://` when no scheme was typed, require http(s),
 * reject query and fragment, strip trailing slashes. `http://` passes only with `allowHttp` and a
 * private host (design §4.10.3); loopback is always allowed (the adapter allows it too).
 */
export function normalizeServerUrl(input: string, opts: { allowHttp: boolean }): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "empty" };
  const withScheme = SCHEME.test(raw) ? raw : "https://" + raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "scheme" };
  if (!u.hostname) return { ok: false, error: "invalid" };
  if (u.search || u.hash) return { ok: false, error: "query" };
  if (u.username || u.password) return { ok: false, error: "invalid" };
  const insecure = u.protocol === "http:";
  if (insecure) {
    const loopback = isLoopback(u.hostname);
    if (!loopback && !(opts.allowHttp && isPrivateHost(u.hostname))) return { ok: false, error: "httpNotAllowed" };
  }
  let s = u.origin + u.pathname;
  while (s.endsWith("/")) s = s.slice(0, -1);
  return { ok: true, url: s, insecure, host: u.host };
}

export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Default endpoint label (design §5.5.3): "Private network" for private ranges, "Public" otherwise. */
export function defaultEndpointLabel(url: string): string {
  try {
    return isPrivateHost(new URL(url).hostname) ? "Private network" : "Public";
  } catch {
    return "Public";
  }
}

/** `host[:port]` of a URL for display (no credentials, no path). */
export function hostLabel(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
