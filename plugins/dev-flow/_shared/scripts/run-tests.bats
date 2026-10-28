#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/run-tests.sh (issue #821)
#
# Strategy: mktemp -d に tests/run-*.sh の fixture（exit 0 / 1 / 126 を返す script、bats / vitest 形式の
# 失敗出力を吐く script）を置き、status / tests / green / scripts / failed_files を stdout の JSON 1 行で検査する。
# tests/run-*.sh が無い repo のフォールバックは npm / pnpm を stub（PATH 先頭）に差し替えて実 install なしで回す。
# untracked の intent-to-add（issue #833）は WT を git init した fixture で、git grep invariant の red と index の状態を見る。
# 変更ファイルの受け渡し（issue #835）は、受け取った DEVFLOW_CHANGED_FILES / DEVFLOW_BASE を WT 外へ書き出す
# probe ランナー（make_env_probe）で、値と一覧の中身・未設定の各経路を見る。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/run-tests.sh"
    TMP_DIR="$(mktemp -d)"
    WT="$(cd "$TMP_DIR" && pwd)/wt"
    mkdir -p "$WT/tests"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
}

teardown() {
    rm -rf "$TMP_DIR"
}

# $1 = tests/ 配下のファイル名、$2 = 本文（#!/usr/bin/env bash の後に続く）。実行ビットを付ける
make_script() {
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$WT/tests/$1"
    chmod +x "$WT/tests/$1"
}

# $1 = テストランナー名。依存が入った worktree を模して node_modules/.bin に実行可能な実体を置く
make_runner() {
    mkdir -p "$WT/node_modules/.bin"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$WT/node_modules/.bin/$1"
    chmod +x "$WT/node_modules/.bin/$1"
}

# stdout（stderr は分ける）が JSON 1 行であることを確かめ、その行を $JSON に入れる。
# 追加の環境変数（PATH の stub 差し替え等）は呼び出し側で export する
run_tests() {
    run --separate-stderr bash "$SCRIPT" "$WT"
    [ "${#lines[@]}" -eq 1 ]
    JSON="$output"
}

@test "exit 0: 全本 exit 0 なら passed / tests passed / green true、全本を絶対パスで実行する" {
    make_script run-a.sh 'echo "1..1"; echo "ok 1 a"'
    make_script run-b.sh 'echo b-ran > "$(dirname "$0")/b.marker"; exit 0'
    run_tests
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.status == "passed" and .tests == "passed" and .green == true'
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" --arg b "$WT/tests/run-b.sh" \
        '[.scripts[] | del(.log)] == [{path: $a, exit: 0, launch_failed: false}, {path: $b, exit: 0, launch_failed: false}]'
    echo "$JSON" | jq -e '.failed_files == [] and (.epoch | type == "number")'
    [ -f "$WT/tests/b.marker" ]
}

@test "scripts[].log: 各 script の stdout / stderr を書いた worktree 外の実在ファイルの絶対パス" {
    make_script run-a.sh 'echo "ok 1 alpha-out"; echo "alpha-err" >&2'
    make_script run-b.sh 'echo "not ok 1 beta-out"; exit 1'
    run_tests
    log_a=$(jq -r '.scripts[0].log' <<< "$JSON")
    log_b=$(jq -r '.scripts[1].log' <<< "$JSON")
    [[ "$log_a" == /* && "$log_b" == /* && "$log_a" != "$log_b" ]]
    [ -f "$log_a" ] && [ -f "$log_b" ]
    [[ "$log_a" != "$WT"/* && "$log_a" != "$(cd "$WT" && pwd -P)"/* ]]
    grep -qx 'ok 1 alpha-out' "$log_a"
    grep -qx 'alpha-err' "$log_a"
    grep -qx 'not ok 1 beta-out' "$log_b"
    ! grep -q 'alpha' "$log_b"
}

@test "exit 1: 1 本でも exit 1 なら failed / green false、残りの script も実行する" {
    make_script run-a.sh 'exit 1'
    make_script run-b.sh 'echo b-ran > "$(dirname "$0")/b.marker"'
    run_tests
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.status == "failed" and .tests == "failed" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | [.exit, .launch_failed]] == [[1, false], [0, false]]'
    [ -f "$WT/tests/b.marker" ]
}

@test "exit 126（起動失敗）: 1 本でも起動失敗があれば error（他の script の exit 1 より優先）、failed_files は空" {
    make_script run-a.sh 'echo "not ok 1 x"; echo "# (in test file '"$WT"'/a.bats, line 2)"; exit 1'
    make_script run-b.sh 'echo "Permission denied" >&2; exit 126'
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | [.exit, .launch_failed]] == [[1, false], [126, true]]'
    echo "$JSON" | jq -e '.failed_files == []'
    echo "$JSON" | jq -e '.summary | contains("launch failed") and contains("run-b.sh")'
}

@test "exit 126（起動失敗）: script 自体を exec できない（interpreter が実行不能）ものも launch_failed" {
    : > "$TMP_DIR/not-an-interpreter"
    printf '#!%s\n' "$TMP_DIR/not-an-interpreter" > "$WT/tests/run-broken.sh"
    chmod +x "$WT/tests/run-broken.sh"
    run_tests
    echo "$JSON" | jq -e '.status == "error" and (.scripts[0].launch_failed == true) and (.scripts[0].exit == 126)'
}

@test "exit 127（command not found）も launch_failed として error" {
    make_script run-a.sh 'exit 127'
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .scripts[0].launch_failed == true'
}

@test "実行ビットの無い run-*.sh は実行しない" {
    make_script run-a.sh 'exit 0'
    printf '#!/usr/bin/env bash\nexit 1\n' > "$WT/tests/run-noexec.sh"
    run_tests
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" '.status == "passed" and ([.scripts[].path] == [$a])'
}

@test "failed_files: bats の not ok 行（直後の in test file 診断行）から WT 相対パスを重複なく抽出する" {
    make_script run-bats.sh "$(cat <<EOF
echo "1..3"
echo "not ok 1 first"
echo "# (in test file $WT/plugins/foo/a.bats, line 10)"
echo "#   \\\`[ 1 -eq 2 ]' failed"
echo "ok 2 second"
echo "not ok 3 setup failed"
echo "# (from function \\\`setup' in test file $WT/plugins/foo/a.bats, line 3)"
echo "not ok 1 other"
echo "# (in test file $(cd "$WT" && pwd -P)/plugins/bar/b.bats, line 4)"
exit 1
EOF
)"
    run_tests
    echo "$JSON" | jq -e '.status == "failed"'
    echo "$JSON" | jq -e '.failed_files == ["plugins/foo/a.bats", "plugins/bar/b.bats"]'
    echo "$JSON" | jq -e '.summary | contains("not ok 1 first")'
}

@test "failed_files: vitest の FAIL 行（ANSI 色付き・project 名付き）からパスを抽出する" {
    make_script run-node.sh "$(cat <<'EOF'
printf ' \033[31mFAIL\033[39m  plugins/x/_lib/a.test.mjs > suite > case\n'
printf ' FAIL  |unit| plugins/x/_lib/b.test.mjs > case\n'
printf ' FAIL  plugins/x/_lib/a.test.mjs > suite > case2\n'
printf ' Test Files  2 failed (2)\n'
exit 1
EOF
)"
    run_tests
    echo "$JSON" | jq -e '.failed_files == ["plugins/x/_lib/a.test.mjs", "plugins/x/_lib/b.test.mjs"]'
}

@test "summary: 失敗 script の not ok / FAIL 行を出力末尾より優先して載せる（stderr に grep の usage を出さない）" {
    make_script run-a.sh "$(cat <<'EOF'
echo "not ok 1 early failure"
printf ' FAIL  plugins/x/_lib/a.test.mjs > case\n'
for i in $(seq 1 40); do echo "noise line $i"; done
exit 1
EOF
)"
    run_tests
    echo "$JSON" | jq -e '.status == "failed"'
    echo "$JSON" | jq -e '.summary | contains("not ok 1 early failure") and contains("FAIL  plugins/x/_lib/a.test.mjs")'
    echo "$JSON" | jq -e '.summary | contains("noise line 40") | not'
    [[ "$stderr" != *"invalid option"* ]]
}

@test "failed_files: テストファイルに結び付かない失敗が 1 件でもあれば空配列" {
    make_script run-a.sh 'echo "not ok 1 x"; echo "# (in test file '"$WT"'/a.bats, line 2)"; exit 1'
    make_script run-b.sh 'echo "build crashed"; exit 1'
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and .failed_files == []'
}

@test "failed_files: in test file 行の無い not ok があれば空配列" {
    make_script run-a.sh 'echo "not ok 1 x"; echo "not ok 2 y"; echo "# (in test file '"$WT"'/a.bats, line 2)"; exit 1'
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and .failed_files == []'
}

@test "stdout は script の出力が多くても JSON 1 行だけ" {
    make_script run-a.sh 'for i in $(seq 1 500); do echo "ok $i t"; done; echo "noise" >&2'
    run_tests
    echo "$JSON" | jq -e '.status == "passed"'
    [[ "$stderr" != *"ok 500 t"* ]]
}

@test "run-*.sh 無し: package.json の scripts.test があれば npm test を同じ規則で実行する（exit 0 → passed）" {
    echo '{"name":"x","scripts":{"test":"node t.js"}}' > "$WT/package.json"
    printf '#!/usr/bin/env bash\necho "$PWD $*" > "%s/npm.log"\nexit 0\n' "$TMP_DIR" > "$STUB_DIR/npm"
    chmod +x "$STUB_DIR/npm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .tests == "passed" and .green == true'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "npm test", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/npm.log")" = "$WT test" ]
}

@test "run-*.sh 無し: pnpm-lock.yaml があれば pnpm test、exit 1 → failed" {
    echo '{"name":"x","scripts":{"test":"vitest run"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner vitest
    printf '#!/usr/bin/env bash\necho " FAIL  src/a.test.ts > x"\necho "[ELIFECYCLE] Test failed. See above for more details."\necho "Error: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
    echo "$JSON" | jq -e '.failed_files == ["src/a.test.ts"]'
}

@test "run-*.sh 無し: pnpm test がテスト前の依存 install で失敗したら起動失敗として error（failed にしない）" {
    echo '{"name":"x","scripts":{"test":"vitest run"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    printf '#!/usr/bin/env bash\necho "\033[31m[ERR_PNPM_EPERM]\033[39m [importPackage x] Operation not permitted"\necho "pnpm: Command failed with exit code 1: '"'"'/opt/pnpm/11.0.8/node_modules/@pnpm/exe/pnpm'"'"' install"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: true}] and .failed_files == []'
    echo "$JSON" | jq -e '.summary | contains("launch failed: pnpm test")'
}

@test "run-*.sh 無し: pnpm test がスクリプト起動前に pnpm 自身のエラーで終了したら起動失敗として error（failed にしない）" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    printf '#!/usr/bin/env bash\necho " ERROR  packages field missing or empty"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: true}] and .failed_files == []'
    echo "$JSON" | jq -e '.summary | contains("launch failed: pnpm test")'
}

@test "run-*.sh 無し: pnpm test がスクリプトを起動した後の ERROR 行は red のまま（launch_failed にしない）" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner jest
    printf '#!/usr/bin/env bash\necho\necho "> x@1.0.0 test /wt"\necho "> jest"\necho\necho " ERROR  db connection refused"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: pnpm test のテストランナーが node_modules/.bin にも PATH にも無ければ起動失敗として error（failed にしない）" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    printf '#!/usr/bin/env bash\necho\necho "> x@1.0.0 test /wt"\necho "> jest"\necho\necho "sh: line 1: jest: command not found"\necho " ELIFECYCLE  Test failed. See above for more details."\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: true}] and .failed_files == []'
    echo "$JSON" | jq -e '.summary | contains("launch failed: pnpm test")'
}

@test "run-*.sh 無し: テストランナーが在れば command not found 行と FAIL 行があっても red のまま" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner jest
    printf '#!/usr/bin/env bash\necho\necho "> x@1.0.0 test /wt"\necho "> jest"\necho\necho "sh: line 1: jest: command not found"\necho " FAIL  src/a.test.ts > x"\necho " ELIFECYCLE  Test failed. See above for more details."\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
    echo "$JSON" | jq -e '.failed_files == ["src/a.test.ts"]'
}

@test "run-*.sh 無し: テストランナーが在れば、テストが command not found 行だけを出して落ちても red のまま（出力で起動失敗に見せかけられない）" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner jest
    printf '#!/usr/bin/env bash\necho\necho "> x@1.0.0 test /wt"\necho "> jest"\necho\necho "sh: line 1: jest: command not found"\necho " ELIFECYCLE  Test failed. See above for more details."\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: テストランナーが WT の祖先（workspace ルート）の node_modules/.bin にだけ在っても red のまま" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    mkdir -p "$TMP_DIR/node_modules/.bin"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_DIR/node_modules/.bin/jest"
    chmod +x "$TMP_DIR/node_modules/.bin/jest"
    printf '#!/usr/bin/env bash\necho "sh: line 1: jest: command not found"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: テストランナーが実行中に消されても、実行前に在れば red のまま" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner jest
    printf '#!/usr/bin/env bash\nrm -f "%s/node_modules/.bin/jest"\necho "sh: line 1: jest: command not found"\nexit 1\n' "$WT" > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: scripts.test の先頭が代入で先頭のコマンドを取り出せなければ red のまま" {
    echo '{"name":"x","scripts":{"test":"NODE_ENV=test jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    printf '#!/usr/bin/env bash\necho "sh: line 1: jest: command not found"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: scripts.test が複合コマンドなら先頭のコマンドが無くても red のまま（後続がテストを走らせうる）" {
    echo '{"name":"x","scripts":{"test":"optional-runner || vitest run"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner vitest
    printf '#!/usr/bin/env bash\necho "sh: line 1: optional-runner: command not found"\necho " ELIFECYCLE  Test failed. See above for more details."\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: pnpm のエラー見出し行が無ければ起動の痕跡が無くても（--silent 等）red のまま" {
    echo '{"name":"x","scripts":{"test":"jest"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    make_runner jest
    printf '#!/usr/bin/env bash\necho "Tests: 1 failed, 1 total"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm test", exit: 1, launch_failed: false}]'
}

@test "run-*.sh 無し: フォールバックの exit 126 も起動失敗として error" {
    echo '{"name":"x","scripts":{"test":"node t.js"}}' > "$WT/package.json"
    printf '#!/usr/bin/env bash\nexit 126\n' > "$STUB_DIR/npm"
    chmod +x "$STUB_DIR/npm"
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .scripts[0].launch_failed == true'
}

# $1 = stub の絶対パス、$2 = calls.log に残す名前、$3 = exit code。"$PWD <名前> $*" を $TMP_DIR/calls.log に追記する
make_runner_stub() {
    mkdir -p "$(dirname "$1")"
    printf '#!/usr/bin/env bash\necho "$PWD %s" "$@" >> "%s/calls.log"\nexit %s\n' "$2" "$TMP_DIR" "$3" > "$1"
    chmod +x "$1"
}

@test "run-*.sh 無し: Gemfile.lock に rspec-core があれば bundle exec rspec、無く bin/rails があれば bin/rails test で全件実行する" {
    printf 'GEM\n  specs:\n    rspec-core (3.13.0)\n' > "$WT/Gemfile.lock"
    make_runner_stub "$STUB_DIR/bundle" bundle 0
    make_runner_stub "$WT/bin/rails" bin/rails 1
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "bundle exec rspec", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/calls.log")" = "$WT bundle exec rspec" ]

    rm "$TMP_DIR/calls.log"
    printf 'GEM\n  specs:\n    minitest (5.25.1)\n' > "$WT/Gemfile.lock"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "bin/rails test", exit: 1, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/calls.log")" = "$WT bin/rails test" ]
}

@test "run-*.sh 無し: composer.json に pestphp/pest があれば vendor/bin/pest、無く phpunit/phpunit があれば vendor/bin/phpunit で全件実行する" {
    echo '{"require-dev":{"pestphp/pest":"^3.0","phpunit/phpunit":"^11.0"}}' > "$WT/composer.json"
    make_runner_stub "$WT/vendor/bin/pest" vendor/bin/pest 0
    make_runner_stub "$WT/vendor/bin/phpunit" vendor/bin/phpunit 1
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "vendor/bin/pest", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/calls.log")" = "$WT vendor/bin/pest" ]

    rm "$TMP_DIR/calls.log"
    echo '{"require":{"phpunit/phpunit":"^11.0"}}' > "$WT/composer.json"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "vendor/bin/phpunit", exit: 1, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/calls.log")" = "$WT vendor/bin/phpunit" ]
}

@test "run-*.sh もフォールバックも無ければ tests no_tests（scripts 空・green false）" {
    rmdir "$WT/tests"
    run_tests
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.status == "passed" and .tests == "no_tests" and .green == false and .scripts == [] and .failed_files == []'
}

@test "workspace-prebuild が failed ならテストを 1 本も実行せず failed、reason を summary の先頭に置く" {
    git -C "$WT" init -q
    echo '{"name":"root","private":true,"devDependencies":{"@fx/shared":"workspace:*"}}' > "$WT/package.json"
    printf 'packages:\n  - "packages/*"\n' > "$WT/pnpm-workspace.yaml"
    printf 'dist/\n' > "$WT/.gitignore"
    mkdir -p "$WT/packages/shared"
    echo '{"name":"@fx/shared","main":"./dist/index.js","scripts":{"build":"exit 1"}}' > "$WT/packages/shared/package.json"
    printf '#!/usr/bin/env bash\necho "build error" >&2\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    make_script run-a.sh 'echo ran > "$(dirname "$0")/a.marker"'
    export PATH="$STUB_DIR:$PATH"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and .tests == "failed" and .green == false and .scripts == [] and .failed_files == []'
    echo "$JSON" | jq -e '.summary | startswith("workspace build failed: @fx/shared")'
    [ ! -f "$WT/tests/a.marker" ]
}

@test "workspace-prebuild が skipped（pnpm ワークスペースでない）ならそのままテストへ進む" {
    make_script run-a.sh 'echo ran > "$(dirname "$0")/a.marker"'
    run_tests
    echo "$JSON" | jq -e '.status == "passed"'
    [ -f "$WT/tests/a.marker" ]
}

# WT を git repo にし、その時点のファイル（tests/ を含む）を 1 commit にする
init_repo() {
    git -C "$WT" init -q
    git -C "$WT" add -A
    git -C "$WT" -c user.name=t -c user.email=t@example.com commit -q -m base
}

# tests/ 以外に禁止文字列があれば exit 1 する git grep invariant（plugin-manifest.bats の移管済み skill 名検査と同型）。
# 禁止文字列は分割して書き、script 自身が一致しないようにする
make_grep_invariant() {
    make_script run-invariant.sh 'pat="forbidden""-skill-name"; if git grep -q "$pat" -- ":(exclude)tests"; then echo "not ok 1 forbidden name remains"; exit 1; fi; echo "ok 1 invariant"'
}

@test "intent-to-add: untracked の新規ファイルにだけ禁止文字列があると git grep の invariant が red になる（中身は stage しない）" {
    make_grep_invariant
    init_repo
    mkdir -p "$WT/plugins/x"
    echo "forbidden-skill-name" > "$WT/plugins/x/new.txt"
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and .green == false'
    echo "$JSON" | jq -e '.summary | contains("forbidden name remains")'
    run git -C "$WT" ls-files plugins/x/new.txt
    [ "$output" = "plugins/x/new.txt" ]
    run git -C "$WT" diff --cached --name-only
    [ -z "$output" ]
}

@test "intent-to-add: .devflow-tmp/ 配下と ignore 対象のファイルは index に載らない" {
    make_grep_invariant
    printf 'ignored/\n' > "$WT/.gitignore"
    init_repo
    mkdir -p "$WT/.devflow-tmp" "$WT/ignored"
    echo "forbidden-skill-name" > "$WT/.devflow-tmp/pr-body.md"
    echo "forbidden-skill-name" > "$WT/ignored/build.txt"
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    run git -C "$WT" ls-files .devflow-tmp ignored
    [ -z "$output" ]
    run git -C "$WT" status --porcelain --untracked-files=all
    [ "$output" = "?? .devflow-tmp/pr-body.md" ]
}

@test "intent-to-add: PR phase の git add -A で commit される tree は run-tests を挟んでも変わらない" {
    make_script run-a.sh 'exit 0'
    echo base > "$WT/tracked.txt"
    init_repo
    echo changed > "$WT/tracked.txt"
    mkdir -p "$WT/src"
    echo new > "$WT/src/new.txt"
    echo "with space" > "$WT/src/a b*.txt"
    # run-tests を通さない場合に git add -A が作る tree（実 index を触らない一時 index で算出）
    tmp_index="$TMP_DIR/expected.index"
    GIT_INDEX_FILE="$tmp_index" git -C "$WT" read-tree HEAD
    GIT_INDEX_FILE="$tmp_index" git -C "$WT" add -A
    expected=$(GIT_INDEX_FILE="$tmp_index" git -C "$WT" write-tree)
    head_tree=$(git -C "$WT" rev-parse 'HEAD^{tree}')
    run_tests
    echo "$JSON" | jq -e '.status == "passed"'
    # intent-to-add は中身を stage しない
    [ "$(git -C "$WT" write-tree)" = "$head_tree" ]
    git -C "$WT" add -A
    [ "$(git -C "$WT" write-tree)" = "$expected" ]
}

@test "intent-to-add: git の work tree でなければ何もせずテストへ進む" {
    make_script run-a.sh 'exit 0'
    run_tests
    echo "$JSON" | jq -e '.status == "passed"'
    [ ! -d "$WT/.git" ]
}

@test "引数不正は exit 2 で status error の JSON を出す" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.status == "error" and .green == false'
    run bash "$SCRIPT" "$WT" --base
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.status == "error" and (.summary | contains("--base <ref>"))'
}

# --- 変更ファイルの受け渡し（issue #835）---

run_tests_base() {
    run --separate-stderr bash "$SCRIPT" "$WT" --base "$1"
    [ "${#lines[@]}" -eq 1 ]
    JSON="$output"
}

# 受け取った DEVFLOW_CHANGED_FILES / DEVFLOW_BASE を WT 外に書き出すランナー（未設定は "unset"）。
# 一覧ファイルの中身も WT 外へ写す
make_env_probe() {
    make_script run-probe.sh "$(cat <<EOF
printf '%s\n%s\n' "\${DEVFLOW_CHANGED_FILES-unset}" "\${DEVFLOW_BASE-unset}" > "$TMP_DIR/env.out"
if [ -n "\${DEVFLOW_CHANGED_FILES-}" ]; then cp "\$DEVFLOW_CHANGED_FILES" "$TMP_DIR/list.out"; fi
exit 0
EOF
)"
}

git_commit() {
    git -C "$WT" -c user.name=t -c user.email=t@example.com commit -q -m "$1"
}

@test "--base: 変数がランナーに届き、一覧に commit 済み・staged・未 stage・untracked が WT 相対で重複なく入る" {
    make_env_probe
    echo base > "$WT/committed.txt"
    echo base > "$WT/staged.txt"
    echo base > "$WT/unstaged.txt"
    echo base > "$WT/old-name.txt"
    init_repo
    git -C "$WT" branch base-ref
    # commit 済み（さらに未 stage の変更も重ね、一覧では 1 件になること）と rename（旧・新の両方）
    echo committed > "$WT/committed.txt"
    git -C "$WT" mv old-name.txt new-name.txt
    git -C "$WT" add committed.txt
    git_commit change
    echo again > "$WT/committed.txt"
    # staged / 未 stage / untracked（.devflow-tmp/ は載せない）
    echo staged > "$WT/staged.txt"
    git -C "$WT" add staged.txt
    echo unstaged > "$WT/unstaged.txt"
    mkdir -p "$WT/src" "$WT/.devflow-tmp"
    echo new > "$WT/src/new file.txt"
    echo tmp > "$WT/.devflow-tmp/pr-body.md"
    run_tests_base base-ref
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    [[ "$stderr" != *"warning"* ]]
    changed_path=$(sed -n 1p "$TMP_DIR/env.out")
    [[ "$changed_path" == /* ]]
    [ "$(sed -n 2p "$TMP_DIR/env.out")" = "$(git -C "$WT" rev-parse base-ref)" ]
    expected=$(printf '%s\n' committed.txt new-name.txt old-name.txt "src/new file.txt" staged.txt unstaged.txt)
    [ "$(LC_ALL=C sort "$TMP_DIR/list.out")" = "$expected" ]
    [ -z "$(sort "$TMP_DIR/list.out" | uniq -d)" ]
}

@test "--base: 2 回目の実行（intent-to-add 済み）でも untracked だったファイルが一覧に残る" {
    make_env_probe
    init_repo
    echo new > "$WT/added.txt"
    run_tests_base HEAD
    run_tests_base HEAD
    [ "$(cat "$TMP_DIR/list.out")" = "added.txt" ]
}

@test "--base 無し: 両変数とも未設定（呼び出し元の環境にあっても継がない）" {
    make_env_probe
    init_repo
    echo new > "$WT/added.txt"
    export DEVFLOW_CHANGED_FILES="$TMP_DIR/outer.txt" DEVFLOW_BASE=outer
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    [ "$(cat "$TMP_DIR/env.out")" = "$(printf 'unset\nunset')" ]
}

@test "--base 解決失敗: 両変数とも未設定、stderr に 1 行だけ出して status / green は変えない" {
    make_env_probe
    init_repo
    run_tests_base no-such-ref
    echo "$JSON" | jq -e '.status == "passed" and .tests == "passed" and .green == true'
    [ "$(cat "$TMP_DIR/env.out")" = "$(printf 'unset\nunset')" ]
    [ "$(grep -c 'DEVFLOW_CHANGED_FILES / DEVFLOW_BASE not set' <<< "$stderr")" -eq 1 ]
}

@test "--base で git が失敗（git の work tree でない）: 両変数とも未設定、status は変えない" {
    make_env_probe
    run_tests_base HEAD
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    [ "$(cat "$TMP_DIR/env.out")" = "$(printf 'unset\nunset')" ]
    [ "$(grep -c 'not set' <<< "$stderr")" -eq 1 ]
}

@test "--base: フォールバック経路（npm test）には変数を渡さない" {
    echo '{"name":"x","scripts":{"test":"node t.js"}}' > "$WT/package.json"
    rmdir "$WT/tests"
    init_repo
    echo new > "$WT/added.txt"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n%%s\\n" "${DEVFLOW_CHANGED_FILES-unset}" "${DEVFLOW_BASE-unset}" > "%s/env.out"\nexit 0\n' "$TMP_DIR" > "$STUB_DIR/npm"
    chmod +x "$STUB_DIR/npm"
    export PATH="$STUB_DIR:$PATH"
    run_tests_base HEAD
    echo "$JSON" | jq -e '.status == "passed" and [.scripts[] | del(.log)] == [{path: "npm test", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/env.out")" = "$(printf 'unset\nunset')" ]
}

@test "--base: 変数を読まないランナーでは status と出力 JSON が --base 無しと同一（epoch・log パスを除く）" {
    make_script run-a.sh 'echo "ok 1 a"'
    make_script run-b.sh 'echo "not ok 1 b"; echo "# (in test file '"$WT"'/plugins/b.bats, line 2)"; exit 1'
    init_repo
    echo new > "$WT/added.txt"
    normalize='del(.epoch) | .summary |= gsub("log: [^)]*"; "log: X") | .scripts[].log = "X"'
    run_tests
    without=$(jq -c "$normalize" <<< "$JSON")
    run_tests_base HEAD
    with=$(jq -c "$normalize" <<< "$JSON")
    echo "$with" | jq -e '.status == "failed" and .failed_files == ["plugins/b.bats"]'
    [ "$with" = "$without" ]
}

# --- 落ちたファイルだけの再実行（issue #865）---

run_tests_files() {
    run --separate-stderr bash "$SCRIPT" "$WT" --files "$@"
    JSON="$output"
}

# 受け取った DEVFLOW_TEST_FILES / DEVFLOW_CHANGED_FILES / DEVFLOW_BASE を WT 外に書き出し、一覧の中身も写すランナー。
# $1 = ランナーの exit code（既定 0）
make_files_probe() {
    make_script run-probe.sh "$(cat <<EOF
printf '%s\n%s\n%s\n' "\${DEVFLOW_TEST_FILES-unset}" "\${DEVFLOW_CHANGED_FILES-unset}" "\${DEVFLOW_BASE-unset}" > "$TMP_DIR/env.out"
if [ -n "\${DEVFLOW_TEST_FILES-}" ]; then cp "\$DEVFLOW_TEST_FILES" "$TMP_DIR/list.out"; fi
exit ${1:-0}
EOF
)"
}

@test "--files: 一覧を DEVFLOW_TEST_FILES でランナーに渡し、DEVFLOW_CHANGED_FILES / DEVFLOW_BASE は渡さない" {
    make_files_probe
    mkdir -p "$WT/plugins/x"
    : > "$WT/plugins/x/a.bats"
    : > "$WT/plugins/x/b.test.mjs"
    export DEVFLOW_CHANGED_FILES="$TMP_DIR/outer.txt" DEVFLOW_BASE=outer DEVFLOW_TEST_FILES="$TMP_DIR/outer-files.txt"
    run_tests_files plugins/x/a.bats plugins/x/b.test.mjs
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$JSON" | jq -e '.status == "passed" and .tests == "passed" and .green == true'
    list_path=$(sed -n 1p "$TMP_DIR/env.out")
    [[ "$list_path" == /* && "$list_path" != "$TMP_DIR/outer-files.txt" ]]
    [ "$(sed -n 2,3p "$TMP_DIR/env.out")" = "$(printf 'unset\nunset')" ]
    [ "$(cat "$TMP_DIR/list.out")" = "$(printf 'plugins/x/a.bats\nplugins/x/b.test.mjs')" ]
}

@test "--files: 再実行でも red なら failed（判定は exit code）" {
    make_files_probe 1
    : > "$WT/a.bats"
    run_tests_files a.bats
    echo "$JSON" | jq -e '.status == "failed" and .tests == "failed" and .green == false'
}

@test "--files: WT 内の通常ファイルでないパス（不在・絶対パス・..）は exit 2 の error でランナーを起動しない" {
    make_files_probe
    : > "$WT/a.bats"
    for bad in missing.bats "$WT/a.bats" ../wt/a.bats; do
        run_tests_files a.bats "$bad"
        [ "$status" -eq 2 ]
        echo "$JSON" | jq -e '.status == "error" and .green == false and (.summary | contains("--files"))'
    done
    [ ! -f "$TMP_DIR/env.out" ]
    run --separate-stderr bash "$SCRIPT" "$WT" --files
    [ "$status" -eq 2 ]
}

@test "--files: tests/run-*.sh が無い repo はフォールバックを実行せず error" {
    echo '{"name":"x","scripts":{"test":"node t.js"}}' > "$WT/package.json"
    rmdir "$WT/tests"
    : > "$WT/a.test.mjs"
    printf '#!/usr/bin/env bash\ntouch "%s/npm.ran"\nexit 0\n' "$TMP_DIR" > "$STUB_DIR/npm"
    chmod +x "$STUB_DIR/npm"
    export PATH="$STUB_DIR:$PATH"
    run_tests_files a.test.mjs
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    [ ! -f "$TMP_DIR/npm.ran" ]
}
