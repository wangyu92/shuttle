// FakeKeyring: the protocol Keyring contract without real crypto (fast, deterministic).
import { describe, expect, it } from "vitest";
import { SxKeyring } from "@shuttle/crypto";
import type { Keyring, RecordHeader } from "@shuttle/protocol";
import { isBlobId, isPathKey, isB64u } from "@shuttle/protocol";
import { FakeKeyring, Prng, TestIds } from "../src/index";

type Assignable<A, B> = [A] extends [B] ? true : false;
const yes = <T extends true>(): T => true as T;
yes<Assignable<FakeKeyring, Keyring>>();

const ids = new TestIds("fake-keyring");
const vaultId = ids.vaultId();

function header(o: Partial<RecordHeader> = {}): RecordHeader {
  return { fileId: "a".repeat(32), kv: 1, kind: "put", base: null, rc: "note", blobs: [], pathKey: "", ...o };
}

describe("FakeKeyring", () => {
  it("ids have the wire formats and are deterministic per vault and secret", async () => {
    const k = new FakeKeyring({ vaultId });
    const k2 = new FakeKeyring({ vaultId });
    const other = new FakeKeyring({ vaultId, secret: "other" });
    const pk = await k.pathKey("Notes/Ä.md");
    expect(isPathKey(pk)).toBe(true);
    expect(pk).toBe(await k2.pathKey("notes/ä.md".normalize("NFD")));
    expect(pk).not.toBe(await other.pathKey("Notes/Ä.md"));
    const { blobId } = await k.blobId(new Uint8Array([1, 2, 3]));
    expect(isBlobId(blobId)).toBe(true);
    expect((await k2.blobId(new Uint8Array([1, 2, 3]))).blobId).toBe(blobId);
    expect(await k.gearTable()).toEqual(await k2.gearTable());
    expect((await k.gearTable()).length).toBe(256);
  });

  it("blobs, metas and inline bodies round-trip and fail closed on tampering, wrong header or wrong key", async () => {
    const k = new FakeKeyring({ vaultId });
    const chunk = new Prng("c").bytes(5000);
    const { blobId } = await k.blobId(chunk);
    const sealed = await k.sealBlob(chunk, blobId, { compress: true, pad: true, chunkMax: 1 << 22 });
    expect(await k.openBlob(sealed, blobId, chunk.length)).toEqual(chunk);
    const bad = sealed.slice();
    bad[100] = (bad[100] as number) ^ 1;
    await expect(k.openBlob(bad, blobId, chunk.length)).rejects.toMatchObject({ name: "CryptoError", code: "BlobIntegrity" });
    await expect(k.openBlob(sealed, blobId, chunk.length - 1)).rejects.toMatchObject({ code: "BlobIntegrity" });
    await expect(new FakeKeyring({ vaultId, kvs: [2] }).openBlob(sealed, blobId, chunk.length)).rejects.toMatchObject({ code: "BlobIntegrity" });

    const pathKey = await k.pathKey("a.md");
    const h = header({ pathKey });
    const meta = await k.sealMeta({ path: "a.md", size: 3, mtime: 1 }, h);
    expect(isB64u(meta)).toBe(true);
    expect(await k.openMeta(meta, h)).toEqual({ path: "a.md", size: 3, mtime: 1 });
    await expect(k.openMeta(meta, { ...h, base: 7 })).rejects.toMatchObject({ code: "RecordIntegrity" });
    await expect(new FakeKeyring({ vaultId, secret: "x" }).openMeta(meta, h)).rejects.toMatchObject({ code: "RecordIntegrity" });
    await expect(k.sealMeta({ path: "b.md" }, h)).rejects.toThrow(/pathKey/);
    await expect(k.sealMeta({ path: "a.md" }, { ...h, kv: 2 })).rejects.toThrow(/active kv/);

    const body = new TextEncoder().encode("inline body");
    const r = await k.sealInline(body, h, { compress: true, pad: true });
    expect(await k.openInline(r.ct, h, r.z, r.p, body.length)).toEqual(body);
    await expect(k.openInline(r.ct, { ...h, kind: "archive" }, r.z, r.p, body.length)).rejects.toMatchObject({ code: "RecordIntegrity" });
  });

  it("vault-info MAC verifies only with the same keys; rotation keeps old kvs readable", async () => {
    const k = new FakeKeyring({ vaultId });
    const info = ids.vaultInfo({ vaultId });
    const { infoMac: _m, ...unsigned } = info;
    info.infoMac = await k.macVaultInfo(unsigned as Parameters<Keyring["macVaultInfo"]>[0]);
    expect(await k.verifyVaultInfo(info)).toBe(true);
    expect(await k.verifyVaultInfo({ ...info, infoRev: info.infoRev + 1 })).toBe(false);
    expect(await new FakeKeyring({ vaultId, secret: "x" }).verifyVaultInfo(info)).toBe(false);
    const rotated = k.withKeys([1, 2]);
    expect(rotated.activeKv).toBe(2);
    const pk = await k.pathKey("a.md");
    const meta = await k.sealMeta({ path: "a.md" }, header({ pathKey: pk }));
    expect(await rotated.openMeta(meta, header({ pathKey: pk }))).toEqual({ path: "a.md" });
    expect(await k.macManifest({ kv: 1, seq: 3 })).toBe(await k.withKeys([1]).macManifest({ kv: 1, seq: 3 }));
  });

  it("is much faster than the real keyring on the hot path", async () => {
    const real = await SxKeyring.fromVmks(vaultId, new Map([[1, new Uint8Array(32).fill(7)]]), 1);
    const fake = new FakeKeyring({ vaultId });
    const chunks = Array.from({ length: 300 }, (_, i) => new Prng(`p${i}`).bytes(2048));
    const time = async (k: Keyring) => {
      const t = performance.now();
      for (const c of chunks) {
        const { blobId } = await k.blobId(c);
        const s = await k.sealBlob(c, blobId, { compress: true, pad: false, chunkMax: 1 << 22 });
        await k.openBlob(s, blobId, c.length);
      }
      return performance.now() - t;
    };
    const tf = await time(fake);
    const tr = await time(real);
    expect(tf).toBeLessThan(tr);
  });
});
