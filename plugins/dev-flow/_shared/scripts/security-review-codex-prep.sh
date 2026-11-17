#!/usr/bin/env bash
# security-review-codex-prep.sh - Codex 経路の security review（issue #1087）の入力（prompt.md・schema.json）を
# 保存先に用意する。
#
# 処理は _lib/scripts/security-review-codex-prep.mjs（prompt・schema は _lib/security-review.mjs）が持ち、このスクリプトは
# node を起動するだけ。node が無いときは ok:false を出す（workflow は Claude 経路の判定に倒す）。
#
# Usage: security-review-codex-prep <review_dir> <head_sha> <pr> [--verify-from <prev_review_dir>]
# Output (stdout, JSON 1 行): {ok, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"error":"node_unavailable"}'
    exit 0
fi

# 起動元（Claude の desktop app など）が NODE_USE_SYSTEM_CA=1 を渡すと、sandbox の中の node は OS の trust settings を
# 読めず、起動のたびに stderr へ ERROR 行を出す。stdout の JSON を中継（security-codex-relay・dev-runner）がそのまま
# 返す契約なので変数を外して出力を stdout の JSON だけにする（この node は network に出ないので OS の CA を使わなくてよい）
unset NODE_USE_SYSTEM_CA

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-codex-prep.mjs" "$@"
