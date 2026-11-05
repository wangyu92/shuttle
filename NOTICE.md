# Notices

Shuttle is licensed per package:

| Package | License |
|---|---|
| `packages/server` (`@shuttle/server`) | AGPL-3.0-only, see `LICENSE-AGPL` |
| all other packages (`shuttle` plugin, `@shuttle/engine`, `@shuttle/protocol`, `@shuttle/crypto`, `@shuttle/adapter-server`, `@shuttle/adapter-s3`, `@shuttle/headless`, `@shuttle/testkit`, `@shuttle/sim`, `@shuttle/spike`) | MIT, see `LICENSE-MIT` |

Each package also carries its own `LICENSE` file.

## Clean room

No code is taken from Obsidian LiveSync (or its commonlib) or from remotely-save. The engine is written from the behavior described in the design documents in `docs/private/design/`.

## Third-party components

| Component | License | Used by |
|---|---|---|
| diff-match-patch | Apache-2.0 | engine (bundled into plugin and headless) |
| ws | MIT | headless, server |
| fflate | MIT | crypto (fallback when `CompressionStream("deflate-raw")` is missing) |

Bundled third-party license comments are emitted next to each bundle by esbuild (`legalComments: "linked"`).
