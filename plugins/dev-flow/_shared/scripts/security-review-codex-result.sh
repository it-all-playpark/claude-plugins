#!/usr/bin/env bash
# security-review-codex-result.sh - Codex 経路の security review（issue #1087）の結果ファイル（保存先の result.json）を読んで判定する。
#
# 判定は _lib/scripts/security-review-codex-result.mjs（規則は _lib/security-review.mjs の codexResultVerdict）が持ち、
# このスクリプトは node を起動するだけ。node が無いときは ok:false・cleared:false を出す（判定できない入力は clear にしない）。
#
# Usage: security-review-codex-result <review_dir> <head_sha> [--issues]
# Output (stdout, JSON 1 行): {ok, cleared, reason, reviewed_sha, counts, issues, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"cleared":false,"reason":null,"reviewed_sha":null,"counts":{"critical":0,"major":0,"minor":0},"issues":[],"error":"node_unavailable"}'
    exit 0
fi

# 起動元（Claude の desktop app など）が NODE_USE_SYSTEM_CA=1 を渡すと、sandbox の中の node は OS の trust settings を
# 読めず、起動のたびに stderr へ ERROR 行を出す。stdout の JSON を中継（security-codex-relay・dev-runner）がそのまま
# 返す契約なので変数を外して出力を stdout の JSON だけにする（この node は network に出ないので OS の CA を使わなくてよい）
unset NODE_USE_SYSTEM_CA

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-codex-result.mjs" "$@"
