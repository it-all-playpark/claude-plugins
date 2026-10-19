#!/usr/bin/env bash
# daily.sh - sandbox-tune の日次集計（install-schedule.sh で登録した launchd ジョブから起動）
#
# `sandbox-tune.sh run` を出力先 ~/.claude/logs/sandbox-tune で走らせ、実行ごとの要約を
# ~/.claude/logs/sandbox-tune/runs.jsonl に 1 行追記する。status line 等の読み手はこのファイルだけで
# 最後の集計の時刻・remaining の件数・失敗したかを読む。止まっているのか失敗しているのかを区別できるよう、失敗も 1 行残す。
#   - 成功: run の最終行の要約 JSON（{report, analysis, verified, types, remaining, stale_branch, resolved}）に ts を足した行
#   - 失敗: {ts, exit, error} — exit は run の終了コード、error は run の stderr の末尾
# ts は ISO 8601 UTC。決定論のみで LLM は呼ばない（draft / handoff は日次実行に含めない）。
#
# Usage:
#   daily.sh [run の引数...]    # 例: daily.sh --config ~/src/dotfiles/sandbox-tune.json
#
#   引数は run にそのまま渡す（出力先の --out は ~/.claude/logs/sandbox-tune に固定して足す）。
#
# 出力: stdout に追記した行。終了コードは run のもの。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HOME/.claude/logs/sandbox-tune"
RUNS="$OUT_DIR/runs.jsonl"
# error に残す run の stderr の行数
ERROR_TAIL_LINES=10

mkdir -p "$OUT_DIR"
OUT="$(mktemp "$OUT_DIR/.run-out.XXXXXX")"
ERR="$(mktemp "$OUT_DIR/.run-err.XXXXXX")"
trap 'rm -f "$OUT" "$ERR"' EXIT

if bash "$SCRIPT_DIR/sandbox-tune.sh" run "$@" --out "$OUT_DIR" > "$OUT" 2> "$ERR"; then
    RC=0
else
    RC=$?
fi
# launchd の StandardErrorPath にも run の stderr を残す
cat "$ERR" >&2
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "$RC" -eq 0 ]]; then
    LINE="$(tail -n 1 "$OUT" | jq -c --arg ts "$TS" '. + {ts: $ts}')"
else
    LINE="$(jq -nc --arg ts "$TS" --argjson rc "$RC" --arg error "$(tail -n "$ERROR_TAIL_LINES" "$ERR")" \
        '{ts: $ts, exit: $rc, error: $error}')"
fi
printf '%s\n' "$LINE" >> "$RUNS"
printf '%s\n' "$LINE"
exit "$RC"
