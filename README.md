# Shuttle

End-to-end encrypted sync for Obsidian vaults through your own server or S3-compatible storage.
The goal is feature, performance and usability parity with Obsidian Sync, plus support for more than one kind of remote.

Status: pre-alpha (P0). Nothing here is ready for real vaults.

## What is in this repo

| Package | Purpose |
| --- | --- |
| `packages/crypto` | Encryption suite on WebCrypto, with test vectors and an independent Python cross-check |
| `packages/protocol` | Wire types and validators |
| `packages/server` | Sync server (AGPL-3.0-only), currently a development stub |
| `packages/spike` | Platform probe plugin used to measure mobile limits. Install it only in a throwaway test vault |
| other packages | Engine, adapters, plugin, headless client, simulator (placeholders until P1) |

## BRAT (P0 only)

During P0 the root `manifest.json` points at the spike plugin (`shuttle-spike`), so BRAT installs the probe plugin from this repo's releases.
Never install it in a vault you care about.

## Network use

The spike plugin contacts only the server URL you type into its settings. Shuttle has no telemetry.

## License

MIT for everything except `packages/server`, which is AGPL-3.0-only. See `LICENSE-MIT`, `LICENSE-AGPL` and `NOTICE.md`.
