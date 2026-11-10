// Lifecycle, rollback and replay (§4.15 required suites 5-6) and vault-info validation order.
import { describe, expect, it } from "vitest";
import { type CachedSecrets, type VaultInfo } from "../src/index.js";
import { changePassphrase, checkRecordFreshness, createVault, fromCache, markRebuild, rotateKey, unlock } from "../src/vault-info.js";
import type { SxKeyring } from "../src/keyring.js";
import { vectorSecrets } from "./helpers.js";
import { guardOutput } from "./h3.js";

const PASS = "correct horse battery staple";
// design §7.2 H3: console output is scanned for the passphrases and VMKs.
guardOutput([...vectorSecrets(), ...[PASS, "a brand new passphrase", "rotated passphrase here"].map((value, i) => ({ name: `passphrase ${i + 1}`, value }))]);
const kdf = { iter: 310000 }; // the floor, to keep the suite fast
const h = (kv: number) => ({ fileId: "00112233445566778899aabbccddeeff", kv, kind: "put" as const, base: 1, rc: "note" as const, blobs: [], pathKey: "u-4AmhZQy1GvDCVXociBXw" });

async function remac(ring: SxKeyring, info: VaultInfo, change: Partial<VaultInfo>): Promise<VaultInfo> {
  const { infoMac: _m, ...rest } = { ...info, ...change };
  return { ...rest, infoMac: await ring.macVaultInfo(rest) } as VaultInfo;
}

describe("vault lifecycle", () => {
  it("create -> unlock -> passphrase change (cached device keeps working) -> rotate (other device Locked) -> unlock reads kv1 and kv2", async () => {
    const created = await createVault(PASS, { kdf });
    const info1 = created.info;
    expect(info1.infoRev).toBe(1);
    expect(info1.keys[0]!.status).toBe("active");
    expect(info1.vaultId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const a = await unlock(PASS, info1, null);
    expect(a.cache).toEqual(created.cache);
    const blob = new TextEncoder().encode("written with kv1");
    const id1 = (await a.ring.blobId(blob)).blobId;
    const sealed1 = await a.ring.sealBlob(blob, id1, { compress: false, pad: false, chunkMax: 4194304 });
    const pkA = await a.ring.pathKey("a.md");
    const meta1 = await a.ring.sealMeta({ v: 1, path: "a.md", type: "file" }, { ...h(1), pathKey: pkA });

    // passphrase change: new salt, all kvs rewrapped, cached device keeps syncing
    const info2 = await changePassphrase(a.ring, info1, PASS, "a brand new passphrase", kdf);
    expect(info2.infoRev).toBe(2);
    expect(info2.kdf.salt).not.toBe(info1.kdf.salt);
    await expect(unlock(PASS, info2, null)).rejects.toMatchObject({ code: "WrongPassphrase" });
    const cachedDevice = await fromCache(created.cache, info2, { epoch: 1, infoRev: 1, activeKv: 1, maxSeq: 0 });
    expect(toHex(await cachedDevice.ring.openBlob(sealed1, id1, blob.length))).toBe(toHex(blob));

    // rotation: kv2 active, kv1 decrypt-only, other devices go Locked
    const rot = await rotateKey(a.ring, info2, "a brand new passphrase", "rotated passphrase here", { kdf });
    expect(rot.info.activeKv).toBe(2);
    expect(rot.info.keys.map((k) => [k.kv, k.status])).toEqual([[1, "decrypt-only"], [2, "active"]]);
    await expect(fromCache(created.cache, rot.info, null)).rejects.toMatchObject({ code: "Locked" });

    const b = await unlock("rotated passphrase here", rot.info, { epoch: 1, infoRev: 2, activeKv: 1, maxSeq: 0 });
    expect(b.ring.kvs).toEqual([1, 2]);
    expect(toHex(await b.ring.openBlob(sealed1, id1, blob.length))).toBe(toHex(blob));
    expect((await b.ring.openMeta(meta1, { ...h(1), pathKey: pkA })).path).toBe("a.md");
    const blob2 = new TextEncoder().encode("written with kv2");
    const sealed2 = await b.ring.sealBlob(blob2, (await b.ring.blobId(blob2)).blobId, { compress: false, pad: false, chunkMax: 4194304 });
    expect(sealed2[4]).toBe(2);
    // identifier keys stay VMK_1
    expect(await b.ring.pathKey("a.md")).toBe(await a.ring.pathKey("a.md"));
    await expect(b.ring.sealMeta({ v: 1, path: "a.md", type: "file" }, h(1))).rejects.toThrow(/active kv/);
    const fromRotCache = await fromCache(rot.cache, rot.info, null);
    expect(fromRotCache.ring.activeKv).toBe(2);

    // rebuild: epoch+1 MAC'd; rollback of infoRev detected
    const reb = await markRebuild(b.ring, rot.info);
    expect([reb.epoch, reb.infoRev]).toEqual([2, 4]);
    expect(await b.ring.verifyVaultInfo(reb)).toBe(true);
    await expect(fromCache(rot.cache, rot.info, { epoch: 2, infoRev: 4, activeKv: 2, maxSeq: 10 })).rejects.toMatchObject({ code: "VaultInfoRollback" });
  }, 60000);

  it("validation order: shape, unlockRequires, KDF bounds, passphrase, check, MAC, rollback, requires", async () => {
    const { info, ring, cache } = await createVault(PASS, { kdf });
    const corrupt = { ...info, formatVersion: 2 } as unknown as VaultInfo;
    await expect(unlock(PASS, corrupt, null)).rejects.toMatchObject({ code: "CorruptVaultInfo" });
    await expect(unlock(PASS, { ...info, unlockRequires: ["kdf-argon2id"] }, null)).rejects.toMatchObject({ code: "UpdateRequired" });
    await expect(unlock(PASS, { ...info, kdf: { ...info.kdf, iter: 1000 } } as VaultInfo, null)).rejects.toMatchObject({ code: "UnsupportedKdf" });
    await expect(unlock(PASS, { ...info, kdf: { ...info.kdf, iter: 9_000_000 } } as VaultInfo, null)).rejects.toMatchObject({ code: "UnsupportedKdf" });
    await expect(unlock(PASS, { ...info, kdf: { alg: "md5", salt: info.kdf.salt } } as unknown as VaultInfo, null)).rejects.toMatchObject({ code: "UnsupportedKdf" });
    await expect(unlock(PASS + "!", info, null)).rejects.toMatchObject({ code: "WrongPassphrase" });
    const badCheck = { ...info, keys: [{ ...info.keys[0]!, check: "AAAAAAAAAAAAAAAAAAAAAA" }] };
    await expect(unlock(PASS, badCheck, null)).rejects.toMatchObject({ code: "CorruptVaultInfo" });
    // stripping `requires` or downgrading params without the key -> MAC fails
    await expect(fromCache(cache, { ...info, requires: [] , params: { ...info.params, padding: "padme" } }, null)).rejects.toMatchObject({ code: "TamperedVaultInfo" });
    await expect(fromCache(cache, { ...info, epoch: 5 }, null)).rejects.toMatchObject({ code: "TamperedVaultInfo" });
    await expect(fromCache(cache, info, { epoch: 1, infoRev: 2, activeKv: 1, maxSeq: 0 })).rejects.toMatchObject({ code: "VaultInfoRollback" });
    // unknown requires (properly MAC'd) -> pull-only
    const withReq = await remac(ring, info, { requires: ["future-feature"], infoRev: 2 });
    expect((await fromCache(cache, withReq, null)).pullOnly).toBe(true);
    expect((await fromCache(cache, info, null)).pullOnly).toBe(false);
    // cache for another vault
    const other: CachedSecrets = { ...cache, vaultId: "AAAAAAAAAAAAAAAAAAAAAA" };
    await expect(fromCache(other, info, null)).rejects.toMatchObject({ code: "Locked" });
    // weak new passphrase
    await expect(createVault("short")).rejects.toThrow(RangeError);
  }, 60000);
});

describe("record freshness (§4.9.1)", () => {
  it("replay rules", () => {
    expect(checkRecordFreshness({ seq: 5, base: 3, kind: "put" }, { seq: 5 })).toBe("ignore");
    expect(checkRecordFreshness({ seq: 9, base: null, kind: "put" }, null)).toBe("apply");
    expect(checkRecordFreshness({ seq: 9, base: 7, kind: "put" }, { seq: 5 })).toBe("apply");
    expect(checkRecordFreshness({ seq: 9, base: 1, kind: "archive" }, { seq: 5 })).toBe("apply");
    expect(checkRecordFreshness({ seq: 9, base: 5, kind: "archive" }, { seq: 5 })).toBe("apply");
    expect(checkRecordFreshness({ seq: 9, base: 3, kind: "archive" }, null)).toBe("apply");
    expect(() => checkRecordFreshness({ seq: 9, base: 6, kind: "archive" }, { seq: 5 })).toThrow(expect.objectContaining({ code: "Replay" }));
    expect(() => checkRecordFreshness({ seq: 9, base: null, kind: "archive" }, { seq: 5 })).toThrow(expect.objectContaining({ code: "Replay" }));
    expect(() => checkRecordFreshness({ seq: 9, base: null, kind: "put" }, { seq: 5 })).toThrow(expect.objectContaining({ code: "Replay" }));
    expect(() => checkRecordFreshness({ seq: 9, base: 4, kind: "del" }, { seq: 5 })).toThrow(expect.objectContaining({ code: "Replay" }));
  });
});

function toHex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}
