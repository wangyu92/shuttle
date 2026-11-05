// SHUTTLE suite sx1 test-vector generator (design §4.15), standalone reference implementation.
// Uses only web-platform globals (crypto.subtle, TextEncoder, CompressionStream), no imports,
// so it is independent of src/ (checked by test/kat.test.ts) and of xcheck.py (Python).
//
// Usage: node vectors/gen.mjs > vectors/vectors-v1.json      (deterministic; ~1 s for the 600k KDF row)
//
// All inputs are fixed (design §4.15 "Inputs"); extensions beyond the design table are marked
// "ext" in the inputs block and documented in the comments below.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const HEX = '0123456789abcdef';
const hex = (u8) => Array.from(u8, (b) => HEX[b >> 4] + HEX[b & 15]).join('');
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64u(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const n = (u8[i] << 16) | ((u8[i + 1] ?? 0) << 8) | (u8[i + 2] ?? 0);
    const k = Math.min(3, u8.length - i);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (k > 1 ? B64[(n >> 6) & 63] : '') + (k > 2 ? B64[n & 63] : '');
  }
  return s;
}
const seqBytes = (start, n) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const concat = (...a) => { const o = new Uint8Array(a.reduce((x, y) => x + y.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

// ---------- primitives ----------
async function pbkdf2(pass, salt, iter) {
  const k = await subtle.importKey('raw', utf8(pass.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
}
async function hkdf(ikm, salt, info, bytes = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, k, bytes * 8));
}
async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
const sha256 = async (d) => new Uint8Array(await subtle.digest('SHA-256', d));
async function gcmEnc(key, nonce, pt, aad) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 }, k, pt));
}
async function gcmDec(key, nonce, ct, aad) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 }, k, ct));
}
const rejects = async (f) => { try { await f(); return 'accepted'; } catch { return 'rejected'; } };
async function deflateRaw(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function inflateRaw(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// Compression is used only when it saves >= 10 %: z * 10 <= n * 9 (same rule as src/envelope.ts).
const worth = (z, n) => n > 0 && z * 10 <= n * 9;

// ---------- padding ----------
function padme(L) {
  if (L < 2) return L;
  const E = 31 - Math.clz32(L);
  const S = 31 - Math.clz32(E) + 1;
  const unit = 2 ** (E - S);
  return Math.ceil(L / unit) * unit;
}
const padmeTarget = (n, cap = Infinity) => Math.max(n + 1, Math.min(padme(n + 1), cap));
const metaPadLen = (n, bucket = 256) => Math.ceil((n + 1) / bucket) * bucket;
function padTo(pt, target) { const o = new Uint8Array(target); o.set(pt); o[pt.length] = 0x80; return o; }
function unpad(p) { let i = p.length - 1; while (i >= 0 && p[i] === 0) i--; if (i < 0 || p[i] !== 0x80) throw new Error('bad padding'); return p.subarray(0, i); }

// ---------- canonical JSON ----------
function canon(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('non-integer'); return String(v); }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

// ---------- AAD builders ----------
const blobsDigest = async (ids) => b64u(await sha256(utf8(ids.join(','))));
const recAad = async (label, vaultId, r) => [label, vaultId, r.fileId, r.kv, r.kind, r.base ?? '-', r.rc, await blobsDigest(r.blobs), r.pathKey].join('|');
const wrapAad = (vaultId, kv) => `shuttle/wrap/v1|${vaultId}|${kv}`;
const blobAad = (vaultId, id) => `shuttle/blob/v1|${vaultId}|${id}`;

// ---------- inputs ----------
const out = {};
const pass = 'correct horse battery staple ✓ 한글'; // Hangul in NFD (conjoining jamo)
const salt = seqBytes(0x00, 32);
const vaultIdBytes = seqBytes(0x10, 16);
const vaultId = b64u(vaultIdBytes);
const VMK1 = seqBytes(0x20, 32);
const VMK2 = seqBytes(0x60, 32);
const wrapNonce = seqBytes(0x40, 12);
const wrapNonce2 = seqBytes(0x90, 12); // ext: kv2 wrap
const blobNonce = seqBytes(0x50, 12);
const blobNonceZ = seqBytes(0xc0, 12); // ext: compressed blob
const metaNonce = seqBytes(0x70, 12);
const inlineNonce = seqBytes(0x80, 12);
const inlineNonceP = seqBytes(0xa0, 12); // ext: padded inline
const meta2Nonce = seqBytes(0xb0, 12); // ext: second record (blobs, base null)
out.inputs = {
  passphraseJsEscaped: JSON.stringify(pass), passphraseIsNfd: pass === pass.normalize('NFD'), passphraseNfcUtf8Hex: hex(utf8(pass.normalize('NFC'))),
  saltHex: hex(salt), vaultId, vaultIdHex: hex(vaultIdBytes), vmk1Hex: hex(VMK1), vmk2Hex: hex(VMK2),
  wrapNonceHex: hex(wrapNonce), blobNonceHex: hex(blobNonce), metaNonceHex: hex(metaNonce), inlineNonceHex: hex(inlineNonce),
  ext: { wrapNonce2Hex: hex(wrapNonce2), blobNonceZHex: hex(blobNonceZ), inlineNoncePHex: hex(inlineNonceP), meta2NonceHex: hex(meta2Nonce) },
};

// ---------- KDF and wrap ----------
out.kdf = {};
for (const it of [1000, 600000]) {
  const kek = await pbkdf2(pass, salt, it);
  const wrapped = await gcmEnc(kek, wrapNonce, VMK1, wrapAad(vaultId, 1));
  const row = { kekHex: hex(kek), wrapAad: wrapAad(vaultId, 1), wrappedVmk1B64u: b64u(wrapped) };
  if (hex(await gcmDec(kek, wrapNonce, wrapped, wrapAad(vaultId, 1))) !== hex(VMK1)) throw new Error('unwrap');
  if (it === 1000) {
    row.wrappedVmk2B64u = b64u(await gcmEnc(kek, wrapNonce2, VMK2, wrapAad(vaultId, 2)));
    const wrongKek = await pbkdf2(pass + ' ', salt, it);
    row.negTrailingSpace = await rejects(() => gcmDec(wrongKek, wrapNonce, wrapped, wrapAad(vaultId, 1)));
    row.negWrongKvAad = await rejects(() => gcmDec(kek, wrapNonce, wrapped, wrapAad(vaultId, 2)));
  }
  out.kdf[it] = row;
}

// ---------- subkeys ----------
const sub = (vmk, name, n = 32) => hkdf(vmk, vaultIdBytes, `shuttle/v1/${name}`, n);
const K = {
  content1: await sub(VMK1, 'content'), meta1: await sub(VMK1, 'meta'), check1: await sub(VMK1, 'check'), info1: await sub(VMK1, 'info'),
  fileid: await sub(VMK1, 'fileid'), blobid: await sub(VMK1, 'blobid'), pathkey: await sub(VMK1, 'pathkey'),
  content2: await sub(VMK2, 'content'), meta2: await sub(VMK2, 'meta'), check2: await sub(VMK2, 'check'), info2: await sub(VMK2, 'info'),
};
const gear = await sub(VMK1, 'cdc-gear', 1024);
out.subkeys = Object.fromEntries(Object.entries(K).map(([k, v]) => [k + 'Hex', hex(v)]));
const dv = new DataView(gear.buffer);
out.subkeys.gearFirst4U32BE = [0, 1, 2, 3].map((i) => dv.getUint32(i * 4, false));
out.subkeys.gearLast2U32BE = [254, 255].map((i) => dv.getUint32(i * 4, false));
out.subkeys.gearSha256Hex = hex(await sha256(gear));

out.keyCheck = {
  message: 'shuttle key check v1',
  kv1: b64u((await hmac(K.check1, utf8('shuttle key check v1'))).subarray(0, 16)),
  kv2: b64u((await hmac(K.check2, utf8('shuttle key check v1'))).subarray(0, 16)),
};

// ---------- identifiers ----------
const pNfc = '2. Area/Daily Notes/2026-11-05.md';
const pKo = '한글 노트.md'; // "한글 노트.md", first word NFD
const pathKeyOf = async (p) => b64u((await hmac(K.pathkey, utf8('p\0' + p.normalize('NFC').toLowerCase()))).subarray(0, 16));
const fileIdOf = async (p) => hex((await hmac(K.fileid, utf8('f\0' + p.normalize('NFC')))).subarray(0, 16));
out.ids = {
  path1: pNfc, pathKey1: await pathKeyOf(pNfc), pathKey1Upper: await pathKeyOf(pNfc.toUpperCase()),
  path2JsEscaped: JSON.stringify(pKo), path2IsPartlyNfd: pKo !== pKo.normalize('NFC'), pathKey2: await pathKeyOf(pKo), pathKey2FromNfc: await pathKeyOf(pKo.normalize('NFC')),
  reservedFileId1: await fileIdOf(pNfc), reservedFileId2: await fileIdOf(pKo), reservedFileId2FromNfc: await fileIdOf(pKo.normalize('NFC')),
};

// ---------- blobs ----------
const chunk = utf8('# Test chunk\n\nSHUTTLE blob vector. 한글 포함.\n');
const chunkHash = await sha256(chunk);
const blobId = hex(await hmac(K.blobid, chunkHash));
const sealBlob = async (key, kv, id, body, flags, nonce) => concat(utf8('SXB1'), Uint8Array.of(kv, flags), nonce, await gcmEnc(key, nonce, body, blobAad(vaultId, id)));
const sealed0 = await sealBlob(K.content1, 1, blobId, chunk, 0, blobNonce);
const sealed2 = await sealBlob(K.content1, 1, blobId, padTo(chunk, padmeTarget(chunk.length, 4194305)), 2, blobNonce);
if (worth((await deflateRaw(chunk)).length, chunk.length)) throw new Error('vector chunk must not be compressible');
out.blob = {
  chunkHex: hex(chunk), chunkSha256Hex: hex(chunkHash), blobId, aad: blobAad(vaultId, blobId),
  sealedFlags0Hex: hex(sealed0), sealedFlags2PadmeHex: hex(sealed2), paddedPlainLen: padmeTarget(chunk.length, 4194305),
};
const tamper = sealed0.slice(); tamper[tamper.length - 1] ^= 1;
out.blob.negTamperedTag = await rejects(() => gcmDec(K.content1, blobNonce, tamper.subarray(18), out.blob.aad));
out.blob.negOtherBlobIdAad = await rejects(() => gcmDec(K.content1, blobNonce, sealed0.subarray(18), blobAad(vaultId, '0'.repeat(64))));
out.blob.negKv2Key = await rejects(() => gcmDec(K.content2, blobNonce, sealed0.subarray(18), out.blob.aad));

// Compressed blob (flags 1 and 3). The deflate bytes depend on the compressor, so these rows are
// verified by opening (decrypt, unpad, inflate, compare), never by re-sealing.
const zChunk = utf8('SHUTTLE compressible line 0123456789.\n'.repeat(64)); // 2432 B, compresses to < 10 %
const zHash = await sha256(zChunk);
const zBlobId = hex(await hmac(K.blobid, zHash));
const zBody = await deflateRaw(zChunk);
if (!worth(zBody.length, zChunk.length)) throw new Error('compressible chunk did not compress');
if (hex(await inflateRaw(zBody)) !== hex(zChunk)) throw new Error('inflate');
out.blobCompressed = {
  textRepeated: { line: 'SHUTTLE compressible line 0123456789.\n', times: 64 }, chunkLen: zChunk.length, chunkSha256Hex: hex(zHash), blobId: zBlobId,
  sealedFlags1Hex: hex(await sealBlob(K.content1, 1, zBlobId, zBody, 1, blobNonceZ)),
  sealedFlags3Hex: hex(await sealBlob(K.content1, 1, zBlobId, padTo(zBody, padmeTarget(zBody.length, 4194305)), 3, blobNonceZ)),
  // kv2 blob, uncompressed: proves the kv byte selects K_content(kv)
  sealedKv2Flags0Hex: hex(await sealBlob(K.content2, 2, zBlobId, zChunk, 0, blobNonceZ)),
};

// ---------- record meta and inline ----------
const inlinePt = utf8('hello world\n');
const inlineHash = hex(await sha256(inlinePt));
const rec = { fileId: '00112233445566778899aabbccddeeff', kv: 1, kind: 'put', base: 18011, rc: 'note', blobs: [], pathKey: out.ids.pathKey1 };
// Meta plaintext is self-consistent with the inline body (size, hash, chunks); key order as written.
const meta = { v: 1, path: pNfc, type: 'file', size: 12, mtime: 1762318800000, ctime: 1762300000000, hash: inlineHash, chunker: 'fastcdc-k1', chunks: [12], z: false, p: false, cat: null };
const metaJson = JSON.stringify(meta);
const metaPadded = padTo(utf8(metaJson), metaPadLen(utf8(metaJson).length));
const metaAad = await recAad('shuttle/meta/v1', vaultId, rec);
const inlineAad = await recAad('shuttle/inline/v1', vaultId, rec);
const metaCt = concat(metaNonce, await gcmEnc(K.meta1, metaNonce, metaPadded, metaAad));
const inlineCt = concat(inlineNonce, await gcmEnc(K.content1, inlineNonce, inlinePt, inlineAad));
const inlinePadded = padTo(inlinePt, padmeTarget(inlinePt.length));
const inlineCtP = concat(inlineNonceP, await gcmEnc(K.content1, inlineNonceP, inlinePadded, inlineAad));
out.record = {
  header: rec, blobsDigestEmpty: await blobsDigest([]), blobsDigestTwo: await blobsDigest(['aa'.repeat(32), 'bb'.repeat(32)]),
  metaAad, inlineAad, metaJson, metaPaddedLen: metaPadded.length, metaB64u: b64u(metaCt),
  inlinePlainHex: hex(inlinePt), inlineSha256Hex: inlineHash, inlineB64u: b64u(inlineCt), inlinePaddedLen: inlinePadded.length, inlinePaddedB64u: b64u(inlineCtP),
};
const mutations = {
  base18010: { ...rec, base: 18010 }, baseNull: { ...rec, base: null }, kindDel: { ...rec, kind: 'del' }, rcConfig: { ...rec, rc: 'config' },
  kv2: { ...rec, kv: 2 }, otherFileId: { ...rec, fileId: 'ffeeddccbbaa99887766554433221100' }, otherPathKey: { ...rec, pathKey: out.ids.pathKey2 }, oneBlob: { ...rec, blobs: [blobId] },
};
out.record.neg = {};
for (const [name, h] of Object.entries(mutations)) out.record.neg[name] = await rejects(async () => gcmDec(K.meta1, metaNonce, metaCt.subarray(12), await recAad('shuttle/meta/v1', vaultId, h)));
out.record.neg.inlineUnderMetaLabel = await rejects(() => gcmDec(K.content1, inlineNonce, inlineCt.subarray(12), metaAad));

// Second record: create (base null -> "-"), attachment, two blobs, kv 1, NFD path.
const rec2 = { fileId: 'ffeeddccbbaa99887766554433221100', kv: 1, kind: 'put', base: null, rc: 'attachment', blobs: [blobId, zBlobId], pathKey: out.ids.pathKey2 };
const meta2 = { v: 1, path: pKo.normalize('NFC'), type: 'file', size: chunk.length + zChunk.length, mtime: 1762318800000, ctime: 1762318800000, hash: hex(await sha256(concat(chunk, zChunk))), chunker: 'fastcdc-k1', chunks: [chunk.length, zChunk.length], z: false, p: false, cat: null };
const meta2Json = JSON.stringify(meta2);
const meta2Aad = await recAad('shuttle/meta/v1', vaultId, rec2);
out.record2 = {
  header: rec2, blobsDigest: await blobsDigest(rec2.blobs), metaAad: meta2Aad, metaJson: meta2Json,
  metaPaddedLen: metaPadLen(utf8(meta2Json).length),
  metaB64u: b64u(concat(meta2Nonce, await gcmEnc(K.meta1, meta2Nonce, padTo(utf8(meta2Json), metaPadLen(utf8(meta2Json).length)), meta2Aad))),
};

// ---------- vault-info MAC ----------
const k1000 = out.kdf[1000];
const info = {
  format: 'shuttle.vault-info', formatVersion: 1, vaultId, createdAt: 1762318800000, infoRev: 1, epoch: 1,
  kdf: { alg: 'PBKDF2-SHA256', iter: 1000, salt: b64u(salt) },
  keys: [{ kv: 1, status: 'active', suite: 'sx1', nonce: b64u(wrapNonce), wrapped: k1000.wrappedVmk1B64u, check: out.keyCheck.kv1, createdAt: 1762318800000 }],
  activeKv: 1,
  params: { chunker: { alg: 'fastcdc-k1', min: 262144, avg: 1048576, max: 4194304 }, inlineMax: 4096, compression: 'deflate-raw', padding: 'none', metaPadBucket: 256 },
  retention: { noteDays: 30, attachmentDays: 14, configDays: 30, tombstoneDays: 90, thinAfterHours: 24, thinBucketMinutes: 60 },
  requires: [], unlockRequires: [], features: ['history-v1', 'archive-v1'],
};
const macOf = async (key, obj) => b64u(await hmac(key, concat(utf8('shuttle/vault-info/v1\0'), utf8(canon(obj)))));
out.vaultInfo = { canonical: canon(info), infoMac: await macOf(K.info1, info) };
// Rotated: kv1 decrypt-only, kv2 active (same salt and KEK, iter 1000), infoRev 2, MAC with K_info(2).
const info2 = {
  ...info, infoRev: 2, activeKv: 2,
  keys: [{ ...info.keys[0], status: 'decrypt-only' }, { kv: 2, status: 'active', suite: 'sx1', nonce: b64u(wrapNonce2), wrapped: k1000.wrappedVmk2B64u, check: out.keyCheck.kv2, createdAt: 1762405200000 }],
};
out.vaultInfoRotated = { canonical: canon(info2), infoMac: await macOf(K.info2, info2) };
// Unknown fields are MAC'd too; key sorting is by UTF-16 code units ("Z" < "a" < "é" < "😀" < "ｆ").
const info3 = { ...info, 'ｆ': 1, '😀': [true, null], 'é': 'x', Zeta: { b: 2, a: 1 } };
out.vaultInfoUnknownFields = { canonical: canon(info3), infoMac: await macOf(K.info1, info3) };

// ---------- S3 snapshot manifest MAC (§4.9.3; shape illustrative) ----------
// `kv` is inside the MAC'd body and selects K_info(kv), so a manifest written before a rotation
// still verifies after it (manifestKv2 is the same manifest written after rotating to kv 2).
const manifest = { epoch: 1, kv: 1, seq: 18000, recordCount: 3, fileCount: 2, parts: [{ key: 'e1/snap/00000000000000018000/part-0000.json.gz', sha256: hex(await sha256(utf8('part-0'))), records: 3 }] };
out.manifest = { canonical: canon(manifest), mac: b64u(await hmac(K.info1, concat(utf8('shuttle/snap/v1\0'), utf8(canon(manifest))))) };
const manifest2 = { ...manifest, kv: 2 };
out.manifestKv2 = { canonical: canon(manifest2), mac: b64u(await hmac(K.info2, concat(utf8('shuttle/snap/v1\0'), utf8(canon(manifest2))))) };

// ---------- tables ----------
out.padme = Object.fromEntries([0, 1, 2, 9, 100, 1000, 4096, 5321, 65536, 1048576, 4194304].map((L) => [L, padme(L + 1)]));
out.padmeCapped = Object.fromEntries([4194303, 4194304].map((L) => [L, padmeTarget(L, 4194305)]));
out.metaPad = Object.fromEntries([0, 254, 255, 256, 600].map((L) => [L, metaPadLen(L)]));

// self-check of this generator
if (hex(unpad(await gcmDec(K.content1, blobNonce, sealed2.subarray(18), out.blob.aad))) !== hex(chunk)) throw new Error('padded blob');
console.log(JSON.stringify(out, null, 2));
