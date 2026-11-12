#!/usr/bin/env bats
# run-all-bats.bats - Regression tests for tests/run-all-bats.sh discovery
# behavior (worktree exclusion of .claude/worktrees/**) and its parallel
# execution / result aggregation.
#
# Each test builds a fixture repository under $BATS_TEST_TMPDIR by copying
# the real run-all-bats.sh into a fresh tests/ dir. Since REPO_ROOT is
# derived from the script's own location, the fixture directory becomes the
# effective repo root for the copied script, letting us exercise discovery
# without touching the real repository.

setup() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE/tests"
    cp "$BATS_TEST_DIRNAME/run-all-bats.sh" "$FIXTURE/tests/"
    # dev-flow の run-tests 経由で本ファイル自体が実行されると、実 worktree の変更一覧が
    # 継承されて fixture repo の selection が狂う。各テストは必要なときだけ明示的に渡す。
    # CI のシャード指定（RUN_ALL_BATS_SHARD）も同じく fixture repo を分割してしまうので外す。
    unset DEVFLOW_CHANGED_FILES DEVFLOW_BASE DEVFLOW_TEST_FILES RUN_ALL_BATS_SHARD
}

# Fixture .bats content is written via printf (not a heredoc with a literal
# `@test` line) so that naive line-scanning `bats` implementations (some
# apt-packaged versions) don't mistake these fixture strings for real test
# definitions in *this* file, which causes spurious "duplicate test name"
# errors across the three tests below (each of which writes an "ok"/"leak"
# fixture). Building the `@` via a variable keeps `@test` from ever
# appearing at the start of a line in this source file.
AT='@'

write_ok_fixture() {
    printf '%stest "ok" { true; }\n' "$AT" > "$1"
}

write_leak_fixture() {
    printf '%stest "leak" { false; }\n' "$AT" > "$1"
}

@test "worktree 配下の .bats は discovery から除外される" {
    write_ok_fixture "$FIXTURE/sample.bats"
    mkdir -p "$FIXTURE/.claude/worktrees/df-999"
    write_leak_fixture "$FIXTURE/.claude/worktrees/df-999/leak.bats"

    run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
    [[ "$output" != *"leak.bats"* ]]
}

@test "worktree の有無で discovery 件数が変わらない" {
    write_ok_fixture "$FIXTURE/sample.bats"

    run bash "$FIXTURE/tests/run-all-bats.sh"
    [ "$status" -eq 0 ]
    first_count_line="$(echo "$output" | grep "Discovered .* file(s)")"

    mkdir -p "$FIXTURE/.claude/worktrees/df-999"
    write_leak_fixture "$FIXTURE/.claude/worktrees/df-999/leak.bats"

    run bash "$FIXTURE/tests/run-all-bats.sh"
    [ "$status" -eq 0 ]
    second_count_line="$(echo "$output" | grep "Discovered .* file(s)")"

    [ "$first_count_line" = "$second_count_line" ]
}

@test "worktree checkout 内から実行しても自身のテストは discovery される" {
    WT_FIXTURE="$BATS_TEST_TMPDIR/main/.claude/worktrees/df-1"
    mkdir -p "$WT_FIXTURE/tests"
    cp "$BATS_TEST_DIRNAME/run-all-bats.sh" "$WT_FIXTURE/tests/"
    write_ok_fixture "$WT_FIXTURE/sample.bats"

    run bash "$WT_FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Discovered 1 .bats file(s)"* ]]
}

@test "並列実行: 1 ファイルの失敗で exit 1 になり Summary と Failed files に反映される" {
    write_ok_fixture "$FIXTURE/a.bats"
    write_leak_fixture "$FIXTURE/b.bats"
    write_ok_fixture "$FIXTURE/c.bats"

    RUN_ALL_BATS_JOBS=3 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 1 ]
    [[ "$output" == *"Summary: 2 passed, 1 failed"* ]]
    [[ "$output" == *"Failed files:"*"  - b.bats"* ]]
}

@test "並列実行: 完了順に関係なく出力は discovery 順にファイル単位でまとまる" {
    # a.bats は b.bats より遅く終わるが、出力は a → b の順に並ぶ
    printf '%stest "slow-a" { sleep 1; true; }\n' "$AT" > "$FIXTURE/a.bats"
    printf '%stest "fast-b" { true; }\n' "$AT" > "$FIXTURE/b.bats"

    RUN_ALL_BATS_JOBS=2 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"=== Running: a.bats ==="*"slow-a"*"=== Running: b.bats ==="*"fast-b"* ]]
}

@test "RUN_ALL_BATS_JOBS=1 は直列で全ファイルを実行する" {
    write_ok_fixture "$FIXTURE/a.bats"
    write_ok_fixture "$FIXTURE/b.bats"

    RUN_ALL_BATS_JOBS=1 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Running with 1 parallel job(s)."* ]]
    [[ "$output" == *"Summary: 2 passed, 0 failed"* ]]
}

@test "RUN_ALL_BATS_JOBS が正の整数でなければ exit 2" {
    write_ok_fixture "$FIXTURE/a.bats"

    for bad in 0 abc -1 1.5; do
        RUN_ALL_BATS_JOBS="$bad" run bash "$FIXTURE/tests/run-all-bats.sh"
        [ "$status" -eq 2 ]
        [[ "$output" == *"RUN_ALL_BATS_JOBS must be a positive integer"* ]]
    done
}

# <file> に <n> 個の test を書く。各 test は実行時に <log> へファイル名を 1 行追記する。
write_weighted_fixture() {
    local file="$1" n="$2" log="$3" k
    : > "$file"
    for ((k = 1; k <= n; k++)); do
        printf '%stest "t%d" { echo %s >> "%s"; }\n' "$AT" "$k" "${file##*/}" "$log" >> "$file"
    done
}

@test "実行順: 重い（@test の多い）ファイルから先に起動し、出力は discovery 順のまま" {
    LOG="$BATS_TEST_TMPDIR/order.log"
    write_weighted_fixture "$FIXTURE/a.bats" 1 "$LOG"
    write_weighted_fixture "$FIXTURE/b.bats" 3 "$LOG"
    write_weighted_fixture "$FIXTURE/c.bats" 2 "$LOG"

    RUN_ALL_BATS_JOBS=1 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [ "$(uniq "$LOG" | tr '\n' ' ')" = "b.bats c.bats a.bats " ]
    [[ "$output" == *"=== Running: a.bats ==="*"=== Running: b.bats ==="*"=== Running: c.bats ==="* ]]
}

@test "RUN_ALL_BATS_SHARD: 全シャードを回すと全ファイルがちょうど 1 回ずつ実行される" {
    LOG="$BATS_TEST_TMPDIR/shard.log"
    local name n
    for spec in a:5 b:1 c:3 d:1 e:2 f:4 g:1; do
        name="${spec%%:*}"
        n="${spec##*:}"
        write_weighted_fixture "$FIXTURE/$name.bats" "$n" "$LOG"
    done
    : > "$LOG"

    for i in 1 2 3; do
        RUN_ALL_BATS_JOBS=1 RUN_ALL_BATS_SHARD="$i/3" run bash "$FIXTURE/tests/run-all-bats.sh"
        [ "$status" -eq 0 ]
        [[ "$output" == *"Shard $i/3: "*" of 7 .bats file(s)"* ]]
        # 各シャードは少なくとも 1 ファイルを持つ（偏りなく割り振られる）
        [[ "$output" != *"Shard $i/3: 0 of"* ]]
    done

    [ "$(uniq "$LOG" | sort | tr '\n' ' ')" = "a.bats b.bats c.bats d.bats e.bats f.bats g.bats " ]
    [ "$(uniq "$LOG" | sort | uniq -d)" = "" ]
}

@test "RUN_ALL_BATS_SHARD: ファイルより多いシャードは bats を起動せず exit 0" {
    write_ok_fixture "$FIXTURE/a.bats"

    RUN_ALL_BATS_SHARD=2/2 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Shard 2/2: 0 of 1 .bats file(s)"* ]]
    [[ "$output" != *"Summary:"* ]]
}

@test "RUN_ALL_BATS_SHARD が <i>/<n>（1 <= i <= n）でなければ exit 2" {
    write_ok_fixture "$FIXTURE/a.bats"

    for bad in 0/3 4/3 1/0 3 abc 1/3x; do
        RUN_ALL_BATS_SHARD="$bad" run bash "$FIXTURE/tests/run-all-bats.sh"
        [ "$status" -eq 2 ]
        [[ "$output" == *"RUN_ALL_BATS_SHARD must be <i>/<n>"* ]]
    done
}

# --- DEVFLOW_CHANGED_FILES による絞り込み ---
#
# fixture repo:
#   plugins/x/scripts/direct.bats  本文に direct.mjs を含む（ok）
#   plugins/x/scripts/other.bats   どの変更ファイル名も含まない（ok / leak は各テストで選ぶ）
#   plugins/x/bin/via-bin         via-bin.mjs を名前で呼ぶ shell 側ファイル
#   plugins/x/hooks/guard.sh       guide-ref.md を名前で読む shell 側ファイル

write_ref_fixture() {
    printf '# uses %s\n%stest "ok" { true; }\n' "$2" "$AT" > "$1"
}

setup_selection_repo() {
    mkdir -p "$FIXTURE/plugins/x/scripts" "$FIXTURE/plugins/x/bin" "$FIXTURE/plugins/x/hooks"
    write_ref_fixture "$FIXTURE/plugins/x/scripts/direct.bats" "direct.mjs"
    if [[ "${1:-ok}" == leak ]]; then
        write_leak_fixture "$FIXTURE/plugins/x/scripts/other.bats"
    else
        write_ok_fixture "$FIXTURE/plugins/x/scripts/other.bats"
    fi
    printf '#!/usr/bin/env bash\nexec node "$(dirname "$0")/../scripts/via-bin.mjs" "$@"\n' \
        > "$FIXTURE/plugins/x/bin/via-bin"
    printf '#!/usr/bin/env bash\ncat "$(dirname "$0")/guide-ref.md"\n' > "$FIXTURE/plugins/x/hooks/guard.sh"
    CHANGED="$BATS_TEST_TMPDIR/changed.txt"
}

write_changed() {
    printf '%s\n' "$@" > "$CHANGED"
}

assert_full_run() {
    [ "$status" -eq 0 ]
    [[ "$output" == *"[run-all-bats] Selection: all ("* ]]
    [[ "$output" == *"Discovered 2 .bats file(s)"* ]]
    [[ "$output" == *"Summary: 2 passed, 0 failed"* ]]
}

@test "selection: DEVFLOW_CHANGED_FILES 未設定なら全件" {
    setup_selection_repo

    run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (DEVFLOW_CHANGED_FILES is unset or empty)"* ]]
}

@test "selection: DEVFLOW_CHANGED_FILES が空文字なら全件" {
    setup_selection_repo

    DEVFLOW_CHANGED_FILES="" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (DEVFLOW_CHANGED_FILES is unset or empty)"* ]]
}

@test "selection: 読めないファイルなら全件" {
    setup_selection_repo

    DEVFLOW_CHANGED_FILES="$BATS_TEST_TMPDIR/missing.txt" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (DEVFLOW_CHANGED_FILES is not a readable file: "* ]]
}

@test "selection: 中身が 0 行（空・空行のみ）なら全件" {
    setup_selection_repo

    : > "$CHANGED"
    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"
    assert_full_run
    [[ "$output" == *"Selection: all (DEVFLOW_CHANGED_FILES lists 0 files)"* ]]

    printf '\n\n' > "$CHANGED"
    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"
    assert_full_run
    [[ "$output" == *"Selection: all (DEVFLOW_CHANGED_FILES lists 0 files)"* ]]
}

@test "selection: .sh を含むと全件（どのファイルのどの規則かを出す）" {
    setup_selection_repo leak
    write_changed "plugins/x/scripts/unref.mjs" "plugins/x/scripts/run.sh"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    # other.bats は leak なので、全件実行されたことは exit 1 と 1 failed で分かる
    [ "$status" -eq 1 ]
    [[ "$output" == *"Selection: all (plugins/x/scripts/run.sh: extension is not .mjs/.js/.md)"* ]]
    [[ "$output" == *"Summary: 1 passed, 1 failed"* ]]
}

@test "selection: .mjs/.js/.md 以外の拡張子（.bats/.json/.jsonl/拡張子なし）は全件" {
    setup_selection_repo

    for p in plugins/x/scripts/direct.bats plugins/x/data.json plugins/x/log.jsonl plugins/x/bin/via-bin; do
        write_changed "$p"
        DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"
        assert_full_run
        [[ "$output" == *"Selection: all ($p: extension is not .mjs/.js/.md)"* ]]
    done
}

@test "selection: fixtures/ 配下の .json は全件" {
    setup_selection_repo
    write_changed "plugins/x/scripts/fixtures/case.json"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (plugins/x/scripts/fixtures/case.json: under fixtures/)"* ]]
}

@test "selection: tests/ 配下は .mjs/.md でも全件" {
    setup_selection_repo
    write_changed "tests/helper.mjs"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (tests/helper.mjs: under tests/)"* ]]
}

@test "selection: shell 側（bin/・hooks/・*.sh）から basename で参照される .mjs/.md は全件" {
    setup_selection_repo
    write_changed "plugins/x/scripts/via-bin.mjs"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (plugins/x/scripts/via-bin.mjs: basename referenced by shell-side file plugins/x/bin/via-bin)"* ]]

    write_changed "plugins/x/hooks/guide-ref.md"
    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (plugins/x/hooks/guide-ref.md: basename referenced by shell-side file plugins/x/hooks/guard.sh)"* ]]
}

@test "selection: shell 側が # 始まりの行（行頭空白は無視）でだけ言及する basename は全件にせず bats で選ぶ" {
    setup_selection_repo leak
    printf '#!/usr/bin/env bash\n# see direct.mjs\n    # also direct.mjs\n\t# direct.mjs again\necho ok\n' \
        > "$FIXTURE/plugins/x/hooks/note.sh"
    write_changed "plugins/x/scripts/direct.mjs"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Selection: 1 of 2 .bats file(s)"* ]]
    [[ "$output" == *"=== Running: plugins/x/scripts/direct.bats ==="* ]]
    [[ "$output" != *"other.bats"* ]]
    [[ "$output" == *"Summary: 1 passed, 0 failed"* ]]
}

@test "selection: shell 側がコメント行に加えてコメントでない行でも言及する basename は全件" {
    setup_selection_repo
    printf '#!/usr/bin/env bash\n# runs direct.mjs\nnode "$(dirname "$0")/direct.mjs"\n' \
        > "$FIXTURE/plugins/x/hooks/run-direct.sh"
    write_changed "plugins/x/scripts/direct.mjs"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    assert_full_run
    [[ "$output" == *"Selection: all (plugins/x/scripts/direct.mjs: basename referenced by shell-side file plugins/x/hooks/run-direct.sh)"* ]]
}

@test "selection: どこからも参照されない .mjs と .md だけなら bats を起動せず exit 0" {
    setup_selection_repo leak
    write_changed "plugins/x/scripts/unref.mjs" "docs/guide.md"

    DEVFLOW_CHANGED_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Selection: 0 of 2 .bats file(s)"* ]]
    [ "$(echo "$output" | grep -c "Selection:")" -eq 1 ]
    [[ "$output" != *"=== Running:"* ]]
    [[ "$output" != *"Summary:"* ]]
}

@test "selection: bats が直接参照する .mjs はその bats だけを実行する" {
    setup_selection_repo leak
    write_changed "plugins/x/scripts/direct.mjs"

    DEVFLOW_CHANGED_FILES="$CHANGED" RUN_ALL_BATS_JOBS=2 run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Selection: 1 of 2 .bats file(s)"* ]]
    [[ "$output" == *"Selected 1 .bats file(s):"* ]]
    [[ "$output" == *"Running with 2 parallel job(s)."* ]]
    [[ "$output" == *"=== Running: plugins/x/scripts/direct.bats ==="* ]]
    [[ "$output" != *"other.bats"* ]]
    [[ "$output" == *"Summary: 1 passed, 0 failed"* ]]
}

# --- DEVFLOW_TEST_FILES による落ちたファイルだけの再実行（issue #865）---

@test "test files: 一覧の .bats だけを実行し、DEVFLOW_CHANGED_FILES より優先する" {
    setup_selection_repo leak
    write_changed "plugins/x/scripts/direct.bats" "plugins/x/scripts/a.test.mjs"
    : > "$BATS_TEST_TMPDIR/all-changed.txt"

    DEVFLOW_TEST_FILES="$CHANGED" DEVFLOW_CHANGED_FILES="$BATS_TEST_TMPDIR/all-changed.txt" run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Selection: 1 .bats file(s) listed in DEVFLOW_TEST_FILES"* ]]
    [[ "$output" == *"=== Running: plugins/x/scripts/direct.bats ==="* ]]
    [[ "$output" != *"other.bats"* ]]
    [[ "$output" == *"Summary: 1 passed, 0 failed"* ]]
}

@test "test files: 一覧の .bats が red なら exit 1" {
    setup_selection_repo leak
    write_changed "plugins/x/scripts/other.bats"

    DEVFLOW_TEST_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 1 ]
    [[ "$output" == *"Summary: 0 passed, 1 failed"* ]]
}

@test "test files: .bats が 1 件も無ければ bats を起動せず exit 0、読めない一覧は全件" {
    setup_selection_repo leak
    write_changed "plugins/x/scripts/a.test.mjs"

    DEVFLOW_TEST_FILES="$CHANGED" run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"Selection: 0 .bats file(s) listed in DEVFLOW_TEST_FILES"* ]]
    [[ "$output" != *"=== Running:"* ]]

    DEVFLOW_TEST_FILES="$BATS_TEST_TMPDIR/missing.txt" run bash "$FIXTURE/tests/run-all-bats.sh"

    [ "$status" -eq 1 ]
    [[ "$output" == *"Selection: all (DEVFLOW_TEST_FILES is not a readable file: "* ]]
    [[ "$output" == *"Discovered 2 .bats file(s)"* ]]
}
