#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/test-commands-prepare.sh（issue #1278）
#
# fixture は WT（git repo）1 つ。origin の URL を GitHub の形にして <owner>/<repo>（acme/demo）を決められるようにし、
# base の commit を refs/remotes/origin/main に置く（fetch はしない）。user 設定は HOME と SKILL_CONFIG_PATH を一時
# ディレクトリに向けて実行者の環境から切り離す。worktree（PR）側の変更は base の commit の後に足す。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/test-commands-prepare.sh"
    WT="$BATS_TEST_TMPDIR/wt"
    mkdir -p "$WT"
    git -C "$WT" init -q -b feature
    git -C "$WT" config user.name t
    git -C "$WT" config user.email t@example.com
    git -C "$WT" remote add origin https://github.com/acme/demo.git
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    export SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/skill-config.json"
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$TMPDIR"
}

# $1 = WT 相対パス、$2 = 本文
put() {
    mkdir -p "$(dirname "$WT/$1")"
    printf '%s\n' "$2" > "$WT/$1"
}

# その時点の WT のファイルを commit して origin/main（base）にする
commit_base() {
    git -C "$WT" add -A
    git -C "$WT" commit -q --allow-empty -m base
    git -C "$WT" update-ref refs/remotes/origin/main HEAD
}

prepare() {
    run --separate-stderr bash "$SCRIPT" "$WT" --base main
    [ "${#lines[@]}" -eq 1 ]
    JSON="$output"
}

@test "(1) user 設定の repo 別の test_commands があれば base に tests/run-*.sh があってもそれを使い、コマンドファイルに書く" {
    put tests/run-unit.sh 'exit 0'
    chmod +x "$WT/tests/run-unit.sh"
    commit_base
    echo '{"dev-flow":{"repos":{"ACME/demo":{"test_commands":{"full_command":" uv run pytest ","files_command":"uv run pytest {files}"}}}}}' > "$SKILL_CONFIG_PATH"
    prepare
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.ok == true and .source == "user_config" and .status == "resolved"'
    echo "$JSON" | jq -e '.full_command == "uv run pytest" and .files_command == "uv run pytest {files}" and .sources == [] and (has("bundle_file") | not)'
    file="$(echo "$JSON" | jq -r .commands_file)"
    jq -e '. == {source: "user_config", status: "resolved", full_command: "uv run pytest", files_command: "uv run pytest {files}", sources: []}' "$file"
}

@test "(1) user 設定の test_commands の形が不正なら status unresolved と error（次の解決元に倒さない）" {
    put tests/run-unit.sh 'exit 0'
    chmod +x "$WT/tests/run-unit.sh"
    commit_base
    for tc in '{"full_command":"pytest","files_command":"pytest"}' \
              '{"full_command":"pytest","files_command":"pytest {files} {files}"}' \
              '{"full_command":"pytest && rm -rf x","files_command":"pytest {files}"}' \
              '"pytest"'; do
        echo "{\"dev-flow\":{\"repos\":{\"acme/demo\":{\"test_commands\":$tc}}}}" > "$SKILL_CONFIG_PATH"
        prepare
        echo "$JSON" | jq -e '.ok == true and .source == "user_config" and .status == "unresolved" and .full_command == null'
        echo "$JSON" | jq -e '.error | contains("test_commands が不正")'
        jq -e '.status == "unresolved"' "$(echo "$JSON" | jq -r .commands_file)"
    done
}

@test "(2) origin/<base> の tree に実行ビット付きの tests/run-*.sh があれば source runners（sources はそのパス）" {
    put tests/run-b.sh 'exit 0'
    put tests/run-a.sh 'exit 0'
    put tests/run-noexec.sh 'exit 0'
    chmod +x "$WT/tests/run-a.sh" "$WT/tests/run-b.sh"
    commit_base
    prepare
    echo "$JSON" | jq -e '.ok == true and .source == "runners" and .status == "resolved" and .full_command == null'
    echo "$JSON" | jq -e '.sources == ["tests/run-a.sh", "tests/run-b.sh"]'
    jq -e '.source == "runners" and .sources == ["tests/run-a.sh", "tests/run-b.sh"]' "$(echo "$JSON" | jq -r .commands_file)"
}

@test "(3) worktree（PR）だけにある tests/run-*.sh では runners にならず resolver（commit 済み・未 commit とも）" {
    put pyproject.toml '[dependency-groups]
dev = ["pytest>=8"]'
    commit_base
    put tests/run-pr.sh 'exit 0'
    chmod +x "$WT/tests/run-pr.sh"
    prepare
    echo "$JSON" | jq -e '.ok == true and .source == "resolver" and .status == "unresolved"'
    git -C "$WT" add -A
    git -C "$WT" commit -q -m pr
    prepare
    echo "$JSON" | jq -e '.source == "resolver"'
    # resolver の結果は workflow が検証してから書くので、ここではコマンドファイルを書かない
    [ ! -e "$(echo "$JSON" | jq -r .commands_file)" ]
}

@test "(3) 束は origin/<base> の tree の内容だけ: worktree 側で CI 定義を書き換えても（commit 済み・未 commit とも）base の内容のまま" {
    put .github/workflows/ci.yml 'run: uv run pytest -q'
    put pyproject.toml '[dependency-groups]
dev = ["pytest>=8"]'
    put src/app.py 'print(1)'
    commit_base
    put .github/workflows/ci.yml 'run: make evil'
    put Makefile 'test:
	echo pr'
    prepare
    bundle="$(echo "$JSON" | jq -r .bundle_file)"
    grep -Fq 'run: uv run pytest -q' "$bundle"
    run ! grep -Fq 'make evil' "$bundle"
    run ! grep -Fq 'echo pr' "$bundle"
    echo "$JSON" | jq -e '.bundle_files == [".github/workflows/ci.yml", "pyproject.toml"]'
    grep -Fq '<<<FILE pyproject.toml>>>' "$bundle"
    # src/app.py はテストの起動方法を宣言するファイルでないので中身を載せない（トップレベルのエントリ名だけ）
    run ! grep -Fq 'print(1)' "$bundle"

    git -C "$WT" add -A
    git -C "$WT" commit -q -m pr
    prepare
    bundle="$(echo "$JSON" | jq -r .bundle_file)"
    grep -Fq 'run: uv run pytest -q' "$bundle"
    run ! grep -Fq 'make evil' "$bundle"
}

@test "コマンドファイルと束は worktree の外の run ごとに別の一時ディレクトリに置く" {
    put tests/run-a.sh 'exit 0'
    chmod +x "$WT/tests/run-a.sh"
    commit_base
    prepare
    first="$(echo "$JSON" | jq -r .commands_file)"
    prepare
    second="$(echo "$JSON" | jq -r .commands_file)"
    [ "$first" != "$second" ]
    [[ "$first" == "$TMPDIR"/test-commands-*/commands.json ]]
    [[ "$first" != "$WT"/* ]]
}

@test "origin/<base> を解決できなければ ok:false（コマンドファイルを作らない）、引数不正は exit 2" {
    commit_base
    run --separate-stderr bash "$SCRIPT" "$WT" --base nope
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.error | contains("origin/nope"))'
    run --separate-stderr bash "$SCRIPT" "$WT"
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false'
}
