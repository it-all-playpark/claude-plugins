#!/usr/bin/env bats
# run-node-tests.bats - DEVFLOW_TEST_FILES（dev-flow run-tests --files、issue #865）で
# 落ちたファイルだけを vitest に渡すことと、run-node-tests.sh が読む vitest.config.mjs の
# testTimeout の検査。
#
# fixture repo に実物の run-node-tests.sh を tests/ へ複写し、node_modules/.bin/vitest を受け取った引数を
# 書き出す stub に差し替える。REPO_ROOT はスクリプト自身の位置から決まるので fixture が repo root になる。

setup() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE/tests" "$FIXTURE/node_modules/.bin"
    cp "$BATS_TEST_DIRNAME/run-node-tests.sh" "$FIXTURE/tests/"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/vitest.args"\nexit 0\n' "$BATS_TEST_TMPDIR" \
        > "$FIXTURE/node_modules/.bin/vitest"
    chmod +x "$FIXTURE/node_modules/.bin/vitest"
    LIST="$BATS_TEST_TMPDIR/files.txt"
    unset DEVFLOW_CHANGED_FILES DEVFLOW_BASE DEVFLOW_TEST_FILES
}

@test "test files: 一覧の .test.mjs だけを vitest に渡す" {
    printf '%s\n' plugins/x/a.bats plugins/x/b.test.mjs tests/c.test.mjs > "$LIST"

    DEVFLOW_TEST_FILES="$LIST" run bash "$FIXTURE/tests/run-node-tests.sh"

    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/vitest.args")" = "$(printf '%s\n' run --configLoader runner plugins/x/b.test.mjs tests/c.test.mjs)" ]
}

@test "test files: .test.mjs が 1 件も無ければ vitest を起動せず exit 0" {
    printf '%s\n' plugins/x/a.bats > "$LIST"

    DEVFLOW_TEST_FILES="$LIST" run bash "$FIXTURE/tests/run-node-tests.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"lists no .test.mjs file"* ]]
    [ ! -f "$BATS_TEST_TMPDIR/vitest.args" ]
}

@test "test files: 未設定・読めない一覧は全件（ファイル引数なし）" {
    run bash "$FIXTURE/tests/run-node-tests.sh"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/vitest.args")" = "$(printf '%s\n' run --configLoader runner)" ]

    DEVFLOW_TEST_FILES="$BATS_TEST_TMPDIR/missing.txt" run bash "$FIXTURE/tests/run-node-tests.sh"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/vitest.args")" = "$(printf '%s\n' run --configLoader runner)" ]
}

# 負荷下（bats の並列実行と同時の全件実行）で子プロセスを起動するテストが vitest 既定の 5000ms で
# 偽 red にならないよう、設定 1 か所で全テストに 60000ms を効かせる（issue #1252）。
# bats の CI job は npm ci をしないので vitest/config を import せず、設定ファイルの値を読む。
@test "vitest.config.mjs: test.testTimeout は 60000" {
    run sed -nE 's/^[[:space:]]*testTimeout:[[:space:]]*([0-9_]+),?[[:space:]]*$/\1/p' \
        "$BATS_TEST_DIRNAME/../vitest.config.mjs"

    [ "$status" -eq 0 ]
    [ "$output" = "60000" ]
}
