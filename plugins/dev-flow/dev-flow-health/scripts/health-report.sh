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
#      merge tier が HOLD の dev-flow run（outcome は success）は、telemetry.hold_reason_codes のうち dev-flow 自身や
#      実行環境の不具合で出る HOLD 理由を 1 つずつ signature にする（skill | hold | Merge tier | <code>）:
#        - HOLD_SIGNATURE_CODES の code。security_review_unresolved の template は止めた理由の細目を足した
#          "security_review_unresolved status=<security_review_status> stop=<security_review_stop_reason>"
#        - iterate_non_lgtm のうち telemetry.iterate_status が HOLD_SIGNATURE_ITERATE_STATUSES のもの
#          （template は "iterate_non_lgtm status=<iterate_status>"、fix_failed は " fix=<fix_terminal_reason>" を足す。
#          security_unresolved は security_review_unresolved の template）。hold_reason_codes に security_review_unresolved が
#          ある run からは作らない（同じ run をその signature が表す）
#        - ac_human_pending のうち telemetry.hold_ac_human_judged が true のもの（観測型の判定か evaluator の
#          unreachable_env で人手になった AC が未達）
#      単体起動の pr-iterate run（telemetry.iterate_caller == "standalone"。outcome は success）も、iterate_status が
#      HOLD_SIGNATURE_ITERATE_STATUSES のものを同じ template で signature にする（skill | hold | Iterate | <template>）。
#      iterate_caller == "dev-flow" の pr-iterate entry は発生にも resolved の判定・最後の成功 run にも入れない — その run は
#      dev-flow entry の HOLD の側で数える。値の無い細目は none と書く。
#      再現率を優先する（誤って拾ったものは LLM の分類で dev_flow 以外になり起票されない）。
#      hold_reason_codes を持たない dev-flow entry と iterate_caller を持たない pr-iterate entry は拾わない。
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

# 異常とする HOLD 理由（dev-flow 自身や実行環境の不具合で出るもの）。一覧はここだけに持ち、health-report.bats と
# skill-docs.bats がこの 2 行を読んで参照する。iterate_non_lgtm と ac_human_pending は条件付き（上の 1.）。
# HOLD_SIGNATURE_ITERATE_STATUSES は単体起動の pr-iterate run の終端 status にも使う
HOLD_SIGNATURE_CODES='["final_reconcile_unavailable","final_ac_unavailable","pr_closes_missing","merge_facts_dropped","danger_fail_closed","ac_agent_unsatisfied","final_test_red","validate_test_red","security_review_unresolved"]'
HOLD_SIGNATURE_ITERATE_STATUSES='["ci_pending","ci_error","review_contract_error","stuck","fix_failed","max_reached","security_unresolved"]'

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
     hold_codes: (.telemetry.hold_reason_codes // null),
     hold_ac_human_judged: (.telemetry.hold_ac_human_judged // null),
     iterate_status: (.telemetry.iterate_status // null),
     iterate_caller: (.telemetry.iterate_caller // null),
     fix_terminal_reason: (.telemetry.fix_terminal_reason // null),
     security_review_status: (.telemetry.security_review_status // null),
     security_review_stop_reason: (.telemetry.security_review_stop_reason // null),
     issue: (.context.issue // null),
     pr_number: (.context.pr_number // null),
     repo: (.context.repo // null),
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

# security review が clear にならなかった run の template。止めた理由の細目で分ける（指摘の件数・本文は入れない —
# 件数を入れると run ごとに signature が割れる）
def security_template:
  "security_review_unresolved status=\(.security_review_status // "none") stop=\(.security_review_stop_reason // "none")";

# pr-iterate の非 LGTM の終端 status の template（dev-flow の iterate_non_lgtm と単体起動の pr-iterate で同じ形）
def iterate_template:
  if .iterate_status == "security_unresolved" then security_template
  elif .iterate_status == "fix_failed" then "iterate_non_lgtm status=fix_failed fix=\(.fix_terminal_reason // "none")"
  else "iterate_non_lgtm status=\(.iterate_status)" end;

# HOLD の dev-flow run 1 件から、異常とする HOLD 理由ごとに 1 つの発生を作る（1 run に複数あれば別々の signature）。
# security_review_unresolved のある run の iterate_non_lgtm は数えない（同じ終わり方を 2 つの signature にしない）
def hold_occurrences:
  select(.skill == "dev-flow" and (.hold_codes | type) == "array")
  | . as $e
  | ($e.hold_codes | map(select(type == "string")) | unique) as $codes
  | $codes[]
  | select(IN($hold_codes[])
           or (. == "iterate_non_lgtm" and ($e.iterate_status | IN($hold_iterate_statuses[]))
               and ("security_review_unresolved" | IN($codes[]) | not))
           or (. == "ac_human_pending" and $e.hold_ac_human_judged == true))
  | (if . == "iterate_non_lgtm" then ($e | iterate_template)
     elif . == "security_review_unresolved" then ($e | security_template)
     else . end) as $t
  | $e + {category: "hold", phase: "Merge tier", template: $t, message: $t};

# 単体起動の pr-iterate run 1 件（outcome は success）から、LGTM に届かなかった終わり方の発生を作る。
# nested（iterate_caller == "dev-flow"）の run は dev-flow entry の HOLD の側で数える
def iterate_occurrences:
  select(.skill == "pr-iterate" and .iterate_caller == "standalone" and .outcome == "success")
  | select(.iterate_status | IN($hold_iterate_statuses[]))
  | iterate_template as $t
  | . + {category: "hold", phase: "Iterate", template: $t, message: $t};

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
| [ ($all[]
      | select(.outcome == "failure" and (.error | type) == "object")
      | select(.error.category != "needs_clarification")
      | . + {category: (.error.category // ""), phase: (.error.phase // ""),
             template: ((.error.message // "") | tostring | template), message: .error.message}),
    ($all[] | hold_occurrences),
    ($all[] | iterate_occurrences)
    | . + {signature: ([.skill, .category, .phase, .template] | join(" | "))}
  ] as $fails
| ($fails | group_by(.signature)
   | map(
       sort_by(.idx) as $occ
       | ($occ[0].skill) as $skill
       # nested の pr-iterate entry は成功 run にも数えない（その run の結果は dev-flow entry が持つ）
       | [ $all[] | select(.skill == $skill and .iterate_caller != "dev-flow") ] as $runs
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
           recent_runs: [ $occ[-5:][] | {timestamp, plugin_commit: .commit, file, issue, pr_number, repo, message} ],
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
    --argjson hold_codes "$HOLD_SIGNATURE_CODES" \
    --argjson hold_iterate_statuses "$HOLD_SIGNATURE_ITERATE_STATUSES" \
    "$REPORT_PROGRAM")"

# --- signature id と候補 commit ---------------------------------------------------
sig_id() {
    local h
    if command -v shasum >/dev/null 2>&1; then
        h="$(printf '%s' "$1" | shasum -a 1)"
    else
        h="$(printf '%s' "$1" | sha1sum)"
    fi
    printf '%s\n' "${h:0:12}"
}

list_candidates() {
    local good="$1" bad="$2"
    local log
    log="$(git -C "$REPO" log --format='%H%x09%s' "${good}..${bad}" -- "$CANDIDATE_PATH" 2>/dev/null)" || return 1
    printf '%s\n' "$log" | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {sha: .[0], subject: (.[1:] | join("\t"))})'
}

# signature ごとに REPORT 全体を jq で書き換えると signature 数の 2 乗で重くなる。
# id と候補 commit は 1 signature 1 行の更新として集め、最後の jq 1 回で反映する
COUNT="$(printf '%s' "$REPORT" | jq '.signatures | length')"
UPDATES=""
i=0
while [[ "$i" -lt "$COUNT" ]]; do
    # 1 行目に候補 pair（commit sha 2 つ・単一行）、2 行目以降に signature をそのまま出す
    row="$(printf '%s' "$REPORT" | jq -r --argjson i "$i" \
        '.signatures[$i] | (.candidates | if . != null and .error == null then "\(.last_good_commit) \(.first_bad_commit)" else "" end), .signature')"
    pair="${row%%$'\n'*}"
    # signature が空なら $(...) が末尾の改行ごと落とすので、改行が無ければ空として扱う
    sig=""
    [[ "$row" == *$'\n'* ]] && sig="${row#*$'\n'}"
    update="{\"i\":$i,\"id\":\"$(sig_id "$sig")\""

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
        update+=",\"commits\":$commits,\"error\":${err:+\"$err\"}"
        [[ -n "$err" ]] || update+="null"
    fi
    UPDATES+="$update}"$'\n'
    i=$((i + 1))
done

# 入力の 1 件目が REPORT、2 件目以降が signature ごとの更新
printf '%s\n%s' "$REPORT" "$UPDATES" | jq -s --arg issue_repo "$ISSUE_REPO" \
    'reduce .[1:][] as $u (.[0];
        .signatures[$u.i].id = $u.id
        | if $u | has("commits") then
            .signatures[$u.i].candidates.commits = $u.commits
            | .signatures[$u.i].candidates.error = $u.error
          else . end)
     | {generated_at, window, resolve_after_runs, runs, summary, needs_llm,
        issue_repo: (if $issue_repo == "" then null else $issue_repo end), signatures}'
