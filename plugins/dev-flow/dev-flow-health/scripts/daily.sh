#!/usr/bin/env bash
# daily.sh - dev-flow ヘルスレポートの実行（launchd の日次ジョブと journal 監視の即時トリガから起動）
#
# 1. health-report.sh でレポートを書く。レポートは実行ごとに別ファイル
#    <out-dir>/<generated_at の YYYY-MM-DDTHHMMSSZ>.json（同じ秒の 2 本目以降は .2.json, .3.json ...）。
#    窓の始点は直前の実行のレポート（同じ日の分も含む最新）の generated_at（無ければ health-report.sh の既定 =
#    24 時間前）。窓は直前の実行の終点から始まるので、実行が空いても取りこぼさず、日次と即時トリガが
#    交互に走っても同じ失敗を 2 回 new / regressed にしない。
# 2. new / regressed が 1 件以上の実行だけ、`claude -p "/dev-flow:dev-flow-health <report>"` で
#    原因の推定と issue 起票を LLM に任せる。0 件なら LLM を呼ばない。出力はレポートと同じ名前の .llm.log。
#
# 1〜2 は <out-dir>/.lock（mkdir の lock）を持って 1 本ずつ走らせる。重なった実行は前の実行が終わるまで
# 待ち、前の実行のレポートを窓の始点にして走る。
#
# Usage:
#   daily.sh [--out-dir DIR] [--journal-dir DIR] [--repo DIR] [--now ISO8601]
#
#   --out-dir      既定 ~/.claude/logs/dev-flow-health
#   --now          窓の終点。既定は現在時刻の NOW_LAG_SECONDS 秒前（直近の秒に後から書かれる entry を次の窓に残す）
#   --journal-dir / --repo は health-report.sh へそのまま渡す
#
# 出力: stdout に {report, needs_llm, llm_invoked, llm_exit} の JSON 1 行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HOME/.claude/logs/dev-flow-health"
PASS=()
NOW=""
# --now を省いたときの終点は現在時刻のこの秒数前。journal の entry は timestamp を確定してから書き込まれる
# （journal.sh は jq を挟んでから mv）ので、終点を現在の秒にすると、同じ秒に走査の後から書かれた失敗は
# 今回の窓に入らず、次の窓 (終点, ...] からも外れて二度と new にならない。直近の数秒は次の実行の窓に残す
NOW_LAG_SECONDS=5

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
        --journal-dir|--repo) PASS+=("$1" "${2:?}"); shift 2 ;;
        --now) NOW="${2:?}"; shift 2 ;;
        -h|--help) sed -n '/^# Usage:/,/^# 出力:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) jq -n --arg e "unknown option: $1" '{error: $e}' >&2; exit 2 ;;
    esac
done

mkdir -p "$OUT_DIR"

# 窓の始点を読む前に lock を取る — 重なった 2 本が同じ前回レポートを始点にすると、同じ失敗で LLM が 2 回起動する。
# 保持していたプロセスが居ない lock（実行中の kill・再起動）は取り直す。残したままだと以後の実行がすべて待ち続ける
LOCK="$OUT_DIR/.lock"
while ! mkdir "$LOCK" 2>/dev/null; do
    holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
        rm -rf "$LOCK"
        continue
    fi
    sleep 1
done
trap 'rm -rf "$LOCK"' EXIT
echo "$$" > "$LOCK/pid"

# 直前の実行のレポート（ファイル名は generated_at 順に並ぶ）の generated_at を窓の始点にする
SINCE=""
prev=""
for f in "$OUT_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z*.json; do
    [[ -f "$f" ]] || continue
    prev="$f"
done
if [[ -n "$prev" ]]; then
    SINCE="$(jq -r '.generated_at // empty' "$prev" 2>/dev/null || true)"
fi

[[ -n "$NOW" ]] || NOW="$(jq -rn --argjson lag "$NOW_LAG_SECONDS" 'now | floor - $lag | todateiso8601')"

ARGS=(--now "$NOW")
[[ -z "$SINCE" ]] || ARGS+=(--since "$SINCE")
if [[ ${#PASS[@]} -gt 0 ]]; then
    ARGS+=("${PASS[@]}")
fi

TMP="$(mktemp "$OUT_DIR/.report.XXXXXX")"
bash "$SCRIPT_DIR/health-report.sh" "${ARGS[@]}" > "$TMP"

STAMP="$(jq -r '.generated_at | gsub(":"; "")' "$TMP")"
BASE="$OUT_DIR/$STAMP"
n=1
while [[ -e "$BASE.json" ]]; do
    n=$((n + 1))
    BASE="$OUT_DIR/$STAMP.$n"
done
REPORT="$BASE.json"
mv "$TMP" "$REPORT"

NEEDS_LLM="$(jq -r '.needs_llm' "$REPORT")"
LLM_INVOKED=false
LLM_EXIT=null
if [[ "$NEEDS_LLM" == "true" ]]; then
    LLM_INVOKED=true
    if claude -p "/dev-flow:dev-flow-health $REPORT" > "$BASE.llm.log" 2>&1; then
        LLM_EXIT=0
    else
        LLM_EXIT=$?
    fi
fi

jq -nc --arg report "$REPORT" --argjson needs "$NEEDS_LLM" --argjson invoked "$LLM_INVOKED" --argjson rc "$LLM_EXIT" \
    '{report: $report, needs_llm: $needs, llm_invoked: $invoked, llm_exit: $rc}'
