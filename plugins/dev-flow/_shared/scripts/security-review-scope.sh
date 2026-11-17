#!/usr/bin/env bash
# security-review-scope.sh - PR の diff が敵対的 security review の対象かを判定する（issue #1063）。
#
# 判定と diff の取得は _lib/scripts/security-review-scope.mjs（規則は _lib/security-review-scope.mjs）が持ち、
# このスクリプトは node を起動するだけ。node が無いときも対象（target:true）の JSON を出す（fail-closed —
# 判定できない入力を対象外と同一視しない）。
#
# Usage: security-review-scope <worktree> <base-ref> [<head-ref> | --working-tree] [--save-diff]
# Output (stdout, JSON 1 行): {ok, target, reasons, file_count, head_sha, reviewer_context_changed, review_dir, diff_path, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"target":true,"reasons":["scope_unavailable"],"file_count":null,"head_sha":null,"review_dir":null,"diff_path":null,"error":"node を実行できない（PATH に node が無い）"}'
    exit 0
fi

# 起動元（Claude の desktop app など）が NODE_USE_SYSTEM_CA=1 を渡すと、sandbox の中の node は OS の trust settings を
# 読めず、起動のたびに stderr へ ERROR 行を出す。stdout の JSON を中継（security-codex-relay・dev-runner）がそのまま
# 返す契約なので変数を外して出力を stdout の JSON だけにする（この node は network に出ないので OS の CA を使わなくてよい）
unset NODE_USE_SYSTEM_CA

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-scope.mjs" "$@"
