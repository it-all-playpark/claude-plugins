#!/usr/bin/env bash
# ensure-worktree-deps.sh - Non-blocking install wrapper for worktree setup (issue #120)
#
# Purpose: Called after a worktree is confirmed (WT established), attempts dependency
# installation without blocking the dev-flow Setup phase. Even if install fails, this
# script exits 0 — the failure is visible in the JSON output (status partial/failed),
# and the downstream Validate (test-green) loop acts as the second safety net.
#
# Usage: ensure-worktree-deps.sh --path <dir> [--lockfile-only] [--skip-custom]
#        ensure-worktree-deps.sh --setup <prerun-setup.json>
#
# --lockfile-only / --skip-custom are forwarded verbatim to detect-and-install.sh
# (see that script for semantics).
#
# --setup (issue #868): dev-flow wrapper (dev-flow/SKILL.md) の deps 段。dev-flow-prerun が書いた
# <WT>/.devflow-tmp/prerun-setup.json を読み、その worktree に `--lockfile-only --skip-custom` で install して、
# setup に deps（{ok, note}）と epoch_end（install 完了後の時刻）を足し、hooks_not_running を install 後の状態で
# 上書きした JSON 1 行を stdout に出す。wrapper は
# これをそのまま Workflow の args.setup に渡す。wrapper は prerun とは別の Bash 呼び出しでこれを実行する —
# install は依存の postinstall（repo の任意コード）を走らせるので、repo の任意コードを実行しない prerun の子にしない。
# setup が読めない・ok:true でない・worktree が無いときは stderr に理由を出して exit 2（stdout 空）。
# deps の失敗は advisory（deps.ok:false + note）で exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TARGET_PATH=""
SETUP_FILE=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path) TARGET_PATH="$2"; shift 2 ;;
        --setup) SETUP_FILE="$2"; shift 2 ;;
        --lockfile-only) EXTRA_ARGS+=("--lockfile-only"); shift ;;
        --skip-custom) EXTRA_ARGS+=("--skip-custom"); shift ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [[ -n "$SETUP_FILE" ]]; then
    if [[ -n "$TARGET_PATH" || ${#EXTRA_ARGS[@]} -gt 0 ]]; then
        echo "--setup cannot be combined with --path / --lockfile-only / --skip-custom" >&2
        exit 2
    fi
elif [[ -z "$TARGET_PATH" ]]; then
    echo "--path or --setup is required" >&2
    exit 2
fi

# ============================================================================
# Delegate to detect-and-install.sh (single source of truth for install logic)
# Idempotency, pm detection, and already_installed checks are all in that script.
#
# Error handling:
#   - Temporarily disable set -e to prevent this wrapper from aborting on
#     a non-zero exit from the delegate (non-blocking contract).
#   - Capture stdout, stderr, and exit code separately via temp files.
#   - If the delegate hard-crashes (nonexistent path, missing jq, etc.) and
#     emits empty or non-JSON output, emit a structured fallback JSON so
#     dev-runner always receives a valid ENVSETUP schema payload.
#   - Re-emit stderr as a diagnostic warning (never silently swallowed).
# ============================================================================

# usage: delegate_install <path> [detect-and-install options...]  → stdout に結果 JSON 1 つ
delegate_install() {
    local path="$1" stdout_tmp stderr_tmp exit_tmp output delegate_exit stderr_content error_detail
    shift
    stdout_tmp="$(mktemp)"
    stderr_tmp="$(mktemp)"
    exit_tmp="$(mktemp)"

    # set +e so a non-zero exit from detect-and-install.sh does not propagate to us.
    set +e
    "$SCRIPT_DIR/detect-and-install.sh" --path "$path" "$@" >"$stdout_tmp" 2>"$stderr_tmp"
    printf '%d' $? >"$exit_tmp"
    set -e

    output="$(cat "$stdout_tmp")"
    delegate_exit="$(cat "$exit_tmp")"
    stderr_content="$(cat "$stderr_tmp")"
    rm -f "$stdout_tmp" "$stderr_tmp" "$exit_tmp"

    # Re-emit stderr as a diagnostic warn on fd2 so it is visible in logs.
    if [[ -n "$stderr_content" ]]; then
        printf '[ensure-worktree-deps] detect-and-install stderr: %s\n' "$stderr_content" >&2
    fi

    # Validate that output looks like JSON (starts with '{'), regardless of exit code.
    # The delegate may exit non-zero but still emit structured error JSON — pass it through.
    # Only synthesize a fallback when output is empty or non-JSON (i.e., the delegate
    # hard-crashed before it could write anything useful).
    if [[ -z "$output" ]] || [[ "${output:0:1}" != "{" ]]; then
        error_detail="${stderr_content:-exit code ${delegate_exit}}"
        # Use json_escape (jq -Rs . with fallback) to safely handle newlines,
        # backslashes, and control characters that may appear in delegate stderr.
        printf '{"status":"failed","path":%s,"error":%s}\n' \
            "$(json_escape "$path")" \
            "$(json_escape "$error_detail")"
        return 0
    fi

    printf '%s\n' "$output"
}

if [[ -z "$SETUP_FILE" ]]; then
    delegate_install "$TARGET_PATH" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
    exit 0
fi

# ============================================================================
# --setup: dev-flow wrapper の deps 段
# ============================================================================

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 127; }

if ! SETUP_JSON="$(jq -c 'select(type == "object" and .ok == true and (.worktree | type == "string") and (.worktree | startswith("/")))' "$SETUP_FILE" 2>/dev/null)" \
    || [[ -z "$SETUP_JSON" ]]; then
    echo "--setup: ${SETUP_FILE} が dev-flow-prerun の ok:true 出力として読めない（dev-flow-prerun を再実行せよ）" >&2
    exit 2
fi
WT="$(printf '%s' "$SETUP_JSON" | jq -r '.worktree')"
[[ -d "$WT" ]] || { echo "--setup: worktree ${WT} が存在しない" >&2; exit 2; }

# detect-and-install の結果を {ok, note} に要約する（advisory。ok:false でも setup は返す）
summarize_deps() {
    local raw="$1"
    if [[ -z "$raw" ]] || ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
        jq -n '{ok:false, note:"依存インストール結果を確認できなかった（ensure-worktree-deps 応答不正）"}'
        return
    fi
    printf '%s' "$raw" | jq -c '
        def failing: [ (.results // [])[] | select(.status == "failed" or .status == "pm_not_found") ];
        def describe: .ecosystem + "/" + .pm + " (" + .command + "): " + .status
            + (if (.missing_node_modules // []) | length > 0 then " — node_modules 欠落: " + (.missing_node_modules | join(", ")) else "" end);
        if .status == "no_dependencies" then
            {ok: true, note: ""}
        elif .status == "success" then
            (failing) as $f
            | if ($f | length) == 0 then
                {ok: true, note: ([ (.results // [])[] | (.pm + ":" + .status) ] | join(", "))}
              else
                {ok: false, note: ("依存インストールに失敗した項目あり — " + ([ $f[] | describe ] | join(", ")))}
              end
        elif (.status == "partial" or .status == "failed") then
            (failing) as $f
            | if ($f | length) > 0 then
                {ok: false, note: ("依存インストールが " + .status + " で終了 — " + ([ $f[] | describe ] | join(", ")))}
              else
                {ok: false, note: ("依存インストールが " + .status + " で終了 — " + (.error // "詳細不明"))}
              end
        else
            {ok: false, note: "依存インストール結果を確認できなかった（ensure-worktree-deps 応答不正）"}
        end
    '
}

DEPS_RAW="$(delegate_install "$WT" --lockfile-only --skip-custom 2>/dev/null)" || DEPS_RAW=""
# jq フィルタ自体が応答不正で落ちても deps だけ ok:false に留める（set -e で script 全体を巻き込まない）
deps_json="$(summarize_deps "$DEPS_RAW")" \
    || deps_json='{"ok":false,"note":"依存インストール結果を確認できなかった（ensure-worktree-deps 応答不正）"}'

# epoch_end は setup_end マーク（implement 区間の起点）の給電元。install の完了後に採る — setup.epoch
# （prerun 開始時点）を使うと deps install + analyze 段 + wrapper turn が丸ごと implement の phase_durations に
# 付け替わる。Setup の決定論処理時間はどの phase にも属さない残差（duration_seconds − Σphase_durations）に
# 留める（analyze 段の所要だけは analyze.duration_seconds → prerun_durations.analyze で別途持つ）。
epoch_end="$(date +%s)"

# install の prepare が hooksPath の生成物（`.husky/_` 等）を worktree に作ると hook は動くので、prerun の時点の値を
# install 後の状態で上書きする（残すと動いている hook を「動いていない」と開示する）
# shellcheck source=worktree-checkout.sh
source "$SCRIPT_DIR/worktree-checkout.sh"
hooks_not_running="$(hooks_not_running_json "$WT")"

printf '%s' "$SETUP_JSON" | jq -c --argjson deps "$deps_json" --argjson epoch_end "$epoch_end" --argjson hooks_not_running "$hooks_not_running" \
    '. + {deps: $deps, epoch_end: $epoch_end, hooks_not_running: $hooks_not_running}'
exit 0
