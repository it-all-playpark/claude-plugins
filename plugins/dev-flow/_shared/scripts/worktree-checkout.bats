#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/worktree-checkout.sh の hooks_not_running_json（worktree で動かない追跡 hook の列挙）。
# worktree_add の部分 checkout そのものは dev-flow/scripts/prerun.bats の (9e-f) が見る。
# fixture は husky の形: 追跡するのは .husky/<event> で、core.hooksPath の先の生成物 .husky/_ はメイン checkout にだけある。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/worktree-checkout.sh"

setup() {
    # shellcheck source=worktree-checkout.sh
    source "$SCRIPT"
    ROOT="$BATS_TEST_TMPDIR/root"
    WT="$BATS_TEST_TMPDIR/wt/df-1"
    git init -q -b main "$ROOT"
    git -C "$ROOT" config user.name "Test"
    git -C "$ROOT" config user.email "test@example.com"
    echo "# seed" >"$ROOT/README.md"
    git -C "$ROOT" add README.md
    git -C "$ROOT" commit -q -m "init"
}

track_husky_hooks() {
    mkdir -p "$ROOT/.husky"
    for event in pre-commit commit-msg pre-push; do
        echo "#!/bin/sh" >"$ROOT/.husky/$event"
    done
    # 追跡していても hook 名でないファイルは数えない
    echo "#!/bin/sh" >"$ROOT/.husky/helper.sh"
    git -C "$ROOT" add .husky
    git -C "$ROOT" commit -q -m "track husky hooks"
}

# メイン checkout にだけ生成物を置く（husky の prepare が書くもの。追跡しない）
generate_husky_dir() {
    mkdir -p "$ROOT/.husky/_"
    echo "*" >"$ROOT/.husky/_/.gitignore"
    for event in "$@"; do
        printf '#!/bin/sh\nexit 0\n' >"$ROOT/.husky/_/$event"
        chmod +x "$ROOT/.husky/_/$event"
    done
}

@test "相対の hooksPath + skip-worktree: 追跡する pre-commit / commit-msg / pre-push を列挙する" {
    track_husky_hooks
    generate_husky_dir pre-commit commit-msg pre-push
    git -C "$ROOT" config core.hooksPath .husky/_
    # sandbox が .husky を作れない状態を、失敗する required smudge filter で作る（prerun.bats の (9e) と同じ）
    echo '.husky/** filter=deny' >"$ROOT/.git/info/attributes"
    git -C "$ROOT" config filter.deny.smudge false
    git -C "$ROOT" config filter.deny.clean cat
    git -C "$ROOT" config filter.deny.required true

    worktree_add "$ROOT" "$WT" feature/issue-1 main
    [ "${#WT_SKIP_WORKTREE[@]}" -eq 4 ]
    [ ! -e "$WT/.husky/pre-commit" ]

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '["pre-commit","commit-msg","pre-push"]' ]
}

@test "相対の hooksPath + hook は取り出せたが .husky/_ が無い: 追跡する pre-commit / commit-msg / pre-push を列挙する" {
    track_husky_hooks
    generate_husky_dir pre-commit commit-msg pre-push
    git -C "$ROOT" config core.hooksPath .husky/_

    worktree_add "$ROOT" "$WT" feature/issue-1 main
    [ "${#WT_SKIP_WORKTREE[@]}" -eq 0 ]
    [ -f "$WT/.husky/pre-commit" ]
    [ ! -e "$WT/.husky/_" ]

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '["pre-commit","commit-msg","pre-push"]' ]
}

@test "解決先が存在する絶対パスの hooksPath: []" {
    track_husky_hooks
    generate_husky_dir pre-commit commit-msg pre-push
    git -C "$ROOT" config core.hooksPath "$ROOT/.husky/_"

    worktree_add "$ROOT" "$WT" feature/issue-1 main

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '[]' ]
}

@test "絶対パスの hooksPath でも解決先に無い event だけを列挙する" {
    track_husky_hooks
    generate_husky_dir pre-commit
    git -C "$ROOT" config core.hooksPath "$ROOT/.husky/_"

    worktree_add "$ROOT" "$WT" feature/issue-1 main

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '["commit-msg","pre-push"]' ]
}

@test "hook を追跡しない repo: core.hooksPath が解決できなくても []" {
    git -C "$ROOT" config core.hooksPath .husky/_

    worktree_add "$ROOT" "$WT" feature/issue-1 main

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '[]' ]
}
