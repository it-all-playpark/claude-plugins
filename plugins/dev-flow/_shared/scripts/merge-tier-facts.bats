#!/usr/bin/env bats
# Tests for _shared/scripts/merge-tier-facts.sh (issue #637)
#
# Strategy: mktemp -d の隔離 git fixture repo (base branch + feature commit) を worktree として
# 扱う。gh の stdout は呼び出し側 subagent が --pr-view-data / --checks-data の argv で転写する契約
# なので、テストでは転写済み JSON 文字列を直接渡す (gh は呼ばれない)。サブ結果
# (diffhash/risk/changed/pr/head_tree/checks) の独立性 —— 1 つの失敗が他へ波及しない —— を、
# argv 省略・不正 JSON・git object 不在・引数不正で個別に誘発して検証する。

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

    PR_VIEW_JSON="$(printf '{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefOid":"%s"}' "$HEAD_SHA")"
    CHECKS_JSON='[{"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z"},{"name":"bats","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-01-01T00:00:00Z"}]'

    # gh が呼ばれないことを PATH 先頭の失敗 stub で pin する (script が gh を内部で呼んだら exit 99)
    STUB_BIN="$(mktemp -d)"
    printf '#!/usr/bin/env bash\necho "merge-tier-facts.sh must not invoke gh: $*" >&2\nexit 99\n' > "$STUB_BIN/gh"
    chmod +x "$STUB_BIN/gh"
    ORIG_PATH="$PATH"
    PATH="$STUB_BIN:$CORE_BIN_DIR:$PATH"
}

teardown() {
    rm -rf "$REPO" "$STUB_BIN"
    PATH="$ORIG_PATH"
}

run_facts() {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON" --closes-data true "$@"
}

# ---------------------------------------------------------------------------
# (a) 全経路正常 -> 6 サブ結果すべて ok:true、値が各 git/gh 結果と一致
# ---------------------------------------------------------------------------
@test "正常系 -> 全サブ結果 ok:true で各値が一致する" {
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e --arg tree "$HEAD_TREE" --arg sha "$HEAD_SHA" '
        .diffhash.ok == true and .diffhash.value.hash == $tree and .diffhash.value.empty == false and
        .risk.ok == true and .risk.value.ok == true and (.risk.value.hits | length) == 0 and
        .changed.ok == true and .changed.value.files == ["src.txt"] and
        .pr.ok == true and .pr.value.mergeable == "MERGEABLE" and .pr.value.mergeStateStatus == "CLEAN" and .pr.value.headRefOid == $sha and
        .head_tree.ok == true and .head_tree.value.tree == $tree and
        .checks.ok == true and .checks.value.checks == [{name: "bats", bucket: "pass"}, {name: "build", bucket: "pass"}] and
        .closes.ok == true and .closes.value.present == true and
        (.epoch | type) == "number"
    '
}

# ---------------------------------------------------------------------------
# (b) 出力は JSON 1 行のみ (exec-proxy が verbatim 転写する契約)
# ---------------------------------------------------------------------------
@test "stdout は JSON 1 行のみ" {
    run_facts
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "1" ]
}

# ---------------------------------------------------------------------------
# (c) gh pr view 失敗 -> pr と head_tree のみ ok:false、他 4 つは ok:true
# ---------------------------------------------------------------------------
@test "--pr-view-data 省略 (gh pr view 失敗) -> pr/head_tree だけ ok:false、diffhash/risk/changed/checks は ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --checks-data "$CHECKS_JSON"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == false and .pr.value == null and (.pr.error | test("not provided")) and
        .head_tree.ok == false and (.head_tree.error | test("skipped")) and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .checks.ok == true
    '
}

# ---------------------------------------------------------------------------
# (d) rollup の取得失敗 -> checks のみ ok:false
# ---------------------------------------------------------------------------
@test "--checks-data 省略 (gh pr view --json statusCheckRollup 失敗) -> checks だけ ok:false、他 5 つは ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .checks.ok == false and .checks.value == null and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .pr.ok == true and .head_tree.ok == true
    '
}

# ---------------------------------------------------------------------------
# (e) rollup を check-ci と同じ定義 (ci-rollup.jq) で {name, bucket} に写す。null は空配列
# ---------------------------------------------------------------------------
@test "conclusion が空の CheckRun は bucket pending、status が IN_PROGRESS でも conclusion があれば pass" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data '[{"name":"a","status":"IN_PROGRESS","conclusion":""},{"name":"b","status":"IN_PROGRESS","conclusion":"SUCCESS"}]'
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.checks == {ok: true, value: {checks: [{name: "a", bucket: "pending"}, {name: "b", bucket: "pass"}]}}'
}

@test "rollup が null -> checks.ok:true で空配列" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data 'null'
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.checks == {ok: true, value: {checks: []}}'
}

@test "不正 JSON の pr-view-data / checks-data -> 当該サブ結果だけ ok:false" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data 'gh: not authenticated' --checks-data 'not json'
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == false and (.pr.error | test("not a JSON object")) and
        .head_tree.ok == false and
        .checks.ok == false and (.checks.error | test("not a JSON array")) and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true
    '
}

# ---------------------------------------------------------------------------
# (e') closes: gh pr view --json body --jq '.body | test("Closes #<issue>(\\D|$)")' の stdout (true / false)
#      だけを --closes-data で受ける (issue #824)。取得失敗 (省略 / true・false 以外) は ok:false で
#      Closes 欠落 (present:false) と区別し、他サブ結果へ波及しない
# ---------------------------------------------------------------------------
@test "closes-data true (末尾改行つき stdout) -> closes.ok:true / present:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON" --closes-data $'true\n'
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.closes == {ok: true, value: {present: true}}'
}

@test "closes-data false -> closes.ok:true / present:false、他サブ結果は ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON" --closes-data false
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .closes == {ok: true, value: {present: false}} and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .pr.ok == true and .head_tree.ok == true and .checks.ok == true
    '
}

@test "--closes-data 省略 (gh pr view --json body 失敗) -> closes だけ ok:false、他 6 つは ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .closes.ok == false and .closes.value == null and (.closes.error | test("not provided")) and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .pr.ok == true and .head_tree.ok == true and .checks.ok == true
    '
}

@test "closes-data が true / false 以外 (gh のエラー文・本文の混入) -> closes だけ ok:false" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON" --closes-data 'Closes #1'
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .closes.ok == false and .closes.value == null and (.closes.error | test("not true/false")) and
        .pr.ok == true and .checks.ok == true
    '
}

# ---------------------------------------------------------------------------
# (f) gh 全滅 -> pr/head_tree/checks が ok:false、ローカル git 系 3 つは ok:true
# ---------------------------------------------------------------------------
@test "gh 系 argv 両方省略 -> pr/head_tree/checks は ok:false、diffhash/risk/changed は ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == false and .head_tree.ok == false and .checks.ok == false and .closes.ok == false and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true
    '
}

# ---------------------------------------------------------------------------
# (g) headRefOid がローカル object DB に無い -> head_tree だけ ok:false (fetch はしない)
# ---------------------------------------------------------------------------
@test "headRefOid がローカルに無い sha -> head_tree だけ ok:false、pr は ok:true (fetch しない)" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$(printf '{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefOid":"%s"}' "$(printf 'f%.0s' {1..40})")" --checks-data "$CHECKS_JSON"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .pr.ok == true and
        .head_tree.ok == false and (.head_tree.error | test("rev-parse")) and
        .diffhash.ok == true and .risk.ok == true and .changed.ok == true and .checks.ok == true
    '
}

# ---------------------------------------------------------------------------
# (h) danger パターンを含む commit -> risk.value.hits に class が載る (判定は diff-risk-classify.sh 側)
# ---------------------------------------------------------------------------
@test "danger パターンを含む commit -> risk.value.hits に exec-sink" {
    printf 'const x = eval(userInput);\n' > "$REPO/danger.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m danger
    run_facts
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .risk.ok == true and .risk.value.ok == true and
        (.risk.value.hits | map(select(.class == "exec-sink")) | length) > 0 and
        (.changed.value.files | index("danger.js")) != null
    '
}

# ---------------------------------------------------------------------------
# (i) base ref が存在しない -> diffhash/risk/changed が ok:false、gh 系は ok:true
# ---------------------------------------------------------------------------
@test "base ref 不在 -> diffhash/risk/changed は ok:false、pr/head_tree/checks は ok:true" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/nonexistent --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .diffhash.ok == false and .changed.ok == false and
        (.risk.ok == false or .risk.value.ok == false) and
        .pr.ok == true and .head_tree.ok == true and .checks.ok == true
    '
}

# ---------------------------------------------------------------------------
# (i') 子スクリプト失敗時は stderr の先頭 (最大 300 byte) を error に含める (issue #790)
#      merge-tier-facts.sh は $SCRIPT_DIR の兄弟スクリプトを呼ぶので、script を stub dir へ複製して
#      失敗する stub と差し替える
# ---------------------------------------------------------------------------
make_stub_scripts_dir() {
    STUB_SCRIPTS="$(mktemp -d)"
    cp "$SCRIPT" "$STUB_SCRIPTS/merge-tier-facts.sh"
    cp "$(dirname "$SCRIPT")/worktree-diff-hash.sh" "$STUB_SCRIPTS/worktree-diff-hash.sh"
    cp "$(dirname "$SCRIPT")/diff-risk-classify.sh" "$STUB_SCRIPTS/diff-risk-classify.sh"
    cp "$(dirname "$SCRIPT")/ci-rollup.jq" "$STUB_SCRIPTS/ci-rollup.jq"
}

@test "worktree-diff-hash.sh 失敗 -> diffhash.error に stderr の先頭が入り、他サブ結果は ok:true" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\necho "fatal: Unable to create index.lock: Operation not permitted" >&2\nexit 128\n' > "$STUB_SCRIPTS/worktree-diff-hash.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON"
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .diffhash.ok == false and .diffhash.value == null and
        .diffhash.error == "worktree-diff-hash.sh failed (exit 128): fatal: Unable to create index.lock: Operation not permitted" and
        .risk.ok == true and .changed.ok == true and .pr.ok == true and .head_tree.ok == true and .checks.ok == true
    '
}

@test "worktree-diff-hash.sh の stderr が 300 byte 超 -> error には先頭 300 byte だけが入る" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\nprintf "%%0400d" 0 | tr 0 x >&2\nexit 1\n' > "$STUB_SCRIPTS/worktree-diff-hash.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    expected="worktree-diff-hash.sh failed (exit 1): $(printf '%0300d' 0 | tr 0 x)"
    printf '%s\n' "$output" | jq -e --arg e "$expected" '.diffhash.ok == false and .diffhash.error == $e'
}

@test "worktree-diff-hash.sh が stderr 無しで失敗 -> error は exit code のみ (従来どおり)" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\nexit 3\n' > "$STUB_SCRIPTS/worktree-diff-hash.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main
    rm -rf "$STUB_SCRIPTS"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.diffhash.ok == false and .diffhash.error == "worktree-diff-hash.sh failed (exit 3)"'
}

@test "diff-risk-classify.sh 失敗 -> risk.error に stderr の先頭が入り、diffhash は ok:true" {
    make_stub_scripts_dir
    printf '#!/usr/bin/env bash\necho "fatal: bad revision" >&2\nexit 2\n' > "$STUB_SCRIPTS/diff-risk-classify.sh"
    run bash "$STUB_SCRIPTS/merge-tier-facts.sh" --worktree "$REPO" --base origin/main
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
# (j) 未知オプション -> usage error (exit 2 + degrade JSON)
# ---------------------------------------------------------------------------
@test "未知オプション -> exit 2 + 全サブ結果 ok:false" {
    run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr 7
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '.pr.ok == false and .risk.ok == false and (.risk.error | test("unknown option"))'
}

# ---------------------------------------------------------------------------
# (k) usage error -> exit 2 かつ stdout に全サブ結果 ok:false の degrade JSON
# ---------------------------------------------------------------------------
@test "worktree 不在 -> exit 2 + 全サブ結果 ok:false の JSON" {
    run bash "$SCRIPT" --worktree /nonexistent/path --base origin/main
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '
        [.diffhash, .risk, .changed, .pr, .head_tree, .checks, .closes] | all(.ok == false and .value == null and (.error | test("does not exist")))
    '
}

@test "--base 欠落 / 不正文字 -> exit 2 + degrade JSON" {
    run bash "$SCRIPT" --worktree "$REPO"
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false'

    run bash "$SCRIPT" --worktree "$REPO" --base 'origin/main; rm -rf /'
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false'
}

# ---------------------------------------------------------------------------
# (l) jq 不在 -> exit 0 + 全サブ結果 ok:false (error: jq_not_installed)
# ---------------------------------------------------------------------------
@test "jq 不在 -> exit 0 + 全サブ結果 ok:false error=jq_not_installed" {
    NO_JQ_BIN="$(mktemp -d)"
    for c in bash git grep sed cut sort cat dirname pwd mkdir mktemp rm date tr head; do
        real="$(/usr/bin/which -a "$c" 2>/dev/null | head -1)"
        [[ -n "$real" ]] && ln -s "$real" "$NO_JQ_BIN/$c"
    done
    PATH="$NO_JQ_BIN:$STUB_BIN:$CORE_BIN_DIR" run bash "$SCRIPT" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON"
    rm -rf "$NO_JQ_BIN"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"risk":{"ok":false,"value":null,"error":"jq_not_installed"}'* ]]
    [[ "$output" == *'"checks":{"ok":false,"value":null,"error":"jq_not_installed"}'* ]]
}

# ---------------------------------------------------------------------------
# (m) bin/ launcher (bare 名) から同一結果が得られる
# ---------------------------------------------------------------------------
@test "bin/merge-tier-facts launcher 経由でも同一の JSON を返す" {
    run "$PLUGIN_ROOT/bin/merge-tier-facts" --worktree "$REPO" --base origin/main --pr-view-data "$PR_VIEW_JSON" --checks-data "$CHECKS_JSON"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e --arg tree "$HEAD_TREE" '.diffhash.value.hash == $tree and .pr.ok == true'
}
