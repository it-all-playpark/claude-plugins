#!/usr/bin/env bash
# security-review-isolated.sh - 指示ファイルを変える PR の security review を、PR の worktree に入らない別の claude -p
# プロセスで人が回す CLI（issue #1083）。
#
# 手順と判定は _lib/scripts/security-review-isolated.mjs（prompt・schema・判定は _lib/security-review.mjs）が持ち、
# このスクリプトは node を起動するだけ。人が Anthropic API に通信できるシェルで起動する（workflow・exec-proxy・subagent
# からは呼ばない）。結果は stdout にだけ出し、gate には戻さない。
#
# Usage: security-review-isolated <PR番号> [--repo owner/repo]   （repo の checkout の中で実行する）
# exit: 0 = clear / 1 = critical か major が残る / 2 = 判定できない（clear とは出さない）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '判定: 判定できない（node を実行できない — PATH に node が無い）'
    exit 2
fi

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-isolated.mjs" "$@"
