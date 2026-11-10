#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/run-tests.sh (issue #821)
#
# Strategy: mktemp -d に tests/run-*.sh の fixture（exit 0 / 1 / 126 を返す script、bats / vitest 形式の
# 失敗出力を吐く script）を置き、status / tests / green / scripts / failed_files を stdout の JSON 1 行で検査する。
# 解決したテストコマンド（--commands。issue #1278）は WT 外に書いたコマンドファイルと、PATH 先頭の stub（fakerunner / pnpm）で回す。
# untracked の intent-to-add（issue #833）は WT を git init した fixture で、git grep invariant の red と index の状態を見る。
# 変更ファイルの受け渡し（issue #835）は、受け取った DEVFLOW_CHANGED_FILES / DEVFLOW_BASE を WT 外へ書き出す
# probe ランナー（make_env_probe）で、値と一覧の中身・未設定の各経路を見る。
# 落ちたテストファイルの受け取り（issue #1249）は、WT 外の list.in を DEVFLOW_FAILED_FILES へ写すランナー
# （make_list_runner）を base に commit し、ランナーを書き換えずに一覧の中身だけを変えて各経路を見る。
# テストは start → wait の公開の起動形だけで回す（切り離した supervisor が残るので start は fd 3 を閉じて呼ぶ）。
# 切り離した実行の stderr は state dir の logs/command.log に残るので、run_tests はそれを $stderr に入れる。
# ランナーの集合は base の tree で決まる（issue #1277）ので、run_tests は WT に commit が無ければその時点のファイルを
# base として commit し、--base が無ければ --base HEAD を前置する（fixture のランナーが base と同一の run になる）。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/run-tests.sh"
    TMP_DIR="$(mktemp -d)"
    WT="$(cd "$TMP_DIR" && pwd)/wt"
    mkdir -p "$WT/tests"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    export BG_JOB_POLL_SEC=0.1
}

teardown() {
    bash "$SCRIPT" stop "$WT" --timeout-sec 15 >/dev/null 2>&1 3>&- || true
    rm -rf "$TMP_DIR"
}

# $1 = tests/ 配下のファイル名、$2 = 本文（#!/usr/bin/env bash の後に続く）。実行ビットを付ける
make_script() {
    printf '#!/usr/bin/env bash\n%s\n' "$2" > "$WT/tests/$1"
    chmod +x "$WT/tests/$1"
}

# WT を git repo にし、その時点のファイル（tests/ を含む）を 1 commit にする
init_repo() {
    git -C "$WT" init -q
    git -C "$WT" add -A
    git -C "$WT" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m base
}

# WT に commit が無ければ（git repo でなければ init して）その時点のファイルを base として commit する
ensure_base() {
    git -C "$WT" rev-parse -q --verify HEAD >/dev/null 2>&1 || init_repo
}

# start の引数を受け取り、start → wait で結果まで進める（ensure_base の後、--base が無ければ --base HEAD を前置する）。
# 各 stdout（stderr は分ける）が JSON 1 行であることを確かめ、wait の行を $JSON に、切り離した実行の stderr を $stderr に入れる。
# start が引数不正で落ちたらその応答を $JSON に入れて返す。追加の環境変数（PATH の stub 差し替え等）は呼び出し側で export する
run_tests() {
    ensure_base
    if [[ " $* " != *" --base "* ]]; then set -- --base HEAD "$@"; fi
    run_tests_raw "$@"
}

# run_tests から base の用意と --base の前置を除いたもの（引数をそのまま start に渡す）
run_tests_raw() {
    run --separate-stderr bash "$SCRIPT" start "$WT" "$@" 3>&-
    [ "${#lines[@]}" -eq 1 ]
    JSON="$output"
    [ "$status" -eq 0 ] || return 0
    run --separate-stderr bash "$SCRIPT" wait "$WT" --wait-sec 120
    [ "${#lines[@]}" -eq 1 ]
    JSON="$output"
    stderr="$(cat "$WT/.devflow-tmp/run-tests/logs/command.log")"
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
    # base と同一のランナーだけの run は changed_runners を出さない（出力の形は issue #1277 の前と同じ）
    echo "$JSON" | jq -e 'keys == (["status", "tests", "green", "summary", "scripts", "failed_files", "epoch"] | sort)'
    [ -f "$WT/tests/b.marker" ]
}

# --- ランナーの集合は base の tree で決める（issue #1277）---

@test "base の集合: base に無い tests/run-new.sh を worktree に足しても実行せず、changed_runners に載せる" {
    make_script run-a.sh 'exit 0'
    init_repo
    make_script run-new.sh 'touch "$(dirname "$0")/new.marker"; exit 0'
    run_tests
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" '.status == "passed" and .green == true and ([.scripts[].path] == [$a])'
    echo "$JSON" | jq -e '.changed_runners == ["tests/run-new.sh"]'
    [ ! -f "$WT/tests/new.marker" ]
    [[ "$stderr" == *"tests/run-new.sh"* ]]
}

@test "base の集合: base のランナーが worktree で欠けていれば起動失敗（exit 127）として error、残りは実行する" {
    make_script run-a.sh 'echo a-ran > "$(dirname "$0")/a.marker"'
    make_script run-b.sh 'exit 0'
    init_repo
    git -C "$WT" rm -q tests/run-b.sh
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false and .failed_files == []'
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" --arg b "$WT/tests/run-b.sh" \
        '[.scripts[] | del(.log)] == [{path: $a, exit: 0, launch_failed: false}, {path: $b, exit: 127, launch_failed: true}]'
    echo "$JSON" | jq -e '.summary | contains("launch failed") and contains("run-b.sh")'
    echo "$JSON" | jq -e 'has("changed_runners") | not'
    [ -f "$WT/tests/a.marker" ]
}

@test "base の集合: base のランナーの実行ビットが worktree で外れていれば起動失敗（exit 126）として error" {
    make_script run-a.sh 'exit 0'
    make_script run-b.sh 'touch "$(dirname "$0")/b.marker"; exit 0'
    init_repo
    chmod -x "$WT/tests/run-b.sh"
    run_tests
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    echo "$JSON" | jq -e --arg b "$WT/tests/run-b.sh" '[.scripts[] | select(.path == $b) | [.exit, .launch_failed]] == [[126, true]]'
    [ ! -f "$WT/tests/b.marker" ]
}

@test "base の集合: 中身が base と違うランナーは実行し、base に無いランナーと合わせて changed_runners に載せる" {
    make_script run-a.sh 'exit 0'
    make_script run-b.sh 'exit 1'
    init_repo
    make_script run-b.sh 'exit 0'
    make_script run-c.sh 'exit 0'
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .green == true and (.scripts | length == 2)'
    echo "$JSON" | jq -e '(.changed_runners | sort) == ["tests/run-b.sh", "tests/run-c.sh"]'
    # 中身が同じなら commit の有無（staged・未 stage）に依らず載せない
    git -C "$WT" checkout -q -- tests/run-b.sh
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and .changed_runners == ["tests/run-c.sh"]'
}

@test "base の集合: red の応答にも changed_runners を載せる" {
    make_script run-a.sh 'exit 0'
    init_repo
    make_script run-a.sh 'exit 1'
    run_tests
    echo "$JSON" | jq -e '.status == "failed" and .changed_runners == ["tests/run-a.sh"]'
}

@test "base の集合: base の tree で実行ビットの無い run-*.sh は実行しない" {
    make_script run-a.sh 'exit 0'
    printf '#!/usr/bin/env bash\nexit 1\n' > "$WT/tests/run-noexec.sh"
    run_tests
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" '.status == "passed" and ([.scripts[].path] == [$a])'
    echo "$JSON" | jq -e 'has("changed_runners") | not'
}

@test "base の集合: --files の再実行も base の集合で実行する（base に無いランナーは実行しない）" {
    make_script run-a.sh "cp \"\$DEVFLOW_TEST_FILES\" \"$TMP_DIR/list.out\""
    : > "$WT/a.bats"
    init_repo
    make_script run-new.sh 'touch "$(dirname "$0")/new.marker"'
    run_tests --base HEAD --files a.bats
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" '.status == "passed" and ([.scripts[].path] == [$a])'
    echo "$JSON" | jq -e '.changed_runners == ["tests/run-new.sh"]'
    [ "$(cat "$TMP_DIR/list.out")" = "a.bats" ]
    [ ! -f "$WT/tests/new.marker" ]
}

@test "base の集合: merge-base を解決できない（ref が無い・git の work tree でない）run はテストを 1 本も実行せず error（--files も）" {
    make_script run-a.sh 'touch "$(dirname "$0")/a.marker"'
    : > "$WT/a.bats"
    run_tests_raw --base HEAD
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false and .scripts == [] and (.summary | contains("merge-base"))'
    init_repo
    for args in "--base no-such-ref" "--base no-such-ref --files a.bats"; do
        # shellcheck disable=SC2086
        run_tests $args
        echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false and .scripts == [] and (.summary | contains("merge-base"))'
    done
    [ ! -f "$WT/tests/a.marker" ]
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

# --- 解決したテストコマンド（--commands。issue #1278）---

# $1 = コマンドファイルの中身（JSON）。WT の外（$TMP_DIR）に書き、そのパスを $CMDS に入れる
make_commands() {
    CMDS="$TMP_DIR/commands.json"
    printf '%s\n' "$1" > "$CMDS"
}

# resolver が解決した形のコマンドファイルを書く（dir "." の 1 entry。$1 = full_command、$2 = files_command（省略時は null））
resolved_commands() {
    make_commands "$(jq -nc --arg f "$1" --arg g "${2-}" \
        '{source: "resolver", status: "resolved", commands: [{dir: ".", full_command: $f, files_command: (if $g == "" then null else $g end)}], sources: ["pyproject.toml"]}')"
}

# 複数 entry のコマンドファイルを書く（引数は dir の並び。各 entry は fakerunner all / fakerunner {files}）
entry_commands() {
    make_commands "$(printf '%s\n' "$@" | jq -R '{dir: ., full_command: "fakerunner all", files_command: "fakerunner {files}"}' \
        | jq -sc '{source: "resolver", status: "resolved", commands: ., sources: ["packages/a/package.json"]}')"
}

# $1 = stub の絶対パス、$2 = calls.log に残す名前、$3 = exit code。"$PWD <名前> $*" を $TMP_DIR/calls.log に追記する
make_runner_stub() {
    mkdir -p "$(dirname "$1")"
    printf '#!/usr/bin/env bash\necho "$PWD %s" "$@" >> "%s/calls.log"\nexit %s\n' "$2" "$TMP_DIR" "$3" > "$1"
    chmod +x "$1"
}

@test "解決したコマンド: full_command を <WT> を cwd に shell を通さない argv で実行し、exit 0 なら passed" {
    rmdir "$WT/tests"
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    resolved_commands "fakerunner -q tests;echo" "fakerunner {files}"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "passed" and .tests == "passed" and .green == true'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "fakerunner -q tests;echo", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/calls.log")" = "$WT fakerunner -q tests;echo" ]
}

@test "解決したコマンド: exit 1 なら failed（failed_files はログから抽出）" {
    rmdir "$WT/tests"
    printf '#!/usr/bin/env bash\necho " FAIL  src/a.test.ts > x"\nexit 1\n' > "$STUB_DIR/fakerunner"
    chmod +x "$STUB_DIR/fakerunner"
    export PATH="$STUB_DIR:$PATH"
    resolved_commands "fakerunner run"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "failed" and .tests == "failed" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "fakerunner run", exit: 1, launch_failed: false}] and .failed_files == ["src/a.test.ts"]'
}

@test "解決したコマンド: exit 126 / 127（起動失敗）は error" {
    rmdir "$WT/tests"
    resolved_commands "no-such-runner-xyz run"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .scripts[0].exit == 127 and .scripts[0].launch_failed == true'
    printf '#!/usr/bin/env bash\nexit 126\n' > "$STUB_DIR/fakerunner"
    chmod +x "$STUB_DIR/fakerunner"
    export PATH="$STUB_DIR:$PATH"
    resolved_commands "fakerunner"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "error" and .scripts[0].launch_failed == true'
}

@test "コマンドファイル: ファイルが無い・unresolved なら tests/run-*.sh の無い repo は no_tests（scripts 空・green false）" {
    rmdir "$WT/tests"
    run_tests --commands "$TMP_DIR/absent.json"
    echo "$JSON" | jq -e '.status == "passed" and .tests == "no_tests" and .green == false and .scripts == [] and .failed_files == []'
    make_commands '{"source":"resolver","status":"unresolved","sources":[]}'
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "passed" and .tests == "no_tests" and .green == false and .scripts == []'
}

@test "コマンドファイル: unresolved は base に tests/run-*.sh があっても実行しない（no_tests）" {
    make_script run-a.sh 'touch "$(dirname "$0")/a.marker"'
    make_commands '{"source":"user_config","status":"unresolved","sources":[]}'
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.tests == "no_tests" and .green == false'
    [ ! -f "$WT/tests/a.marker" ]
}

@test "コマンドファイル: resolved のコマンドは base の tests/run-*.sh に代えて実行し、source runners なら tests/run-*.sh を実行する" {
    make_script run-a.sh 'touch "$(dirname "$0")/a.marker"'
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    make_commands '{"source":"user_config","status":"resolved","commands":[{"dir":".","full_command":"fakerunner all","files_command":"fakerunner {files}"}],"sources":[]}'
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "fakerunner all", exit: 0, launch_failed: false}]'
    [ ! -f "$WT/tests/a.marker" ]

    make_commands '{"source":"runners","status":"resolved","sources":["tests/run-a.sh"]}'
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e --arg a "$WT/tests/run-a.sh" '[.scripts[] | del(.log)] == [{path: $a, exit: 0, launch_failed: false}]'
    [ -f "$WT/tests/a.marker" ]
}

@test "コマンドファイル: JSON として読めない・resolved なのに commands が無い（最上位の full_command）ならテストを実行せず error" {
    make_script run-a.sh 'touch "$(dirname "$0")/a.marker"'
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    for body in 'not json' '{"source":"user_config","status":"resolved","full_command":"fakerunner all","files_command":"fakerunner {files}","sources":[]}'; do
        make_commands "$body"
        run_tests --commands "$CMDS"
        echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false and (.summary | contains("not readable"))'
    done
    [ ! -f "$WT/tests/a.marker" ]
    [ ! -f "$TMP_DIR/calls.log" ]
}

@test "commands: 全件実行は各 entry を <WT>/<dir> を cwd に並び順で実行し、全部 exit 0 なら passed" {
    rmdir "$WT/tests"
    mkdir -p "$WT/packages/a" "$WT/services/api"
    : > "$WT/packages/a/.keep"
    : > "$WT/services/api/.keep"
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    entry_commands packages/a services/api
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "passed" and .tests == "passed" and .green == true'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "packages/a: fakerunner all", exit: 0, launch_failed: false}, {path: "services/api: fakerunner all", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/calls.log")" = "$(printf '%s\n' "$WT/packages/a fakerunner all" "$WT/services/api fakerunner all")" ]
}

# cwd が $WT/packages/a のときだけ FAIL 行を出して exit 1 する fakerunner（それ以外の cwd は exit 0）。呼び出しは calls.log に残す
make_failing_in_a_stub() {
    printf '#!/usr/bin/env bash\necho "$PWD fakerunner" "$@" >> "%s/calls.log"\nif [ "$PWD" = "%s/packages/a" ]; then echo " FAIL  src/x.test.ts > t"; exit 1; fi\nexit 0\n' \
        "$TMP_DIR" "$WT" > "$STUB_DIR/fakerunner"
    chmod +x "$STUB_DIR/fakerunner"
}

@test "commands: 1 つの entry が red なら failed で残りの entry も実行し、failed_files は WT root からの相対パス" {
    rmdir "$WT/tests"
    mkdir -p "$WT/packages/a/src" "$WT/services/api"
    : > "$WT/packages/a/src/x.test.ts"
    : > "$WT/services/api/.keep"
    make_failing_in_a_stub
    export PATH="$STUB_DIR:$PATH"
    entry_commands packages/a services/api
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "failed" and .tests == "failed" and .green == false'
    echo "$JSON" | jq -e '[.scripts[].exit] == [1, 0] and .failed_files == ["packages/a/src/x.test.ts"]'
    [ "$(wc -l < "$TMP_DIR/calls.log" | tr -d ' ')" = 2 ]
}

@test "commands --files: 各ファイルを含む最も深い entry に振り分け、dir からの相対パスで {files} に渡す（ファイルの無い entry は実行しない・- 始まりは ./ を付けて option にしない）" {
    rmdir "$WT/tests"
    mkdir -p "$WT/packages/a/src" "$WT/packages/b" "$WT/top"
    : > "$WT/packages/a/src/x.test.ts"
    : > "$WT/packages/a/y.test.ts"
    : > "$WT/top/z.test.ts"
    : > "$WT/packages/b/.keep"
    : > "$WT/packages/a/--help"
    make_failing_in_a_stub
    export PATH="$STUB_DIR:$PATH"
    entry_commands . packages/a packages/b
    run_tests --commands "$CMDS" --files packages/a/src/x.test.ts top/z.test.ts packages/a/y.test.ts packages/a/--help
    [ "$(cat "$TMP_DIR/calls.log")" = "$(printf '%s\n' "$WT fakerunner top/z.test.ts" "$WT/packages/a fakerunner src/x.test.ts y.test.ts ./--help")" ]
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[].path] == ["fakerunner top/z.test.ts", "packages/a: fakerunner src/x.test.ts y.test.ts ./--help"]'
    echo "$JSON" | jq -e '.failed_files == ["packages/a/src/x.test.ts"]'
}

@test "commands --files: どの entry の dir にも含まれないファイルがあれば何も実行せず error" {
    rmdir "$WT/tests"
    mkdir -p "$WT/packages/a" "$WT/packages/ab"
    : > "$WT/packages/a/x.test.ts"
    : > "$WT/packages/ab/y.test.ts"
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    entry_commands packages/a
    run_tests --commands "$CMDS" --files packages/a/x.test.ts packages/ab/y.test.ts
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false and (.summary | contains("packages/ab/y.test.ts"))'
    [ ! -f "$TMP_DIR/calls.log" ]
}

@test "commands: <WT>/<dir> が WT 内の実ディレクトリでない entry（無い・symlink・.. ・絶対パス）があれば何も実行せず error" {
    rmdir "$WT/tests"
    mkdir -p "$WT/packages/a" "$TMP_DIR/outside"
    : > "$WT/packages/a/.keep"
    ln -s "$TMP_DIR/outside" "$WT/packages/link"
    ln -s a "$WT/packages/inner"
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    for bad in packages/missing packages/link packages/inner packages/a/../a "$WT/packages/a" ""; do
        entry_commands packages/a "$bad"
        run_tests --commands "$CMDS"
        echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false and .scripts == [] and (.summary | contains("commands[1].dir"))'
    done
    [ ! -f "$TMP_DIR/calls.log" ]
}

@test "言語別の決め打ちは無い: package.json の scripts.test だけで tests/run-*.sh もコマンドファイルも無い repo は no_tests" {
    echo '{"name":"x","scripts":{"test":"node t.js"}}' > "$WT/package.json"
    : > "$WT/pnpm-lock.yaml"
    rmdir "$WT/tests"
    for pm in npm pnpm yarn; do make_runner_stub "$STUB_DIR/$pm" "$pm" 0; done
    export PATH="$STUB_DIR:$PATH"
    run_tests
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.status == "passed" and .tests == "no_tests" and .green == false and .scripts == [] and .failed_files == []'
    [ ! -f "$TMP_DIR/calls.log" ]
}

@test "解決したコマンド: pnpm で始まるコマンドがテスト前の依存 install で失敗したら起動失敗として error（failed にしない）" {
    rmdir "$WT/tests"
    printf '#!/usr/bin/env bash\necho "\033[31m[ERR_PNPM_EPERM]\033[39m [importPackage x] Operation not permitted"\necho "pnpm: Command failed with exit code 1: '"'"'/opt/pnpm/11.0.8/node_modules/@pnpm/exe/pnpm'"'"' install"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    resolved_commands "pnpm exec vitest run"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    echo "$JSON" | jq -e '[.scripts[] | del(.log)] == [{path: "pnpm exec vitest run", exit: 1, launch_failed: true}] and .failed_files == []'
    echo "$JSON" | jq -e '.summary | contains("launch failed: pnpm exec vitest run")'
}

@test "解決したコマンド: pnpm がテストの起動前に pnpm 自身のエラーで終了したら起動失敗として error（failed にしない）" {
    rmdir "$WT/tests"
    printf '#!/usr/bin/env bash\necho " ERROR  packages field missing or empty"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    resolved_commands "pnpm exec vitest run"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "error" and [.scripts[] | del(.log)] == [{path: "pnpm exec vitest run", exit: 1, launch_failed: true}]'
}

@test "解決したコマンド: pnpm がテストを起動した後の ERROR 行・エラー見出しの無い失敗は red のまま（launch_failed にしない）" {
    rmdir "$WT/tests"
    printf '#!/usr/bin/env bash\necho " FAIL  src/a.test.ts > x"\necho " ERROR  db connection refused"\nexit 1\n' > "$STUB_DIR/pnpm"
    chmod +x "$STUB_DIR/pnpm"
    export PATH="$STUB_DIR:$PATH"
    resolved_commands "pnpm exec vitest run"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "failed" and [.scripts[] | del(.log)] == [{path: "pnpm exec vitest run", exit: 1, launch_failed: false}]'

    printf '#!/usr/bin/env bash\necho "Tests: 1 failed, 1 total"\nexit 1\n' > "$STUB_DIR/pnpm"
    run_tests --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "failed" and .scripts[0].launch_failed == false'
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
    # run-tests 自身の state dir を除いて見る
    run git -C "$WT" status --porcelain --untracked-files=all -- . ':(exclude).devflow-tmp/run-tests'
    [ "$output" = "?? .devflow-tmp/pr-body.md" ]
}

@test "intent-to-add: PR phase の git add -A で commit される tree は run-tests を挟んでも変わらない" {
    make_script run-a.sh 'exit 0'
    echo base > "$WT/tracked.txt"
    init_repo
    # prerun と同じく .devflow-tmp を ignore する（run-tests の state dir が git add -A に載らない）
    echo '.devflow-tmp/' >> "$WT/.git/info/exclude"
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

@test "引数不正は exit 2 で status error の JSON を出す（subcommand の無い起動形・--base の無い start も）" {
    make_script run-a.sh 'echo ran > "$(dirname "$0")/a.marker"'
    : > "$WT/a.bats"
    init_repo
    for args in "" "$WT" "$WT --base origin/main" "start $WT" "start $WT --files a.bats" "start $WT --base HEAD --files" \
        "start $WT --base HEAD a.bats" "start $WT --base HEAD --commands" "start $WT --base HEAD --files a.bats --commands x" \
        "wait" "stop" "wait $WT --wait-sec x" "stop $WT --wait-sec 1"; do
        # shellcheck disable=SC2086
        run bash "$SCRIPT" $args
        [ "$status" -eq 2 ]
        echo "$output" | jq -e '.status == "error" and .green == false'
    done
    run bash "$SCRIPT" start "$WT" --base
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.status == "error" and (.summary | contains("--base <ref>"))'
    [ ! -f "$WT/tests/a.marker" ]
}

# --- start / wait / stop（issue #1225）---

@test "start はテストを切り離してすぐ返し、wait は --wait-sec より長く sleep する間 running、終われば結果の JSON を返す" {
    make_script run-a.sh 'sleep 3; echo "ok 1 a"'
    ensure_base
    run --separate-stderr bash "$SCRIPT" start "$WT" --base HEAD 3>&-
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.status == "running" and .tests == "running" and .green == false'

    run --separate-stderr bash "$SCRIPT" wait "$WT" --wait-sec 1
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.status == "running" and .tests == "running" and .green == false'

    run --separate-stderr bash "$SCRIPT" wait "$WT" --wait-sec 120
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e --arg a "$WT/tests/run-a.sh" \
        '.status == "passed" and .tests == "passed" and .green == true and ([.scripts[] | del(.log)] == [{path: $a, exit: 0, launch_failed: false}]) and .failed_files == [] and (.epoch | type == "number")'
}

@test "wait: 終わった後は何度呼んでも同じ結果の JSON を返す（red の failed_files も含む）" {
    make_script run-a.sh 'echo "not ok 1 x"; echo "# (in test file '"$WT"'/a.bats, line 2)"; exit 1'
    run_tests
    first="$JSON"
    echo "$first" | jq -e '.status == "failed" and .tests == "failed" and .green == false and .failed_files == ["a.bats"]'
    run bash "$SCRIPT" wait "$WT" --wait-sec 0
    [ "$output" = "$first" ]
}

@test "stop: 走っているテストを止め、その後の wait は tests error（テストが通ったとみなさない）" {
    make_script run-a.sh 'sleep 30; touch "$(dirname "$0")/a.marker"'
    ensure_base
    run bash "$SCRIPT" start "$WT" --base HEAD 3>&-
    echo "$output" | jq -e '.status == "running"'
    run bash "$SCRIPT" stop "$WT" --timeout-sec 15
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .was_running == true'
    run bash "$SCRIPT" wait "$WT" --wait-sec 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.status == "error" and .tests == "error" and .green == false'
    [ ! -f "$WT/tests/a.marker" ]
}

@test "start 前の wait は tests error、stop は何もしない" {
    run bash "$SCRIPT" wait "$WT" --wait-sec 0
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.status == "error" and .tests == "error" and .green == false'
    run bash "$SCRIPT" stop "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .was_running == false'
}

@test "切り離したテストの上限を超えると止めて tests error" {
    make_script run-a.sh 'sleep 30'
    export RUN_TESTS_TIMEOUT_SEC=1
    ensure_base
    run bash "$SCRIPT" start "$WT" --base HEAD 3>&-
    run bash "$SCRIPT" wait "$WT" --wait-sec 20
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.status == "error" and .tests == "error" and .green == false and (.summary | contains("did not finish"))'
}

@test "start を繰り返すと前の実行を止めて新しい引数で走らせ直す" {
    make_script run-a.sh 'sleep 30; touch "$(dirname "$0")/first.marker"'
    ensure_base
    run bash "$SCRIPT" start "$WT" --base HEAD 3>&-
    echo "$output" | jq -e '.status == "running"'
    make_script run-a.sh 'exit 0'
    run_tests
    echo "$JSON" | jq -e '.status == "passed" and .green == true'
    [ ! -f "$WT/tests/first.marker" ]
}

@test "--base / --files の引数は切り離した実行まで届く（空白を含むパスも 1 引数のまま）" {
    make_script run-probe.sh "$(cat <<EOF
cp "\$DEVFLOW_TEST_FILES" "$TMP_DIR/list.out"
EOF
)"
    : > "$WT/a b.bats"
    run_tests --files "a b.bats"
    echo "$JSON" | jq -e '.status == "passed"'
    [ "$(cat "$TMP_DIR/list.out")" = "a b.bats" ]
}

# --- 変更ファイルの受け渡し（issue #835）---

run_tests_base() {
    run_tests --base "$1"
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

@test "--base: 解決したテストコマンドには変数を渡さない（DEVFLOW_FAILED_FILES も）" {
    rmdir "$WT/tests"
    init_repo
    echo new > "$WT/added.txt"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n%%s\\n%%s\\n" "${DEVFLOW_CHANGED_FILES-unset}" "${DEVFLOW_BASE-unset}" "${DEVFLOW_FAILED_FILES-unset}" > "%s/env.out"\nexit 0\n' "$TMP_DIR" > "$STUB_DIR/fakerunner"
    chmod +x "$STUB_DIR/fakerunner"
    export PATH="$STUB_DIR:$PATH" DEVFLOW_FAILED_FILES="$TMP_DIR/outer-failed.txt"
    resolved_commands "fakerunner run"
    run_tests --base HEAD --commands "$CMDS"
    echo "$JSON" | jq -e '.status == "passed" and [.scripts[] | del(.log)] == [{path: "fakerunner run", exit: 0, launch_failed: false}]'
    [ "$(cat "$TMP_DIR/env.out")" = "$(printf 'unset\nunset\nunset')" ]
}

# --- 落ちたファイルだけの再実行（issue #865）---

run_tests_files() {
    run_tests --files "$@"
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
    run --separate-stderr bash "$SCRIPT" start "$WT" --files
    [ "$status" -eq 2 ]
}

@test "--files: tests/run-*.sh も解決したテストコマンドも無い repo は何も実行せず error" {
    echo '{"name":"x","scripts":{"test":"node t.js"}}' > "$WT/package.json"
    rmdir "$WT/tests"
    : > "$WT/a.test.mjs"
    make_runner_stub "$STUB_DIR/npm" npm 0
    export PATH="$STUB_DIR:$PATH"
    run_tests_files a.test.mjs
    [ "$status" -eq 0 ]
    echo "$JSON" | jq -e '.status == "error" and .tests == "error" and .green == false'
    [ ! -f "$TMP_DIR/calls.log" ]
}

@test "--files: 解決したテストコマンドは files_command の {files} の語を一覧のパスに置き換えて実行する（空白を含むパスも 1 引数）" {
    rmdir "$WT/tests"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$PWD" "$@" > "%s/argv.out"\nexit 1\n' "$TMP_DIR" > "$STUB_DIR/fakerunner"
    chmod +x "$STUB_DIR/fakerunner"
    export PATH="$STUB_DIR:$PATH"
    : > "$WT/a b.test.mjs"
    : > "$WT/c.test.mjs"
    resolved_commands "fakerunner run" "fakerunner run {files} --reporter dot"
    run_tests --commands "$CMDS" --files "a b.test.mjs" c.test.mjs
    echo "$JSON" | jq -e '.status == "failed" and .scripts[0].path == "fakerunner run a b.test.mjs c.test.mjs --reporter dot"'
    [ "$(cat "$TMP_DIR/argv.out")" = "$(printf '%s\n' "$WT" run "a b.test.mjs" c.test.mjs --reporter dot)" ]
}

@test "--files: files_command に {files} の語がちょうど 1 つ無ければ何も実行せず error" {
    rmdir "$WT/tests"
    make_runner_stub "$STUB_DIR/fakerunner" fakerunner 0
    export PATH="$STUB_DIR:$PATH"
    : > "$WT/a.test.mjs"
    for g in "" "fakerunner run" "fakerunner {files} {files}"; do
        resolved_commands "fakerunner run" "$g"
        run_tests --commands "$CMDS" --files a.test.mjs
        echo "$JSON" | jq -e '.status == "error" and .tests == "error" and (.summary | contains("{files}"))'
    done
    [ ! -f "$TMP_DIR/calls.log" ]
}

# --- 落ちたテストファイルの受け取り（issue #1249）---

@test "DEVFLOW_FAILED_FILES: ランナーごとにログディレクトリ内のまだ存在しないファイルのパスを渡す（呼び出し元の値は継がない）" {
    make_script run-a.sh "$(cat <<EOF
p="\${DEVFLOW_FAILED_FILES-unset}"
if [ -e "\$p" ]; then state=exists; else state=absent; fi
printf '%s\n%s\n' "\$p" "\$state" > "$TMP_DIR/env-a.out"
EOF
)"
    make_script run-b.sh "printf '%s\n' \"\${DEVFLOW_FAILED_FILES-unset}\" > \"$TMP_DIR/env-b.out\""
    : > "$WT/a.bats"
    export DEVFLOW_FAILED_FILES="$TMP_DIR/outer-failed.txt"
    for args in "" "--files a.bats"; do
        rm -f "$TMP_DIR/env-a.out" "$TMP_DIR/env-b.out"
        # shellcheck disable=SC2086
        run_tests $args
        echo "$JSON" | jq -e '.status == "passed"'
        path_a=$(sed -n 1p "$TMP_DIR/env-a.out")
        path_b=$(cat "$TMP_DIR/env-b.out")
        [[ "$path_a" == /* && "$path_a" != "$DEVFLOW_FAILED_FILES" && "$path_a" != "$path_b" ]]
        [ "$(sed -n 2p "$TMP_DIR/env-a.out")" = absent ]
        [ "$(dirname "$path_a")" = "$(dirname "$(jq -r '.scripts[0].log' <<< "$JSON")")" ]
        [[ "$path_a" != "$WT"/* && "$path_a" != "$(cd "$WT" && pwd -P)"/* ]]
    done
}

# list.in（WT 外）があれば DEVFLOW_FAILED_FILES へ写して exit 1 するランナー。$1 = 追加で出力する行の echo 群。
# ランナー自体は書き換えずに一覧の中身だけを変えられる（base と同じランナーのまま各経路を見る）
make_list_runner() {
    make_script run-py.sh "$(cat <<EOF
echo "FAILED tests/test_a.py::test_x - assert 1 == 2"
echo "ERROR tests/test_b.py::test_y - RuntimeError"
echo "SUBFAILED(i=1) tests/test_a.py::test_z - AssertionError"
${1:-}
if [ -f "$TMP_DIR/list.in" ]; then cp "$TMP_DIR/list.in" "\$DEVFLOW_FAILED_FILES"; fi
exit 1
EOF
)"
}

# ログに bats の not ok 行（b.bats）も出すランナー。ログからの抽出に戻ったかを failed_files == ["b.bats"] で見分ける
make_list_runner_with_bats() {
    make_list_runner "echo 'not ok 1 bats-side'; echo '# (in test file $WT/b.bats, line 2)'"
}

# 落ちたテストファイルの fixture を置いて base に commit する
init_list_repo() {
    : > "$WT/tests/test_a.py"
    : > "$WT/tests/test_b.py"
    : > "$WT/b.bats"
    init_repo
}

@test "DEVFLOW_FAILED_FILES: base と同じランナーが書いた一覧（WT 相対・WT 配下の絶対パス）が failed_files になる（pytest 形式の出力）" {
    make_list_runner
    init_list_repo
    printf '%s\n' tests/test_a.py "$WT/tests/test_b.py" ./tests/test_a.py > "$TMP_DIR/list.in"
    run_tests_base HEAD
    echo "$JSON" | jq -e '.status == "failed" and .tests == "failed" and .green == false'
    echo "$JSON" | jq -e '.failed_files == ["tests/test_a.py", "tests/test_b.py"]'
}

@test "DEVFLOW_FAILED_FILES: 一覧を使うときはログからの抽出を使わない" {
    make_list_runner_with_bats
    init_list_repo
    printf '%s\n' tests/test_a.py > "$TMP_DIR/list.in"
    run_tests_base HEAD
    echo "$JSON" | jq -e '.failed_files == ["tests/test_a.py"]'
}

@test "DEVFLOW_FAILED_FILES: ランナーが diff に入っているときは一覧を使わずログからの抽出に戻る" {
    make_list_runner_with_bats
    init_list_repo
    printf '%s\n' tests/test_a.py > "$TMP_DIR/list.in"
    echo "# changed" >> "$WT/tests/run-py.sh"
    run_tests_base HEAD
    echo "$JSON" | jq -e '.status == "failed" and .failed_files == ["b.bats"]'
}

@test "DEVFLOW_FAILED_FILES: --files の再実行では一覧を使わずログからの抽出に戻る" {
    make_list_runner_with_bats
    init_list_repo
    printf '%s\n' tests/test_a.py > "$TMP_DIR/list.in"
    run_tests --files tests/test_a.py
    echo "$JSON" | jq -e '.status == "failed" and .failed_files == ["b.bats"]'
}

@test "DEVFLOW_FAILED_FILES: 一覧に WT 内の通常ファイルでない行（..・WT の外・不在）が 1 件でもあれば failed_files は空" {
    make_list_runner_with_bats
    init_list_repo
    : > "$TMP_DIR/outside.py"
    for bad in ../wt/tests/test_b.py "$TMP_DIR/outside.py" tests/missing.py tests; do
        printf '%s\n' tests/test_a.py "$bad" > "$TMP_DIR/list.in"
        run_tests_base HEAD
        echo "$JSON" | jq -e '.status == "failed" and .failed_files == []'
    done
}

@test "DEVFLOW_FAILED_FILES: ランナーが一覧を書かない・空のときはログからの抽出のまま" {
    make_list_runner_with_bats
    init_list_repo
    run_tests_base HEAD
    echo "$JSON" | jq -e '.status == "failed" and .failed_files == ["b.bats"]'
    : > "$TMP_DIR/list.in"
    run_tests_base HEAD
    echo "$JSON" | jq -e '.status == "failed" and .failed_files == ["b.bats"]'
}
