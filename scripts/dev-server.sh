#!/usr/bin/env bash
# Build and run the P0 dev server stub (design §9 P0, §2.8).
# Env: SHUTTLE_PORT (8787), SHUTTLE_HOST (127.0.0.1), SHUTTLE_DATA (~/tmp/claude/shuttle-dev-data).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=env.sh
source scripts/env.sh
npm run --silent build:server
exec node --disable-warning=ExperimentalWarning dist/server/shuttle-server.mjs "$@"
