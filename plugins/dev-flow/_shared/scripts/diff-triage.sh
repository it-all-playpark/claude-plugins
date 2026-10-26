#!/usr/bin/env bash
# diff-triage.sh - dev-flow Diff triage 統合 composition wrapper (issue #544, P1).
#
# Purpose: dev-flow の Diff triage phase が今まで個別に取得していた 4 exec-proxy
# (danger-grep / realized-diff / structural-classify / diff-hash-triage) 相当の情報を
# 1 回のスクリプト実行にまとめて返す薄い composition wrapper。既存 3 スクリプト
# (diff-risk-classify.sh --working-tree / structural-classify.sh / worktree-diff-hash.sh)
# + `git status --porcelain` を worktree cwd から順に呼び出して集約するのみで、各スクリプト
# の検出ロジックそのものは複製しない。
#
# Usage: diff-triage.sh <worktree-path> <base-ref>
#
# Output (stdout, JSON 1 行):
#   {"risk":<diff-risk-classify.sh の出力 object>,
#    "files":["path1",...]|null,
#    "struct":<structural-classify.sh の出力 object>|null,
#    "diffhash":<worktree-diff-hash.sh の出力 object>|null,
#    "lines":[{"path":"path1","added":N,"deleted":M},...]|null}
#
# フィールド別失敗セマンティクス (各フィールドの失敗は他フィールドへ絶対に波及しない):
#   risk     - fail-closed 用。diff-risk-classify.sh が非0 exit でも stdout に
#              {"ok":false,"hits":[...],...} を出す契約なのでそれをそのまま使う。
#              stdout が空/JSON 不正なときのみ {"ok":false,"hits":[],"error":...,
#              "exit_code":N} を合成する -- risk フィールドは決して null にしない
#              (danger-grep が hits 欠落を clean と同一視しないための fail-closed 要)。
#   files    - fail-safe 用。`git status --porcelain` 取得成功時のみ配列 (0 件は [])、
#              取得失敗は null (取得失敗と空 diff の区別を維持する -- complex floor
#              安全弁の前提)。
#   struct   - fail-open 用。structural-classify.sh の失敗 (非0 exit) / 不正 JSON は
#              null (advisory な diff 前処理のため、失敗しても deterministic gate を
#              緩めない。difft 未インストール時の available:false は正常応答として扱う)。
#   diffhash - fail-open 用。worktree-diff-hash.sh の失敗 (このスクリプトはエラー時に
#              JSON を出さず exit 1 するだけの契約) は null (stale 検出の補助信号のため)。
#   lines    - fail-safe 用 (classifyShape の行数補正の入力、issue #740)。tracked 変更は
#              `git diff --numstat --no-renames HEAD` (implementer は未コミットなので HEAD との差分が
#              realized diff)、untracked file は `wc -l` を追加行として数える (`git add -N` で index を
#              触らない)。binary (numstat が "-") と読めない untracked file は要素を出さない
#              -- その file の行数が欠けると呼び出し側が補正を諦めて file 数判定に戻る。numstat 自体の
#              失敗は null。
#
# Exit: 0 が既定。usage error (引数不足・worktree パス不在) のみ非0 exit 可
# (この場合も stdout には risk:{"ok":false,...}, files/struct/diffhash:null の
# JSON を出す -- fail-closed 安全側)。jq 不在時も exit 0
# (risk.ok:false, error:"jq_not_installed" の全 degrade JSON、fail-closed 安全側)。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

emit_degrade() {
    # $1: risk JSON object (raw, already-complete JSON text). files/struct/diffhash/lines
    # は常に null (usage error / jq 不在は risk 以外の全フィールドが取得不能なため)。
    printf '{"risk":%s,"files":null,"struct":null,"diffhash":null,"lines":null}\n' "$1"
}

usage_error() {
    local msg="$1"
    local code="${2:-2}"
    emit_degrade "$(printf '{"ok":false,"hits":[],"error":%s,"exit_code":%s}' "$(json_str "$msg")" "$code")"
    exit "$code"
}

# ============================================================================
# Args
# ============================================================================

wt="${1:-}"
base="${2:-}"

if [[ -z "$wt" || -z "$base" ]]; then
    usage_error "usage: diff-triage.sh <worktree-path> <base-ref>" 2
fi

if [[ ! -d "$wt" ]]; then
    usage_error "worktree path does not exist: $wt" 2
fi

# ============================================================================
# jq availability (sub-output の妥当性検証と最終 JSON 組み立ての両方に必須)
# ============================================================================

if ! has_jq; then
    emit_degrade '{"ok":false,"hits":[],"error":"jq_not_installed","exit_code":127}'
    exit 0
fi

# ============================================================================
# 1. risk = diff-risk-classify.sh --working-tree <base-ref> (worktree cwd で実行)
# ============================================================================

RISK_SCRIPT="$SCRIPT_DIR/diff-risk-classify.sh"

set +e
risk_out="$(cd "$wt" && bash "$RISK_SCRIPT" --working-tree "$base" 2>/dev/null)"
risk_rc=$?
set -e

if [[ -n "$risk_out" ]] && printf '%s' "$risk_out" | jq -e . >/dev/null 2>&1; then
    risk_json="$risk_out"
else
    risk_json="$(printf '{"ok":false,"hits":[],"error":%s,"exit_code":%s}' \
        "$(json_str "diff-risk-classify.sh produced no valid JSON output")" "$risk_rc")"
fi

# ============================================================================
# 2. files = `git status --porcelain --untracked-files=all` の直接パース
# ============================================================================

set +e
files_raw="$(git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null)"
files_rc=$?
set -e

if [[ $files_rc -ne 0 ]]; then
    files_json="null"
else
    files_list=""
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        # 各行は "XY<space>path" (rename: "XY<space>old -> new")。先頭3文字
        # (status 2文字 + 区切り空白1文字) を除去してパス部分のみを残す。
        path="${line:3}"
        if [[ "$path" == *" -> "* ]]; then
            path="${path##* -> }"
        fi
        [[ -z "$path" ]] && continue
        files_list="${files_list}${path}"$'\n'
    done <<< "$files_raw"
    files_list="${files_list%$'\n'}"
    if [[ -z "$files_list" ]]; then
        files_json="[]"
    else
        files_json="$(printf '%s\n' "$files_list" | jq -R -s -c 'split("\n") | map(select(length > 0))')"
    fi
fi

# ============================================================================
# 2b. lines = file ごとの追加・削除行数 (tracked: numstat / untracked: wc -l)
# ============================================================================

lines_json="null"
if [[ $files_rc -eq 0 ]]; then
    set +e
    numstat_raw="$(git -C "$wt" diff --numstat --no-renames HEAD 2>/dev/null)"
    numstat_rc=$?
    set -e
    if [[ $numstat_rc -eq 0 ]]; then
        lines_tsv=""
        while IFS=$'\t' read -r added deleted path; do
            [[ -z "$path" ]] && continue
            # binary は "-<TAB>-" -- 行数が無いので要素を出さない
            [[ "$added" =~ ^[0-9]+$ && "$deleted" =~ ^[0-9]+$ ]] || continue
            lines_tsv+="${path}"$'\t'"${added}"$'\t'"${deleted}"$'\n'
        done <<< "$numstat_raw"
        while IFS= read -r line; do
            [[ "$line" == '?? '* ]] || continue
            path="${line:3}"
            [[ -f "$wt/$path" ]] || continue
            n="$(wc -l < "$wt/$path" 2>/dev/null | tr -d ' ')" || continue
            [[ "$n" =~ ^[0-9]+$ ]] || continue
            lines_tsv+="${path}"$'\t'"${n}"$'\t'"0"$'\n'
        done <<< "$files_raw"
        lines_json="$(printf '%s' "$lines_tsv" | jq -R -s -c '
            split("\n") | map(select(length > 0) | split("\t")
              | {path: .[0], added: (.[1] | tonumber), deleted: (.[2] | tonumber)})')"
    fi
fi

# ============================================================================
# 3. struct = structural-classify.sh <worktree-path> <base-ref>
# ============================================================================

STRUCT_SCRIPT="$SCRIPT_DIR/structural-classify.sh"

set +e
struct_out="$(bash "$STRUCT_SCRIPT" "$wt" "$base" 2>/dev/null)"
struct_rc=$?
set -e

if [[ $struct_rc -eq 0 && -n "$struct_out" ]] && printf '%s' "$struct_out" | jq -e . >/dev/null 2>&1; then
    struct_json="$struct_out"
else
    struct_json="null"
fi

# ============================================================================
# 4. diffhash = worktree-diff-hash.sh <worktree-path> <base-ref>
# ============================================================================

DIFFHASH_SCRIPT="$SCRIPT_DIR/worktree-diff-hash.sh"

set +e
diffhash_out="$(bash "$DIFFHASH_SCRIPT" "$wt" "$base" 2>/dev/null)"
diffhash_rc=$?
set -e

if [[ $diffhash_rc -eq 0 && -n "$diffhash_out" ]] && printf '%s' "$diffhash_out" | jq -e . >/dev/null 2>&1; then
    diffhash_json="$diffhash_out"
else
    diffhash_json="null"
fi

# ============================================================================
# JSON emission
# ============================================================================

jq -nc \
    --argjson risk "$risk_json" \
    --argjson files "$files_json" \
    --argjson struct "$struct_json" \
    --argjson diffhash "$diffhash_json" \
    --argjson lines "$lines_json" \
    '{risk: $risk, files: $files, struct: $struct, diffhash: $diffhash, lines: $lines}'

exit 0
