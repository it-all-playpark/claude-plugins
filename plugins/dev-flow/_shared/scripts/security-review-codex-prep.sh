#!/usr/bin/env bash
# security-review-codex-prep.sh - Codex 経路の security review（issue #1087）の入力（prompt.md・schema.json・空の作業ディレクトリ）を
# 保存先に用意する。
#
# 処理は _lib/scripts/security-review-codex-prep.mjs（prompt・schema は _lib/security-review.mjs）が持ち、このスクリプトは
# node を起動するだけ。node が無いときは ok:false を出す（workflow は Claude 経路の判定に倒す）。
#
# Usage: security-review-codex-prep <review_dir> <head_sha> <pr> <output_dir> [--verify-from <prev_nonce>]
# Output (stdout, JSON 1 行): {ok, review_dir, cwd_dir, nonce, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"review_dir":null,"cwd_dir":null,"error":"node_unavailable"}'
    exit 0
fi

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-codex-prep.mjs" "$@"
