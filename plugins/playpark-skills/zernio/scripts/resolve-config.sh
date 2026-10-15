#!/usr/bin/env bash
# resolve-config.sh - Resolve zernio profile_id / sync_dirs
# Usage: resolve-config.sh
#
# Reads the zernio section via load_skill_config (global → project merge, project
# resolved from the git root of the CWD), so calling from a subdirectory never loses
# sync_dirs. A missing sync_dirs entry makes `zernio sync --execute` DELETE that
# directory's posts from the API.
#
# Output (1 line JSON): {"profile_id": <string|null>, "sync_dirs": [<absolute path>...]}
# Relative sync_dirs are resolved against the git root (CWD when outside a git repo).

set -euo pipefail

# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

require_cmd jq

CONFIG=$(load_skill_config "zernio")

BASE_DIR="$(git_root)"
[[ -n "$BASE_DIR" ]] || BASE_DIR="$PWD"

echo "$CONFIG" | jq -c --arg base "$BASE_DIR" '{
  profile_id: (if (.profile_id // "") == "" then null else .profile_id end),
  sync_dirs: [(.sync_dirs // [])[] | if startswith("/") then . else $base + "/" + ltrimstr("./") end]
}'
