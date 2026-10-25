#!/usr/bin/env bash
# security-review-scope.sh - PR の diff が敵対的 security review の対象かを判定する（issue #1063）。
#
# 判定と diff の取得は _lib/scripts/security-review-scope.mjs（規則は _lib/security-review-scope.mjs）が持ち、
# このスクリプトは node を起動するだけ。node が無いときも対象（target:true）の JSON を出す（fail-closed —
# 判定できない入力を対象外と同一視しない）。
#
# Usage: security-review-scope <worktree> <base-ref> [<head-ref> | --working-tree] [--save-diff]
# Output (stdout, JSON 1 行): {ok, target, reasons, file_count, head_sha, review_dir, diff_path, diff_sha256, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"target":true,"reasons":["scope_unavailable"],"file_count":null,"head_sha":null,"review_dir":null,"diff_path":null,"diff_sha256":null,"error":"node を実行できない（PATH に node が無い）"}'
    exit 0
fi

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-scope.mjs" "$@"
