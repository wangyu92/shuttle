#!/usr/bin/python3 -I
"""Independent cross-check of SHUTTLE suite sx1 vectors (design §4.15, P0 cross-check item).

Every input, AAD string, canonical JSON and plaintext is rebuilt here from the design text
(§2.2, §2.3, §4.3, §4.5.2, §4.6, §4.15 Inputs). vectors-v1.json is read ONLY for the expected
outputs; its strings are never used as inputs. Ciphertexts are recomputed with AES-GCM and
compared byte for byte, except the deflate rows, whose bytes depend on the compressor: those
are opened (decrypt, unpad, inflate) and compared with the chunk rebuilt here.

Usage: /usr/bin/python3 -I vectors/xcheck.py vectors/vectors-v1.json      exit 0 = all pass
"""
import base64, hashlib, hmac, json, sys, unicodedata, zlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag

import os
VECTORS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors-v1.json")
V = json.load(open(VECTORS, encoding="utf-8"))
results = []


def check(name, got, want):
    ok = got == want
    results.append((name, ok))
    if not ok:
        print(f"FAIL {name}\n  got:  {got!r}\n  want: {want!r}")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def seq(start, n):
    return bytes((start + i) & 0xFF for i in range(n))


def hkdf(ikm, salt, info, n=32):  # RFC 5869
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    t, o, i = b"", b"", 1
    while len(o) < n:
        t = hmac.new(prk, t + info.encode() + bytes([i]), hashlib.sha256).digest()
        o += t
        i += 1
    return o[:n]


def H(k, m):
    return hmac.new(k, m, hashlib.sha256).digest()


def sha(b):
    return hashlib.sha256(b).digest()


def gcm_enc(k, nonce, pt, aad):
    return AESGCM(k).encrypt(nonce, pt, aad.encode("utf-8"))


def gcm_dec(k, nonce, ct, aad):
    return AESGCM(k).decrypt(nonce, ct, aad.encode("utf-8"))


def rejected(f):
    try:
        f()
        return "accepted"
    except InvalidTag:
        return "rejected"


# §4.6.4 Padmé, written from the formula in the design: E=floor(log2 L), S=floor(log2 E)+1, z=E-S
def padme(L):
    if L < 2:
        return L
    E = L.bit_length() - 1
    S = E.bit_length() - 1 + 1
    z = E - S
    unit = 1 << z
    return -(-L // unit) * unit


def padme_target(n, cap=None):
    t = padme(n + 1)
    if cap is not None:
        t = min(t, cap)
    return max(t, n + 1)


def meta_pad_len(n, bucket=256):
    return -(-(n + 1) // bucket) * bucket


def pad_iso(pt, target):  # ISO/IEC 7816-4
    return pt + b"\x80" + b"\x00" * (target - len(pt) - 1)


def unpad_iso(p):
    s = p.rstrip(b"\x00")
    if not s.endswith(b"\x80"):
        raise ValueError("bad padding")
    return s[:-1]


def worth(z, n):  # deflate only if it saves >= 10 %
    return n > 0 and z * 10 <= n * 9


def inflate_raw(z, cap):
    d = zlib.decompressobj(wbits=-15)
    out = d.decompress(z, cap + 1)
    if not d.eof or len(out) > cap:
        raise ValueError("inflate")
    return out


# §4.5.2 canonical JSON: keys sorted by UTF-16 code units, no whitespace, JSON.stringify strings,
# safe integers only, arrays in order.
def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def canon(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return js_str(v)
    if isinstance(v, int):
        if abs(v) > 2**53 - 1:
            raise ValueError("unsafe int")
        return str(v)
    if isinstance(v, float):
        raise ValueError("non-integer")
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, dict):
        ks = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(js_str(k) + ":" + canon(v[k]) for k in ks) + "}"
    raise TypeError(type(v))


def js_json(d):  # JSON.stringify of a plain object, insertion order
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


# ---------------- inputs (design §4.15) ----------------
PASS_NFC = "correct horse battery staple ✓ 한글"  # ✓ 한글
PASS = unicodedata.normalize("NFD", PASS_NFC)  # the JS source holds Hangul in NFD
SALT = seq(0x00, 32)
VID_B = seq(0x10, 16)
VID = b64u(VID_B)
VMK1, VMK2 = seq(0x20, 32), seq(0x60, 32)
WRAP_N, WRAP_N2 = seq(0x40, 12), seq(0x90, 12)
BLOB_N, BLOB_NZ = seq(0x50, 12), seq(0xC0, 12)
META_N, INLINE_N, INLINE_NP, META2_N = seq(0x70, 12), seq(0x80, 12), seq(0xA0, 12), seq(0xB0, 12)
CHUNK_MAX = 4194304

I = V["inputs"]
check("inputs.passphrase (NFD in JS source)", unicodedata.normalize("NFD", json.loads(I["passphraseJsEscaped"])) == json.loads(I["passphraseJsEscaped"]), True)
check("inputs.passphrase NFC equal", unicodedata.normalize("NFC", json.loads(I["passphraseJsEscaped"])), PASS_NFC)
check("inputs.passphraseNfcUtf8Hex", PASS_NFC.encode().hex(), I["passphraseNfcUtf8Hex"])
check("inputs.passphraseNfcUtf8Hex tail (design)", PASS_NFC.encode().hex().endswith("20ed959ceab880"), True)
check("inputs.vaultId", VID, I["vaultId"])
check("inputs.vaultId (design)", VID, "EBESExQVFhcYGRobHB0eHw")

# ---------------- KDF and wrap (§4.4, §4.6.6) ----------------
def wrap_aad(kv):
    return f"shuttle/wrap/v1|{VID}|{kv}"


keks = {}
for it in (1000, 600000):
    kek = hashlib.pbkdf2_hmac("sha256", unicodedata.normalize("NFC", PASS).encode(), SALT, it)
    keks[it] = kek
    row = V["kdf"][str(it)]
    check(f"kdf.{it}.kek", kek.hex(), row["kekHex"])
    check(f"kdf.{it}.wrapAad", wrap_aad(1), row["wrapAad"])
    w1 = gcm_enc(kek, WRAP_N, VMK1, wrap_aad(1))
    check(f"kdf.{it}.wrappedVmk1", b64u(w1), row["wrappedVmk1B64u"])
    check(f"kdf.{it}.unwrap", gcm_dec(kek, WRAP_N, unb64u(row["wrappedVmk1B64u"]), wrap_aad(1)), VMK1)
    if it == 1000:
        check("kdf.1000.wrappedVmk2", b64u(gcm_enc(kek, WRAP_N2, VMK2, wrap_aad(2))), row["wrappedVmk2B64u"])
        wrong = hashlib.pbkdf2_hmac("sha256", (PASS_NFC + " ").encode(), SALT, it)
        check("kdf.1000.negTrailingSpace", rejected(lambda: gcm_dec(wrong, WRAP_N, w1, wrap_aad(1))), "rejected")
        check("kdf.1000.negTrailingSpace (json)", row["negTrailingSpace"], "rejected")
        check("kdf.1000.negWrongKvAad", rejected(lambda: gcm_dec(kek, WRAP_N, w1, wrap_aad(2))), row["negWrongKvAad"])

# ---------------- subkeys (§4.3) ----------------
def sub(vmk, label, n=32):
    return hkdf(vmk, VID_B, "shuttle/v1/" + label, n)


K = {
    "content1": sub(VMK1, "content"), "meta1": sub(VMK1, "meta"), "check1": sub(VMK1, "check"), "info1": sub(VMK1, "info"),
    "fileid": sub(VMK1, "fileid"), "blobid": sub(VMK1, "blobid"), "pathkey": sub(VMK1, "pathkey"),
    "content2": sub(VMK2, "content"), "meta2": sub(VMK2, "meta"), "check2": sub(VMK2, "check"), "info2": sub(VMK2, "info"),
}
S = V["subkeys"]
for k, v in K.items():
    check(f"subkeys.{k}", v.hex(), S[k + "Hex"])
gear = sub(VMK1, "cdc-gear", 1024)
u32 = [int.from_bytes(gear[4 * i:4 * i + 4], "big") for i in range(256)]
check("subkeys.gearFirst4U32BE", u32[:4], S["gearFirst4U32BE"])
check("subkeys.gearLast2U32BE", u32[254:], S["gearLast2U32BE"])
check("subkeys.gearSha256", sha(gear).hex(), S["gearSha256Hex"])

KC = "shuttle key check v1"
check("keyCheck.message", KC, V["keyCheck"]["message"])
check("keyCheck.kv1", b64u(H(K["check1"], KC.encode())[:16]), V["keyCheck"]["kv1"])
check("keyCheck.kv2", b64u(H(K["check2"], KC.encode())[:16]), V["keyCheck"]["kv2"])

# ---------------- identifiers (§2.3, §4.7) ----------------
def path_key(p):
    return b64u(H(K["pathkey"], ("p\0" + unicodedata.normalize("NFC", p).lower()).encode())[:16])


def file_id_reserved(p):
    return H(K["fileid"], ("f\0" + unicodedata.normalize("NFC", p)).encode())[:16].hex()


P1 = "2. Area/Daily Notes/2026-11-05.md"
P2 = unicodedata.normalize("NFD", "한글") + " 노트.md"  # 한글(NFD) 노트.md
D = V["ids"]
check("ids.path1", P1, D["path1"])
check("ids.path2", P2, json.loads(D["path2JsEscaped"]))
check("ids.pathKey1", path_key(P1), D["pathKey1"])
check("ids.pathKey1Upper", path_key(P1.upper()), D["pathKey1Upper"])
check("ids.pathKey1 == upper", path_key(P1), path_key(P1.upper()))
check("ids.pathKey2", path_key(P2), D["pathKey2"])
check("ids.pathKey2FromNfc", path_key(unicodedata.normalize("NFC", P2)), D["pathKey2FromNfc"])
check("ids.reservedFileId1", file_id_reserved(P1), D["reservedFileId1"])
check("ids.reservedFileId2", file_id_reserved(P2), D["reservedFileId2"])
check("ids.reservedFileId2FromNfc", file_id_reserved(unicodedata.normalize("NFC", P2)), D["reservedFileId2FromNfc"])

# ---------------- blobs (§4.6.1) ----------------
def blob_aad(bid):
    return f"shuttle/blob/v1|{VID}|{bid}"


def blob_id(chunk):
    return H(K["blobid"], sha(chunk)).hex()


def seal_blob(key, kv, bid, body, flags, nonce):
    return b"SXB1" + bytes([kv, flags]) + nonce + gcm_enc(key, nonce, body, blob_aad(bid))


def open_blob(sealed, bid, expected, keys):
    assert len(sealed) >= 34 and sealed[:4] == b"SXB1"
    kv, flags = sealed[4], sealed[5]
    assert flags & ~3 == 0
    body = gcm_dec(keys[kv], sealed[6:18], sealed[18:], blob_aad(bid))
    if flags & 2:
        body = unpad_iso(body)
    if flags & 1:
        body = inflate_raw(body, expected)
    assert len(body) == expected and blob_id(body) == bid
    return body, kv, flags


CHUNK = "# Test chunk\n\nSHUTTLE blob vector. 한글 포함.\n".encode()
BID = blob_id(CHUNK)
B = V["blob"]
check("blob.chunk", CHUNK.hex(), B["chunkHex"])
check("blob.chunkSha256", sha(CHUNK).hex(), B["chunkSha256Hex"])
check("blob.blobId", BID, B["blobId"])
check("blob.aad", blob_aad(BID), B["aad"])
s0 = seal_blob(K["content1"], 1, BID, CHUNK, 0, BLOB_N)
check("blob.sealedFlags0", s0.hex(), B["sealedFlags0Hex"])
plen = padme_target(len(CHUNK), CHUNK_MAX + 1)
check("blob.paddedPlainLen", plen, B["paddedPlainLen"])
check("blob.sealedFlags2", seal_blob(K["content1"], 1, BID, pad_iso(CHUNK, plen), 2, BLOB_N).hex(), B["sealedFlags2PadmeHex"])
check("blob.chunk not compressible (zlib)", worth(len(zlib.compress(CHUNK, 6)[2:-4]), len(CHUNK)), False)
t = bytearray(s0)
t[-1] ^= 1
check("blob.negTamperedTag", rejected(lambda: gcm_dec(K["content1"], BLOB_N, bytes(t[18:]), blob_aad(BID))), B["negTamperedTag"])
check("blob.negOtherBlobIdAad", rejected(lambda: gcm_dec(K["content1"], BLOB_N, s0[18:], blob_aad("0" * 64))), B["negOtherBlobIdAad"])
check("blob.negKv2Key", rejected(lambda: gcm_dec(K["content2"], BLOB_N, s0[18:], blob_aad(BID))), B["negKv2Key"])
check("blob.negs are rejections", [B["negTamperedTag"], B["negOtherBlobIdAad"], B["negKv2Key"]], ["rejected"] * 3)

LINE = "SHUTTLE compressible line 0123456789.\n"
ZCHUNK = (LINE * 64).encode()
ZBID = blob_id(ZCHUNK)
C = V["blobCompressed"]
check("blobZ.chunkLen", len(ZCHUNK), C["chunkLen"])
check("blobZ.chunkSha256", sha(ZCHUNK).hex(), C["chunkSha256Hex"])
check("blobZ.blobId", ZBID, C["blobId"])
zc = zlib.compressobj(6, zlib.DEFLATED, -15)
pyz = zc.compress(ZCHUNK) + zc.flush()
check("blobZ.compressible under zlib too", worth(len(pyz), len(ZCHUNK)), True)
KEYS = {1: K["content1"], 2: K["content2"]}
for name, want_flags in (("sealedFlags1Hex", 1), ("sealedFlags3Hex", 3)):
    sealed = bytes.fromhex(C[name])
    body, kv, flags = open_blob(sealed, ZBID, len(ZCHUNK), KEYS)
    check(f"blobZ.{name} opens", (body, kv, flags, sealed[6:18]), (ZCHUNK, 1, want_flags, BLOB_NZ))
    if want_flags == 3:
        inner = unpad_iso(gcm_dec(K["content1"], sealed[6:18], sealed[18:], blob_aad(ZBID)))
        check("blobZ.flags3 padded length", len(sealed) - 34, padme_target(len(inner), CHUNK_MAX + 1))
check("blobZ.sealedKv2Flags0", seal_blob(K["content2"], 2, ZBID, ZCHUNK, 0, BLOB_NZ).hex(), C["sealedKv2Flags0Hex"])

# ---------------- record meta and inline (§4.6.3) ----------------
def blobs_digest(blobs):
    return b64u(sha(",".join(blobs).encode()))


def rec_aad(label, h):
    base = "-" if h["base"] is None else str(h["base"])
    return "|".join([label, VID, h["fileId"], str(h["kv"]), h["kind"], base, h["rc"], blobs_digest(h["blobs"]), h["pathKey"]])


INLINE = b"hello world\n"
REC = {"fileId": "00112233445566778899aabbccddeeff", "kv": 1, "kind": "put", "base": 18011, "rc": "note", "blobs": [], "pathKey": path_key(P1)}
META = {"v": 1, "path": P1, "type": "file", "size": 12, "mtime": 1762318800000, "ctime": 1762300000000, "hash": sha(INLINE).hex(),
        "chunker": "fastcdc-k1", "chunks": [12], "z": False, "p": False, "cat": None}
R = V["record"]
check("record.header", REC, R["header"])
check("record.blobsDigestEmpty", blobs_digest([]), R["blobsDigestEmpty"])
check("record.blobsDigestEmpty (design)", blobs_digest([]), "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
check("record.blobsDigestTwo", blobs_digest(["aa" * 32, "bb" * 32]), R["blobsDigestTwo"])
meta_aad = rec_aad("shuttle/meta/v1", REC)
inline_aad = rec_aad("shuttle/inline/v1", REC)
check("record.metaAad", meta_aad, R["metaAad"])
check("record.inlineAad", inline_aad, R["inlineAad"])
mj = js_json(META).encode()
check("record.metaJson", mj.decode(), R["metaJson"])
check("record.metaPaddedLen", meta_pad_len(len(mj)), R["metaPaddedLen"])
meta_ct = META_N + gcm_enc(K["meta1"], META_N, pad_iso(mj, meta_pad_len(len(mj))), meta_aad)
check("record.meta sealed", b64u(meta_ct), R["metaB64u"])
check("record.inlinePlain", INLINE.hex(), R["inlinePlainHex"])
check("record.inlineSha256", sha(INLINE).hex(), R["inlineSha256Hex"])
check("record.inline sealed", b64u(INLINE_N + gcm_enc(K["content1"], INLINE_N, INLINE, inline_aad)), R["inlineB64u"])
ip = padme_target(len(INLINE))
check("record.inlinePaddedLen", ip, R["inlinePaddedLen"])
check("record.inline padded sealed", b64u(INLINE_NP + gcm_enc(K["content1"], INLINE_NP, pad_iso(INLINE, ip), inline_aad)), R["inlinePaddedB64u"])
MUT = {
    "base18010": dict(REC, base=18010), "baseNull": dict(REC, base=None), "kindDel": dict(REC, kind="del"), "rcConfig": dict(REC, rc="config"),
    "kv2": dict(REC, kv=2), "otherFileId": dict(REC, fileId="ffeeddccbbaa99887766554433221100"), "otherPathKey": dict(REC, pathKey=path_key(P2)),
    "oneBlob": dict(REC, blobs=[BID]),
}
for name, h in MUT.items():
    check(f"record.neg.{name}", rejected(lambda h=h: gcm_dec(K["meta1"], META_N, meta_ct[12:], rec_aad("shuttle/meta/v1", h))), "rejected")
    check(f"record.neg.{name} (json)", R["neg"][name], "rejected")
check("record.neg.inlineUnderMetaLabel", rejected(lambda: gcm_dec(K["content1"], INLINE_N, unb64u(R["inlineB64u"])[12:], meta_aad)), R["neg"]["inlineUnderMetaLabel"])

REC2 = {"fileId": "ffeeddccbbaa99887766554433221100", "kv": 1, "kind": "put", "base": None, "rc": "attachment", "blobs": [BID, ZBID], "pathKey": path_key(P2)}
META2 = {"v": 1, "path": unicodedata.normalize("NFC", P2), "type": "file", "size": len(CHUNK) + len(ZCHUNK), "mtime": 1762318800000, "ctime": 1762318800000,
         "hash": sha(CHUNK + ZCHUNK).hex(), "chunker": "fastcdc-k1", "chunks": [len(CHUNK), len(ZCHUNK)], "z": False, "p": False, "cat": None}
R2 = V["record2"]
check("record2.header", REC2, R2["header"])
check("record2.blobsDigest", blobs_digest(REC2["blobs"]), R2["blobsDigest"])
m2aad = rec_aad("shuttle/meta/v1", REC2)
check("record2.metaAad", m2aad, R2["metaAad"])
check("record2.metaAad has '-' for base null", m2aad.split("|")[5], "-")
m2j = js_json(META2).encode()
check("record2.metaJson", m2j.decode(), R2["metaJson"])
check("record2.metaPaddedLen", meta_pad_len(len(m2j)), R2["metaPaddedLen"])
check("record2.meta sealed", b64u(META2_N + gcm_enc(K["meta1"], META2_N, pad_iso(m2j, meta_pad_len(len(m2j))), m2aad)), R2["metaB64u"])

# ---------------- vault-info MAC (§2.2, §4.5.2) ----------------
def info_mac(key, info):
    return b64u(H(key, b"shuttle/vault-info/v1\0" + canon(info).encode()))


INFO = {
    "format": "shuttle.vault-info", "formatVersion": 1, "vaultId": VID, "createdAt": 1762318800000, "infoRev": 1, "epoch": 1,
    "kdf": {"alg": "PBKDF2-SHA256", "iter": 1000, "salt": b64u(SALT)},
    "keys": [{"kv": 1, "status": "active", "suite": "sx1", "nonce": b64u(WRAP_N), "wrapped": b64u(gcm_enc(keks[1000], WRAP_N, VMK1, wrap_aad(1))),
              "check": b64u(H(K["check1"], KC.encode())[:16]), "createdAt": 1762318800000}],
    "activeKv": 1,
    "params": {"chunker": {"alg": "fastcdc-k1", "min": 262144, "avg": 1048576, "max": 4194304}, "inlineMax": 4096,
               "compression": "deflate-raw", "padding": "none", "metaPadBucket": 256},
    "retention": {"noteDays": 30, "attachmentDays": 14, "configDays": 30, "tombstoneDays": 90, "thinAfterHours": 24, "thinBucketMinutes": 60},
    "requires": [], "unlockRequires": [], "features": ["history-v1", "archive-v1"],
}
check("vaultInfo.canonical", canon(INFO), V["vaultInfo"]["canonical"])
check("vaultInfo.infoMac", info_mac(K["info1"], INFO), V["vaultInfo"]["infoMac"])
INFO2 = dict(INFO, infoRev=2, activeKv=2, keys=[
    dict(INFO["keys"][0], status="decrypt-only"),
    {"kv": 2, "status": "active", "suite": "sx1", "nonce": b64u(WRAP_N2), "wrapped": b64u(gcm_enc(keks[1000], WRAP_N2, VMK2, wrap_aad(2))),
     "check": b64u(H(K["check2"], KC.encode())[:16]), "createdAt": 1762405200000}])
check("vaultInfoRotated.canonical", canon(INFO2), V["vaultInfoRotated"]["canonical"])
check("vaultInfoRotated.infoMac (K_info(2))", info_mac(K["info2"], INFO2), V["vaultInfoRotated"]["infoMac"])
INFO3 = dict(INFO, **{"ｆ": 1, "\U0001F600": [True, None], "é": "x", "Zeta": {"b": 2, "a": 1}})
c3 = canon(INFO3)
check("vaultInfoUnknownFields.canonical", c3, V["vaultInfoUnknownFields"]["canonical"])
check("vaultInfoUnknownFields UTF-16 order", [c3.index(x) for x in ('"Zeta"', '"activeKv"', '"é"', '"\U0001F600"', '"ｆ"')] == sorted(c3.index(x) for x in ('"Zeta"', '"activeKv"', '"é"', '"\U0001F600"', '"ｆ"')), True)
check("vaultInfoUnknownFields.infoMac", info_mac(K["info1"], INFO3), V["vaultInfoUnknownFields"]["infoMac"])

MAN = {"epoch": 1, "kv": 1, "seq": 18000, "recordCount": 3, "fileCount": 2,
       "parts": [{"key": "e1/snap/00000000000000018000/part-0000.json.gz", "sha256": sha(b"part-0").hex(), "records": 3}]}
check("manifest.canonical", canon(MAN), V["manifest"]["canonical"])
check("manifest.mac", b64u(H(K["info1"], b"shuttle/snap/v1\0" + canon(MAN).encode())), V["manifest"]["mac"])
MAN2 = dict(MAN, kv=2)
check("manifestKv2.canonical", canon(MAN2), V["manifestKv2"]["canonical"])
check("manifestKv2.mac", b64u(H(K["info2"], b"shuttle/snap/v1\0" + canon(MAN2).encode())), V["manifestKv2"]["mac"])

# ---------------- tables (§4.6.3, §4.6.4, design §4.15 rows) ----------------
PADME_DESIGN = {0: 1, 1: 2, 2: 3, 9: 10, 100: 104, 1000: 1024, 4096: 4352, 5321: 5376, 65536: 67584, 1048576: 1081344, 4194304: 4325376}
check("padme table (design)", {L: padme(L + 1) for L in PADME_DESIGN}, PADME_DESIGN)
check("padme table (json)", {int(k): v for k, v in V["padme"].items()}, PADME_DESIGN)
check("padme capped", {int(k): v for k, v in V["padmeCapped"].items()}, {L: padme_target(L, CHUNK_MAX + 1) for L in (4194303, 4194304)})
META_DESIGN = {0: 256, 254: 256, 255: 256, 256: 512, 600: 768}
check("meta bucket (design)", {L: meta_pad_len(L) for L in META_DESIGN}, META_DESIGN)
check("meta bucket (json)", {int(k): v for k, v in V["metaPad"].items()}, META_DESIGN)

passed = sum(1 for _, ok in results if ok)
print(f"xcheck: {passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
