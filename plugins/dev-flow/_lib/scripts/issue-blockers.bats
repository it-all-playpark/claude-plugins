#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _lib/scripts/issue-blockers.sh (issue #775)
#
# ネットワークには出ない。gh は PATH 先頭の stub:
#   `api .../dependencies/blocked_by` → GH_STUB_DEPS_FIXTURE（未設定なら []）、GH_STUB_DEPS_FAIL で失敗
#   `issue view N` → $GH_STUB_ISSUES_DIR/N.json（無ければ not found で失敗）
# 呼び出しは全て $GH_LOG に 1 行ずつ残る。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/issue-blockers.sh"

setup() {
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin"
    GH_LOG="$WORK/gh.log"
    : >"$GH_LOG"
    GH_STUB_ISSUES_DIR="$WORK/issues"
    mkdir -p "$GH_STUB_ISSUES_DIR"
    cat >"$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
# GH_STUB_HINT: gh 2.105.0 がエージェント環境で成功した呼び出しにも stderr へ出す案内を真似る
if [[ -n "${GH_STUB_HINT:-}" ]]; then
    echo "hint: if you need to wait for this pull request to be reviewed, merged, or closed before continuing, use this instead of polling:" >&2
fi
if [[ "$1" == "api" && "$2" == */dependencies/blocked_by* ]]; then
    if [[ -n "${GH_STUB_DEPS_FAIL:-}" ]]; then
        echo "$GH_STUB_DEPS_FAIL" >&2
        exit 1
    fi
    if [[ -n "${GH_STUB_DEPS_FIXTURE:-}" ]]; then cat "$GH_STUB_DEPS_FIXTURE"; else echo '[]'; fi
    exit 0
fi
if [[ "$1 $2" == "issue view" && -f "$GH_STUB_ISSUES_DIR/$3.json" ]]; then
    cat "$GH_STUB_ISSUES_DIR/$3.json"
    exit 0
fi
echo "GraphQL: Could not resolve to an issue with the number of $3." >&2
exit 1
STUB
    chmod +x "$WORK/bin/gh"
    export GH_LOG GH_STUB_ISSUES_DIR
    unset GH_STUB_DEPS_FIXTURE GH_STUB_DEPS_FAIL GH_STUB_HINT
    export PATH="$WORK/bin:$PATH"
}

# deps_fixture <number> <state>...: dependencies API（blocked_by）の応答（acme/skills の issue）
deps_fixture() {
    local items='[]'
    while [[ $# -ge 2 ]]; do
        items="$(jq -c --argjson n "$1" --arg s "$2" '. + [{number: $n, state: $s, html_url: "https://github.com/acme/skills/issues/\($n)"}]' <<<"$items")"
        shift 2
    done
    printf '%s' "$items" >"$WORK/deps.json"
    export GH_STUB_DEPS_FIXTURE="$WORK/deps.json"
}

# issue_fixture <repo> <number> <STATE> [body]: `gh issue view N` の応答
issue_fixture() {
    jq -n --arg r "$1" --argjson n "$2" --arg s "$3" --arg b "${4:-}" \
        '{number: $n, state: $s, url: "https://github.com/\($r)/issues/\($n)", body: $b}' \
        >"$GH_STUB_ISSUES_DIR/$2.json"
}

@test "issue-blockers: 依存なし -> []（exit 0）、--repo の dependencies API と本文を読む" {
    issue_fixture acme/skills 7 OPEN "本文"
    run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
    grep -qx 'api repos/acme/skills/issues/7/dependencies/blocked_by?per_page=100' "$GH_LOG"
    grep -qx 'issue view 7 --repo acme/skills --json body' "$GH_LOG"
}

@test "issue-blockers: --repo 省略時は gh api の {owner}/{repo} を使う" {
    issue_fixture acme/skills 7 OPEN "本文"
    run --separate-stderr "$SCRIPT" --issue 7
    [ "$status" -eq 0 ]
    grep -qx 'api repos/{owner}/{repo}/issues/7/dependencies/blocked_by?per_page=100' "$GH_LOG"
    grep -qx 'issue view 7 --json body' "$GH_LOG"
}

@test "issue-blockers: API と本文の Blocked by の和集合を返し、同じ issue は 1 件（source=api）にまとめる" {
    issue_fixture acme/skills 7 OPEN "Blocked by #12
- blocked by: other/lib#5, #12"
    deps_fixture 12 open 13 closed
    issue_fixture acme/skills 12 OPEN
    issue_fixture other/lib 5 CLOSED
    run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == [
        {repo: "acme/skills", number: 12, state: "OPEN", source: "api", url: "https://github.com/acme/skills/issues/12"},
        {repo: "acme/skills", number: 13, state: "CLOSED", source: "api", url: "https://github.com/acme/skills/issues/13"},
        {repo: "other/lib", number: 5, state: "CLOSED", source: "body", url: "https://github.com/other/lib/issues/5"}]'
    # 本文で 2 回出る #12 は 1 回だけ読む
    [ "$(grep -c '^issue view 12 ' "$GH_LOG")" -eq 1 ]
    grep -qx 'issue view 5 --repo other/lib --json number,state,url' "$GH_LOG"
}

@test "issue-blockers: gh が成功して stderr に案内を出しても 3 種の応答を JSON として読む（stdout だけを読む）" {
    issue_fixture acme/skills 7 OPEN "Blocked by other/lib#5"
    deps_fixture 12 open
    issue_fixture other/lib 5 CLOSED
    GH_STUB_HINT=1 run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == [
        {repo: "acme/skills", number: 12, state: "OPEN", source: "api", url: "https://github.com/acme/skills/issues/12"},
        {repo: "other/lib", number: 5, state: "CLOSED", source: "body", url: "https://github.com/other/lib/issues/5"}]'
}

@test "issue-blockers: 行頭でない Blocked by の言及は拾わない" {
    issue_fixture acme/skills 7 OPEN "本文の \`Blocked by #99\` 行を読む"
    run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
    ! grep -q '^issue view 99' "$GH_LOG"
}

@test "issue-blockers: dependencies API の取得失敗 -> exit 1（stderr に理由）" {
    issue_fixture acme/skills 7 OPEN "本文"
    GH_STUB_DEPS_FAIL="HTTP 404: Not Found" run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 1 ]
    [ -z "$output" ]
    [[ "$stderr" == *"dependencies API"*"HTTP 404"* ]]
}

@test "issue-blockers: dependencies API の応答が配列でない -> exit 1" {
    issue_fixture acme/skills 7 OPEN "本文"
    printf '{"message":"Not Found"}' >"$WORK/deps.json"
    GH_STUB_DEPS_FIXTURE="$WORK/deps.json" run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 1 ]
    [[ "$stderr" == *"dependencies API の応答が不正"* ]]
}

@test "issue-blockers: 本文の Blocked by 先の状態を取得できない -> exit 1" {
    issue_fixture acme/skills 7 OPEN "Blocked by #404"
    run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 1 ]
    [[ "$stderr" == *"Blocked by #404"*"Could not resolve"* ]]
}

@test "issue-blockers: 対象 issue の本文を取得できない -> exit 1" {
    run --separate-stderr "$SCRIPT" --issue 7 --repo acme/skills
    [ "$status" -eq 1 ]
    [[ "$stderr" == *"issue 本文の取得に失敗"* ]]
}

@test "issue-blockers: --issue が正の整数でない -> exit 2" {
    run --separate-stderr "$SCRIPT" --issue abc
    [ "$status" -eq 2 ]
}
