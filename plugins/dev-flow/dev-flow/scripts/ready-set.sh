#!/usr/bin/env bash
# ready-set.sh - 今 /dev-flow を流してよく、互いに変更対象パスが重ならない issue の集合を選ぶ（dev-flow-ready-set）
#
# Usage: dev-flow-ready-set [--repo <owner/name>] [--label <label>] [--with-in-flight] [<issue>...]
#   <issue>...        候補の issue 番号
#   --label <label>   そのラベルの open issue を候補に加える
#   --with-in-flight  実行中の issue を自動で加え、その変更対象パスを占有に入れる。実行中 = head が
#                     `feature/issue-<N>` の open PR、`feature/issue-<N>` の local branch、その branch か
#                     df-<N> の worktree。自動で加えた issue は human-task / blocker を見ずに in_flight にする
#                     （実際に走っているので占有から漏らさない）。closed の issue は残骸として出力しない
#
# 出力（stdout に 1 行 JSON）:
#   { ok: true, launch: [{number, title, paths, command: "/dev-flow <N>", bg_command: "claude --bg \"/dev-flow <N>\""}],
#     in_flight: [{number, reason: "open_pr"|"local_branch"|"worktree"}],
#     waiting: [{number, reason: "human_task"|"blocked_by"|"path_conflict"|"no_declared_paths", detail}] }
#   { ok: false, error: "..." }（exit 1。引数不正は exit 2）
#
# 分類（上から順に最初に当たったもの）:
#   closed → 出力しない / `human-task` ラベル → waiting human_task / open な blocker → waiting blocked_by
#   （detail に blocker 番号。判定は prerun と共有の _lib/scripts/issue-blockers.sh）/ open な linked PR、
#   `feature/issue-<N>` の local branch、その branch か df-<N> の worktree → in_flight / それ以外 → ready
#
# 選択: ready を issue 番号の昇順に貪欲に launch へ入れる。in_flight の変更対象パスは最初から占有扱い。
# 占有とパスが重なる issue は waiting path_conflict（detail に相手の番号）。`## 変更対象パス` が無い・空の
# issue は全パスと重なる扱い（占有が空のときだけ単独で launch、それ以外は waiting no_declared_paths）。
# 相手が申告なしで全パスと重なっただけなら detail の番号に `(変更対象パスなし)` を付ける（申告を足せば解ける）。
#
# パスの重なりは保守的に判定する（誤って並列にするより直列に倒す）: 各エントリを最初の glob 文字
# （`*?[{`）より前の完結したパスセグメントに縮め、セグメント単位で一方が他方の prefix なら重なり。
# lockfile は repo 内のどこにあっても互いに重なり（依存追加は別 issue でも同じ lockfile を書き換える）。
#
# 読み取りのみ: issue / PR / label の変更・push・ファイル書き込みはしない。gh / git の読み取り失敗は
# ok:false で終える（失敗した issue を ready に倒さない）。local branch / worktree はカレントの git repo を読む。

set -euo pipefail

ISSUE_BLOCKERS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/_lib/scripts/issue-blockers.sh"

die() {
    local code="$1" msg="$2"
    jq -cn --arg e "$msg" '{ok: false, error: $e}'
    exit "$code"
}

command -v jq >/dev/null 2>&1 || { echo '{"ok":false,"error":"jq is required"}'; exit 127; }

oneline() { printf '%s' "$1" | tr '\n' ' '; }

REPO=""
LABEL=""
WITH_IN_FLIGHT=0
CANDIDATES=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) [[ $# -ge 2 ]] || die 2 "--repo requires a value"; REPO="$2"; shift 2 ;;
        --label) [[ $# -ge 2 ]] || die 2 "--label requires a value"; LABEL="$2"; shift 2 ;;
        --with-in-flight) WITH_IN_FLIGHT=1; shift ;;
        -*) die 2 "Unknown option: $1" ;;
        *)
            [[ "$1" =~ ^[1-9][0-9]*$ ]] || die 2 "issue must be a positive integer: $1"
            CANDIDATES+=("$1"); shift ;;
    esac
done
[[ ${#CANDIDATES[@]} -gt 0 || -n "$LABEL" || "$WITH_IN_FLIGHT" == 1 ]] \
    || die 2 "Usage: dev-flow-ready-set [--repo owner/repo] [--label <label>] [--with-in-flight] [<issue>...]"

REPO_ARGS=()
[[ -n "$REPO" ]] && REPO_ARGS=(--repo "$REPO")

if [[ -n "$LABEL" ]]; then
    if ! LIST_RAW="$(gh issue list "${REPO_ARGS[@]+"${REPO_ARGS[@]}"}" --label "$LABEL" --state open --limit 1000 --json number 2>&1)"; then
        die 1 "label ${LABEL} の open issue 一覧を取得できない: $(oneline "$LIST_RAW")"
    fi
    LABELED="$(printf '%s' "$LIST_RAW" | jq -r '
        if type == "array" and all(.[]; (.number | type) == "number") then .[].number else error("malformed") end' 2>/dev/null)" \
        || die 1 "label ${LABEL} の open issue 一覧の応答が不正"
    while IFS= read -r N; do
        [[ -n "$N" ]] && CANDIDATES+=("$N")
    done <<<"$LABELED"
fi

# 在庫中の作業（local branch / worktree）はカレントの git repo から 1 回だけ読む
if ! BRANCHES="$(git for-each-ref --format='%(refname:short)' refs/heads/feature/ 2>&1)"; then
    die 1 "local branch を読めない（git repo の中で実行する）: $(oneline "$BRANCHES")"
fi
if ! WORKTREES="$(git worktree list --porcelain 2>&1)"; then
    die 1 "worktree 一覧を読めない（git repo の中で実行する）: $(oneline "$WORKTREES")"
fi
WT_BRANCHES="$(printf '%s\n' "$WORKTREES" | awk '/^branch refs\/heads\//{ print substr($0, 19) }')"
WT_DIRS="$(printf '%s\n' "$WORKTREES" | awk '/^worktree /{ n = split(substr($0, 10), p, "/"); print p[n] }')"

has_line() { printf '%s\n' "$2" | grep -qxF -- "$1"; }

# --with-in-flight: 実行中の issue を open PR の head / local branch / worktree から拾い、候補に足す。
# 利用者が渡した候補（USER_CANDIDATES）とは分けて持ち、拾っただけの issue は in_flight 判定だけ行う
USER_CANDIDATES="$(printf '%s\n' "${CANDIDATES[@]+"${CANDIDATES[@]}"}" | sort -n -u)"
PR_HEADS=""
if [[ "$WITH_IN_FLIGHT" == 1 ]]; then
    if ! PR_RAW="$(gh pr list "${REPO_ARGS[@]+"${REPO_ARGS[@]}"}" --state open --limit 1000 --json headRefName 2>&1)"; then
        die 1 "open PR 一覧を取得できない: $(oneline "$PR_RAW")"
    fi
    PR_HEADS="$(printf '%s' "$PR_RAW" | jq -r '
        if type == "array" and all(.[]; (.headRefName | type) == "string") then .[].headRefName else error("malformed") end' 2>/dev/null)" \
        || die 1 "open PR 一覧の応答が不正"
    DISCOVERED="$(
        printf '%s\n' "$PR_HEADS" "$BRANCHES" "$WT_BRANCHES" | sed -nE 's#^feature/issue-([1-9][0-9]*)$#\1#p'
        printf '%s\n' "$WT_DIRS" | sed -nE 's#^df-([1-9][0-9]*)$#\1#p'
    )"
    while IFS= read -r N; do
        [[ -n "$N" ]] && CANDIDATES+=("$N")
    done <<<"$DISCOVERED"
fi

# `## 変更対象パス` 見出しから次の `#` / `##` 見出しまでの `- <entry>` 行（create_issue.py の書式と同じ）
# shellcheck disable=SC2016
JQ_DECLARED_PATHS='def declared_paths: [ (gsub("\r"; "") | split("\n")) as $l
  | ($l | map(test("^##[ \t]+変更対象パス[ \t]*$")) | index(true)) as $h
  | if $h == null then empty else
      ($l[($h + 1):]) as $rest
      | ($rest | map(test("^#{1,2}[ \t]")) | index(true)) as $e
      | (if $e == null then $rest else $rest[:$e] end)[]
      | select(test("^-[ \t]+\\S"))
      | sub("^-[ \t]+"; "") | gsub("`"; "") | sub("[ \t]+$"; "")
      | select(. != "")
    end ];'

# 実行中の理由（open_pr / local_branch / worktree）。走っていなければ空。PR_HEADS は --with-in-flight の時だけ埋まる
flight_of() {
    local n="$1" issue_json="$2"
    if [[ "$(jq -r '.open_pr' <<<"$issue_json")" == "true" ]] || has_line "feature/issue-${n}" "$PR_HEADS"; then
        echo "open_pr"
    elif has_line "feature/issue-${n}" "$BRANCHES"; then
        echo "local_branch"
    elif has_line "feature/issue-${n}" "$WT_BRANCHES" || has_line "df-${n}" "$WT_DIRS"; then
        echo "worktree"
    fi
}

SORTED="$(printf '%s\n' "${CANDIDATES[@]+"${CANDIDATES[@]}"}" | sort -n -u)"
READY='[]'
IN_FLIGHT='[]'
WAITING='[]'
while IFS= read -r N; do
    [[ -z "$N" ]] && continue
    if ! VIEW_RAW="$(gh issue view "$N" "${REPO_ARGS[@]+"${REPO_ARGS[@]}"}" --json number,title,state,labels,body,url,closedByPullRequestsReferences 2>&1)"; then
        die 1 "#${N} を取得できない: $(oneline "$VIEW_RAW")"
    fi
    # closedByPullRequestsReferences は既定で close 済み PR を含まない。state が載っていれば OPEN だけ数える
    ISSUE_JSON="$(printf '%s' "$VIEW_RAW" | jq -c --argjson n "$N" "$JQ_DECLARED_PATHS"'
        if (.state | type) == "string" and (.title | type) == "string" and (.labels | type) == "array"
           and (.closedByPullRequestsReferences | type) == "array"
        then {number: $n, title, url: (.url // ""),
              state: (.state | ascii_upcase),
              human_task: any(.labels[]; .name == "human-task"),
              open_pr: any(.closedByPullRequestsReferences[]; ((.state // "OPEN") | ascii_upcase) == "OPEN"),
              paths: ((.body // "") | declared_paths)}
        else error("malformed") end' 2>/dev/null)" \
        || die 1 "#${N} の応答が不正"

    [[ "$(jq -r '.state' <<<"$ISSUE_JSON")" == "OPEN" ]] || continue

    if ! has_line "$N" "$USER_CANDIDATES"; then
        # --with-in-flight で拾っただけの issue: 走っているなら占有に入れ、そうでなければ出力しない
        FLIGHT="$(flight_of "$N" "$ISSUE_JSON")"
        if [[ -n "$FLIGHT" ]]; then
            IN_FLIGHT="$(jq -c --argjson i "$ISSUE_JSON" --arg r "$FLIGHT" '. + [$i + {reason: $r}]' <<<"$IN_FLIGHT")"
        fi
        continue
    fi

    if [[ "$(jq -r '.human_task' <<<"$ISSUE_JSON")" == "true" ]]; then
        WAITING="$(jq -c --argjson n "$N" '. + [{number: $n, reason: "human_task", detail: "label human-task"}]' <<<"$WAITING")"
        continue
    fi

    if ! BLOCKERS="$(bash "$ISSUE_BLOCKERS" --issue "$N" "${REPO_ARGS[@]+"${REPO_ARGS[@]}"}" 2>&1)"; then
        die 1 "#${N}: $(oneline "$BLOCKERS")"
    fi
    OPEN_BLOCKERS="$(jq -r --arg url "$(jq -r '.url' <<<"$ISSUE_JSON")" '
        ($url | capture("^https://[^/]+/(?<r>[^/]+/[^/]+)/issues/").r // "") as $self
        | [.[] | select(.state == "OPEN") | (if .repo == $self then "" else .repo end) + "#\(.number)"] | join(" ")' \
        <<<"$BLOCKERS" 2>/dev/null)" \
        || die 1 "#${N}: issue-blockers.sh の出力が不正"
    if [[ -n "$OPEN_BLOCKERS" ]]; then
        WAITING="$(jq -c --argjson n "$N" --arg d "$OPEN_BLOCKERS" '. + [{number: $n, reason: "blocked_by", detail: $d}]' <<<"$WAITING")"
        continue
    fi

    FLIGHT="$(flight_of "$N" "$ISSUE_JSON")"
    if [[ -n "$FLIGHT" ]]; then
        IN_FLIGHT="$(jq -c --argjson i "$ISSUE_JSON" --arg r "$FLIGHT" '. + [$i + {reason: $r}]' <<<"$IN_FLIGHT")"
        continue
    fi

    READY="$(jq -c --argjson i "$ISSUE_JSON" '. + [$i]' <<<"$READY")"
done <<<"$SORTED"

jq -cn --argjson ready "$READY" --argjson in_flight "$IN_FLIGHT" --argjson waiting "$WAITING" '
    def lockfiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum", "flake.lock", "uv.lock", "poetry.lock"];
    def is_lockfile: (split("/") | last) as $b | lockfiles | index($b) != null;
    # 最初の glob 文字より前の完結したセグメント（glob が途中に掛かるセグメントは落とす）
    def segments:
        sub("^(\\./)+"; "")
        | if test("[*?\\[{]") then (capture("^(?<s>[^*?\\[{]*)").s | split("/") | .[:-1]) else split("/") end
        | map(select(. != "" and . != "."));
    def seg_prefix($a; $b): ($a | length) <= ($b | length) and $b[:($a | length)] == $a;
    def overlap($x; $y):
        ($x | is_lockfile) and ($y | is_lockfile)
        or (($x | segments) as $a | ($y | segments) as $b | seg_prefix($a; $b) or seg_prefix($b; $a));
    # 申告なし（空）の issue は全パスと重なる
    def conflicts($p; $q): ($p | length) == 0 or ($q | length) == 0 or any($p[]; . as $x | any($q[]; overlap($x; .)));
    # 申告なしで全パスと重なった相手には印を付ける（申告を足せば解ける待ちだと分かるように）
    def refs: map("#\(.number)" + (if (.paths | length) == 0 then "(変更対象パスなし)" else "" end)) | join(" ");

    (reduce ($ready | sort_by(.number))[] as $c (
        {launch: [], occupied: [$in_flight[] | {number, paths}], waiting: []};
        ([.occupied[] | select(conflicts(.paths; $c.paths))]) as $hit
        | if ($hit | length) == 0 then
            .launch += [{number: $c.number, title: $c.title, paths: $c.paths, command: "/dev-flow \($c.number)",
                         bg_command: "claude --bg \"/dev-flow \($c.number)\""}]
            | .occupied += [{number: $c.number, paths: $c.paths}]
          elif ($c.paths | length) == 0 then
            .waiting += [{number: $c.number, reason: "no_declared_paths", detail: ($hit | refs)}]
          else
            .waiting += [{number: $c.number, reason: "path_conflict", detail: ($hit | refs)}]
          end
    )) as $sel
    | {ok: true,
       launch: $sel.launch,
       in_flight: [$in_flight[] | {number, reason}],
       waiting: (($waiting + $sel.waiting) | sort_by(.number))}'
