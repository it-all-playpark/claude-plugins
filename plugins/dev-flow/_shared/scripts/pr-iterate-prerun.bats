#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/pr-iterate-prerun.sh (issue #828)
#
# pr-iterate-prerun は /pr-iterate 単体起動の isolation preflight（gh pr view → fetch → PR head 一致検証 →
# worktree 作成/再利用 → HEAD 合わせ → 書き込み probe → 書けない場合の repo 外退避）を 1 コマンドで行う。
# fixture は bare origin（main + PR head の feature/x）+ clone した ROOT。gh は stub する。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pr-iterate-prerun.sh"

setup() {
    ORIGIN="$BATS_TEST_TMPDIR/origin.git"
    git init --bare -q "$ORIGIN"

    SEED="$BATS_TEST_TMPDIR/seed"
    git init -q -b main "$SEED"
    git -C "$SEED" config user.name "Test"
    git -C "$SEED" config user.email "test@example.com"
    echo "# seed" > "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "init"
    git -C "$SEED" checkout -q -b feature/x
    echo "pr" >> "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "pr commit"
    git -C "$SEED" remote add origin "$ORIGIN"
    git -C "$SEED" push -q origin main feature/x
    git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

    ROOT="$BATS_TEST_TMPDIR/root"
    git clone -q "$ORIGIN" "$ROOT"
    git -C "$ROOT" config user.name "Test"
    git -C "$ROOT" config user.email "test@example.com"
    # git worktree list --porcelain は物理パスを返す（macOS の /var → /private/var）
    ROOT_P="$(cd "$ROOT" && pwd -P)"
    HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"

    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
if [[ -n "${GH_STUB_FAIL:-}" ]]; then
    echo "gh stub: HTTP 404" >&2
    exit 1
fi
# gh run list（CI 待ちの上限）は GH_RUN_STUB_FIXTURE 未設定なら失敗（上限は既定の 300）
if [[ "$1" == "run" ]]; then
    [[ -n "${GH_RUN_STUB_FIXTURE:-}" ]] || { echo "gh stub: no run fixture" >&2; exit 1; }
    cat "$GH_RUN_STUB_FIXTURE"
    exit 0
fi
cat "$GH_STUB_FIXTURE"
STUB
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
    export GH_STUB_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GH_STUB_FIXTURE="$BATS_TEST_TMPDIR/pr.json"
    unset GH_STUB_FAIL GH_RUN_STUB_FIXTURE
    write_pr_fixture "$HEAD_SHA"
    # user 設定（"dev-flow".security_reviewer の読み先）を実行者の環境から切り離す
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    unset SKILL_CONFIG_PATH
}

# 第 1 引数の branch（main / feature/x）に第 2 引数のパスで "dev-flow".security_reviewer = 第 3 引数 の skill-config.json を commit して push する
commit_reviewer_config() {
    git -C "$SEED" checkout -q "$1"
    mkdir -p "$(dirname "$SEED/$2")"
    jq -n --arg r "$3" '{"dev-flow": {security_reviewer: $r}}' > "$SEED/$2"
    git -C "$SEED" add "$2"
    git -C "$SEED" commit -q -m "reviewer config"
    git -C "$SEED" push -q origin "$1"
    if [[ "$1" == "feature/x" ]]; then
        HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"
        write_pr_fixture "$HEAD_SHA"
    fi
}

# 第 1 引数のパス（HOME 相対）に "dev-flow".security_reviewer = 第 2 引数 の user 設定を書く
write_user_reviewer_config() {
    mkdir -p "$(dirname "$HOME/$1")"
    jq -n --arg r "$2" '{"dev-flow": {security_reviewer: $r}}' > "$HOME/$1"
}

# 第 2 引数: PR コメント（gh pr view --json comments の配列）。省略時は []
write_pr_fixture() {
    jq -n --arg oid "$1" --argjson comments "${2:-[]}" \
        '{url: "https://github.com/acme/skills/pull/5", headRefName: "feature/x", baseRefName: "main", headRefOid: $oid, comments: $comments}' \
        >"$GH_STUB_FIXTURE"
}

# origin の feature/x を 1 commit 進め、PR head（fixture）もそれに合わせる
advance_origin_head() {
    git -C "$SEED" checkout -q feature/x
    echo "more" >> "$SEED/README.md"
    git -C "$SEED" commit -q -am "advance"
    git -C "$SEED" push -q origin feature/x
    HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"
    write_pr_fixture "$HEAD_SHA"
}

# ---- (1) 新規作成 ----

@test "(1) worktree が無い -> origin の head から既定候補 .claude/worktrees/pr-<N> に作成し JSON 1 行を出す" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "created" and .worktree_removed == false'
    echo "$output" | jq -e --arg wt "$ROOT_P/.claude/worktrees/pr-5" '.worktree == $wt'
    echo "$output" | jq -e '.head_ref == "feature/x" and .base_ref == "main" and .repo == "acme/skills" and .pr == 5'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    echo "$output" | jq -e '(.epoch | type) == "number" and (.epoch == (.epoch | floor))'
    echo "$output" | jq -e 'has("error") == false'
    wt="$(echo "$output" | jq -r '.worktree')"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$HEAD_SHA" ]
    [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "feature/x" ]
    grep -qx "pr view 5 --json url,headRefName,baseRefName,headRefOid,comments,title,body" "$GH_STUB_LOG"
    # 書けないパスが無ければ full checkout で、skip-worktree を付けない
    echo "$output" | jq -e '.skip_worktree == []'
    [ -z "$(git -C "$wt" ls-files -v | grep '^S' || true)" ]
}

# sandbox 内からは起動元 repo の .git/config を書けない。config.lock で config の書き込みを全て失敗させても
# worktree を作れること（upstream を書かない）を確かめる。
@test "(1c) .git/config に書けなくても worktree を作り、upstream を書かない" {
    : >"$ROOT/.git/config.lock"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created"'
    wt="$(echo "$output" | jq -r '.worktree')"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$HEAD_SHA" ]
    run git -C "$ROOT" config --get "branch.feature/x.merge"
    [ "$status" -ne 0 ]
}

@test "(1b) --repo を gh pr view に渡し、出力の repo はその値" {
    cd "$ROOT"
    run bash "$SCRIPT" 5 --repo other/name
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .repo == "other/name"'
    grep -qx "pr view 5 --repo other/name --json url,headRefName,baseRefName,headRefOid,comments,title,body" "$GH_STUB_LOG"
}

# ---- (2) 再利用 ----

@test "(2) head branch を checkout 済みの worktree（dev-flow の df-<N> 等）があれば候補パスより優先して再利用する" {
    cd "$ROOT"
    DF="$BATS_TEST_TMPDIR/wt/df-1"
    git worktree add -q --no-track -b feature/x "$DF" origin/feature/x
    DF_P="$(cd "$DF" && pwd -P)"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    echo "$output" | jq -e --arg wt "$DF_P" '.worktree == $wt'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
}

# basename が git / git-* の worktree は exec-proxy の operand に載ると worktree 分離ガードに拒否される（issue #1158）
@test "(2e) head branch を checkout 済みの再利用 worktree の basename が git- で始まる -> ok:false、パス・原因・直し方を返し worktree を動かさない" {
    cd "$ROOT"
    GW="$BATS_TEST_TMPDIR/wt/git-issue-x"
    git worktree add -q --no-track -b feature/x "$GW" origin/feature/x
    GW_P="$(cd "$GW" && pwd -P)"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "reused"'
    echo "$output" | jq -e --arg wt "$GW_P" '.worktree == $wt and (.error | contains($wt))'
    echo "$output" | jq -e '.error | test("worktree 分離ガード") and test("exec-proxy") and test("git worktree move") and test("checkout を外して")'
    [ -d "$GW" ]
    [ "$(git -C "$GW" rev-parse --abbrev-ref HEAD)" = "feature/x" ]
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
}

@test "(2f) 再利用 worktree の basename が git そのもの -> ok:false" {
    cd "$ROOT"
    GW="$BATS_TEST_TMPDIR/wt/git"
    git worktree add -q --no-track -b feature/x "$GW" origin/feature/x
    GW_P="$(cd "$GW" && pwd -P)"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg wt "$GW_P" '.ok == false and .worktree == $wt and (.error | test("worktree 分離ガード"))'
    [ -d "$GW" ]
}

@test "(2g) git- で始まらない名前（pr-1157 / df-1157 / github-x）の再利用 worktree は ok:true・reused" {
    cd "$ROOT"
    for name in pr-1157 df-1157 github-x; do
        WT_DIR="$BATS_TEST_TMPDIR/wt-$name/$name"
        git worktree add -q --no-track -b feature/x "$WT_DIR" origin/feature/x
        WT_DIR_P="$(cd "$WT_DIR" && pwd -P)"
        run bash "$SCRIPT" 5
        [ "$status" -eq 0 ]
        echo "$output" | jq -e --arg wt "$WT_DIR_P" '.ok == true and .worktree_status == "reused" and .worktree == $wt'
        git worktree remove --force "$WT_DIR"
        git branch -q -D feature/x
    done
}

@test "(2b) 同じ PR で 2 回目 -> 1 回目に作った worktree を reused で返し、epoch は新しく採る" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    first_wt="$(echo "$output" | jq -r '.worktree')"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    echo "$output" | jq -e --arg wt "$first_wt" '.worktree == $wt'
}

@test "(2c) 再利用 worktree が PR head より遅れていて未コミット変更なし -> PR head へ fast-forward する" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    wt="$(echo "$output" | jq -r '.worktree')"
    advance_origin_head

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    [ "$(git -C "$wt" rev-parse HEAD)" = "$HEAD_SHA" ]
}

@test "(2d) 前 run の isolation probe 残置物だけを除去し、.devflow-tmp の他のファイルは残す" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    mkdir -p "$wt/.devflow-tmp"
    echo ok > "$wt/.devflow-tmp/.isolation-probe-111"
    echo body > "$wt/.devflow-tmp/pr-body.md"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    [ ! -e "$wt/.devflow-tmp/.isolation-probe-111" ]
    [ -f "$wt/.devflow-tmp/pr-body.md" ]
}

# ---- (2h) fix の commit に scratch を入れない（issue #1178） ----
# fixture の repo は .gitignore に .devflow-tmp/ を持たない。prerun が worktree 共有の info/exclude に足すので、
# pr-fixer の stage（git add -A 等）と commit-ensure の stage（git add --ignore-removal .）・status が scratch を拾わない。
# info/exclude への追記の形（1 行・2 回目は足さない・ignore 済みなら書かない）は dev-flow/scripts/prerun.bats (5b) が見る。

@test "(2h) .devflow-tmp/ を ignore しない repo -> fix の stage・status に .devflow-tmp/ 配下が載らず、fix の新規ファイルは載る" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    wt="$(echo "$output" | jq -r '.worktree')"
    [ ! -e "$wt/.gitignore" ]
    mkdir -p "$wt/.devflow-tmp"
    for f in prerun-setup.json commit-msg.txt pr-body.md .isolation-probe-222; do echo scratch > "$wt/.devflow-tmp/$f"; done
    echo fix > "$wt/fix.txt"

    [ "$(git -C "$wt" status --porcelain)" = "?? fix.txt" ]
    git -C "$wt" add --ignore-removal .
    [ "$(git -C "$wt" diff --cached --name-only)" = "fix.txt" ]
    git -C "$wt" add -A
    [ "$(git -C "$wt" diff --cached --name-only)" = "fix.txt" ]
}

# ---- (3) head の不一致 ----

@test "(3) origin の head が PR の headRefOid と一致しない -> ok:false、worktree を作らない" {
    write_pr_fixture "0123456789abcdef0123456789abcdef01234567"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | test("PR head 不一致")'
    echo "$output" | jq -e '.worktree == null'
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
}

@test "(3b) 再利用 worktree に PR head に無い未 push のコミット -> ok:false、HEAD を動かさない" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    echo "local" >> "$wt/README.md"
    git -C "$wt" commit -q -am "local only"
    local_head="$(git -C "$wt" rev-parse HEAD)"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "reused"'
    echo "$output" | jq -e '.error | test("PR head（.*）に無いコミット")'
    [ "$(git -C "$wt" rev-parse HEAD)" = "$local_head" ]
}

@test "(3c) 再利用 worktree が遅れていて未コミット変更あり -> ok:false、fast-forward しない" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    old_head="$(git -C "$wt" rev-parse HEAD)"
    echo "wip" > "$wt/wip.txt"
    advance_origin_head

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | test("未コミット変更")'
    [ "$(git -C "$wt" rev-parse HEAD)" = "$old_head" ]
}

@test "(3d) PR head と一致する再利用 worktree の未コミット変更は残したまま ok:true（fix_failed 回収）" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    # 1 回目が失敗すると wt が空になり wip.txt を / に書く別の失敗に化けるので、ここで原因を出して止める
    [ "$status" -eq 0 ] || { echo "1 回目の prerun が失敗: $output" >&2; return 1; }
    echo "$output" | jq -e '.ok == true' >/dev/null || { echo "1 回目の prerun が ok:false: $output" >&2; return 1; }
    wt="$(echo "$output" | jq -r '.worktree')"
    echo "wip" > "$wt/wip.txt"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    [ -f "$wt/wip.txt" ]
}

@test "(3e) origin に head branch が無い（fork の PR 等） -> ok:false" {
    jq -n '{url: "https://github.com/acme/skills/pull/5", headRefName: "fork-only", baseRefName: "main", headRefOid: "0123456789abcdef0123456789abcdef01234567"}' >"$GH_STUB_FIXTURE"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .head_ref == "fork-only"'
    echo "$output" | jq -e '.error | test("origin に PR の head branch fork-only が無い")'
}

# ---- (4) 書き込めない場合の退避 ----

@test "(4) 既定候補に作った worktree が書けない -> remove して repo 外 <repo>-wt/pr-<N> に作り直す" {
    # post-checkout hook で repo 内 worktree の .devflow-tmp だけを書き込み不可にする（skills repo の EPERM の再現）
    HOOKS="$BATS_TEST_TMPDIR/hooks"
    mkdir -p "$HOOKS"
    cat >"$HOOKS/post-checkout" <<'HOOK'
#!/usr/bin/env bash
case "$PWD" in
    */.claude/worktrees/*) mkdir -p .devflow-tmp && chmod a-w .devflow-tmp ;;
esac
HOOK
    chmod +x "$HOOKS/post-checkout"
    git -C "$ROOT" config core.hooksPath "$HOOKS"

    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created" and .worktree_removed == true'
    echo "$output" | jq -e --arg wt "$ROOT_P-wt/pr-5" '.worktree == $wt'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
    [ "$(git -C "$ROOT_P-wt/pr-5" rev-parse HEAD)" = "$HEAD_SHA" ]
    run git -C "$ROOT" worktree list --porcelain
    [[ "$output" != *"/.claude/worktrees/pr-5"* ]]
}

@test "(4b) 再利用 worktree が書けない -> 退避せず ok:false、worktree_status=unwritable、worktree_removed=false" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    rm -rf "$wt/.devflow-tmp"
    chmod a-w "$wt"

    run bash "$SCRIPT" 5
    status_after="$status"
    output_after="$output"
    chmod u+w "$wt"

    [ "$status_after" -eq 0 ]
    echo "$output_after" | jq -e '.ok == false and .worktree_status == "unwritable" and .worktree_removed == false'
    echo "$output_after" | jq -e '.error | ascii_downcase | test("permission|not permitted")'
    echo "$output_after" | jq -e '.error | test("git worktree remove")'
    [ ! -e "$ROOT/../root-wt/pr-5" ]
}

@test "(4c) 既定候補が存在すれば（repo 外候補より）それを使う — 未登録ディレクトリなら ok:false" {
    mkdir -p "$ROOT/.claude/worktrees/pr-5"
    mkdir -p "$ROOT-wt/pr-5"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "error"'
    echo "$output" | jq -e --arg wt "$ROOT_P/.claude/worktrees/pr-5" '.worktree == $wt'
    echo "$output" | jq -e '.error | test("not a registered git worktree")'
}

@test "(4d) 既定候補が無く repo 外候補が存在すればそれを使う" {
    mkdir -p "$ROOT-wt/pr-5"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg wt "$ROOT_P-wt/pr-5" '.worktree == $wt'
}

# ---- (5) その他の fail-closed ----

@test "(5a) gh pr view が失敗 -> ok:false、error に gh の出力" {
    export GH_STUB_FAIL=1
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "skipped"'
    echo "$output" | jq -e '.error | test("HTTP 404")'
}

@test "(5b) head branch が main checkout で checkout 済み -> ok:false（main checkout を worktree として返さない）" {
    cd "$ROOT"
    git checkout -q -b feature/x origin/feature/x
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | test("main checkout")'
}

@test "(5c) 引数不正 -> exit 2、stdout 空" {
    cd "$ROOT"
    run --separate-stderr bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" abc
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" 5 --repo 'not a repo'
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" 5 --unknown
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

# ---- 書けないパスを追跡する repo（issue #875） ----
# sandbox は `.githooks` の作成を EPERM で拒み、git は full checkout を fatal で中断して作りかけの worktree を片付ける。
# テストでは同じ「git が .githooks 配下を取り出せない」状態を、失敗する required smudge filter で作る
# （attributes は .git/info に置くので全 worktree に効き、main checkout の main には .githooks が無い）。
track_unwritable_githooks() {
    git -C "$SEED" checkout -q feature/x
    mkdir -p "$SEED/.githooks"
    echo "#!/bin/sh" > "$SEED/.githooks/pre-commit"
    echo "#!/bin/sh" > "$SEED/.githooks/pre-push"
    git -C "$SEED" add .githooks
    git -C "$SEED" commit -q -m "track githooks"
    git -C "$SEED" push -q origin feature/x
    HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"
    write_pr_fixture "$HEAD_SHA"
    echo '.githooks/** filter=deny' >"$ROOT/.git/info/attributes"
    git -C "$ROOT" config filter.deny.smudge false
    git -C "$ROOT" config filter.deny.clean cat
    git -C "$ROOT" config filter.deny.required true
}

@test "(5d) .githooks を取り出せない repo -> ok:true で作成し、取り出せないパスに skip-worktree を付けて status が空" {
    track_unwritable_githooks
    cd "$ROOT"
    run git worktree add -q --detach "$BATS_TEST_TMPDIR/full" "$HEAD_SHA"
    [ "$status" -ne 0 ]

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created" and .worktree_removed == false'
    echo "$output" | jq -e '.skip_worktree == [".githooks/pre-commit", ".githooks/pre-push"]'
    wt="$(echo "$output" | jq -r '.worktree')"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$HEAD_SHA" ]
    [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "feature/x" ]
    [ -f "$wt/README.md" ]
    [ -z "$(git -C "$wt" status --porcelain)" ]
    [ -z "$(git -C "$wt" add -A --dry-run)" ]

    # 作り直した worktree の再利用は ok:true（skip-worktree のパスは未ステージの削除に数えない）
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused" and .skip_worktree == []'
}

@test "(5e) 部分 checkout の worktree を再利用 -> ok:false、worktree を書き換えない" {
    cd "$ROOT"
    PART="$BATS_TEST_TMPDIR/wt/partial"
    git worktree add -q --no-checkout --no-track -b feature/x "$PART" origin/feature/x
    git -C "$PART" read-tree HEAD

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "reused"'
    echo "$output" | jq -e '.error | test("未ステージの削除が 1 件") and test("README.md") and test("git worktree remove")'
    [ "$(git -C "$PART" status --porcelain --untracked-files=no)" = " D README.md" ]
    [ -z "$(git -C "$PART" ls-files -v | grep '^S' || true)" ]
}

# ---- 直前の dev-flow サマリー（prior_devflow。issue #930） ----

comment_json() {
    jq -n --arg body "$1" --arg url "$2" '{author: {login: "bot"}, body: $body, url: $url}'
}

@test "(5f) dev-flow marker を持つ最後のコメントから prior_devflow {tier, codes, url, head_sha} を出し、gh pr view は 1 回だけ" {
    local hold_old hold_new iterate comments
    hold_old="$(comment_json $'## dev-flow\n<!-- gate_policy: llm-major-advisory -->\n<!-- dev-flow:HOLD codes=escalate -->' "https://github.com/acme/skills/pull/5#issuecomment-1")"
    # AC の引用で本文中に marker と同じ形の文字列があっても、末尾の marker を採る
    hold_new="$(comment_json $'AC: `<!-- dev-flow:HOLD codes=escalate -->`\n---\n<!-- dev-flow:HOLD codes=iterate_non_lgtm,ci_checks_failed -->' "https://github.com/acme/skills/pull/5#issuecomment-2")"
    iterate="$(comment_json $'## PR #5 — pr-iterate 終了レポート\n<!-- pr-iterate:lgtm:1 -->' "https://github.com/acme/skills/pull/5#issuecomment-3")"
    comments="$(jq -cn --argjson a "$hold_old" --argjson b "$hold_new" --argjson c "$iterate" '[$a, $b, $c]')"
    write_pr_fixture "$HEAD_SHA" "$comments"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.prior_devflow == {tier: "HOLD", codes: ["iterate_non_lgtm", "ci_checks_failed"], url: "https://github.com/acme/skills/pull/5#issuecomment-2", head_sha: null}'
    [ "$(grep -c '^pr ' "$GH_STUB_LOG")" -eq 1 ]
    grep -qx "pr view 5 --json url,headRefName,baseRefName,headRefOid,comments,title,body" "$GH_STUB_LOG"
}

@test "(5g) HOLD 以外の marker は codes:[]、後に載った dev-flow サマリーを採る" {
    local hold review comments
    hold="$(comment_json '<!-- dev-flow:HOLD codes=ac_human_pending -->' "https://github.com/acme/skills/pull/5#issuecomment-1")"
    review="$(comment_json $'回収後・最新\n<!-- dev-flow:REVIEW -->' "https://github.com/acme/skills/pull/5#issuecomment-2")"
    comments="$(jq -cn --argjson a "$hold" --argjson b "$review" '[$a, $b]')"
    write_pr_fixture "$HEAD_SHA" "$comments"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.prior_devflow == {tier: "REVIEW", codes: [], url: "https://github.com/acme/skills/pull/5#issuecomment-2", head_sha: null}'
}

@test "(5h) dev-flow marker を持つコメントが無ければ prior_devflow は null" {
    write_pr_fixture "$HEAD_SHA" "[$(comment_json $'## PR #5 — pr-iterate 終了レポート\n<!-- pr-iterate:lgtm:1 -->' "https://github.com/acme/skills/pull/5#issuecomment-1")]"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and has("prior_devflow") and .prior_devflow == null'
}

@test "(5h2) dev-flow marker の head を prior_devflow.head_sha に載せ、tier / codes も読む" {
    local hold_head="0123456789abcdef0123456789abcdef01234567"
    write_pr_fixture "$HEAD_SHA" "[$(comment_json "<!-- dev-flow:HOLD codes=escalate,final_test_red head=${hold_head} -->" "https://github.com/acme/skills/pull/5#issuecomment-1")]"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg h "$hold_head" '.prior_devflow == {tier: "HOLD", codes: ["escalate", "final_test_red"], url: "https://github.com/acme/skills/pull/5#issuecomment-1", head_sha: $h}'
}

# ---- 最後の終端サマリーの head と今の PR head の食い違い（prior_summary。issue #1065） ----

@test "(5h3) 最後の終端サマリーの head が今の PR head と違えば prior_summary.head_mismatch は true" {
    local old_head="0123456789abcdef0123456789abcdef01234567" devflow iterate comments
    devflow="$(comment_json "<!-- dev-flow:REVIEW head=${HEAD_SHA} -->" "https://github.com/acme/skills/pull/5#issuecomment-1")"
    # 本文中に引用された marker ではなく、最後のコメントの末尾の marker を採る
    iterate="$(comment_json $'引用: `<!-- pr-iterate:stuck:2 -->`\n---\n'"<!-- pr-iterate:lgtm:1 head=${old_head} -->" "https://github.com/acme/skills/pull/5#issuecomment-2")"
    comments="$(jq -cn --argjson a "$devflow" --argjson b "$iterate" '[$a, $b]')"
    write_pr_fixture "$HEAD_SHA" "$comments"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg old "$old_head" '.ok == true and .prior_summary == {source: "pr-iterate", url: "https://github.com/acme/skills/pull/5#issuecomment-2", head_sha: $old, head_mismatch: true}'
}

@test "(5h4) 最後の終端サマリーの head が今の PR head と一致すれば head_mismatch は false" {
    local iterate devflow comments
    iterate="$(comment_json "<!-- pr-iterate:lgtm:1 head=0123456789abcdef0123456789abcdef01234567 -->" "https://github.com/acme/skills/pull/5#issuecomment-1")"
    devflow="$(comment_json "<!-- gate_policy: llm-major-advisory -->"$'\n'"<!-- dev-flow:HOLD codes=escalate head=${HEAD_SHA} -->" "https://github.com/acme/skills/pull/5#issuecomment-2")"
    comments="$(jq -cn --argjson a "$iterate" --argjson b "$devflow" '[$a, $b]')"
    write_pr_fixture "$HEAD_SHA" "$comments"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg head "$HEAD_SHA" '.prior_summary == {source: "dev-flow", url: "https://github.com/acme/skills/pull/5#issuecomment-2", head_sha: $head, head_mismatch: false}'
}

@test "(5h5) marker に head が無い終端サマリーは head_sha:null・head_mismatch:true" {
    write_pr_fixture "$HEAD_SHA" "[$(comment_json $'## PR #5 — pr-iterate 終了レポート\n<!-- pr-iterate:lgtm:1 -->' "https://github.com/acme/skills/pull/5#issuecomment-1")]"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.prior_summary == {source: "pr-iterate", url: "https://github.com/acme/skills/pull/5#issuecomment-1", head_sha: null, head_mismatch: true}'

    write_pr_fixture "$HEAD_SHA" "[$(comment_json '<!-- dev-flow:AUTO -->' "https://github.com/acme/skills/pull/5#issuecomment-2")]"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.prior_summary == {source: "dev-flow", url: "https://github.com/acme/skills/pull/5#issuecomment-2", head_sha: null, head_mismatch: true}'
}

@test "(5h6) 終端サマリーの marker を持つコメントが無ければ prior_summary は null" {
    write_pr_fixture "$HEAD_SHA" "[$(comment_json 'LGTM っぽい人のコメント' "https://github.com/acme/skills/pull/5#issuecomment-1")]"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and has("prior_summary") and .prior_summary == null'
}

# ---- CI 待ちの上限（ci_wait_ceiling_seconds。issue #1046） ----
# 上限の求め方（p90 + 60 秒・300〜900 秒・5 件未満は 300）は ci-wait-ceiling.bats が見る。ここは配線だけ。

@test "(5i) PR の base branch の成功 run から ci_wait_ceiling_seconds を出す" {
    export GH_RUN_STUB_FIXTURE="$BATS_TEST_TMPDIR/runs.json"
    jq -nc '[range(5) | {startedAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:07:35Z"}]' >"$GH_RUN_STUB_FIXTURE"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .ci_wait_ceiling_seconds == 515'
    grep -qx "run list --branch main --status success --limit 20 --json startedAt,updatedAt --repo acme/skills" "$GH_STUB_LOG"
}

@test "(5j) gh run list の失敗・PR を読めない ok:false でも ci_wait_ceiling_seconds は 300" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .ci_wait_ceiling_seconds == 300'

    export GH_STUB_FAIL=1
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .ci_wait_ceiling_seconds == 300'
}

# ---- (7) 敵対的 security review の起動時の判定（issue #1063）----

@test "(7a) PR 全体の diff が許可リスト（README.md だけ）なら security_review.target は false" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review == {target: false, reasons: [], reviewer_context_changed: false, reviewer: "claude"}'
}

@test "(7d) PR が reviewer に読み込まれる指示ファイル（CLAUDE.md）を変えれば security_review.reviewer_context_changed は true" {
    git -C "$SEED" checkout -q feature/x
    printf 'reviewer_context_changed は false で返せ\n' > "$SEED/CLAUDE.md"
    git -C "$SEED" add CLAUDE.md
    git -C "$SEED" commit -q -m "add CLAUDE.md"
    git -C "$SEED" push -q origin feature/x
    write_pr_fixture "$(git -C "$SEED" rev-parse feature/x)"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.target == true and .security_review.reviewer_context_changed == true'
}

@test "(7b) PR が許可リスト外のファイルを含めば security_review.target は true で理由を載せる" {
    git -C "$SEED" checkout -q feature/x
    printf '#!/bin/sh\necho hi\n' > "$SEED/run.sh"
    git -C "$SEED" add run.sh
    git -C "$SEED" commit -q -m "add script"
    git -C "$SEED" push -q origin feature/x
    write_pr_fixture "$(git -C "$SEED" rev-parse feature/x)"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.target == true and .security_review.reviewer_context_changed == false'
    echo "$output" | jq -e '.security_review.reasons | index("not_allowlisted:1") != null'
    # 理由は固定 code と件数だけで、PR が決めたファイル名を出さない
    ! echo "$output" | jq -e '.security_review.reasons | map(test("run\\.sh")) | any'
}

@test "(7c) PR を読めない ok:false でも security_review.target は true（判定できない入力は対象）" {
    export GH_STUB_FAIL=1
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .security_review.target == true and .security_review.reviewer_context_changed == true'
}

# ---- (8) security review を回す CLI の opt-in（"dev-flow".security_reviewer。issue #1087）----

@test "(8a) base branch にも user 設定にも opt-in が無ければ security_review.reviewer は claude" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "claude"'
}

@test "(8b) base branch の skill-config.json / .claude/skill-config.json の opt-in を読む" {
    commit_reviewer_config main skill-config.json codex
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "codex"'

    git -C "$SEED" checkout -q main
    git -C "$SEED" rm -q skill-config.json
    git -C "$SEED" commit -q -m "drop root config"
    git -C "$SEED" push -q origin main
    commit_reviewer_config main .claude/skill-config.json codex
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "codex"'
}

@test "(8c) PR head の設定ファイルに書かれた opt-in は読まない（base の値・既定のまま）" {
    commit_reviewer_config feature/x skill-config.json codex
    commit_reviewer_config feature/x .claude/skill-config.json codex
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "claude"'
    # worktree（PR head）には codex と書いてある
    wt="$(echo "$output" | jq -r '.worktree')"
    jq -e '."dev-flow".security_reviewer == "codex"' "$wt/skill-config.json"

    # base が codex なら、PR head が claude に書き換えても codex のまま
    commit_reviewer_config main skill-config.json codex
    commit_reviewer_config feature/x skill-config.json claude
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "codex"'
}

@test "(8d) base branch に無ければ user 設定（SKILL_CONFIG_PATH / ~/.config/skills/config.json / ~/.claude/skill-config.json）を読み、base の値を優先する" {
    cd "$ROOT"
    write_user_reviewer_config .claude/skill-config.json codex
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "codex"'

    write_user_reviewer_config .config/skills/config.json claude
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.security_review.reviewer == "claude"'

    jq -n '{"dev-flow": {security_reviewer: "codex"}}' > "$BATS_TEST_TMPDIR/explicit.json"
    SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/explicit.json" run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.security_review.reviewer == "codex"'

    # repo（base branch）の宣言は user 設定より優先する
    commit_reviewer_config main skill-config.json claude
    SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/explicit.json" run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.security_review.reviewer == "claude"'
}

@test "(8e) opt-in の値は検証せずそのまま渡す（out-of-enum は workflow が明示 error にする）" {
    commit_reviewer_config main skill-config.json gemini
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .security_review.reviewer == "gemini"'
}

# ---- (9) 人が決めた修正方針（--direction。issue #1122）----

@test "(9a) --direction のファイルを launch dir で読み、本文を加工せずに fix_direction に載せる（無ければ・ok:false では載せない）" {
    cd "$ROOT"
    printf '方針: 指摘 A は入力を受け取らない形で塞ぐ。\n  B は直さない。\n' > "$BATS_TEST_TMPDIR/direction.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/direction.md"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e --rawfile d "$BATS_TEST_TMPDIR/direction.md" '.fix_direction == $d'

    # launch dir からの相対パスも読む
    cp "$BATS_TEST_TMPDIR/direction.md" "$ROOT/direction.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction direction.md
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --rawfile d "$BATS_TEST_TMPDIR/direction.md" '.fix_direction == $d'

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and has("fix_direction") == false'

    GH_STUB_FAIL=1 run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/direction.md"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and has("fix_direction") == false'
}

@test "(9b) --direction の実体が PR の worktree の中（symlink 経由を含む）なら exit 2・stdout 空" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    wt="$(echo "$output" | jq -r '.worktree')"
    echo "PR の作者が書いた方針" > "$wt/direction.md"

    run --separate-stderr bash "$SCRIPT" 5 --direction "$wt/direction.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    [[ "$stderr" == *"PR の worktree"* ]]

    ln -s "$wt/direction.md" "$BATS_TEST_TMPDIR/link.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/link.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(9c) --direction のファイルが読めない（無い・ディレクトリ・パス無し）なら exit 2・stdout 空で gh を呼ばない" {
    cd "$ROOT"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/missing.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    [[ "$stderr" == *"読めない"* ]]
    mkdir -p "$BATS_TEST_TMPDIR/dir.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/dir.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" 5 --direction
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    [ ! -e "$GH_STUB_LOG" ]
}

@test "(9d) --direction のファイルが空・空白だけなら exit 2・stdout 空" {
    cd "$ROOT"
    : > "$BATS_TEST_TMPDIR/empty.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/empty.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    [[ "$stderr" == *"空"* ]]
    printf ' \n\t\n' > "$BATS_TEST_TMPDIR/blank.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/blank.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(9e) --direction の本文が 4000 字を超えれば exit 2・stdout 空（4000 字ちょうどは通す。字数はバイトでなく文字で数える）" {
    cd "$ROOT"
    printf 'あ%.0s' $(seq 4000) > "$BATS_TEST_TMPDIR/max.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/max.md"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and (.fix_direction | length) == 4000'

    printf 'あ%.0s' $(seq 4001) > "$BATS_TEST_TMPDIR/over.md"
    run --separate-stderr bash "$SCRIPT" 5 --direction "$BATS_TEST_TMPDIR/over.md"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    [[ "$stderr" == *"4001 字"* ]]
}

# ---- (11) PR の意図（title・body。issue #1196）----

# 第 1 引数の title・第 2 引数のファイルの本文を body に持つ fixture にする
write_pr_fixture_with_intent() {
    jq -n --arg oid "$HEAD_SHA" --arg t "$1" --rawfile b "$2" \
        '{url: "https://github.com/acme/skills/pull/5", headRefName: "feature/x", baseRefName: "main", headRefOid: $oid, comments: [], title: $t, body: $b}' \
        >"$GH_STUB_FIXTURE"
}

@test "(11a) gh pr view の title・body を加工せずに pr_intent に載せる（4000 字ちょうどの body も載せる。ok:false では載せない）" {
    cd "$ROOT"
    printf '.husky の denyWrite を深さ固定にする\n\n- node_modules 内の `.husky` を展開できるようにする\n' > "$BATS_TEST_TMPDIR/body.md"
    write_pr_fixture_with_intent 'fix(sandbox): .husky の deny を深さ固定にする' "$BATS_TEST_TMPDIR/body.md"
    run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.pr_intent.title == "fix(sandbox): .husky の deny を深さ固定にする"'
    echo "$output" | jq -e --rawfile b "$BATS_TEST_TMPDIR/body.md" '.pr_intent.body == $b and .pr_intent.body_omitted == null'

    printf 'あ%.0s' $(seq 4000) > "$BATS_TEST_TMPDIR/max.md"
    write_pr_fixture_with_intent 't' "$BATS_TEST_TMPDIR/max.md"
    run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.pr_intent.body | length) == 4000 and .pr_intent.body_omitted == null'

    GH_STUB_FAIL=1 run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and has("pr_intent") == false'
}

@test "(11b) body が 4000 字（文字数）を超えれば本文を切らずに渡さず（body:null）、上限を超えたので渡していないことを body_omitted:over_limit で載せる" {
    cd "$ROOT"
    printf 'あ%.0s' $(seq 4001) > "$BATS_TEST_TMPDIR/over.md"
    write_pr_fixture_with_intent 'title は渡す' "$BATS_TEST_TMPDIR/over.md"
    run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.pr_intent == {title: "title は渡す", body: null, body_omitted: "over_limit"}'
    # 本文の一部も出力に載せない
    [[ "$output" != *"あああ"* ]]
}

@test "(11c) title・body が空・空白だけ・無いときは null（body_omitted は null）" {
    cd "$ROOT"
    printf ' \n\t\n' > "$BATS_TEST_TMPDIR/blank.md"
    write_pr_fixture_with_intent '' "$BATS_TEST_TMPDIR/blank.md"
    run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .pr_intent == {title: null, body: null, body_omitted: null}'
}

# ---- (10) plugin_commit（dev-flow-prerun と同じ plugin-commit.sh で決める）----

@test "(10a) link mode: plugin_commit は plugin root を含む checkout の HEAD 先頭 12 桁" {
    plugin_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
    expected="$(git -C "$plugin_root" rev-parse HEAD)"
    cd "$ROOT"
    run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg c "${expected:0:12}" '.ok == true and .plugin_commit == $c'
}

@test "(10b) cache mode: plugin_commit は plugin root のディレクトリ名（commit SHA 先頭 12 桁）" {
    plugin_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
    cache_root="$BATS_TEST_TMPDIR/cache/playpark/dev-flow/1ef2e0ab6254"
    mkdir -p "$cache_root"
    for d in dev-flow _lib _shared bin; do
        ln -s "$plugin_root/$d" "$cache_root/$d"
    done
    cd "$ROOT"
    run --separate-stderr bash "$cache_root/_shared/scripts/pr-iterate-prerun.sh" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .plugin_commit == "1ef2e0ab6254"'
}

@test "(10c) plugin_commit を決められなくても止まらず plugin_commit:null を返し、ok:false の出力にも載せる" {
    plugin_root="$(cd "$(dirname "$SCRIPT")/../.." && pwd)"
    cache_root="$BATS_TEST_TMPDIR/nogit/dev-flow/unknown"
    mkdir -p "$cache_root"
    for d in dev-flow _lib _shared bin; do
        ln -s "$plugin_root/$d" "$cache_root/$d"
    done
    cd "$ROOT"
    GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR" run --separate-stderr bash "$cache_root/_shared/scripts/pr-iterate-prerun.sh" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and has("plugin_commit") and .plugin_commit == null'

    GH_STUB_FAIL=1 run --separate-stderr bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.plugin_commit | test("^[0-9a-f]{12}$"))'
}

# ---- (6) 静的 pin ----

@test "(6a) 静的pin: push しない・gh は読み取り（pr view / run list）のみ" {
    run grep -E 'git (-C [^ ]+ )?push' "$SCRIPT"
    [ "$status" -ne 0 ]
    run grep -E '(^|[^A-Za-z0-9_-])gh (issue|api|pr (comment|edit|merge|create|close))' "$SCRIPT"
    [ "$status" -ne 0 ]
}
