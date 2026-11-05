#!/usr/bin/env bash
# merge-tier-facts.sh - dev-flow Merge tier 統合 composition wrapper (issue #637).
#
# Purpose: dev-flow の Merge tier phase が個別 exec-proxy spawn で取得していた read-only
# 事実 6 種 (diff-hash-merge / danger-grep-final / changed-files / gh-pr-view /
# head-tree-oid / ci-checks) と PR body の `Closes #<issue>` 有無 (closes。issue #824) を
# 1 回のスクリプト実行で取得して 1 つの JSON に束ねる。
# 既存スクリプト (worktree-diff-hash.sh / diff-risk-classify.sh) とローカル read-only git を順に
# 呼び出して集約するのみで、各スクリプトの判定ロジックは複製しない。
#
# 認証付き network I/O (gh) は本スクリプト内に持たない (.claude/rules/dev-flow.md の exec-proxy 制約。
# check-ci と同じ precedent): `gh pr view` は呼び出し側 subagent が gh を先頭
# トークンとする bare 単文で実行し、その stdout を --pr-view-data / --checks-data / --closes-data の
# argv で verbatim 転写する。本スクリプトはその argv 入力とローカル git の純変換に留まる。
# PR body は subagent 側が `gh pr view --json body --jq` で true / false に畳んでから渡す — 本文そのものを
# argv や prompt に載せない (本文の転写ゆれで Closes 行を見落とす偽 HOLD を防ぐ。issue #713 / #824)。
# 書き込み系コマンド (fetch / pull / comment / commit) は一切発行しない。
#
# Usage: merge-tier-facts.sh --worktree <abs-path> --base <ref> \
#          [--pr-view-data '<gh pr view --json mergeable,mergeStateStatus,headRefOid の stdout>'] \
#          [--checks-data '<gh pr view --json statusCheckRollup --jq (判定に要るキーへの畳み込み) の stdout>'] \
#          [--closes-data '<gh pr view --json body --jq '.body | test("Closes #<issue>(\\D|$)")' の stdout>']
#   --base は完全修飾 ref (例: origin/main)。呼び出し側 (dev-flow.js) が origin/ を付けて渡す。
#   --pr-view-data / --checks-data / --closes-data は gh の stdout が空だった場合に省略してよい (省略は ok:false)。
#
# Output (stdout, JSON 1 行)。サブ結果は全て {ok, value, error?} で、1 つの失敗は他へ波及しない:
#   diffhash  - worktree-diff-hash.sh <wt> <base> の出力 ({hash, empty, epoch})
#   risk      - diff-risk-classify.sh <base> (cwd=<wt>) の出力 ({ok, hits, ...})。
#               スクリプトが ok:false を報告した場合も value にそのまま載る (ok:true)。
#               stdout が空 / JSON 不正のときのみ ok:false
#               diffhash / risk の error には子スクリプトの stderr 先頭 300 byte を添える (空なら付けない)
#   changed   - `git diff --name-only <base>...HEAD` の各行 ({files: [...]})
#   pr        - --pr-view-data の JSON object から抽出 ({mergeable, mergeStateStatus, headRefOid})。
#               省略 / JSON object でないときは ok:false
#   head_tree - `git rev-parse <pr.headRefOid>^{tree}` ({tree})。pr が取得できないか headRefOid が
#               40hex でないときは ok:false (skipped)
#   checks    - --checks-data の rollup を ci-rollup.jq (check-ci.sh と同じ分類の定義) で写した
#               ({checks: [{name, bucket}, ...]})。null は空配列と同じ。省略 / ci-rollup.jq が受理しないときは ok:false
#   closes    - --closes-data が `true` / `false` (前後の空白は除く) のとき ({present: <bool>})。
#               省略 / それ以外の値は ok:false (取得失敗。Closes 欠落 = present:false とは区別する)
#   epoch     - `date +%s` (clock mark 給電用。取得失敗は null)
#
# 呼び出し側 (dev-flow.js の parseMergeTierFacts) がサブ結果ごとに fail-closed (risk) /
# fail-open (それ以外) を判定する。本スクリプトは判定しない。
#
# Exit: 0 が既定。usage error (引数不正・worktree パス不在) は非0 exit だが、その場合も stdout
# には全サブ結果 ok:false の JSON を出す。jq 不在時は全 degrade JSON で exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

SUB_KEYS=(diffhash risk changed pr head_tree checks closes)

# 全サブ結果を同一 error で ok:false にした degrade JSON を出す (jq 非依存)
emit_degrade() {
    local msg="$1" esc first=1 k
    esc="$(json_str "$msg")"
    printf '{'
    for k in "${SUB_KEYS[@]}"; do
        [[ $first -eq 1 ]] || printf ','
        first=0
        printf '"%s":{"ok":false,"value":null,"error":%s}' "$k" "$esc"
    done
    printf ',"epoch":%s}\n' "$(date +%s 2>/dev/null || echo null)"
}

usage_error() {
    emit_degrade "$1"
    exit 2
}

# ============================================================================
# Args
# ============================================================================

WT=""
BASE=""
PR_VIEW_DATA=""
HAVE_PR_VIEW_DATA=false
CHECKS_DATA=""
HAVE_CHECKS_DATA=false
CLOSES_DATA=""
HAVE_CLOSES_DATA=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree)     [[ $# -ge 2 ]] || usage_error "--worktree requires a value"; WT="$2"; shift 2 ;;
        --base)         [[ $# -ge 2 ]] || usage_error "--base requires a value"; BASE="$2"; shift 2 ;;
        --pr-view-data) [[ $# -ge 2 ]] || usage_error "--pr-view-data requires a value"; PR_VIEW_DATA="$2"; HAVE_PR_VIEW_DATA=true; shift 2 ;;
        --checks-data)  [[ $# -ge 2 ]] || usage_error "--checks-data requires a value"; CHECKS_DATA="$2"; HAVE_CHECKS_DATA=true; shift 2 ;;
        --closes-data)  [[ $# -ge 2 ]] || usage_error "--closes-data requires a value"; CLOSES_DATA="$2"; HAVE_CLOSES_DATA=true; shift 2 ;;
        *) usage_error "unknown option: $1" ;;
    esac
done

[[ -n "$WT" ]] || usage_error "usage: merge-tier-facts.sh --worktree <abs-path> --base <ref> [--pr-view-data <json>] [--checks-data <json>] [--closes-data <true|false>]"
[[ "$WT" == /* ]] || usage_error "--worktree must be an absolute path"
[[ -d "$WT" ]] || usage_error "worktree path does not exist: $WT"
[[ -n "$BASE" ]] || usage_error "--base is required"
[[ "$BASE" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || usage_error "--base contains invalid characters"

# ============================================================================
# jq availability (サブ出力の妥当性検証と最終 JSON 組み立ての両方に必須)
# ============================================================================

if ! has_jq; then
    emit_degrade "jq_not_installed"
    exit 0
fi

# サブ結果の組み立て。ok_result <json-object> / err_result <message>
ok_result()  { jq -nc --argjson v "$1" '{ok: true, value: $v}'; }
err_result() { jq -nc --arg e "$1" '{ok: false, value: null, error: $e}'; }

is_json_object() { printf '%s' "$1" | jq -e 'type == "object"' >/dev/null 2>&1; }

# 子スクリプトの stderr は捨てずに一時ファイルへ受け、失敗時だけ先頭 300 byte を error に添える
# (exit code だけでは git の fatal 文など原因を回収できない)。
stderr_tmp="$(mktemp "${TMPDIR:-/tmp}/merge-tier-facts-stderr.XXXXXX")"
trap 'rm -f "$stderr_tmp"' EXIT

# with_stderr <message>: stderr_tmp が空でなければ "<message>: <stderr 先頭 300 byte>"、空なら <message>
with_stderr() {
    local head
    head="$(head -c 300 "$stderr_tmp" 2>/dev/null || true)"
    if [[ -n "$head" ]]; then
        printf '%s: %s' "$1" "$head"
    else
        printf '%s' "$1"
    fi
}

# ============================================================================
# 1. diffhash = worktree-diff-hash.sh <wt> <base>
# ============================================================================

set +e
diffhash_out="$(bash "$SCRIPT_DIR/worktree-diff-hash.sh" "$WT" "$BASE" 2>"$stderr_tmp")"
diffhash_rc=$?
set -e
if [[ $diffhash_rc -eq 0 ]] && is_json_object "$diffhash_out" \
    && printf '%s' "$diffhash_out" | jq -e '(.hash | type) == "string"' >/dev/null 2>&1; then
    diffhash_json="$(ok_result "$diffhash_out")"
else
    diffhash_json="$(err_result "$(with_stderr "worktree-diff-hash.sh failed (exit ${diffhash_rc})")")"
fi

# ============================================================================
# 2. risk = diff-risk-classify.sh <base> (cwd=<wt>。committed diff 対象 — 従来の danger-grep-final と同一)
# ============================================================================

set +e
risk_out="$(cd "$WT" && bash "$SCRIPT_DIR/diff-risk-classify.sh" "$BASE" 2>"$stderr_tmp")"
risk_rc=$?
set -e
if is_json_object "$risk_out" \
    && printf '%s' "$risk_out" | jq -e '(.ok | type) == "boolean" and (.hits | type) == "array"' >/dev/null 2>&1; then
    risk_json="$(ok_result "$risk_out")"
else
    risk_json="$(err_result "$(with_stderr "diff-risk-classify.sh produced no valid JSON output (exit ${risk_rc})")")"
fi

# ============================================================================
# 3. changed = git diff --name-only <base>...HEAD
# ============================================================================

set +e
changed_out="$(git -C "$WT" diff --name-only "${BASE}...HEAD" 2>&1)"
changed_rc=$?
set -e
if [[ $changed_rc -eq 0 ]]; then
    changed_files="$(printf '%s\n' "$changed_out" | jq -R -s -c 'split("\n") | map(select(length > 0))')"
    changed_json="$(ok_result "$(jq -nc --argjson f "$changed_files" '{files: $f}')")"
else
    changed_json="$(err_result "git diff --name-only failed: ${changed_out}")"
fi

# ============================================================================
# 4. pr = --pr-view-data (gh pr view --json mergeable,mergeStateStatus,headRefOid の stdout 転写) の純変換
# ============================================================================

head_ref_oid=""
if [[ "$HAVE_PR_VIEW_DATA" != true ]]; then
    pr_json="$(err_result "pr view data not provided (--pr-view-data omitted: gh pr view stdout was empty or the command failed)")"
elif is_json_object "$PR_VIEW_DATA"; then
    pr_value="$(printf '%s' "$PR_VIEW_DATA" | jq -c '{mergeable: (.mergeable // null), mergeStateStatus: (.mergeStateStatus // null), headRefOid: (.headRefOid // null)}')"
    pr_json="$(ok_result "$pr_value")"
    head_ref_oid="$(printf '%s' "$pr_value" | jq -r '.headRefOid // ""')"
else
    pr_json="$(err_result "pr view data is not a JSON object: $(printf '%s' "$PR_VIEW_DATA" | head -c 300)")"
fi

# ============================================================================
# 5. head_tree = git rev-parse <headRefOid>^{tree} (pr 取得成功時のみ。fetch はしない)
# ============================================================================

if [[ "$head_ref_oid" =~ ^[0-9a-fA-F]{40}$ ]]; then
    set +e
    tree_out="$(git -C "$WT" rev-parse "${head_ref_oid}^{tree}" 2>&1)"
    tree_rc=$?
    set -e
    if [[ $tree_rc -eq 0 && "$tree_out" =~ ^[0-9a-f]{40}$ ]]; then
        head_tree_json="$(ok_result "$(jq -nc --arg t "$tree_out" '{tree: $t}')")"
    else
        head_tree_json="$(err_result "git rev-parse ${head_ref_oid}^{tree} failed: $(printf '%s' "$tree_out" | head -c 300)")"
    fi
else
    head_tree_json="$(err_result "skipped: pr headRefOid unavailable")"
fi

# ============================================================================
# 6. checks = --checks-data (gh pr view --json statusCheckRollup の stdout 転写) の純変換
# ============================================================================

if [[ "$HAVE_CHECKS_DATA" != true ]]; then
    checks_json="$(err_result "checks data not provided (--checks-data omitted: gh pr view --json statusCheckRollup stdout was empty or the command failed)")"
elif checks_rollup="$(printf '%s' "$CHECKS_DATA" | jq -ce -f "$SCRIPT_DIR/ci-rollup.jq" 2>/dev/null)"; then
    checks_json="$(ok_result "$(jq -nc --argjson c "$checks_rollup" '{checks: ($c | map({name, bucket}))}')")"
else
    checks_json="$(err_result "checks data is not a JSON array: $(printf '%s' "$CHECKS_DATA" | head -c 300)")"
fi

# ============================================================================
# 7. closes = --closes-data (gh pr view --json body --jq '.body | test("Closes #<issue>(\\D|$)")' の stdout 転写)
# ============================================================================

if [[ "$HAVE_CLOSES_DATA" != true ]]; then
    closes_json="$(err_result "closes data not provided (--closes-data omitted: gh pr view --json body stdout was empty or the command failed)")"
else
    closes_trimmed="$(printf '%s' "$CLOSES_DATA" | tr -d '[:space:]')"
    if [[ "$closes_trimmed" == "true" || "$closes_trimmed" == "false" ]]; then
        closes_json="$(ok_result "$(jq -nc --argjson p "$closes_trimmed" '{present: $p}')")"
    else
        closes_json="$(err_result "closes data is not true/false: $(printf '%s' "$CLOSES_DATA" | head -c 300)")"
    fi
fi

# ============================================================================
# JSON emission
# ============================================================================

epoch="$(date +%s 2>/dev/null || echo null)"

jq -nc \
    --argjson diffhash "$diffhash_json" \
    --argjson risk "$risk_json" \
    --argjson changed "$changed_json" \
    --argjson pr "$pr_json" \
    --argjson head_tree "$head_tree_json" \
    --argjson checks "$checks_json" \
    --argjson closes "$closes_json" \
    --argjson epoch "$epoch" \
    '{diffhash: $diffhash, risk: $risk, changed: $changed, pr: $pr, head_tree: $head_tree, checks: $checks, closes: $closes, epoch: $epoch}'

exit 0
