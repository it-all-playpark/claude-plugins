#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/worktree-checkout.sh の worktree_switch（Claude Code が作った直後の worktree を作業ブランチへ
# 付け替える。git switch が失敗したら部分 checkout）と hooks_not_running_json（worktree で動かない追跡 hook の列挙）。
# prerun を通した部分 checkout は dev-flow/scripts/prerun.bats の (9e-f) が見る。
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
    INIT="$(git -C "$ROOT" rev-parse HEAD)"
}

# Claude Code が EnterWorktree({name}) で作った直後の worktree（branch worktree-<ディレクトリ名>）を、hook を追跡する前の
# commit から作る（取り出せないパスを含む commit からは Claude Code の代役の git worktree add 自体が失敗する）
enter_fresh_worktree() {
    git -C "$ROOT" worktree add -q -b worktree-df-1 "$WT" "$INIT"
}

# 作った直後の worktree を main 起点の feature/issue-1 へ付け替える
enter_and_switch() {
    enter_fresh_worktree
    worktree_switch "$WT" feature/issue-1 main
}

# sandbox が .husky を作れない状態を、失敗する required smudge filter で作る（prerun.bats の (9e) と同じ）
deny_husky_checkout() {
    echo '.husky/** filter=deny' >"$ROOT/.git/info/attributes"
    git -C "$ROOT" config filter.deny.smudge false
    git -C "$ROOT" config filter.deny.clean cat
    git -C "$ROOT" config filter.deny.required true
}

# ---- worktree_switch ----

@test "worktree_switch: branch が無ければ起点から track なしで作って付け替え、skip-worktree を付けない" {
    echo "later" >>"$ROOT/README.md"
    git -C "$ROOT" commit -q -am "later"
    enter_fresh_worktree

    worktree_switch "$WT" feature/issue-1 main
    [ "${#WT_SKIP_WORKTREE[@]}" -eq 0 ]
    [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "feature/issue-1" ]
    [ "$(git -C "$WT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse main)" ]
    [ "$(git -C "$ROOT" log -g --format=%gs refs/heads/feature/issue-1 -- | tail -n 1)" = "branch: Created from main" ]
    run git -C "$ROOT" config --get "branch.feature/issue-1.merge"
    [ "$status" -ne 0 ]
    [ -z "$(git -C "$WT" status --porcelain)" ]
}

@test "worktree_switch: local の既存 branch は作り直さず（起点を使わず）そのまま switch する" {
    git -C "$ROOT" branch -q feature/issue-1 "$INIT"
    echo "later" >>"$ROOT/README.md"
    git -C "$ROOT" commit -q -am "later"
    enter_fresh_worktree

    worktree_switch "$WT" feature/issue-1 main
    [ "${#WT_SKIP_WORKTREE[@]}" -eq 0 ]
    [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "feature/issue-1" ]
    [ "$(git -C "$WT" rev-parse HEAD)" = "$INIT" ]
}

@test "worktree_switch: 取り出せないパスを含む repo -> 部分 checkout で付け替え、取り出せないパスに skip-worktree を付けて status が空" {
    # 付け替え前の commit にだけあるファイルは作業ツリーに残さない
    git -C "$ROOT" mv README.md OLD.md
    echo "new" >"$ROOT/NEW.md"
    git -C "$ROOT" add NEW.md
    git -C "$ROOT" commit -q -m "rename"
    track_husky_hooks
    deny_husky_checkout
    enter_fresh_worktree
    [ -f "$WT/README.md" ]

    worktree_switch "$WT" feature/issue-1 main
    [ "$(printf '%s\n' "${WT_SKIP_WORKTREE[@]}" | sort | paste -sd ',' -)" = ".husky/commit-msg,.husky/helper.sh,.husky/pre-commit,.husky/pre-push" ]
    [ "$(skip_worktree_json | jq -c 'sort')" = '[".husky/commit-msg",".husky/helper.sh",".husky/pre-commit",".husky/pre-push"]' ]
    [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "feature/issue-1" ]
    [ "$(git -C "$WT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse main)" ]
    [ "$(git -C "$ROOT" log -g --format=%gs refs/heads/feature/issue-1 -- | tail -n 1)" = "branch: Created from main" ]
    [ -f "$WT/OLD.md" ] && [ -f "$WT/NEW.md" ]
    [ ! -e "$WT/README.md" ]
    [ ! -e "$WT/.husky/pre-commit" ]
    [ "$(git -C "$WT" ls-files -v | grep -c '^S')" -eq 4 ]
    [ -z "$(git -C "$WT" status --porcelain)" ]
    [ -z "$(git -C "$WT" add -A --dry-run)" ]
    [ -z "$(partial_checkout_error "$WT")" ]
}

# Claude Code は sandbox の外で full checkout するので、書けないパスは古い中身で作業ツリーに既にある。git は置き換えられない
# 既存ファイルで fatal にならないことがある（`unable to unlink old ...`）。そのときも同じ結果にする
@test "worktree_switch: 書けないディレクトリに古い中身で既にあるパス -> 付け替え、そのパスに skip-worktree を付けて status が空" {
    track_husky_hooks
    git -C "$ROOT" worktree add -q -b worktree-df-1 "$WT" HEAD
    echo "#!/bin/sh # v2" >"$ROOT/.husky/pre-commit"
    echo "later" >>"$ROOT/README.md"
    git -C "$ROOT" commit -q -am "change hook"
    chmod a-w "$WT/.husky"

    rc=0
    worktree_switch "$WT" feature/issue-1 main || rc=$?
    status_out="$(git -C "$WT" status --porcelain)"
    add_out="$(git -C "$WT" add -A --dry-run)"
    chmod u+w "$WT/.husky"

    [ "$rc" -eq 0 ] || { echo "WT_SWITCH_ERR: $WT_SWITCH_ERR" >&2; return 1; }
    [ "$(skip_worktree_json)" = '[".husky/pre-commit"]' ]
    [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "feature/issue-1" ]
    [ "$(git -C "$WT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse main)" ]
    [ "$(cat "$WT/README.md")" = "$(cat "$ROOT/README.md")" ]
    [ -z "$status_out" ]
    [ -z "$add_out" ]
}

@test "worktree_switch: branch が別の worktree で checkout 済み -> 部分 checkout にせず git switch のエラーを返し、HEAD を動かさない" {
    track_husky_hooks
    deny_husky_checkout
    git -C "$ROOT" branch -q feature/issue-1 "$INIT"
    git -C "$ROOT" worktree add -q "$BATS_TEST_TMPDIR/wt/other" feature/issue-1
    enter_fresh_worktree

    run worktree_switch "$WT" feature/issue-1 main
    [ "$status" -eq 1 ]
    worktree_switch "$WT" feature/issue-1 main || true
    [[ "$WT_SWITCH_ERR" == *"feature/issue-1"* ]]
    [ "${#WT_SKIP_WORKTREE[@]}" -eq 0 ]
    [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "worktree-df-1" ]
    [ -z "$(git -C "$WT" status --porcelain)" ]
}

# ---- hooks_not_running_json ----

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
    deny_husky_checkout

    enter_and_switch
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

    enter_and_switch
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

    enter_and_switch

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '[]' ]
}

@test "絶対パスの hooksPath でも解決先に無い event だけを列挙する" {
    track_husky_hooks
    generate_husky_dir pre-commit
    git -C "$ROOT" config core.hooksPath "$ROOT/.husky/_"

    enter_and_switch

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '["commit-msg","pre-push"]' ]
}

@test "hook を追跡しない repo: core.hooksPath が解決できなくても []" {
    git -C "$ROOT" config core.hooksPath .husky/_

    enter_and_switch

    run hooks_not_running_json "$WT"
    [ "$status" -eq 0 ]
    [ "$output" = '[]' ]
}
