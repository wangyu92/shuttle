// Pure helpers: server URL input (P0 bug), enrollment codes, redaction, platform defaults, i18n.
import { describe, expect, it } from "vitest";
import { normalizeServerUrl, isPrivateHost, defaultEndpointLabel } from "../src/util/url";
import { normalizeEnrollCode, parseEnrollLink, parseSetupInput, fromParams } from "../src/util/enrollCode";
import { assertNoSecrets, redact, shortId } from "../src/util/redact";
import { defaultDeviceName, localPlatform, caseInsensitive, type PlatformInfo } from "../src/util/platformInfo";
import { t } from "../src/i18n";

const P = (o: Partial<PlatformInfo>): PlatformInfo => ({ isIos: false, isAndroid: false, isMobile: false, isTablet: false, isMacOS: false, isWin: false, isLinux: false, ...o });

describe("normalizeServerUrl", () => {
  it("adds https:// when the scheme is missing (P0 bug)", () => {
    expect(normalizeServerUrl("sync.example.com", { allowHttp: false })).toEqual({ ok: true, url: "https://sync.example.com", insecure: false, host: "sync.example.com" });
    expect(normalizeServerUrl("  sync.example.com:6984/ ", { allowHttp: false })).toMatchObject({ ok: true, url: "https://sync.example.com:6984" });
    expect(normalizeServerUrl("sync.example.com/base//", { allowHttp: false })).toMatchObject({ ok: true, url: "https://sync.example.com/base" });
  });
  it("keeps an explicit https:// and strips trailing slashes", () => {
    expect(normalizeServerUrl("HTTPS://Sync.Example.com/", { allowHttp: false })).toMatchObject({ ok: true, url: "https://sync.example.com" });
  });
  it("accepts http:// only for private hosts with the toggle on, and loopback always", () => {
    expect(normalizeServerUrl("http://sync.example.com", { allowHttp: true })).toEqual({ ok: false, error: "httpNotAllowed" });
    expect(normalizeServerUrl("http://192.168.1.5:8787", { allowHttp: false })).toEqual({ ok: false, error: "httpNotAllowed" });
    expect(normalizeServerUrl("http://192.168.1.5:8787", { allowHttp: true })).toMatchObject({ ok: true, insecure: true });
    expect(normalizeServerUrl("http://127.0.0.1:8787", { allowHttp: false })).toMatchObject({ ok: true, insecure: true });
    expect(normalizeServerUrl("http://shuttle-server:8787", { allowHttp: true })).toMatchObject({ ok: true });
  });
  it("rejects other schemes, queries, credentials and garbage", () => {
    expect(normalizeServerUrl("", { allowHttp: false })).toEqual({ ok: false, error: "empty" });
    expect(normalizeServerUrl("ftp://sync.example.com", { allowHttp: false })).toEqual({ ok: false, error: "scheme" });
    expect(normalizeServerUrl("https://sync.example.com/?x=1", { allowHttp: false })).toEqual({ ok: false, error: "query" });
    expect(normalizeServerUrl("https://alice:pw@sync.example.com", { allowHttp: false })).toEqual({ ok: false, error: "invalid" });
    expect(normalizeServerUrl("https://exa mple.com", { allowHttp: false })).toEqual({ ok: false, error: "invalid" });
  });
  it("classifies private ranges per design §4.10.3", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.255.254", "localhost", "nas", "[::1]"]) expect(isPrivateHost(h)).toBe(true);
    for (const h of ["172.32.0.1", "100.128.0.1", "8.8.8.8", "sync.example.com", "x.ts.net", "[2001:db8::1]", "300.1.1.1"]) expect(isPrivateHost(h)).toBe(false);
    expect(defaultEndpointLabel("http://100.64.1.2:8787")).toBe("Private network");
    expect(defaultEndpointLabel("https://sync.example.com")).toBe("Public");
  });
});

describe("enrollment codes and links", () => {
  it("normalizes Crockford aliases, case, dashes and spaces", () => {
    expect(normalizeEnrollCode("sxe-abcd-efgh-jkmn-pqrs-tvwx")).toBe("SXE-ABCD-EFGH-JKMN-PQRS-TVWX");
    expect(normalizeEnrollCode("ABCDOILEFGHJKMNPQRST")).toBe("SXE-ABCD-011E-FGHJ-KMNP-QRST");
    expect(normalizeEnrollCode("SXE ABCD EFGH JKMN PQRS TVWX")).toBe("SXE-ABCD-EFGH-JKMN-PQRS-TVWX");
    expect(normalizeEnrollCode("SXE-ABCD")).toBeNull();
    expect(normalizeEnrollCode("SXE-ABCD-EFGH-JKMN-PQRS-TVWU")).toBeNull(); // U is not Crockford
  });
  it("parses setup links and bare codes", () => {
    const link = "obsidian://shuttle-enroll?server=https%3A%2F%2Fsync.example.com&code=SXE-ABCD-EFGH-JKMN-PQRS-TVWX";
    expect(parseEnrollLink(link)).toEqual({ server: "https://sync.example.com", code: "SXE-ABCD-EFGH-JKMN-PQRS-TVWX", vault: null });
    expect(parseSetupInput(" abcd-efgh-jkmn-pqrs-tvwx ")).toEqual({ server: null, code: "SXE-ABCD-EFGH-JKMN-PQRS-TVWX", vault: null });
    expect(parseSetupInput("hello")).toBeNull();
    expect(fromParams({ action: "shuttle-enroll", server: "https://sync.example.com", code: "bad" })).toEqual({ server: "https://sync.example.com", code: null, vault: null });
  });
});

describe("redaction and the data.json guard", () => {
  it("redacts tokens, codes and auth headers", () => {
    const tok = "sxd_" + "A".repeat(43);
    const s = redact(`token ${tok} code SXE-ABCD-EFGH-JKMN-PQRS-TVWX Authorization: Bearer abc.def`);
    expect(s).not.toContain(tok);
    expect(s).not.toContain("SXE-ABCD");
    expect(s).not.toContain("abc.def");
    expect(redact("pass hunter2hunter2 here", ["hunter2hunter2"])).toBe("pass [redacted] here");
    expect(shortId("q3mYabcdefW1A")).toBe("q3mY…W1A");
  });
  it("refuses to save secret-looking values", () => {
    expect(() => assertNoSecrets({ schema: 1 })).not.toThrow();
    expect(() => assertNoSecrets({ t: "sxd_abc" })).toThrow();
    expect(() => assertNoSecrets({ a: { passphrase: "x" } })).toThrow();
    expect(() => assertNoSecrets({ k: "A".repeat(43) })).toThrow();
    expect(() => assertNoSecrets({ fingerprint: "A".repeat(43) }, ["fingerprint"])).not.toThrow();
  });
});

describe("platform defaults (design UX-D2, §3.2)", () => {
  it("names devices and picks the LocalFs platform", () => {
    expect(defaultDeviceName(P({ isIos: true }))).toBe("iPhone");
    expect(defaultDeviceName(P({ isIos: true, isTablet: true }))).toBe("iPad");
    expect(defaultDeviceName(P({ isAndroid: true }))).toBe("Android phone");
    expect(defaultDeviceName(P({ isMacOS: true }))).toBe("Mac");
    expect(defaultDeviceName(P({ isWin: true }))).toBe("Windows PC");
    expect(localPlatform(P({ isAndroid: true }))).toBe("android");
    expect(caseInsensitive(P({ isAndroid: true }))).toBe(false);
    expect(caseInsensitive(P({ isIos: true }))).toBe(true);
  });
});

describe("i18n", () => {
  it("fills placeholders and shows unknown keys", () => {
    expect(t("wiz.step", { n: 2, total: 4 })).toBe("Step 2 of 4");
    expect(t("no.such.key", { a: 1 })).toBe("no.such.key (a=1)");
  });
});
