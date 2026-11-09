#!/usr/bin/env bash
# porcelain-verdict.sh - pr-iterate の fix-baseline・commit-ensure・worktree-dirty-check の status 判定。
#
# status の実行と判定は _shared/scripts/porcelain-verdict.mjs（規則は _lib/porcelain-verdict.mjs）が持ち、
# このスクリプトは node を起動するだけ。node が無いときは判定できない側（基準線なし・dirty・回収不可）の JSON を出す。
#
# Usage: porcelain-verdict baseline | porcelain-verdict check [<baseline_digest>]
# Output (stdout, JSON 1 行): baseline → {exit_code, baseline_digest} / check → {exit_code, baseline, dirty, new_lines, recoverable, add_command}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"exit_code":127,"baseline_digest":null,"baseline":"none","dirty":true,"new_lines":[],"recoverable":false,"add_command":null}'
    exit 0
fi

exec node "$SCRIPT_DIR/porcelain-verdict.mjs" "$@"
