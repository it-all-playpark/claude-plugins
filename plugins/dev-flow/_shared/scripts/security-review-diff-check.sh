#!/usr/bin/env bash
# security-review-diff-check.sh - security review の保存先の pr.diff が security-review-scope --save-diff の書いた diff のままかを
# 照合する（issue #1095）。
#
# 照合は _lib/scripts/security-review-diff-check.mjs が持ち、このスクリプトは node を起動するだけ。node が無いときは
# ok:false・matched:false を出す（照合できない入力で clear にしない）。
#
# Usage: security-review-diff-check <review_dir> <diff_sha256> <diff_ino> <diff_ctime_ns> <dir_ino> <dir_ctime_ns>
# Output (stdout, JSON 1 行): {ok, matched, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"matched":false,"error":"node_unavailable"}'
    exit 0
fi

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-diff-check.mjs" "$@"
