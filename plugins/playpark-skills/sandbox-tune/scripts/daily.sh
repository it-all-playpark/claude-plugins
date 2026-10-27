#!/usr/bin/env bash
# daily.sh - sandbox-tune の日次集計と issue の下書き（install-schedule.sh で登録した launchd ジョブから起動）
#
# 1. `sandbox-tune.sh run` を出力先 ~/.claude/logs/sandbox-tune で走らせ、実行ごとの要約を
#    ~/.claude/logs/sandbox-tune/runs.jsonl に 1 行追記する。status line 等の読み手はこのファイルだけで
#    最後の集計の時刻・remaining の件数・失敗したか・下書きの置き場所を読む。止まっているのか失敗しているのかを区別できるよう、失敗も 1 行残す。
#    - 成功: run の最終行の要約 JSON（{report, analysis, verified, types, remaining, stale_branch, resolved, intended, recurring}）に
#      ts を足した行。verify した run では 2 の結果 {new_recurring, drafts, drafts_root, draft_error} も足す
#    - 失敗: {ts, exit, error} — exit は run の終了コード、error は run の stderr の末尾
#    ts は ISO 8601 UTC。
# 2. verify した run では、recurring の型のうちまだ下書きの判断に回していない型（新しい再発）だけを
#    `claude -p "/playpark-skills:sandbox-tune --daily ..."` に渡し、原因・修正案・安全性の判断を LLM に任せる。
#    新しい再発が無ければ LLM を呼ばない。判断に回した型の id は ~/.claude/logs/sandbox-tune/triaged.json に持ち、
#    resolved になった型はそこから外す（修正の後に再発したら、また新しい再発として回す）。
#    triaged.json が無い初回は、今の recurring を判断済みとして記録するだけで LLM を呼ばない（溜まっている型は手で
#    /sandbox-tune --issue にかける）。
#    LLM の出力の候補ブロック（CAND_BEGIN 〜 CAND_END の行の間。複数あれば最後の 1 つ）を <下書き置き場>/<実行時刻>/triage.json に書き、
#    issue 候補を `sandbox-tune.sh draft --issue` で下書きにする。伏せ字と公開範囲の判定は draft が行い、
#    起票はしない（人が /sandbox-tune で下書きを確認してから handoff する）。下書きを作るのをここで行うのは、
#    claude -p の Bash は sandbox 内で動き、~/.claude/logs は組み込みの書き込み保護で skill から書けないため。
#    下書き置き場は設定ファイル（--config。無ければ cwd）のディレクトリの claudedocs/sandbox-tune-drafts。
#    設定に issue.repo が無ければ draft が必ず失敗するので LLM を呼ばない。
#    issue.repo が無い・LLM が失敗した・ブロックが無い（要素が id を持つ object でないものを含む）・draft が失敗したときは新しい再発を判断済みにせず（翌日に回し直す）、理由を draft_error に出す。
#
# Usage:
#   daily.sh [run の引数...]    # 例: daily.sh --config ~/src/dotfiles/sandbox-tune.json
#
#   引数は run にそのまま渡す（出力先の --out は ~/.claude/logs/sandbox-tune に固定して足す）。
#
# 出力: stdout に追記した行。終了コードは run のもの（2 の失敗では非 0 にしない）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HOME/.claude/logs/sandbox-tune"
RUNS="$OUT_DIR/runs.jsonl"
TRIAGED="$OUT_DIR/triaged.json"
# error に残す run の stderr の行数
ERROR_TAIL_LINES=10
# 候補ブロックの区切り行。SKILL.md の「日次の判断（--daily）」と同じ文字列
CAND_BEGIN='<!-- sandbox-tune-daily-candidates:begin -->'
CAND_END='<!-- sandbox-tune-daily-candidates:end -->'

CONFIG=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "--config" ]]; then
        CONFIG="${args[$((i + 1))]:-}"
    fi
done
if [[ -n "$CONFIG" ]]; then
    DRAFTS_ROOT="$(cd "$(dirname "$CONFIG")" && pwd)/claudedocs/sandbox-tune-drafts"
else
    DRAFTS_ROOT="$PWD/claudedocs/sandbox-tune-drafts"
fi

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

if [[ "$RC" -ne 0 ]]; then
    LINE="$(jq -nc --arg ts "$TS" --argjson rc "$RC" --arg error "$(tail -n "$ERROR_TAIL_LINES" "$ERR")" \
        '{ts: $ts, exit: $rc, error: $error}')"
    printf '%s\n' "$LINE" >> "$RUNS"
    printf '%s\n' "$LINE"
    exit "$RC"
fi

LINE="$(tail -n 1 "$OUT" | jq -c --arg ts "$TS" '. + {ts: $ts}')"
if [[ "$(jq -r '.verified' <<<"$LINE")" == "true" ]]; then
    ANALYSIS="$(jq -r '.analysis' <<<"$LINE")"
    REC="$(bash "$SCRIPT_DIR/sandbox-tune.sh" recurring "$ANALYSIS")"
    NEW='[]'
    DRAFTS=0
    DRAFT_ERROR=""
    if [[ ! -f "$TRIAGED" ]]; then
        printf '%s\n' "$REC" > "$TRIAGED"
    else
        SEEN="$(jq -c --argjson resolved "$(jq -c '[.types[] | select(.status == "resolved") | .id]' "$ANALYSIS")" \
            '. - $resolved' "$TRIAGED")"
        NEW="$(jq -cn --argjson rec "$REC" --argjson seen "$SEEN" '$rec - $seen')"
        KEEP="$SEEN"
        config_args=(config)
        [[ -z "$CONFIG" ]] || config_args+=(--config "$CONFIG")
        if [[ "$NEW" != "[]" ]] && ! bash "$SCRIPT_DIR/sandbox-tune.sh" "${config_args[@]}" 2>/dev/null \
            | jq -e '.issue.repo // "" | length > 0' >/dev/null 2>&1; then
            # draft は issue.repo が無いと必ず失敗するので、LLM を呼ばずに飛ばす（新しい再発は判断済みにしない）
            DRAFT_ERROR="no issue.repo in config; drafts need it"
        elif [[ "$NEW" != "[]" ]]; then
            DIR="$DRAFTS_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
            mkdir -p "$DIR"
            prompt="/playpark-skills:sandbox-tune --daily --analysis $ANALYSIS --ids $(jq -r 'join(",")' <<<"$NEW")"
            [[ -z "$CONFIG" ]] || prompt+=" --config $CONFIG"
            if claude -p "$prompt" > "$DIR/llm.log" 2>&1; then
                awk -v b="$CAND_BEGIN" -v e="$CAND_END" '
                    { line = $0; sub(/\r$/, "", line); gsub(/^[ \t]+|[ \t]+$/, "", line) }
                    line == b { f = 1; buf = ""; next }
                    f && line == e { f = 0; last = buf; next }
                    f { buf = buf $0 "\n" }
                    END { printf "%s", last }' "$DIR/llm.log" > "$DIR/triage.json"
                if ! jq -e '(.candidates | type) == "array" and (.skipped | type) == "array"
                    and all(.candidates[], .skipped[]; type == "object" and (.id | type) == "string")' \
                    "$DIR/triage.json" >/dev/null 2>&1; then
                    DRAFT_ERROR="no candidates block in LLM output"
                else
                    ids="$(jq -r --argjson new "$NEW" '[.candidates[].id | select(IN($new[]))] | unique | join(",")' "$DIR/triage.json")"
                    # 候補にも skipped にも挙がらなかった新しい再発は判断済みにしない（翌日に回し直す）
                    covered="$(jq -c --argjson seen "$SEEN" --argjson new "$NEW" \
                        '$seen + [(.candidates[].id, .skipped[].id) | select(IN($new[]))] | unique' "$DIR/triage.json")"
                    draft_args=(draft --issue --analysis "$ANALYSIS" --candidates "$DIR/triage.json" --ids "$ids" --out "$DIR")
                    [[ -z "$CONFIG" ]] || draft_args+=(--config "$CONFIG")
                    if [[ -z "$ids" ]]; then
                        KEEP="$covered"
                    elif bash "$SCRIPT_DIR/sandbox-tune.sh" "${draft_args[@]}" > "$DIR/draft.log" 2>&1; then
                        DRAFTS="$(tr ',' '\n' <<<"$ids" | wc -l | tr -d ' ')"
                        KEEP="$covered"
                    else
                        DRAFT_ERROR="draft failed: $(tail -n "$ERROR_TAIL_LINES" "$DIR/draft.log")"
                    fi
                fi
            else
                DRAFT_ERROR="claude exited $?"
            fi
        fi
        printf '%s\n' "$KEEP" > "$TRIAGED"
    fi
    LINE="$(jq -c --argjson new "$(jq 'length' <<<"$NEW")" --argjson drafts "$DRAFTS" --arg root "$DRAFTS_ROOT" --arg err "$DRAFT_ERROR" \
        '. + {new_recurring: $new, drafts: $drafts, drafts_root: $root, draft_error: (if $err == "" then null else $err end)}' <<<"$LINE")"
fi
printf '%s\n' "$LINE" >> "$RUNS"
printf '%s\n' "$LINE"
exit 0
