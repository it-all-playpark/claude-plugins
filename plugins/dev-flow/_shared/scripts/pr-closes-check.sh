#!/usr/bin/env bash
# pr-closes-check.sh - PR 本文に `Closes #<issue>` があるかを gh pr view 1 回で取り、true / false だけを stdout に出す。
#
# Purpose: dev-flow Merge tier の closes-reinject（Closes 欠落時に本文を再投入した後の再確認）が使う。
# 判定は merge-tier-facts.sh の closes サブ結果と同じ pr-closes.jq。本文そのものは stdout に出さない —
# 本文を subagent に転写させると転写のゆれで Closes 行を見落とし偽の pr_closes_missing HOLD を出す（issue #713）。
#
# Usage: pr-closes-check.sh --pr <N> [--repo <owner/repo>] --issue <N>
#   --pr / --issue は正の整数、--repo（省略時は gh が cwd の repo を使う）は owner/repo 形。
#   形式が不正なら gh を実行せずに非 0 exit。
#
# gh は読み取り専用で 1 回だけ、argv 配列で実行する（シェル文字列を組み立てない）:
#
#   gh pr view <N> [--repo <owner/repo>] --json body
#
# Output: stdout に `true` / `false` の 1 行（exit 0）。
# Exit: 引数不正・gh の失敗・body が文字列でない応答は stdout を空のまま非 0 exit（理由は stderr の JSON）。
# 取得失敗を `false`（Closes 欠落）と同一視しない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

PR=""
REPO=""
HAVE_REPO=0
ISSUE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr)    [[ $# -ge 2 ]] || die_json "--pr requires a value" 1; PR="$2"; shift 2 ;;
        --repo)  [[ $# -ge 2 ]] || die_json "--repo requires a value" 1; REPO="$2"; HAVE_REPO=1; shift 2 ;;
        --issue) [[ $# -ge 2 ]] || die_json "--issue requires a value" 1; ISSUE="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ "$PR" =~ ^[1-9][0-9]*$ ]] || die_json "Invalid --pr: $PR. Must be a positive integer" 1
[[ "$ISSUE" =~ ^[1-9][0-9]*$ ]] || die_json "Invalid --issue: $ISSUE. Must be a positive integer" 1
if (( HAVE_REPO == 1 )); then
    [[ "$REPO" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$ ]] || die_json "Invalid --repo: $REPO. Must be owner/repo" 1
fi

require_cmd jq

GH_ARGS=(pr view "$PR")
if (( HAVE_REPO == 1 )); then
    GH_ARGS+=(--repo "$REPO")
fi
GH_ARGS+=(--json body)

GH_STDERR="$(mktemp "${TMPDIR:-/tmp}/pr-closes-check-stderr.XXXXXX")"
trap 'rm -f "$GH_STDERR"' EXIT

rc=0
out="$(gh "${GH_ARGS[@]}" 2>"$GH_STDERR")" || rc=$?
if (( rc != 0 )); then
    die_json "gh pr view failed (exit $rc): $(head -c 300 "$GH_STDERR" 2>/dev/null || true)" 1
fi

present="$(printf '%s' "$out" | jq -c --arg issue "$ISSUE" -f "$SCRIPT_DIR/pr-closes.jq" 2>/dev/null)" \
    || die_json "gh pr view stdout has no string body" 1
[[ "$present" == "true" || "$present" == "false" ]] || die_json "gh pr view stdout has no string body" 1

printf '%s\n' "$present"
