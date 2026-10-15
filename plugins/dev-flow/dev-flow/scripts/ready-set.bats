#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/ready-set.sh (issue #775)
#
# ネットワークには出ない。gh は PATH 先頭の stub:
#   `issue view N`  → $GH_STUB_ISSUES_DIR/N.json（無い・N == GH_STUB_FAIL_ISSUE なら失敗）
#   `issue list`    → GH_STUB_LIST_FIXTURE（GH_STUB_LIST_FAIL で失敗）
#   `pr list`       → GH_STUB_PR_LIST_FIXTURE（無ければ []、GH_STUB_PR_LIST_FAIL で失敗）
#   `api .../issues/N/dependencies/blocked_by` → $GH_STUB_DEPS_DIR/N.json（無ければ []、GH_STUB_DEPS_FAIL で失敗）
# 呼び出しは全て $GH_LOG に 1 行ずつ残る。local branch / worktree は cwd の使い捨て git repo で作る。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/ready-set.sh"

setup() {
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin"
    GH_LOG="$WORK/gh.log"
    : >"$GH_LOG"
    GH_STUB_ISSUES_DIR="$WORK/issues"
    GH_STUB_DEPS_DIR="$WORK/deps"
    mkdir -p "$GH_STUB_ISSUES_DIR" "$GH_STUB_DEPS_DIR"
    cat >"$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [[ "$1" == "api" && "$2" == */dependencies/blocked_by* ]]; then
    if [[ -n "${GH_STUB_DEPS_FAIL:-}" ]]; then
        echo "$GH_STUB_DEPS_FAIL" >&2
        exit 1
    fi
    n="${2%/dependencies/*}"
    n="${n##*/}"
    if [[ -f "$GH_STUB_DEPS_DIR/$n.json" ]]; then cat "$GH_STUB_DEPS_DIR/$n.json"; else echo '[]'; fi
    exit 0
fi
if [[ "$1 $2" == "pr list" ]]; then
    if [[ -n "${GH_STUB_PR_LIST_FAIL:-}" ]]; then
        echo "$GH_STUB_PR_LIST_FAIL" >&2
        exit 1
    fi
    if [[ -n "${GH_STUB_PR_LIST_FIXTURE:-}" ]]; then cat "$GH_STUB_PR_LIST_FIXTURE"; else echo '[]'; fi
    exit 0
fi
if [[ "$1 $2" == "issue list" ]]; then
    if [[ -n "${GH_STUB_LIST_FAIL:-}" ]]; then
        echo "$GH_STUB_LIST_FAIL" >&2
        exit 1
    fi
    cat "$GH_STUB_LIST_FIXTURE"
    exit 0
fi
if [[ "$1 $2" == "issue view" && "$3" != "${GH_STUB_FAIL_ISSUE:-}" && -f "$GH_STUB_ISSUES_DIR/$3.json" ]]; then
    cat "$GH_STUB_ISSUES_DIR/$3.json"
    exit 0
fi
echo "GraphQL: Could not resolve to an issue with the number of $3." >&2
exit 1
STUB
    chmod +x "$WORK/bin/gh"
    export GH_LOG GH_STUB_ISSUES_DIR GH_STUB_DEPS_DIR
    unset GH_STUB_FAIL_ISSUE GH_STUB_LIST_FIXTURE GH_STUB_LIST_FAIL GH_STUB_DEPS_FAIL GIT_DIR GIT_WORK_TREE \
        GH_STUB_PR_LIST_FIXTURE GH_STUB_PR_LIST_FAIL
    export PATH="$WORK/bin:$PATH"

    # local branch / worktree を読む cwd の git repo
    git init -q "$WORK/repo"
    git -C "$WORK/repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
    cd "$WORK/repo"
}

# issue <number> <paths> [state=OPEN|CLOSED] [label=<name>] [pr=OPEN|CLOSED] [pre=<本文冒頭>]
#   <paths>: 空白区切りのパス / NONE（`## 変更対象パス` 見出しなし）/ EMPTY（見出しのみ）
issue() {
    local n="$1" paths="$2" state="OPEN" label="" pr="" pre="" kv p
    shift 2
    for kv in "$@"; do
        case "$kv" in
            state=*) state="${kv#state=}" ;;
            label=*) label="${kv#label=}" ;;
            pr=*) pr="${kv#pr=}" ;;
            pre=*) pre="${kv#pre=}" ;;
        esac
    done
    local body="${pre}

## 概要

説明。
"
    case "$paths" in
        NONE) ;;
        EMPTY) body+="
## 変更対象パス

" ;;
        *)
            body+="
## 変更対象パス
"
            for p in $paths; do body+="- \`$p\`
"; done
            ;;
    esac
    # 次の見出し以降の箇条書きはパスに数えない
    body+="
## 専門観点での調査結果
- not/a/declared/path
"
    jq -n --argjson n "$n" --arg s "$state" --arg l "$label" --arg pr "$pr" --arg b "$body" '{
        number: $n, title: "issue \($n)", state: $s, body: $b,
        url: "https://github.com/acme/skills/issues/\($n)",
        labels: (if $l == "" then [] else [{name: $l}] end),
        closedByPullRequestsReferences: (if $pr == "" then [] else [{number: (900 + $n), state: $pr}] end)}' \
        >"$GH_STUB_ISSUES_DIR/$n.json"
}

ready_set() {
    run --separate-stderr "$SCRIPT" --repo acme/skills "$@"
}

# ---- AC-1: 入出力 ----

@test "ready-set: 重ならない 2 件 -> launch に {number,title,paths,command,bg_command} を 1 行 JSON で出す" {
    issue 3 "plugins/a/x.sh plugins/a/x.bats"
    issue 4 "plugins/b"
    ready_set 4 3
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '. == {ok: true,
        launch: [
            {number: 3, title: "issue 3", paths: ["plugins/a/x.sh", "plugins/a/x.bats"], command: "/dev-flow 3",
             bg_command: "claude --bg \"/dev-flow 3\""},
            {number: 4, title: "issue 4", paths: ["plugins/b"], command: "/dev-flow 4",
             bg_command: "claude --bg \"/dev-flow 4\""}],
        in_flight: [], waiting: []}'
    grep -qx 'issue view 3 --repo acme/skills --json number,title,state,labels,body,url,closedByPullRequestsReferences' "$GH_LOG"
}

@test "ready-set: --label はそのラベルの open issue を候補にする（番号指定と併用可）" {
    issue 40 "a"
    issue 41 "b"
    issue 42 "c"
    printf '[{"number":41},{"number":40}]' >"$WORK/list.json"
    GH_STUB_LIST_FIXTURE="$WORK/list.json" ready_set --label dev-ready 42
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [40, 41, 42]'
    grep -qx 'issue list --repo acme/skills --label dev-ready --state open --limit 1000 --json number' "$GH_LOG"
}

@test "ready-set: 候補が無い引数 -> exit 2 と ok:false" {
    run --separate-stderr "$SCRIPT"
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false and (.error | test("Usage"))'
}

# ---- AC-2: 分類 ----

@test "ready-set: closed の issue はどこにも出力しない" {
    issue 5 "a" state=CLOSED
    issue 6 "b"
    ready_set 5 6
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [6] and .in_flight == [] and .waiting == []'
}

@test "ready-set: human-task ラベル -> waiting human_task" {
    issue 7 "a" label=human-task
    ready_set 7
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.launch == [] and .waiting == [{number: 7, reason: "human_task", detail: "label human-task"}]'
}

@test "ready-set: 本文 Blocked by の open な blocker -> waiting blocked_by（detail に番号）、closed なら ready" {
    issue 8 "a" pre="Blocked by #50"
    issue 9 "b" pre="Blocked by #51"
    issue 50 "z"
    issue 51 "z" state=CLOSED
    ready_set 8 9
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [9] and .waiting == [{number: 8, reason: "blocked_by", detail: "#50"}]'
}

@test "ready-set: dependencies API の open な blocker（他 repo を含む）-> waiting blocked_by" {
    issue 10 "a"
    printf '[{"number":60,"state":"open","html_url":"https://github.com/acme/skills/issues/60"},{"number":5,"state":"open","html_url":"https://github.com/other/lib/issues/5"}]' \
        >"$GH_STUB_DEPS_DIR/10.json"
    ready_set 10
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.waiting == [{number: 10, reason: "blocked_by", detail: "#60 other/lib#5"}]'
    grep -qx 'api repos/acme/skills/issues/10/dependencies/blocked_by?per_page=100' "$GH_LOG"
}

@test "ready-set: open な linked PR -> in_flight open_pr、closed な PR だけなら ready" {
    issue 11 "a" pr=OPEN
    issue 12 "b" pr=CLOSED
    ready_set 11 12
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 11, reason: "open_pr"}] and [.launch[].number] == [12]'
}

@test "ready-set: feature/issue-<N> の local branch -> in_flight local_branch" {
    git branch feature/issue-13
    issue 13 "a"
    issue 14 "b"
    ready_set 13 14
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 13, reason: "local_branch"}] and [.launch[].number] == [14]'
}

@test "ready-set: df-<N> の worktree -> in_flight worktree" {
    git worktree add -q -b wip "$WORK/df-15"
    issue 15 "a"
    ready_set 15
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 15, reason: "worktree"}] and .launch == []'
}

# ---- AC-3: 貪欲選択 ----

@test "ready-set: 番号の昇順に貪欲に選び、選んだ集合と重なる issue は waiting path_conflict（detail に相手）" {
    issue 22 "pkg/a/y.sh"
    issue 20 "pkg/a"
    issue 21 "pkg/a/x.sh"
    issue 23 "pkg/b"
    ready_set 22 23 21 20
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [20, 23] and .waiting == [
        {number: 21, reason: "path_conflict", detail: "#20"},
        {number: 22, reason: "path_conflict", detail: "#20"}]'
}

@test "ready-set: in_flight の変更対象パスは最初から占有扱い" {
    issue 30 "pkg/a" pr=OPEN
    issue 31 "pkg/a/x.sh"
    issue 32 "pkg/b"
    ready_set 30 31 32
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 30, reason: "open_pr"}] and [.launch[].number] == [32]
        and .waiting == [{number: 31, reason: "path_conflict", detail: "#30"}]'
}

# ---- AC-4: 重なり判定 ----

@test "ready-set: glob は最初の glob 文字より前の静的 prefix に縮めて判定する" {
    issue 40 "plugins/dev-flow/**/*.sh"
    issue 41 "plugins/dev-flow/bin/x"
    issue 42 "plugins/dev-*"
    issue 43 "docs/{a,b}.md"
    issue 44 "docs/c.md"
    ready_set 40 41 42 43 44
    [ "$status" -eq 0 ]
    # 40 → plugins/dev-flow、42 → plugins（glob の掛かるセグメントは落とす）、43 → docs
    echo "$output" | jq -e '[.launch[].number] == [40, 43] and .waiting == [
        {number: 41, reason: "path_conflict", detail: "#40"},
        {number: 42, reason: "path_conflict", detail: "#40"},
        {number: 44, reason: "path_conflict", detail: "#43"}]'
}

@test "ready-set: prefix はパスセグメント単位（文字列 prefix だけでは重ならない）" {
    issue 45 "plugins/dev-flow"
    issue 46 "plugins/dev-flow-x/a.sh"
    issue 47 "./plugins/dev-flow/x.sh"
    ready_set 45 46 47
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [45, 46] and .waiting == [{number: 47, reason: "path_conflict", detail: "#45"}]'
}

@test "ready-set: lockfile は repo 内のどこにあっても互いに重なる" {
    issue 50 "web/package-lock.json"
    issue 51 "pnpm-lock.yaml"
    issue 52 "nix/flake.lock"
    issue 53 "web/src/app.ts"
    ready_set 50 51 52 53
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [50, 53] and .waiting == [
        {number: 51, reason: "path_conflict", detail: "#50"},
        {number: 52, reason: "path_conflict", detail: "#50"}]'
}

# ---- AC-5: 変更対象パスの申告なし ----

@test "ready-set: 変更対象パスが無い issue は launch 集合が空のときだけ単独で選ばれる" {
    issue 60 NONE
    issue 61 "a"
    ready_set 60 61
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.launch == [{number: 60, title: "issue 60", paths: [], command: "/dev-flow 60",
            bg_command: "claude --bg \"/dev-flow 60\""}]
        and .waiting == [{number: 61, reason: "path_conflict", detail: "#60(変更対象パスなし)"}]'
}

@test "ready-set: 変更対象パスが無い・空の issue は他が選ばれていれば waiting no_declared_paths" {
    issue 62 "a"
    issue 63 NONE
    issue 64 EMPTY
    ready_set 62 63 64
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [62] and .waiting == [
        {number: 63, reason: "no_declared_paths", detail: "#62"},
        {number: 64, reason: "no_declared_paths", detail: "#62"}]'
}

@test "ready-set: 変更対象パスが無い issue は in_flight があれば waiting no_declared_paths" {
    issue 65 "a" pr=OPEN
    issue 66 NONE
    ready_set 65 66
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.launch == [] and .waiting == [{number: 66, reason: "no_declared_paths", detail: "#65"}]'
}

# ---- AC-7: 読み取りのみ / 読み取り失敗は ok:false ----

@test "ready-set: issue の取得失敗 -> ok:false と非 0 終了（失敗した issue を ready に倒さない）" {
    issue 70 "a"
    issue 71 "b"
    GH_STUB_FAIL_ISSUE=71 ready_set 70 71
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.ok == false and (.error | test("#71")) and has("launch") == false'
}

@test "ready-set: blocker の取得失敗 -> ok:false と非 0 終了" {
    issue 72 "a"
    GH_STUB_DEPS_FAIL="HTTP 502" ready_set 72
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.ok == false and (.error | test("HTTP 502"))'
}

@test "ready-set: --label の一覧取得失敗 -> ok:false と非 0 終了" {
    GH_STUB_LIST_FAIL="HTTP 401" ready_set --label dev-ready
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.ok == false and (.error | test("HTTP 401"))'
}

@test "ready-set: gh は読み取りだけ呼び、cwd の repo とファイルを変更しない" {
    git branch feature/issue-80
    issue 80 "a"
    issue 81 "b" pre="Blocked by #82"
    issue 82 "c"
    issue 83 "d"
    printf '[{"number":83}]' >"$WORK/list.json"
    local before_refs before_files
    before_refs="$(git for-each-ref)"
    before_files="$(ls -A "$WORK/repo")"
    GH_STUB_LIST_FIXTURE="$WORK/list.json" ready_set --label dev-ready 80 81
    [ "$status" -eq 0 ]
    # 呼ぶのは issue view / issue list / dependencies API（GET）だけ
    [ -s "$GH_LOG" ]
    [ -z "$(grep -vE '^(issue view|issue list|api repos/acme/skills/issues/[0-9]+/dependencies/blocked_by\?per_page=100$)' "$GH_LOG")" ]
    [ -z "$(grep -E '(^| )(-X|--method|-f|--field|-F|--raw-field|--input)( |$)' "$GH_LOG")" ]
    [ "$(git for-each-ref)" = "$before_refs" ]
    [ "$(ls -A "$WORK/repo")" = "$before_files" ]
    [ -z "$(git status --porcelain)" ]
}

# ---- --with-in-flight: 実行中の issue を自動で占有に入れる ----

pr_heads() {
    local h json='[]'
    for h in "$@"; do json="$(jq -c --arg h "$h" '. + [{headRefName: $h}]' <<<"$json")"; done
    printf '%s' "$json" >"$WORK/prs.json"
    export GH_STUB_PR_LIST_FIXTURE="$WORK/prs.json"
}

@test "ready-set: --with-in-flight 無しでは open PR 一覧を読まない（既定の挙動は変えない）" {
    git branch feature/issue-100
    issue 100 "pkg/a"
    issue 101 "pkg/a/x.sh"
    ready_set 101
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '[.launch[].number] == [101] and .in_flight == []'
    ! grep -q '^pr list' "$GH_LOG"
}

@test "ready-set: --with-in-flight は head が feature/issue-<N> の open PR を in_flight open_pr にし、パスを占有する" {
    pr_heads feature/issue-110 renovate/foo
    issue 110 "pkg/a"
    issue 111 "pkg/a/x.sh"
    issue 112 "pkg/b"
    ready_set --with-in-flight 111 112
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 110, reason: "open_pr"}] and [.launch[].number] == [112]
        and .waiting == [{number: 111, reason: "path_conflict", detail: "#110"}]'
    grep -q '^pr list --repo acme/skills --state open --limit 1000 --json headRefName$' "$GH_LOG"
}

@test "ready-set: --with-in-flight は feature/issue-<N> の local branch と df-<N> の worktree も拾う" {
    git branch feature/issue-120
    git worktree add -q -b wip "$WORK/df-121"
    issue 120 "pkg/a"
    issue 121 "pkg/b"
    issue 122 "pkg/a/x.sh pkg/b/y.sh"
    issue 123 "pkg/c"
    ready_set --with-in-flight 122 123
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 120, reason: "local_branch"}, {number: 121, reason: "worktree"}]
        and [.launch[].number] == [123]
        and .waiting == [{number: 122, reason: "path_conflict", detail: "#120 #121"}]'
}

@test "ready-set: --with-in-flight で拾った issue に変更対象パスが無ければ全部と重なり、detail に印が付く" {
    pr_heads feature/issue-130
    issue 130 NONE
    issue 131 "pkg/a"
    ready_set --with-in-flight 131
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 130, reason: "open_pr"}] and .launch == []
        and .waiting == [{number: 131, reason: "path_conflict", detail: "#130(変更対象パスなし)"}]'
}

@test "ready-set: --with-in-flight で拾った issue は human-task・blocker があっても in_flight、closed は出力しない" {
    git branch feature/issue-140
    git branch feature/issue-141
    git branch feature/issue-142
    issue 140 "pkg/a" label=human-task
    issue 141 "pkg/b" pre="Blocked by #149"
    issue 142 "pkg/c" state=CLOSED
    issue 149 "z"
    issue 143 "pkg/c"
    ready_set --with-in-flight 143
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 140, reason: "local_branch"}, {number: 141, reason: "local_branch"}]
        and [.launch[].number] == [143] and .waiting == []'
    # 拾っただけの issue の blocker は読まない
    ! grep -q 'issues/141/dependencies' "$GH_LOG"
}

@test "ready-set: 渡した候補が実行中でも --with-in-flight で重複しない" {
    pr_heads feature/issue-150
    issue 150 "pkg/a" pr=OPEN
    ready_set --with-in-flight 150
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.in_flight == [{number: 150, reason: "open_pr"}] and .launch == [] and .waiting == []'
}

@test "ready-set: --with-in-flight だけでも実行でき、実行中の一覧を返す" {
    git branch feature/issue-160
    issue 160 "pkg/a"
    ready_set --with-in-flight
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: true, launch: [], in_flight: [{number: 160, reason: "local_branch"}], waiting: []}'
}

@test "ready-set: --with-in-flight の open PR 一覧取得失敗 -> ok:false と非 0 終了" {
    issue 170 "a"
    GH_STUB_PR_LIST_FAIL="HTTP 403" ready_set --with-in-flight 170
    [ "$status" -ne 0 ]
    echo "$output" | jq -e '.ok == false and (.error | test("HTTP 403")) and has("launch") == false'
}

@test "ready-set: --with-in-flight でも gh は読み取りだけ呼ぶ" {
    pr_heads feature/issue-180
    git branch feature/issue-181
    issue 180 "a"
    issue 181 "b"
    issue 182 "c"
    ready_set --with-in-flight 182
    [ "$status" -eq 0 ]
    [ -z "$(grep -vE '^(issue view|pr list|api repos/acme/skills/issues/[0-9]+/dependencies/blocked_by\?per_page=100$)' "$GH_LOG")" ]
    [ -z "$(grep -E '(^| )(-X|--method|-f|--field|-F|--raw-field|--input)( |$)' "$GH_LOG")" ]
}

# ---- 出力仕様と dev-flow SKILL.md「並列実行」節（issue #1000） ----

# dev-flow SKILL.md の「## 並列実行」節を次の `## ` 見出しまで抜き出す
parallel_section() {
    awk '/^## 並列実行/ { f = 1; print; next } f && /^## / { exit } f { print }' \
        "$(dirname "$SCRIPT")/../SKILL.md"
}

@test "ready-set: 冒頭の出力仕様コメントが launch[] の command と bg_command を書いている" {
    grep -qF '#   { ok: true, launch: [{number, title, paths, command: "/dev-flow <N>", bg_command: "claude --bg \"/dev-flow <N>\""}],' "$SCRIPT"
}

@test "ready-set: SKILL.md 並列実行節は agent が repo ルートで bg_command を実行して自分で起動し、claude logs / attach で追うと書く" {
    sec="$(parallel_section)"
    [ -n "$sec" ]
    [[ "$sec" == *"人間が流すよう指示した issue を、agent が **issue ごとに別セッション**で自分で起動する（人間に起動を頼まない）"* ]]
    [[ "$sec" == *'自分のセッションで Workflow を回す 1 本は `launch[].command`（`/dev-flow <N>`）'* ]]
    [[ "$sec" == *'残りは repo ルートで各要素の `bg_command`（`claude --bg "/dev-flow <N>"`）を実行して別セッションを起動する'* ]]
    [[ "$sec" == *'`claude logs <id>` で進行を、`claude attach <id>` で'* ]]
}

@test "ready-set: SKILL.md 並列実行節は sandbox 内では ~/.claude/jobs を作れず EPERM になり、外の経路→人間に示す順で倒すと書く" {
    sec="$(parallel_section)"
    [[ "$sec" == *'sandbox 内の Bash からはそこを作れず `EPERM: operation not permitted, mkdir '"'"'<home>/.claude/jobs/<id>'"'"'` で'* ]]
    [[ "$sec" == *'`~/.claude/jobs`'* ]]
    [[ "$sec" == *'sandbox の外でコマンドを実行できる経路で `bg_command` を'*'実行し、それも無ければ `bg_command` を人間に示して起動を頼む'* ]]
}

@test "ready-set: SKILL.md 並列実行節は人間が指示した issue・本数だけを起動し、waiting は指名された path_conflict だけ起動してよいと書く" {
    sec="$(parallel_section)"
    [[ "$sec" == *"**起動するのは人間が指示した issue・本数だけ**"* ]]
    [[ "$sec" == *'人間が指示した範囲を超えて `launch[]` の残りを起動しない'* ]]
    [[ "$sec" == *'**`waiting[]` の issue は起動しない**'* ]]
    [[ "$sec" == *'人間が明示的に指名した `path_conflict` の issue は'*'merge 時に conflict が出る見込みを伝えたうえで起動してよい'* ]]
    [[ "$sec" == *'`blocked_by` / `human_task` は指名されても'*'起動しない'* ]]
}
