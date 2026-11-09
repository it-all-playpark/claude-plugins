#!/usr/bin/env bats
# Tests for _shared/scripts/merge-tier-facts.sh (issue #637 / #1311)
#
# Strategy: mktemp -d の隔離 git fixture repo (base branch + feature commit) を worktree として
# 扱う。merge-tier-facts.sh は読み取り専用の `gh pr view` を 1 回だけ自分で実行するので、PATH 先頭の
# gh スタブ (受けた argv を GH_STUB_LOG に 1 行ずつ記録し、GH_STUB_RESPONSE の fixture JSON を返す。
# GH_STUB_EXIT を設定すると stderr に GH_STUB_STDERR を出してその exit code で落ちる) で応答を差し替える。
# サブ結果 (diffhash/risk/changed/pr/head_tree/checks/closes) の独立性 —— 1 つの失敗が他へ波及しない —— を、
# gh の失敗・応答の形・git object 不在・引数不正で個別に誘発して検証する。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/merge-tier-facts.sh"
    PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    CORE_BIN_DIR="$PLUGIN_ROOT/../playpark-core/bin"

    REPO="$(mktemp -d)"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    printf 'hello\n' > "$REPO/base.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m base
    # 従来の call site は origin/<BASE> を渡す。fixture では origin/main を base commit に向ける
    git -C "$REPO" update-ref refs/remotes/origin/main HEAD
    git -C "$REPO" checkout -q -b feature/issue-1
    printf 'feature\n' > "$REPO/src.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m feature
    HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
    HEAD_TREE="$(git -C "$REPO" rev-parse 'HEAD^{tree}')"

    CHECKS_JSON='[{"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z"},{"name":"bats","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z"}]'

    STUB_BIN="$(mktemp -d)"
    export GH_STUB_LOG="$STUB_BIN/gh-argv.log"
    export GH_STUB_RESPONSE="$STUB_BIN/gh-response.json"
    cat > "$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
if [[ -n "${GH_STUB_EXIT:-}" ]]; then
    printf '%s\n' "${GH_STUB_STDERR:-}" >&2
    exit "$GH_STUB_EXIT"
fi
cat "$GH_STUB_RESPONSE"
EOF
    chmod +x "$STUB_BIN/gh"
    write_response "$(printf 'Summary\n\nCloses #824\n')"
    ORIG_PATH="$PATH"
    PATH="$STUB_BIN:$CORE_BIN_DIR:$PATH"
}

teardown() {
    rm -rf "$REPO" "$STUB_BIN"
    PATH="$ORIG_PATH"
    unset GH_STUB_EXIT GH_STUB_STDERR
}

# write_response <body> [<rollup JSON>] [<headRefOid>]: gh pr view の応答 fixture を書く
write_response() {
    jq -nc --arg body "$1" --argjson rollup "${2:-$CHECKS_JSON}" --arg sha "${3:-$HEAD_SHA}" \
        '{mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: $sha, statusCheckRollup: $rollup, body: $body}' \
        > "$GH_STUB_RESPONSE"
}

run_facts() {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42 --repo acme/skills --issue 824 "$@"
}

gh_call_count() {
    if [[ -f "$GH_STUB_LOG" ]]; then wc -l < "$GH_STUB_LOG" | tr -d ' '; else echo 0; fi
}

# ---------------------------------------------------------------------------
# (a) 全経路正常 -> 全サブ結果 ok:true、値が各 git/gh 結果と一致。gh はちょうど 1 回
# ---------------------------------------------------------------------------
@test "正常系 -> 全サブ結果 ok:true で各値が一致し、gh は pr view 42 --repo acme/skills --json で 1 回だけ呼ばれる" {
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e --arg tree "$HEAD_TREE" --arg sha "$HEAD_SHA" '
        .diffhash.ok == true and .diffhash.value.hash == $tree and .diffhash.value.empty == false and
        .risk.ok == true and .risk.value.ok == true and (.risk.value.hits | length) == 0 and
        .changed.ok == true and .changed.value.files == ["src.txt"] and
        .pr.ok == true and .pr.value == {mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: $sha} and
        .head_tree.ok == true and .head_tree.value.tree == $tree and
        .checks.ok == true and .checks.value.checks == [{name: "bats", bucket: "pass"}, {name: "build", bucket: "pass"}] and
        .closes == {ok: true, value: {present: true}} and
        (.epoch | type) == "number"
    '
    [ "$(gh_call_count)" = "1" ]
    [ "$(cat "$GH_STUB_LOG")" = "pr view 42 --repo acme/skills --json mergeable,mergeStateStatus,headRefOid,statusCheckRollup,body" ]
}

@test "--repo 省略 -> gh の argv に --repo を付けない" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42 --issue 824
    [ "$status" -eq 0 ]
    [ "$(cat "$GH_STUB_LOG")" = "pr view 42 --json mergeable,mergeStateStatus,headRefOid,statusCheckRollup,body" ]
}

# ---------------------------------------------------------------------------
# (b) 出力は JSON 1 行のみで、PR 本文は出さない (exec-proxy が verbatim 転写する契約)
# ---------------------------------------------------------------------------
@test "stdout は JSON 1 行のみで、PR 本文を含まない" {
    write_response "$(printf 'Secret summary line\n\nCloses #824\n')"
    run_facts
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "1" ]
    [[ "$output" != *"Secret summary line"* ]]
}

# ---------------------------------------------------------------------------
# (c) closes: body の `Closes #<issue>(\D|$)` を true / false に畳む (issue #824)
# ---------------------------------------------------------------------------
@test "本文が Closes #8240 だけ -> closes.ok:true / present:false、他サブ結果は ok:true" {
    write_response "Closes #8240"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .closes == {ok: true, value: {present: false}} and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .pr.ok == true and .head_tree.ok == true and .checks.ok == true
    '
}

@test "本文の末尾が Closes #824 (改行なし) -> present:true" {
    write_response "body text Closes #824"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.closes == {ok: true, value: {present: true}}'
}

@test "body が null (文字列でない) -> closes だけ ok:false (Closes 欠落と区別する)" {
    jq -nc --arg sha "$HEAD_SHA" --argjson rollup "$CHECKS_JSON" \
        '{mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: $sha, statusCheckRollup: $rollup, body: null}' > "$GH_STUB_RESPONSE"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .closes.ok == false and .closes.value == null and (.closes.error | test("body is not a string")) and
        .pr.ok == true and .head_tree.ok == true and .checks.ok == true
    '
}

# ---------------------------------------------------------------------------
# (d) gh pr view 失敗 -> pr/head_tree/checks/closes だけ ok:false、ローカル git 系 3 つは ok:true
# ---------------------------------------------------------------------------
@test "gh が非 0 exit -> pr/head_tree/checks/closes だけ ok:false、pr/checks/closes の error に stderr の先頭、diffhash/risk/changed は ok:true" {
    export GH_STUB_EXIT=1 GH_STUB_STDERR="HTTP 401: Bad credentials (https://api.github.com/graphql)"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == false and .pr.value == null and (.pr.error | test("exit 1") and test("HTTP 401: Bad credentials")) and
        .checks.ok == false and .checks.value == null and (.checks.error | test("HTTP 401: Bad credentials")) and
        .closes.ok == false and .closes.value == null and (.closes.error | test("HTTP 401: Bad credentials")) and
        .head_tree.ok == false and (.head_tree.error | test("skipped")) and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true
    '
    [ "$(gh_call_count)" = "1" ]
}

@test "gh の stdout が JSON object でない -> pr/head_tree/checks/closes だけ ok:false" {
    printf 'not json\n' > "$GH_STUB_RESPONSE"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == false and (.pr.error | test("not a JSON object")) and
        .head_tree.ok == false and .checks.ok == false and .closes.ok == false and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true
    '
}

# ---------------------------------------------------------------------------
# (e) rollup を check-ci と同じ定義 (ci-rollup.jq) で {name, bucket} に写す。null は空配列
# ---------------------------------------------------------------------------
@test "conclusion が空の CheckRun は bucket pending、status が IN_PROGRESS でも conclusion があれば pass" {
    write_response "Closes #824" '[{"name":"a","status":"IN_PROGRESS","conclusion":""},{"name":"b","status":"IN_PROGRESS","conclusion":"SUCCESS"}]'
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.checks == {ok: true, value: {checks: [{name: "a", bucket: "pending"}, {name: "b", bucket: "pass"}]}}'
}

@test "rollup が null -> checks.ok:true で空配列" {
    write_response "Closes #824" 'null'
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.checks == {ok: true, value: {checks: []}}'
}

@test "rollup が配列でない / statusCheckRollup キーが無い -> checks だけ ok:false" {
    write_response "Closes #824" '{}'
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .checks.ok == false and (.checks.error | test("statusCheckRollup")) and
        .pr.ok == true and .head_tree.ok == true and .closes.ok == true and .diffhash.ok == true
    '

    jq -nc --arg sha "$HEAD_SHA" '{mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: $sha, body: "Closes #824"}' > "$GH_STUB_RESPONSE"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.checks.ok == false and .pr.ok == true and .closes.ok == true'
}

# ---------------------------------------------------------------------------
# (f) headRefOid がローカル object DB に無い -> head_tree だけ ok:false (fetch はしない)
# ---------------------------------------------------------------------------
@test "headRefOid がローカルに無い sha -> head_tree だけ ok:false、pr は ok:true (fetch しない)" {
    write_response "Closes #824" "$CHECKS_JSON" "$(printf 'f%.0s' {1..40})"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == true and
        .head_tree.ok == false and (.head_tree.error | test("rev-parse")) and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .checks.ok == true
    '
}

# ---------------------------------------------------------------------------
# (g) danger パターンを含む commit -> risk.value.hits に class が載る (判定は diff-risk-classify.sh 側)
# ---------------------------------------------------------------------------
@test "danger パターンを含む commit -> risk.value.hits に exec-sink" {
    printf 'const x = eval(userInput);\n' > "$REPO/danger.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m danger
    write_response "Closes #824" "$CHECKS_JSON" "$(git -C "$REPO" rev-parse HEAD)"
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .risk.ok == true and .risk.value.ok == true and
        (.risk.value.hits | map(select(.class == "exec-sink")) | length) > 0 and
        (.changed.value.files | index("danger.js")) != null
    '
}

# ---------------------------------------------------------------------------
# (h) base ref が存在しない -> diffhash/risk/changed が ok:false、gh 系は ok:true
# ---------------------------------------------------------------------------
@test "base ref 不在 -> diffhash/risk/changed は ok:false、pr/head_tree/checks/closes は ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/nonexistent --pr 42 --repo acme/skills --issue 824
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .diffhash.ok == false and .changed.ok == false and
        (.risk.ok == false or .risk.value.ok == false) and
        .pr.ok == true and .head_tree.ok == true and .checks.ok == true and .closes.ok == true
    '
}

# ---------------------------------------------------------------------------
# (i) 子スクリプト失敗時は stderr の先頭 (最大 300 byte) を error に含める (issue #790)
#     merge-tier-facts.sh は $SCRIPT_DIR の兄弟スクリプトを呼ぶので、script を stub dir へ複製して
#     失敗する stub と差し替える
# ---------------------------------------------------------------------------
make_stub_scripts_dir() {
    STUB_SCRIPTS="$(mktemp -d)"
    cp "$SCRIPT" "$STUB_SCRIPTS/merge-tier-facts.sh"
    cp "$(dirname "$SCRIPT")/worktree-diff-hash.sh" "$STUB_SCRIPTS/worktree-diff-hash.sh"
    cp "$(dirname "$SCRIPT")/diff-risk-classify.sh" "$STUB_SCRIPTS/diff-risk-classify.sh"
    cp "$(dirname "$SCRIPT")/ci-rollup.jq" "$STUB_SCRIPTS/ci-rollup.jq"
    cp "$(dirname "$SCRIPT")/pr-closes.jq" "$STUB_SCRIPTS/pr-closes.jq"
}

@test "worktree-diff-hash.sh 失敗 -> diffhash.error に stderr の先頭が入り、他サブ結果は ok:true" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\necho "fatal: Unable to create index.lock: Operation not permitted" >&2\nexit 128\n' > "$STUB_SCRIPTS/worktree-diff-hash.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main --pr 42 --issue 824
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .diffhash.ok == false and .diffhash.value == null and
        .diffhash.error == "worktree-diff-hash.sh failed (exit 128): fatal: Unable to create index.lock: Operation not permitted" and
        .risk.ok == true and .changed.ok == true and .pr.ok == true and .head_tree.ok == true and .checks.ok == true and .closes.ok == true
    '
}

@test "worktree-diff-hash.sh の stderr が 300 byte 超 -> error には先頭 300 byte だけが入る" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\nprintf "%%0400d" 0 | tr 0 x >&2\nexit 1\n' > "$STUB_SCRIPTS/worktree-diff-hash.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main --pr 42 --issue 824
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    expected="worktree-diff-hash.sh failed (exit 1): $(printf '%0300d' 0 | tr 0 x)"
    printf '%s\n' "$output" | jq -e --arg e "$expected" '.diffhash.ok == false and .diffhash.error == $e'
}

@test "worktree-diff-hash.sh が stderr 無しで失敗 -> error は exit code のみ (従来どおり)" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\nexit 3\n' > "$STUB_SCRIPTS/worktree-diff-hash.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main --pr 42 --issue 824
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.diffhash.ok == false and .diffhash.error == "worktree-diff-hash.sh failed (exit 3)"'
}

@test "diff-risk-classify.sh 失敗 -> risk.error に stderr の先頭が入り、diffhash は ok:true" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\necho "fatal: bad revision" >&2\nexit 2\n' > "$STUB_SCRIPTS/diff-risk-classify.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main --pr 42 --issue 824
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .risk.ok == false and
        .risk.error == "diff-risk-classify.sh produced no valid JSON output (exit 2): fatal: bad revision" and
        .diffhash.ok == true
    '
}

@test "成功時は diffhash / risk に error キーを持たない (出力 JSON は従来どおり)" {
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        (.diffhash | keys) == ["ok", "value"] and (.risk | keys) == ["ok", "value"] and
        (.diffhash.value | keys) == ["empty", "epoch", "hash"]
    '
}

# ---------------------------------------------------------------------------
# (j) 旧オプション・引数の形の不正 -> usage error (exit 2 + 全サブ結果 ok:false)。gh は呼ばない
# ---------------------------------------------------------------------------
@test "旧オプション --pr-view-data / --checks-data / --closes-data -> exit 2 + 全サブ結果 ok:false、gh は呼ばない" {
    for opt in --pr-view-data --checks-data --closes-data; do
        run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42 --issue 824 "$opt" 'true'
        [ "$status" -eq 2 ]
        printf '%s\n' "$output" | jq -e --arg opt "$opt" '
            [.diffhash, .risk, .changed, .pr, .head_tree, .checks, .closes] | all(.ok == false and .value == null and (.error | test("unknown option: " + $opt)))
        '
    done
    [ "$(gh_call_count)" = "0" ]
}

@test "--pr / --issue が正の整数でない・欠落 -> exit 2 + 全サブ結果 ok:false、gh は呼ばない" {
    for bad in abc 0 -1 '42; touch /tmp/x' '4 2' ''; do
        run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr "$bad" --issue 824
        [ "$status" -eq 2 ]
        printf '%s\n' "$output" | jq -e '[.diffhash, .risk, .changed, .pr, .head_tree, .checks, .closes] | all(.ok == false and (.error | test("--pr must be a positive integer")))'

        run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42 --issue "$bad"
        [ "$status" -eq 2 ]
        printf '%s\n' "$output" | jq -e '[.diffhash, .risk, .changed, .pr, .head_tree, .checks, .closes] | all(.ok == false and (.error | test("--issue must be a positive integer")))'
    done

    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --issue 824
    [ "$status" -eq 2 ]
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42
    [ "$status" -eq 2 ]
    [ "$(gh_call_count)" = "0" ]
}

@test "--repo が owner/repo 形でない -> exit 2 + 全サブ結果 ok:false、gh は呼ばない" {
    for bad in acme acme/skills/x '/skills' 'acme/' 'acme/sk ills' 'acme/skills;id' ''; do
        run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42 --repo "$bad" --issue 824
        [ "$status" -eq 2 ]
        printf '%s\n' "$output" | jq -e '[.diffhash, .risk, .changed, .pr, .head_tree, .checks, .closes] | all(.ok == false and (.error | test("--repo must be owner/repo")))'
    done
    [ "$(gh_call_count)" = "0" ]
}

@test "worktree 不在 -> exit 2 + 全サブ結果 ok:false の JSON" {
    run bash "$SCRIPT" --worktree /nonexistent/path --base origin/main --pr 42 --issue 824
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '
        [.diffhash, .risk, .changed, .pr, .head_tree, .checks, .closes] | all(.ok == false and .value == null and (.error | test("does not exist")))
    '
    [ "$(gh_call_count)" = "0" ]
}

@test "--base 欠落 / 不正文字 -> exit 2 + degrade JSON" {
    run bash "$SCRIPT" --worktree "$REPO" --pr 42 --issue 824
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false'

    run bash "$SCRIPT" --worktree "$REPO" --base 'origin/main; rm -rf /' --pr 42 --issue 824
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false'
}

# ---------------------------------------------------------------------------
# (k) jq 不在 -> exit 0 + 全サブ結果 ok:false (error: jq_not_installed)
# ---------------------------------------------------------------------------
@test "jq 不在 -> exit 0 + 全サブ結果 ok:false error=jq_not_installed" {
    NO_JQ_BIN="$(mktemp -d)"
    for c in bash git grep sed cut sort cat dirname pwd mkdir mktemp rm date tr head; do
        real="$(/usr/bin/which -a "$c" 2>/dev/null | head -1)"
        [[ -n "$real" ]] && ln -s "$real" "$NO_JQ_BIN/$c"
    done
    PATH="$NO_JQ_BIN:$STUB_BIN:$CORE_BIN_DIR" run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 42 --issue 824
    rm -rf "$NO_JQ_BIN"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"risk":{"ok":false,"value":null,"error":"jq_not_installed"}'* ]]
    [[ "$output" == *'"checks":{"ok":false,"value":null,"error":"jq_not_installed"}'* ]]
}

# ---------------------------------------------------------------------------
# (l) bin/ launcher (bare 名) から同一結果が得られる
# ---------------------------------------------------------------------------
@test "bin/merge-tier-facts launcher 経由でも同一の JSON を返す" {
    run "$PLUGIN_ROOT/bin/merge-tier-facts" --worktree "$REPO" --base origin/main --pr 42 --repo acme/skills --issue 824
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e --arg tree "$HEAD_TREE" '.diffhash.value.hash == $tree and .pr.ok == true and .closes.value.present == true'
}
