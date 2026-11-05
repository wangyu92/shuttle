# Source before any npm or node command: `source scripts/env.sh`
export PATH="$HOME/miniconda3/envs/node22/bin:$PATH"
export TMPDIR="$HOME/tmp/claude/shuttle-tmp"
export npm_config_cache="$HOME/.npm"
export SHUTTLE_TEST_TMP="$HOME/tmp/claude/shuttle-test"
mkdir -p "$TMPDIR" "$SHUTTLE_TEST_TMP"
