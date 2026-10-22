#!/usr/bin/env bats
# Tests for _shared/scripts/worktree-teardown.sh
#
# Strategy: 各テストは $BATS_TEST_TMPDIR 配下に隔離した tmp git repo + worktree
# fixture を作る。fixture repo は tracked な README.md を commit 済みとし、
# remove-blocked ケースは README.md の modify で発火させる。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/worktree-teardown.sh"
}

make_repo() {
    # $1 = repo path
    local repo="$1"
    git init -q "$repo"
    git -C "$repo" config user.email t@t
    git -C "$repo" config user.name t
    printf '# readme\n' > "$repo/README.md"
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
}

# ---------------------------------------------------------------------------
# 正常系 — teardown 成功、worktree 消滅
# ---------------------------------------------------------------------------
@test "clean worktree is removed" {
    REPO="$BATS_TEST_TMPDIR/repo1"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt1"
    git -C "$REPO" worktree add -q "$WT" -b wt1-branch

    run bash "$SCRIPT" "$WT"
    [ "$status" -eq 0 ]
    [ ! -d "$WT" ]
}

# ---------------------------------------------------------------------------
# remove-blocked 系 — tracked ファイル(README.md)を modify すると
#          git worktree remove が fail し、その exit code をそのまま返す
# ---------------------------------------------------------------------------
@test "remove blocked by modified tracked file propagates git exit code" {
    REPO="$BATS_TEST_TMPDIR/repo2"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt2"
    git -C "$REPO" worktree add -q "$WT" -b wt2-branch

    # tracked file modify -> blocks git worktree remove
    printf 'modified\n' >> "$WT/README.md"

    run bash "$SCRIPT" "$WT"
    teardown_status="$status"
    [ "$teardown_status" -ne 0 ]
    [ -d "$WT" ]
    printf '%s\n' "$output" | grep -q -- '--force で再実行可能'

    run git -C "$REPO" worktree remove "$WT"
    [ "$status" -ne 0 ]
    [ "$teardown_status" -eq "$status" ]

    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# --force — modified file があっても git worktree remove --force で削除される
# ---------------------------------------------------------------------------
@test "--force removes worktree with modified tracked file" {
    REPO="$BATS_TEST_TMPDIR/repo3"
    make_repo "$REPO"

    WT="$BATS_TEST_TMPDIR/wt3"
    git -C "$REPO" worktree add -q "$WT" -b wt3-branch

    printf 'modified\n' >> "$WT/README.md"

    run bash "$SCRIPT" "$WT" --force
    [ "$status" -eq 0 ]
    [ ! -d "$WT" ]
}

# ---------------------------------------------------------------------------
# 非 worktree パス -> exit 2
# ---------------------------------------------------------------------------
@test "non-worktree path -> error exit 2" {
    NOTWT="$BATS_TEST_TMPDIR/notwt"
    mkdir -p "$NOTWT"
    run bash "$SCRIPT" "$NOTWT"
    [ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# 引数不足 -> usage を stderr に出し exit 2
# ---------------------------------------------------------------------------
@test "missing arguments -> usage on stderr, exit 2" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
}
