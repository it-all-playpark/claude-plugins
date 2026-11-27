#!/usr/bin/env bash
# issue-blockers.sh - issue の blocker を GitHub issue dependencies API と本文の `Blocked by` 行の和集合で返す
#
# Usage: issue-blockers.sh --issue <N> [--repo <owner/name>]
#
# 出力（exit 0）: blockers JSON 配列を stdout に 1 行
#   [{repo, number, state: "OPEN"|"CLOSED", source: "api"|"body", url}]
# 失敗（exit 1）: 理由 1 行を stderr（取得・状態読み取りの失敗は全て失敗 — 黙って素通りさせると
# 未準備の issue に着手してしまうので、呼び出し側は fail-closed に倒す）
#
# blocker 判定の唯一の実装。dev-flow prerun（prerun-analyze.sh）と dev-flow-ready-set が共有する —
# 写しを持つと判定がずれる。
#
# API だけだと本文で依存を書いた issue を、本文だけだと API で依存を張った issue を取りこぼすので両方読む。
# 本文は issue の全文を読む（末尾の Blocked by 行を落とさない）。読み取りのみ（リモートに書き込まない）。
# gh の応答は gh_stdout（_shared/scripts/gh-stdout.sh）で stdout だけを JSON として読み、成否は gh の exit code で
# 決める。gh が失敗したときは stderr を理由に載せて失敗に倒す。stdout が不正な JSON のときも JSON の検証で失敗に倒れる。

set -euo pipefail

# shellcheck source=../../_shared/scripts/gh-stdout.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../_shared/scripts/gh-stdout.sh"

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 127; }

ISSUE=""
REPO=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue) [[ $# -ge 2 ]] || { echo "--issue requires a value" >&2; exit 2; }; ISSUE="$2"; shift 2 ;;
        --repo) [[ $# -ge 2 ]] || { echo "--repo requires a value" >&2; exit 2; }; REPO="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done
[[ "$ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "--issue must be a positive integer" >&2; exit 2; }

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

oneline() { printf '%s' "$1" | tr '\n' ' '; }

API_REPO="${REPO:-}"
# gh api は {owner}/{repo} をカレント repo に展開する（--repo 省略時）
[[ -n "$API_REPO" ]] || API_REPO='{owner}/{repo}'
if ! DEPS_RAW="$(gh_stdout api "repos/${API_REPO}/issues/${ISSUE}/dependencies/blocked_by?per_page=100")"; then
    fail "blocked_by: dependencies API の取得に失敗: $(oneline "$DEPS_RAW")"
fi
API_BLOCKERS="$(printf '%s' "$DEPS_RAW" | jq -c '
    if type == "array" and all(.[]; (.number | type) == "number" and (.state | type) == "string" and (.html_url | type) == "string")
    then [.[] | {repo: (.html_url | capture("^https://[^/]+/(?<r>[^/]+/[^/]+)/issues/").r // ""), number, state: (.state | ascii_upcase), source: "api", url: .html_url}]
    else error("malformed") end' 2>/dev/null)" \
    || fail "blocked_by: dependencies API の応答が不正（issue の配列でない）"

ISSUE_VIEW_ARGS=(issue view "$ISSUE")
[[ -n "$REPO" ]] && ISSUE_VIEW_ARGS+=(--repo "$REPO")
if ! BODY_RAW="$(gh_stdout "${ISSUE_VIEW_ARGS[@]}" --json body)"; then
    fail "blocked_by: issue 本文の取得に失敗: $(oneline "$BODY_RAW")"
fi
FULL_BODY="$(printf '%s' "$BODY_RAW" | jq -r '.body // ""' 2>/dev/null)" \
    || fail "blocked_by: issue 本文の応答が不正"

# 行頭（箇条書き可）の `Blocked by` 行から `#N` / `owner/repo#N` を拾う（大文字小文字は問わない）
BODY_REFS="$(printf '%s\n' "$FULL_BODY" \
    | { grep -iE '^[[:space:]]*([-*][[:space:]]+)?blocked by([[:space:]]|:)' || true; } \
    | { grep -oE '([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+' || true; } \
    | awk '!seen[$0]++')"
BODY_BLOCKERS='[]'
while IFS= read -r REF; do
    [[ -z "$REF" ]] && continue
    REF_REPO="${REF%#*}"
    REF_NUM="${REF##*#}"
    VIEW_ARGS=(issue view "$REF_NUM")
    if [[ -n "$REF_REPO" ]]; then
        VIEW_ARGS+=(--repo "$REF_REPO")
    elif [[ -n "$REPO" ]]; then
        VIEW_ARGS+=(--repo "$REPO")
    fi
    if ! REF_RAW="$(gh_stdout "${VIEW_ARGS[@]}" --json number,state,url)"; then
        fail "blocked_by: 本文の Blocked by ${REF} の状態を取得できない: $(oneline "$REF_RAW")"
    fi
    BODY_BLOCKERS="$(printf '%s' "$REF_RAW" | jq -c --argjson acc "$BODY_BLOCKERS" --argjson n "$REF_NUM" '
        if (.state | type) == "string" and (.url | type) == "string"
        then $acc + [{repo: (.url | capture("^https://[^/]+/(?<r>[^/]+/[^/]+)/issues/").r // ""), number: $n, state: (.state | ascii_upcase), source: "body", url: .url}]
        else error("malformed") end' 2>/dev/null)" \
        || fail "blocked_by: 本文の Blocked by ${REF} の応答が不正"
done <<<"$BODY_REFS"

# 和集合（同じ repo#number は API 由来を残す）
jq -cn --argjson a "$API_BLOCKERS" --argjson b "$BODY_BLOCKERS" '
    reduce ($a + $b)[] as $x ([]; if any(.[]; .repo == $x.repo and .number == $x.number) then . else . + [$x] end)'
