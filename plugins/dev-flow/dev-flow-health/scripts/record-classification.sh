#!/usr/bin/env bash
# record-classification.sh - dev-flow-health の LLM が付けた signature の振り分けを JSONL に追記する
#
# LLM を使わない決定論スクリプト。SKILL.md の手順で LLM が new / regressed の各 signature を
# dev_flow / target_repo / environment / transient に振り分けた結果を受け取り、レポートと同じディレクトリの
# classifications.jsonl に 1 signature 1 行で追記する。後から自動起票の精度（dev_flow と判定して起票したものが
# 本当に dev-flow の欠陥だったか、起票しなかったものに dev-flow の欠陥が混ざっていないか）を測るための記録。
# JSONL は LLM に直接書かせない — 行の形と enum をここで固定し、集計側が壊れた行を読まないようにする。
#
# 入力の 1 件でも classification が enum 外・id / signature が空・reason が文字列でない・issue が数値でも null でもない
# なら、何も追記せず exit 2（一部だけ記録すると
# 1 回の実行の振り分けが欠けたまま残り、件数の分母が狂う）。
#
# Usage:
#   record-classification.sh --report <report.json> --input <classifications.json>
#
#   --report   health-report.sh のレポート（daily.sh が書いた <out-dir>/YYYY-MM-DDTHHMMSSZ.json）
#   --input    {id, signature, classification, reason, issue} のオブジェクト、またはその配列。
#              issue は起票した（重複確認で見つかった）issue 番号。起票しない分類では null
#
# 出力: <report のディレクトリ>/classifications.jsonl に
#   {recorded_at, report, generated_at, id, signature, classification, reason, issue} を 1 件 1 行で追記し、
#   stdout に {jsonl, appended} の JSON 1 行。
set -euo pipefail

die_json() {
    jq -n --arg e "$1" '{error: $e}' >&2
    exit "${2:-2}"
}

REPORT=""
INPUT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --report) REPORT="${2:?}"; shift 2 ;;
        --input) INPUT="${2:?}"; shift 2 ;;
        -h|--help) sed -n '/^# Usage:/,/^# 出力:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die_json "unknown option: $1" ;;
    esac
done

[[ -n "$REPORT" ]] || die_json "--report is required"
[[ -n "$INPUT" ]] || die_json "--input is required"
[[ -f "$REPORT" ]] || die_json "report not found: $REPORT"
[[ -f "$INPUT" ]] || die_json "input not found: $INPUT"

REPORT_ABS="$(cd "$(dirname "$REPORT")" && pwd)/$(basename "$REPORT")"
GENERATED_AT="$(jq -r '.generated_at // empty' "$REPORT" 2>/dev/null)" || die_json "report is not JSON: $REPORT"
JSONL="$(dirname "$REPORT_ABS")/classifications.jsonl"

# 全件を検証してから行を作る。1 件でも不正なら 1 行も書かない
# shellcheck disable=SC2016
LINES="$(jq -c \
    --arg report "$REPORT_ABS" \
    --arg generated_at "$GENERATED_AT" \
    --arg recorded_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    def nonempty: type == "string" and length > 0;
    (if type == "array" then . else [.] end) as $items
    | [ $items[]
        | select((type == "object"
                  and (.id | nonempty)
                  and (.signature | nonempty)
                  and (.classification | IN("dev_flow", "target_repo", "environment", "transient"))
                  and (.reason | type == "string")
                  and (.issue | type == "number" or type == "null")) | not) ] as $bad
    | if ($items | length) == 0 then error("no classifications in input")
      elif ($bad | length) > 0 then error("invalid classification entry: \($bad[0] | tojson)")
      else $items[]
        | {recorded_at: $recorded_at, report: $report,
           generated_at: (if $generated_at == "" then null else $generated_at end),
           id, signature, classification, reason, issue}
      end' "$INPUT" 2>&1)" || die_json "$LINES"

printf '%s\n' "$LINES" >> "$JSONL"

jq -nc --arg jsonl "$JSONL" --argjson n "$(printf '%s\n' "$LINES" | wc -l | tr -d ' ')" '{jsonl: $jsonl, appended: $n}'
