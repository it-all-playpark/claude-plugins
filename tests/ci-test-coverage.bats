#!/usr/bin/env bats
# Invariant (#906): repo の test ファイルはすべて CI（.github/workflows/lint.yml）から実行される。
# CI の test job は tests/run-all-bats.sh（*.bats）と tests/run-node-tests.sh（vitest, *.test.mjs）
# の 2 本だけで、それ以外の形式の test（*.test.sh / tests/ 配下の test-*.sh / test_*.py 等）は
# どちらの runner にも拾われない。そうした test は *.bats の wrapper から呼んで run-all-bats.sh に
# 載せる。wrapper を書き忘れた test は誰にも実行されないまま green に見えるので、ここで検出する。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    LINT_YML="$REPO_ROOT/.github/workflows/lint.yml"
}

# lint.yml のうち、指定した run 行を持つ job の `name:` を出力する。
job_name_running() {
    awk -v runner="$1" '
        /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { name = "" }
        /^    name: / { name = $0; sub(/^    name: /, "", name) }
        index($0, runner) && $0 !~ /^[[:space:]]*- name:/ { print name; exit }
    ' "$LINT_YML"
}

# run-all-bats.sh / vitest.config.mjs と同じ除外で repo を走査する。
find_repo() {
    cd "$REPO_ROOT" && find . \
        -type d \( -name ".git" -o -name "node_modules" -o -name ".serena" \
                -o -name ".system" \
                -o -path "*/.claude/worktrees" \) -prune -o \
        "$@"
}

@test "CI の bats job は全 *.bats を回す job として命名されている" {
    run job_name_running './tests/run-all-bats.sh --strict'
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$output" = "Bats Tests (all *.bats)" ]
}

@test "CI の node job は全 *.test.mjs を回す job として命名されている" {
    run job_name_running './tests/run-node-tests.sh --strict'
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$output" = "Node Unit Tests (all *.test.mjs)" ]
}

@test "run-all-bats.sh と vitest が拾わない test ファイルは、いずれかの *.bats から呼ばれている" {
    local bats_files=() harnesses=() orphans=() f
    mapfile -t bats_files < <(find_repo -type f -name '*.bats' -print)
    mapfile -t harnesses < <(find_repo -type f \( \
            -name '*.test.sh' \
            -o \( -path '*/tests/*' -name 'test[-_]*.sh' \) \
            -o -name 'test_*.py' -o -name '*_test.py' \
            -o -name '*.test.js' -o -name '*.test.cjs' -o -name '*.test.ts' \
            -o -name '*.spec.mjs' -o -name '*.spec.js' -o -name '*.spec.ts' \
        \) -print | sort)

    for f in "${harnesses[@]}"; do
        grep -qF -- "${f##*/}" "${bats_files[@]/#/$REPO_ROOT/}" || orphans+=("$f")
    done

    printf 'not run by CI: %s\n' ${orphans[@]+"${orphans[@]}"}
    [ "${#harnesses[@]}" -gt 0 ]
    [ "${#orphans[@]}" -eq 0 ]
}
