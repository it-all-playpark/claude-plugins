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
# 3. LLM を呼んだ実行では、.llm.log の振り分けブロック（CLASS_BEGIN 〜 CLASS_END の行の間。複数あれば最後の 1 つ）を
#    record-classification.sh の --input に渡し、<out-dir>/classifications.jsonl に追記する。記録をここで行うのは、
#    claude -p の Bash は sandbox 内で動き、~/.claude/logs は組み込みの書き込み保護で skill から書けないため。
#    検証と行の形は record-classification.sh だけが持つ — ここで行を組み立てたり JSONL に直接書いたりしない。
#    ブロックが無い・記録に失敗しても実行は止めず、理由を classification_error に出す。
#
# 1〜3 は <out-dir>/.lock（mkdir の lock）を持って 1 本ずつ走らせる。重なった実行は前の実行が終わるまで
# 待ち、前の実行のレポートを窓の始点にして走る。
#
# Usage:
#   daily.sh [--out-dir DIR] [--journal-dir DIR] [--repo DIR] [--now ISO8601]
#
#   --out-dir      既定 ~/.claude/logs/dev-flow-health
#   --now          窓の終点。既定は現在の秒で、NOW_LAG_SECONDS 秒待ってから走査する（終点以前の entry の書き込み完了を待つ）
#   --journal-dir / --repo は health-report.sh へそのまま渡す
#
# 出力: stdout に {report, needs_llm, llm_invoked, llm_exit, classifications_recorded, classification_error} の JSON 1 行。
#   classifications_recorded は追記した行数（記録できなければ 0）、classification_error は記録できなかった理由。
#   LLM を呼ばない実行ではどちらも null。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HOME/.claude/logs/dev-flow-health"
PASS=()
NOW=""
# --now を省いたときは終点を現在の秒にし、この秒数待ってから走査する。journal の entry は timestamp を確定してから
# 書き込まれる（journal.sh は jq を挟んでから mv）ので、待たずに走査すると終点以前の timestamp で走査の後から
# 書かれた失敗は今回の窓に入らず、次の窓 (終点, ...] からも外れて二度と new にならない。
# 終点を過去にずらす形にはしない — WatchPaths の即時トリガが自分を起こした entry（timestamp ≒ 現在）を窓から外す
NOW_LAG_SECONDS="${DEV_FLOW_HEALTH_NOW_LAG_SECONDS:-5}"
# 振り分けブロックの区切り行。SKILL.md の手順 7 と同じ文字列
CLASS_BEGIN='<!-- dev-flow-health-classifications:begin -->'
CLASS_END='<!-- dev-flow-health-classifications:end -->'

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

if [[ -z "$NOW" ]]; then
    NOW="$(jq -rn 'now | floor | todateiso8601')"
    sleep "$NOW_LAG_SECONDS"
fi

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
CLASS_RECORDED=null
CLASS_ERROR=""
if [[ "$NEEDS_LLM" == "true" ]]; then
    LLM_INVOKED=true
    if claude -p "/dev-flow:dev-flow-health $REPORT" > "$BASE.llm.log" 2>&1; then
        LLM_EXIT=0
    else
        LLM_EXIT=$?
    fi

    # 一時ファイルは <out-dir> の dotfile — 窓の始点を探す glob（YYYY-MM-DDTHHMMSSZ*.json）に掛からない名前にする
    BLOCK="$(mktemp "$OUT_DIR/.classifications.XXXXXX")"
    awk -v b="$CLASS_BEGIN" -v e="$CLASS_END" '
        { line = $0; sub(/\r$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line) }
        line == b { f = 1; buf = ""; next }
        f && line == e { f = 0; last = buf; next }
        f { buf = buf $0 "\n" }
        END { printf "%s", last }' "$BASE.llm.log" > "$BLOCK"
    if ! grep -q '[^[:space:]]' "$BLOCK"; then
        CLASS_RECORDED=0
        CLASS_ERROR="no classification block in LLM output"
    elif rec="$(bash "$SCRIPT_DIR/record-classification.sh" --report "$REPORT" --input "$BLOCK" 2> "$BLOCK.err")"; then
        CLASS_RECORDED="$(printf '%s' "$rec" | jq '.appended')"
    else
        CLASS_RECORDED=0
        CLASS_ERROR="$(jq -r '.error // empty' "$BLOCK.err" 2>/dev/null || true)"
        [[ -n "$CLASS_ERROR" ]] || CLASS_ERROR="record-classification.sh failed: $(cat "$BLOCK.err")"
    fi
    rm -f "$BLOCK" "$BLOCK.err"
fi

jq -nc --arg report "$REPORT" --argjson needs "$NEEDS_LLM" --argjson invoked "$LLM_INVOKED" --argjson rc "$LLM_EXIT" \
    --argjson recorded "$CLASS_RECORDED" --arg cerr "$CLASS_ERROR" \
    '{report: $report, needs_llm: $needs, llm_invoked: $invoked, llm_exit: $rc,
      classifications_recorded: $recorded, classification_error: (if $cerr == "" then null else $cerr end)}'
