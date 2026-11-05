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
