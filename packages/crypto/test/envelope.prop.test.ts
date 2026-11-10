// Property and tamper tests (§4.15 required suites 2-4).
import fc from "fast-check";
import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { RecordHeader } from "../src/aad.js";
import { b64u, fromB64u } from "../src/b64u.js";
import { toHex } from "../src/bytes.js";
import { BLOB_OVERHEAD, MAX_BLOB_SIZE } from "../src/envelope.js";
import { padIso, padme, unpadIso } from "../src/pad.js";
import { V, vectorRing, vectorSecrets } from "./helpers.js";
import { guardOutput } from "./h3.js";

// design §7.2 H3: console output is scanned for the passphrases and VMKs.
guardOutput(vectorSecrets());

const CHUNK_MAX = 4194304;
const hexN = (n: number) => fc.uint8Array({ minLength: n, maxLength: n }).map(toHex);
const headerArb: fc.Arbitrary<RecordHeader> = fc.record({
  fileId: hexN(16),
  kv: fc.constant(1),
  kind: fc.constantFrom("put" as const, "del" as const, "archive" as const),
  base: fc.option(fc.integer({ min: 0, max: 2 ** 40 }), { nil: null }),
  rc: fc.constantFrom("note" as const, "attachment" as const, "config" as const),
  blobs: fc.array(hexN(32), { maxLength: 4 }),
  pathKey: fc.uint8Array({ minLength: 16, maxLength: 16 }).map(b64u),
});
// Mostly compressible text-like chunks plus random bytes.
const chunkArb = fc.oneof(
  fc.uint8Array({ maxLength: 65536 }),
  fc.tuple(fc.string({ maxLength: 64 }), fc.integer({ min: 1, max: 800 })).map(([s, n]) => new TextEncoder().encode(s.repeat(n)).subarray(0, 65536)),
);

async function rejectsWith(p: Promise<unknown>, code: string): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return (e as { code?: string }).code === code;
  }
}

describe("blob seal/open", () => {
  it("round-trips random chunks x {compress, pad}; size bounds hold", async () => {
    const r = await vectorRing();
    await fc.assert(
      fc.asyncProperty(chunkArb, fc.boolean(), fc.boolean(), async (chunk, compress, pad) => {
        const { blobId } = await r.blobId(chunk);
        const s = await r.sealBlob(chunk, blobId, { compress, pad, chunkMax: CHUNK_MAX });
        expect(s.length).toBeLessThanOrEqual(MAX_BLOB_SIZE);
        expect(s[5]! & ~3).toBe(0);
        if (!compress) expect(s[5]! & 1).toBe(0);
        if (!pad && !(s[5]! & 1)) expect(s.length).toBe(chunk.length + BLOB_OVERHEAD);
        expect(toHex(await r.openBlob(s, blobId, chunk.length))).toBe(toHex(chunk));
      }),
      { numRuns: 150 },
    );
  });

  it("1 MiB and 4 MiB (chunkMax) chunks round-trip padded; sealed <= maxBlobSize", async () => {
    const r = await vectorRing();
    for (const n of [1048576, CHUNK_MAX]) {
      const chunk = new Uint8Array(n);
      for (let o = 0; o < n; o += 65536) globalThis.crypto.getRandomValues(chunk.subarray(o, o + 65536));
      const { blobId } = await r.blobId(chunk);
      const s = await r.sealBlob(chunk, blobId, { compress: true, pad: true, chunkMax: CHUNK_MAX });
      expect(s.length).toBeLessThanOrEqual(MAX_BLOB_SIZE);
      expect((await r.openBlob(s, blobId, n)).length).toBe(n);
    }
    await expect(r.sealBlob(new Uint8Array(CHUNK_MAX + 1), "0".repeat(64), { compress: false, pad: false, chunkMax: CHUNK_MAX })).rejects.toThrow(RangeError);
  });

  it("flipping any single byte of a sealed blob fails with BlobIntegrity (exhaustive, 4 shapes)", async () => {
    const r = await vectorRing();
    const z = new TextEncoder().encode("abc ".repeat(200));
    for (const [chunk, compress, pad] of [
      [new TextEncoder().encode("tamper me, please"), false, false],
      [new TextEncoder().encode("tamper me, please"), false, true],
      [z, true, false],
      [z, true, true],
    ] as const) {
      const { blobId } = await r.blobId(chunk);
      const s = await r.sealBlob(chunk, blobId, { compress, pad, chunkMax: CHUNK_MAX });
      for (let i = 0; i < s.length; i++) {
        const t = s.slice();
        t[i]! ^= 0x01;
        expect(await rejectsWith(r.openBlob(t, blobId, chunk.length), "BlobIntegrity"), `byte ${i}`).toBe(true);
      }
    }
  });

  it("property: random chunk, random byte, random xor mask -> BlobIntegrity", async () => {
    const r = await vectorRing();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), fc.boolean(), fc.boolean(), fc.nat(), fc.integer({ min: 1, max: 255 }), async (chunk, compress, pad, idx, mask) => {
        const { blobId } = await r.blobId(chunk);
        const s = await r.sealBlob(chunk, blobId, { compress, pad, chunkMax: CHUNK_MAX });
        const t = s.slice();
        t[idx % t.length]! ^= mask;
        expect(await rejectsWith(r.openBlob(t, blobId, chunk.length), "BlobIntegrity")).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("swapped AAD (other blobId), truncation, wrong magic, unknown kv, reserved flags, wrong size", async () => {
    const r = await vectorRing();
    const chunk = new TextEncoder().encode("hello blob");
    const { blobId } = await r.blobId(chunk);
    const other = (await r.blobId(new TextEncoder().encode("other"))).blobId;
    const s = await r.sealBlob(chunk, blobId, { compress: false, pad: false, chunkMax: CHUNK_MAX });
    const mod = (f: (t: Uint8Array) => Uint8Array | void) => {
      const t = s.slice();
      return f(t) ?? t;
    };
    const cases: [string, () => Promise<unknown>][] = [
      ["other blobId", () => r.openBlob(s, other, chunk.length)],
      ["truncated to 33", () => r.openBlob(s.subarray(0, 33), blobId, chunk.length)],
      ["truncated tag", () => r.openBlob(s.subarray(0, s.length - 1), blobId, chunk.length)],
      ["magic", () => r.openBlob(mod((t) => void (t[0] = 0x54)), blobId, chunk.length)],
      ["unknown kv", () => r.openBlob(mod((t) => void (t[4] = 9)), blobId, chunk.length)],
      ["reserved flag", () => r.openBlob(mod((t) => void (t[5] = 4)), blobId, chunk.length)],
      ["expected size", () => r.openBlob(s, blobId, chunk.length + 1)],
      ["oversize", () => r.openBlob(new Uint8Array(MAX_BLOB_SIZE + 1), blobId, chunk.length)],
    ];
    for (const [name, p] of cases) expect(await rejectsWith(p(), "BlobIntegrity"), name).toBe(true);
  });

  it("decompression bomb is capped by the expected size", async () => {
    const r = await vectorRing();
    const big = new Uint8Array(CHUNK_MAX); // zeros: deflates to a few KB
    const { blobId } = await r.blobId(big);
    const s = await r.sealBlob(big, blobId, { compress: true, pad: false, chunkMax: CHUNK_MAX });
    expect(s[5]! & 1).toBe(1);
    expect(s.length).toBeLessThan(10000);
    expect(await rejectsWith(r.openBlob(s, blobId, 1000), "BlobIntegrity")).toBe(true);
    expect((await r.openBlob(s, blobId, CHUNK_MAX)).length).toBe(CHUNK_MAX);
    expect(deflateSync(big).length).toBeLessThan(10000);
  });
});

describe("meta and inline seal/open", () => {
  const metaArb = fc.record({
    v: fc.constant(1),
    path: fc.string({ minLength: 1, maxLength: 300 }),
    type: fc.constant("file"),
    cat: fc.constantFrom(null, "app", "hotkey"),
    extra: fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(fc.integer(), fc.string({ maxLength: 20 }), fc.boolean()), { maxKeys: 4 }),
  });

  it("meta round-trips for random headers; unknown fields preserved; any header mutation fails", async () => {
    const r = await vectorRing();
    await fc.assert(
      fc.asyncProperty(headerArb, metaArb, async (h0, meta0) => {
        // sealMeta requires an NFC meta.path whose pathKey is the header's (C5).
        const meta = { ...meta0, path: meta0.path.normalize("NFC") };
        const h = { ...h0, pathKey: await r.pathKey(meta.path) };
        const ct = await r.sealMeta(meta, h);
        expect(fromB64u(ct).length % 256).toBe(28 % 256); // 12 nonce + 16 tag around a 256-multiple
        expect(await r.openMeta(ct, h)).toEqual(JSON.parse(JSON.stringify(meta)));
        const muts: Partial<RecordHeader>[] = [
          { fileId: h.fileId.replace(/^./, (c) => (c === "0" ? "1" : "0")) },
          { kind: h.kind === "put" ? "archive" : "put" },
          { base: h.base === null ? 0 : null },
          { base: h.base === null ? 1 : h.base + 1 },
          { rc: h.rc === "note" ? "config" : "note" },
          { blobs: [...h.blobs, "ab".repeat(32)] },
          { pathKey: h.pathKey.startsWith("A") ? "B" + h.pathKey.slice(1) : "A" + h.pathKey.slice(1) },
          { kv: 2 },
        ];
        if (h.blobs.length >= 2) muts.push({ blobs: [...h.blobs].reverse() }, { blobs: h.blobs.slice(1) });
        for (const m of muts) {
          if (m.blobs && m.blobs.join() === h.blobs.join()) continue;
          expect(await rejectsWith(r.openMeta(ct, { ...h, ...m }), "RecordIntegrity"), JSON.stringify(m)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("inline: any header mutation (incl. pathKey) fails", async () => {
    const r = await vectorRing();
    await fc.assert(
      fc.asyncProperty(headerArb, fc.uint8Array({ maxLength: 4096 }), fc.boolean(), fc.boolean(), async (h, body, compress, pad) => {
        const { ct, z, p } = await r.sealInline(body, h, { compress, pad });
        const muts: Partial<RecordHeader>[] = [
          { fileId: h.fileId.replace(/^./, (c) => (c === "0" ? "1" : "0")) },
          { kind: h.kind === "put" ? "archive" : "put" },
          { base: h.base === null ? 0 : null },
          { base: h.base === null ? 1 : h.base + 1 },
          { rc: h.rc === "note" ? "config" : "note" },
          { blobs: [...h.blobs, "ab".repeat(32)] },
          { pathKey: h.pathKey.startsWith("A") ? "B" + h.pathKey.slice(1) : "A" + h.pathKey.slice(1) },
          { kv: 2 },
        ];
        if (h.blobs.length >= 2) muts.push({ blobs: [...h.blobs].reverse() }, { blobs: h.blobs.slice(1) });
        for (const m of muts) {
          if (m.blobs && m.blobs.join() === h.blobs.join()) continue;
          expect(await rejectsWith(r.openInline(ct, { ...h, ...m }, z, p, body.length), "RecordIntegrity"), JSON.stringify(m)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("sealMeta refuses an NFD meta.path or a pathKey that does not match meta.path", async () => {
    const r = await vectorRing();
    const h = V.record.header as RecordHeader;
    await expect(r.sealMeta({ v: 1, path: "something/else.md", type: "file" }, h)).rejects.toThrow(/pathKey/);
    const nfd = "\u1112\u1161\u11ab.md"; // "한.md" in NFD
    await expect(r.sealMeta({ v: 1, path: nfd, type: "file" }, { ...h, pathKey: await r.pathKey(nfd) })).rejects.toThrow(/NFC/);
    await expect(r.sealMeta({ v: 1, type: "file" }, h)).rejects.toThrow(/NFC/);
  });

  it("inline round-trips x {compress, pad}; byte flips and label swap fail", async () => {
    const r = await vectorRing();
    await fc.assert(
      fc.asyncProperty(headerArb, chunkArb.map((c) => c.subarray(0, 4096)), fc.boolean(), fc.boolean(), fc.nat(), async (h, body, compress, pad, idx) => {
        const { ct, z, p } = await r.sealInline(body, h, { compress, pad });
        expect(toHex(await r.openInline(ct, h, z, p, body.length))).toBe(toHex(body));
        const raw = fromB64u(ct);
        raw[idx % raw.length]! ^= 0x80;
        expect(await rejectsWith(r.openInline(b64u(raw), h, z, p, body.length), "RecordIntegrity")).toBe(true);
        // an inline body presented as meta (other label and key) fails
        expect(await rejectsWith(r.openMeta(ct, h), "RecordIntegrity")).toBe(true);
      }),
      { numRuns: 80 },
    );
  });

  it("pathKey consistency mismatch is a warning, not an error; tombstones must not carry size/hash", async () => {
    const warnings: string[] = [];
    const { SxKeyring } = await import("../src/keyring.js");
    const { fromHex } = await import("../src/bytes.js");
    const { sealMetaRaw } = await import("../src/envelope.js");
    const r = await SxKeyring.fromVmks(V.inputs.vaultId, new Map([[1, fromHex(V.inputs.vmk1Hex)]]), 1, { onWarning: (m) => warnings.push(m) });
    const h = V.record.header as RecordHeader;
    // A mismatched record can only come from another (buggy or hostile) writer, so build it with the
    // raw sealer and K_meta(1) derived from the same VMK.
    const { hkdfAesKey, importHkdfBase } = await import("../src/suite-sx1.js");
    const base = await importHkdfBase(fromHex(V.inputs.vmk1Hex));
    const kMeta = await hkdfAesKey(base, fromHex(V.inputs.vaultIdHex), "shuttle/v1/meta");
    const ct = await sealMetaRaw(kMeta, V.inputs.vaultId, h, { v: 1, path: "something/else.md", type: "file" }, 256);
    expect((await r.openMeta(ct, h)).path).toBe("something/else.md");
    expect(warnings).toHaveLength(1);
    const tomb = { ...h, kind: "del" as const };
    expect(await rejectsWith(r.openMeta(await r.sealMeta({ v: 1, path: V.ids.path1, type: "file", size: 3 }, tomb), tomb), "RecordIntegrity")).toBe(true);
    expect(await rejectsWith(r.openMeta(await r.sealMeta({ v: 2, path: V.ids.path1, type: "file" }, h), h), "RecordIntegrity")).toBe(true);
    expect(await rejectsWith(r.openMeta(await r.sealMeta({ v: 1, path: V.ids.path1, type: "folder" }, h), h), "RecordIntegrity")).toBe(true);
    await expect(r.sealMeta({ v: 1 }, { ...h, pathKey: "has|pipe-xxxxxxxxxxxxxx" })).rejects.toThrow(/pathKey/);
  });
});

describe("padding", () => {
  it("ISO 7816-4 round-trip and malformed padding is rejected", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), fc.integer({ min: 1, max: 300 }), (pt, extra) => {
        expect(toHex(unpadIso(padIso(pt, pt.length + extra)))).toBe(toHex(pt));
        const bad = padIso(pt, pt.length + extra);
        bad[pt.length] = 0x81;
        expect(() => unpadIso(bad)).toThrow();
      }),
    );
    expect(() => unpadIso(new Uint8Array(10))).toThrow();
  });

  it("Padmé overhead <= 12 % and monotone", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 2 ** 26 }), (L) => {
        const p = padme(L);
        expect(p).toBeGreaterThanOrEqual(L);
        expect(p - L).toBeLessThanOrEqual(Math.ceil(L * 0.12));
        expect(padme(L + 1)).toBeGreaterThanOrEqual(p);
      }),
    );
  });
});
