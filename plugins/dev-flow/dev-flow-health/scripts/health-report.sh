#!/usr/bin/env bash
# health-report.sh - dev-flow / pr-iterate の失敗を signature 単位にまとめ、状態と候補 commit を JSON で出す
#
# LLM を使わない決定論スクリプト。journal の dev-flow / pr-iterate entry だけを読む。
#
#   1. 失敗 entry（outcome == "failure" かつ error object あり）を
#      skill | error.category | error.phase | error.message のテンプレート化で signature にまとめる。
#      message の URL・絶対パス・hash・PR 番号・数値は <*> に置き換える（Drain 系）。
#      error.category == "needs_clarification"（analyze ゲート等が人間の判断待ちで止めた設計どおりの停止）は
#      dev-flow の欠陥ではないので signature にしない（1 signature = 1 issue で毎回起票されるのを防ぐ）。
#      error.category == "pr_phase_failed"（PR phase の commit / push / gh pr create が失敗し、throw せずに終えた run）は
#      人間の回収が要る失敗なので abort と同じく signature にする（phase は PR）。
#   2. signature ごとに first_seen / last_seen（timestamp と telemetry.plugin_commit）を出し、状態を決める:
#        resolved  : last_seen 以後に、last_seen と別の plugin_commit で同じ skill が N 回以上成功し、再発していない
#                    （別の失敗で止まった run はその phase まで到達した証拠にならないので数えない）
#        new       : resolved でなく、first_seen が窓（--since より後、--now 以前）に入っている
#        regressed : resolved でなく、一度 resolved の条件を満たした後の再発が窓に入っている
#        ongoing   : それ以外
#      「より新しい commit」は timestamp の後で plugin_commit が異なる run と読む（commit の祖先関係は見ない。
#      plugin は main に追随するので、後に走った別 commit は新しい commit とみなせる）。
#      窓は始点を含まず終点を含む。--now より後の entry は読まない — 前回の --now を次の --since に渡す
#      連続実行（daily.sh）で、境界の秒や実行中に書かれた entry を 2 回 new / regressed にしないため。
#   3. new / regressed は、失敗し始めた run（new は first_seen、regressed は再発）の commit と、それより前で
#      最後に成功した同じ skill の run の commit の間で、plugins/dev-flow/ を触った commit を git log で列挙する。
#      別の失敗で止まった run は、その signature の手前まで進んだ証拠にならないので「正常」に数えない。
#      列挙できないときは candidates.error に理由を入れる（first_bad_commit_unknown / no_prior_good_run /
#      repo_unavailable / git_log_failed）。
#   4. issue_repo（self-improve issue の起票先 OWNER/NAME）を --repo の checkout の origin から解決する。
#      origin が GitHub の URL でない・checkout が無いときは null。起票先は固定値にしない — plugin を
#      install した第三者の失敗を別の repo に起票しないため。null のとき SKILL.md の手順は起票せずに止まる。
#
# Usage:
#   health-report.sh [--journal-dir DIR] [--repo DIR] [--now ISO8601] [--since ISO8601]
#                    [--window-hours N] [--resolve-after N]
#
#   --journal-dir    既定 $CLAUDE_JOURNAL_DIR、なければ ~/.claude/journal
#   --repo           候補 commit を引く skills repo。既定は本スクリプトを含む git checkout
#                    （plugin cache の install は git ではないので repo_unavailable になる。日次ジョブは
#                    install-schedule.sh --repo で登録した checkout を daily.sh 経由で渡す）。
#                    issue_repo もこの checkout の origin から解決する
#   --now           基準時刻（UTC, YYYY-MM-DDTHH:MM:SSZ）。既定は現在時刻
#   --since          new / regressed とみなす窓の始点（この時刻ちょうどは含まない）。既定は --now から --window-hours 前
#   --window-hours   既定 24
#   --resolve-after  resolved とみなす再発なし run 数 N。既定 5
#
# 出力: stdout に JSON 1 つ。needs_llm は summary.new + summary.regressed > 0。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANDIDATE_PATH="plugins/dev-flow/"

die_json() {
    jq -n --arg e "$1" '{error: $e}' >&2
    exit "${2:-2}"
}

usage() {
    sed -n '/^# Usage:/,/^# 出力:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"
REPO=""
NOW=""
SINCE=""
WINDOW_HOURS="24"
RESOLVE_AFTER="5"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --journal-dir) JOURNAL_DIR="${2:?}"; shift 2 ;;
        --repo) REPO="${2:?}"; shift 2 ;;
        --now) NOW="${2:?}"; shift 2 ;;
        --since) SINCE="${2:?}"; shift 2 ;;
        --window-hours) WINDOW_HOURS="${2:?}"; shift 2 ;;
        --resolve-after) RESOLVE_AFTER="${2:?}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die_json "unknown option: $1" ;;
    esac
done

ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ -n "$NOW" ]] || NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$NOW" =~ $ISO_RE ]] || die_json "invalid --now: $NOW (YYYY-MM-DDTHH:MM:SSZ)"
[[ "$WINDOW_HOURS" =~ ^[1-9][0-9]*$ ]] || die_json "invalid --window-hours: $WINDOW_HOURS"
[[ "$RESOLVE_AFTER" =~ ^[1-9][0-9]*$ ]] || die_json "invalid --resolve-after: $RESOLVE_AFTER"
if [[ -z "$SINCE" ]]; then
    SINCE="$(jq -rn --arg now "$NOW" --argjson h "$WINDOW_HOURS" '$now | fromdateiso8601 - ($h * 3600) | todateiso8601')"
fi
[[ "$SINCE" =~ $ISO_RE ]] || die_json "invalid --since: $SINCE (YYYY-MM-DDTHH:MM:SSZ)"

# 候補 commit を引く repo。指定がなければ本スクリプトを含む checkout（plugin cache なら git ではないので空）
if [[ -z "$REPO" ]]; then
    REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
elif ! REPO="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)"; then
    REPO=""
fi

# 起票先。origin の GitHub URL（https / ssh）から OWNER/NAME を取り出す。取れなければ空（出力は null）
ISSUE_REPO=""
if [[ -n "$REPO" ]]; then
    origin="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
    if [[ "$origin" =~ ^(https://|ssh://git@|git@)github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
        ISSUE_REPO="${BASH_REMATCH[2]}/${BASH_REMATCH[3]%.git}"
    fi
fi

# --- journal の読み込み -------------------------------------------------------
# ファイル名は <UTC 日付>-<時刻>-<skill>-<pid>.json。dev-flow / pr-iterate の名前だけを読み、
# 他 skill の entry（件数の大半）は開かない。壊れたファイルは飛ばす。
ENTRY_FILTER='select(type == "object")
  | {skill, outcome, timestamp, source, error,
     commit: (.telemetry.plugin_commit // null),
     issue: (.context.issue // null),
     pr_number: (.context.pr_number // null),
     file: (input_filename | split("/") | last)}'

read_batch() {
    local out
    if out="$(jq -c "$ENTRY_FILTER" "$@" 2>/dev/null)"; then
        [[ -z "$out" ]] || printf '%s\n' "$out"
        return 0
    fi
    # 1 件でも壊れていると jq はそこで止まるので、その batch だけ 1 ファイルずつ読み直す
    local f
    for f in "$@"; do
        jq -c "$ENTRY_FILTER" "$f" 2>/dev/null || true
    done
}

collect_entries() {
    local batch=() f
    for f in "$JOURNAL_DIR"/*-dev-flow-[0-9]*.json "$JOURNAL_DIR"/*-pr-iterate-[0-9]*.json; do
        [[ -f "$f" ]] || continue
        batch+=("$f")
        if [[ ${#batch[@]} -ge 200 ]]; then
            read_batch "${batch[@]}"
            batch=()
        fi
    done
    if [[ ${#batch[@]} -gt 0 ]]; then
        read_batch "${batch[@]}"
    fi
}

ENTRIES="$(collect_entries)"

# --- signature と状態の判定 ---------------------------------------------------
# shellcheck disable=SC2016
REPORT_PROGRAM='
def template:
  gsub("[A-Za-z][A-Za-z0-9+.-]*://[^\\s\"'"'"'`<>]+"; "<*>")
  | gsub("(?<![A-Za-z0-9_.@-])(~|\\.{1,2})?/[^\\s:,;\"'"'"'`()\\[\\]{}<>]+"; "<*>")
  | gsub("(?<![A-Za-z0-9])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}(?![A-Za-z0-9])"; "<*>")
  | gsub("#[0-9]+"; "<*>")
  | gsub("[0-9]+"; "<*>")
  | gsub("<\\*>(?:[-_.:/]*<\\*>)+"; "<*>")
  | gsub("\\s+"; " ")
  | sub("^ "; "") | sub(" $"; "");

def point: {timestamp, plugin_commit: .commit, file};

# run r の後（until より前）に、commit が分かっていて c と異なる成功 run が何回あったか。
# 失敗 run は該当 phase まで到達した証拠にならないので数えない（last_good と同じ規則）
def clean_runs($runs; $after; $until; $c):
  [ $runs[]
    | select(.outcome == "success")
    | select(.timestamp > $after.timestamp)
    | select($until == null or .timestamp < $until.timestamp)
    | select(.commit != null and .commit != $c) ]
  | length;

[ .[]
  | select((.source // "skill") == "skill")
  | select(.skill == "dev-flow" or .skill == "pr-iterate")
  | select((.timestamp | type) == "string" and .timestamp <= $now)
  | .commit = (if (.commit | type) == "string" and (.commit | test("^[0-9a-f]{7,40}$")) then .commit else null end)
] | sort_by(.timestamp, .file)
| to_entries | map(.value + {idx: .key}) as $all
| [ $all[]
    | select(.outcome == "failure" and (.error | type) == "object")
    | select(.error.category != "needs_clarification")
    | . + {category: (.error.category // ""), phase: (.error.phase // ""),
           template: ((.error.message // "") | tostring | template)}
    | . + {signature: ([.skill, .category, .phase, .template] | join(" | "))}
  ] as $fails
| ($fails | group_by(.signature)
   | map(
       sort_by(.idx) as $occ
       | ($occ[0].skill) as $skill
       | [ $all[] | select(.skill == $skill) ] as $runs
       | ($occ | last) as $last
       # 一度 resolved の条件を満たした後の再発（直前の発生から N 回以上の別 commit run を挟んだ発生）
       | [ range(1; $occ | length) as $i
           | select(clean_runs($runs; $occ[$i - 1]; $occ[$i]; $occ[$i - 1].commit) >= $resolve_after)
           | $occ[$i] ] as $regressions
       | clean_runs($runs; $last; null; $last.commit) as $clean_after
       | (if $clean_after >= $resolve_after then "resolved"
          elif $occ[0].timestamp > $since then "new"
          elif ($regressions | length) > 0 and ($regressions | last).timestamp > $since then "regressed"
          else "ongoing" end) as $status
       | (if $status == "new" then $occ[0]
          elif $status == "regressed" then ($regressions | last)
          else null end) as $bad
       | (if $bad == null then null
          else [ $runs[] | select(.idx < $bad.idx and .outcome == "success" and .commit != null) ] | last
          end) as $good
       | {
           signature: $occ[0].signature,
           skill: $skill,
           category: $occ[0].category,
           phase: $occ[0].phase,
           template: $occ[0].template,
           status: $status,
           count: ($occ | length),
           first_seen: ($occ[0] | point),
           last_seen: ($last | point),
           regressed_at: (if ($regressions | length) > 0 then ($regressions | last | point) else null end),
           clean_runs_since_last_seen: $clean_after,
           recent_runs: [ $occ[-5:][] | {timestamp, plugin_commit: .commit, file, issue, pr_number, message: .error.message} ],
           candidates: (if $bad == null then null
                        else {first_bad_commit: $bad.commit,
                              last_good_commit: (if $good == null then null else $good.commit end),
                              path: $candidate_path,
                              commits: [],
                              error: (if $bad.commit == null then "first_bad_commit_unknown"
                                      elif $good == null then "no_prior_good_run"
                                      else null end)}
                        end)
         })
   | sort_by((.status as $s | {new: 0, regressed: 1, ongoing: 2, resolved: 3} | .[$s]), .last_seen.timestamp)
  ) as $signatures
| {
    generated_at: $now,
    window: {since: $since, until: $now},
    resolve_after_runs: $resolve_after,
    runs: {"dev-flow": ([$all[] | select(.skill == "dev-flow")] | length),
           "pr-iterate": ([$all[] | select(.skill == "pr-iterate")] | length)},
    summary: {
      new: ([$signatures[] | select(.status == "new")] | length),
      regressed: ([$signatures[] | select(.status == "regressed")] | length),
      ongoing: ([$signatures[] | select(.status == "ongoing")] | length),
      resolved: ([$signatures[] | select(.status == "resolved")] | length)
    },
    signatures: $signatures
  }
| .needs_llm = ((.summary.new + .summary.regressed) > 0)
'

REPORT="$(printf '%s\n' "$ENTRIES" | jq -s \
    --arg now "$NOW" --arg since "$SINCE" \
    --argjson resolve_after "$RESOLVE_AFTER" \
    --arg candidate_path "$CANDIDATE_PATH" \
    "$REPORT_PROGRAM")"

# --- signature id と候補 commit ---------------------------------------------------
sig_id() {
    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$1" | shasum -a 1 | cut -c1-12
    else
        printf '%s' "$1" | sha1sum | cut -c1-12
    fi
}

list_candidates() {
    local good="$1" bad="$2"
    local log
    log="$(git -C "$REPO" log --format='%H%x09%s' "${good}..${bad}" -- "$CANDIDATE_PATH" 2>/dev/null)" || return 1
    printf '%s\n' "$log" | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {sha: .[0], subject: (.[1:] | join("\t"))})'
}

COUNT="$(printf '%s' "$REPORT" | jq '.signatures | length')"
i=0
while [[ "$i" -lt "$COUNT" ]]; do
    sig="$(printf '%s' "$REPORT" | jq -r --argjson i "$i" '.signatures[$i].signature')"
    REPORT="$(printf '%s' "$REPORT" | jq --argjson i "$i" --arg id "$(sig_id "$sig")" '.signatures[$i].id = $id')"

    pair="$(printf '%s' "$REPORT" | jq -r --argjson i "$i" \
        '.signatures[$i].candidates | if . != null and .error == null then "\(.last_good_commit) \(.first_bad_commit)" else "" end')"
    if [[ -n "$pair" ]]; then
        good="${pair% *}"
        bad="${pair#* }"
        err=""
        commits="[]"
        if [[ -z "$REPO" ]]; then
            err="repo_unavailable"
        elif ! commits="$(list_candidates "$good" "$bad")"; then
            commits="[]"
            err="git_log_failed"
        fi
        REPORT="$(printf '%s' "$REPORT" | jq --argjson i "$i" --argjson c "$commits" --arg err "$err" \
            '.signatures[$i].candidates.commits = $c
             | .signatures[$i].candidates.error = (if $err == "" then null else $err end)')"
    fi
    i=$((i + 1))
done

printf '%s\n' "$REPORT" | jq --arg issue_repo "$ISSUE_REPO" \
    '{generated_at, window, resolve_after_runs, runs, summary, needs_llm,
      issue_repo: (if $issue_repo == "" then null else $issue_repo end), signatures}'
