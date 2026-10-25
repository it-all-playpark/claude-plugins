#!/usr/bin/env bash
# security-review-codex-result.sh - Codex 経路の security review（issue #1087）の結果ファイル（出力先の dev-flow-codex-result-<nonce>.json）を読んで判定する。
#
# 判定は _lib/scripts/security-review-codex-result.mjs（規則は _lib/security-review.mjs の codexResultVerdict）が持ち、
# このスクリプトは node を起動するだけ。node が無いときは ok:false・cleared:false を出す（判定できない入力は clear にしない）。
#
# Usage: security-review-codex-result <review_dir> <head_sha> <nonce> <binding> <prompt_sha256> <schema_sha256> <output_dir> [--issues]
# Output (stdout, JSON 1 行): {ok, cleared, reason, reviewed_sha, counts, issues, error?}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '{"ok":false,"cleared":false,"reason":null,"reviewed_sha":null,"counts":{"critical":0,"major":0,"minor":0},"issues":[],"error":"node_unavailable"}'
    exit 0
fi

exec node "$SCRIPT_DIR/../../_lib/scripts/security-review-codex-result.mjs" "$@"
