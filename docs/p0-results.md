# P0 results and decisions

Device numbers from the spike (`packages/spike`) go here as they come in. Until then this file only
records decisions taken while building P0.

## P0-C8 Argon2id timing: deferred (2026-11-05)

- The spike checks WASM in a Blob-URL Worker with 64 MiB of memory. It does not time Argon2id
  m=64MiB t=3, because `hash-wasm` is not installed (its exact version and community-store acceptance
  of inline WASM are still UNVERIFIED, design §10.2).
- v1 keeps PBKDF2-SHA256 (600000 iterations, floor 310000) as the only KDF, which is also the §10.2
  fallback when Argon2id misses 2 s. The decision does not change any v1 format.
- Revisit when Argon2id is planned: add `hash-wasm` at an exact version and time it inside the worker
  on iPhone, iPad mini and the Fold.

## Device results

| Probe | Mac (M1 Pro, Obsidian 1.15.0, Electron 43.8.4) | iPhone 13 Pro (iOS 18.7) | iPad mini 6 (not tested) | Fold 8 (SM-F971N unfolded, Android 17, WebView 156) |
|---|---|---|---|---|
| P0-C1 subtle, getRandomValues, secure context | PASS | PASS (origin capacitor://localhost) | | PASS (origin http://localhost) |
| P0-C2 full KAT, KEK@600k byte-identical | PASS (selfTest 86 ms) | PASS (selfTest 114 ms) | | PASS (selfTest 64 ms) |
| M2/P0-C3 PBKDF2 600k | PASS 58.2 ms | PASS 95 ms | | PASS 41.9 ms |
| P0-C4 HKDF, non-extractable keys | PASS | PASS | | PASS |
| M1/P0-C5 AES-GCM 4 MiB | 2097 MB/s single, 1824 MB/s x4, 24 MiB ok | 1398 MB/s single, 1398 MB/s x4, 24 MiB ok | | 912 MB/s single, 1216 MB/s x4, 24 MiB ok |
| P0-C6 NFC, casing vs Node | PASS, 0/18 casing diffs | PASS, 0/18 casing diffs | | PASS, 0/18 casing diffs |
| P0-C7 ECDH P-256 | PASS 0.9 ms | PASS 3 ms | | PASS 1.1 ms |
| P0-C8 WASM worker 64 MiB | PASS (Argon2id not bundled) | PASS (Argon2id not bundled) | | PASS (Argon2id not bundled) |
| M17/P0-C9 deflate-raw | PASS | PASS | | PASS |
| P0-C11 main-thread blocking | PBKDF2 17.2 ms, GCM 16.4 ms, 0 long tasks | PBKDF2 20 ms, GCM 17 ms (no longtask API on iOS) | | PBKDF2 16.1 ms, GCM 16.2 ms, 0 long tasks |
| M3 HMAC 10k paths | 23.4 ms | 223 ms sequential, 54 ms batched (batch on iOS) | | 19 ms |
| M10 IndexedDB 10k put / getAll | 420 ms / 35.1 ms | 243 ms / 19 ms | | 318 ms / 44 ms |
| M13 raw event for configDir write | PASS 1 ms | PASS 1 ms | | PASS 0 ms |
| M18 getFiles + stat (4792 files) | 0.6 ms cached, 195 ms for 4000 adapter.stat | not measured (empty vault, run 'M18 corpus') | | not measured (empty vault, run 'M18 corpus') |
| M20 DMP golden vs Node | 7/7 | 7/7 | | 7/7 |
| M24 private settings APIs | PASS | PASS | | PASS |
| M4-M7 server | SKIPPED (no serverUrl yet) | see below | | SKIPPED (no serverUrl yet) |
| M9, M12, M19, M21 | need a second step (app switch, force-quit, open link, disable/enable) | see below | | need a second step |

Engine note from M3: on iOS, sequential HMAC over 10k paths took 223 ms and batches of 256 took 54 ms, so the engine computes path keys in batches.

iPad mini 6 is not tested (decision 2026-11-09). It runs the same iOS WebKit as the iPhone, which passed every automatic probe.

iPhone second-step results (2026-11-09):

- M9: app switch and lock fire `visibilitychange` hidden/visible, `resume`, `blur`/`focus`; no `pagehide`. The engine flushes on `visibilitychange:hidden`.
- M12: the `saveLocalStorage` marker survived a force-quit and 6.37 h idle.
- M19: the `obsidian://shuttle-enroll` handler fired from another app.
- M21: a force-quit ends the session without `onunload`. The engine must not rely on `onunload` to persist state.
- Spike bug: a server URL entered without `https://` fails with "unsupported URL". The plugin settings must add the scheme or reject the value.

iPhone server probes away from home (2026-11-09 10:03 UTC, cellular assumed; the probe cannot read the network type on iOS), via the public hostname on port 6984 (router -> DSM reverse proxy -> stub on 8787):

- M4: 4 MiB PUT 614 ms (201), GET 589 ms (200), hash matches. LTE limit is 8 s.
- M5: 8 MiB and 6 MiB bodies reached the stub and got its own 413 (stub cap 4195328 B); no proxy 413, so the DSM proxy passes at least 8 MiB.
- M6: `If-None-Match` returns 200 with the ETag visible (the stub never answers 304).
- M7: wss open 137 ms, welcome 152 ms, subprotocol `shuttle.1` echoed, ping RTT 10 ms. From the NAS, a 90 s idle socket stayed open after the proxy timeouts were raised to 600 s.
