#!/usr/bin/env bats
# Tests for _shared/scripts/devflow-config.sh（issue #1214 / #1215）
#
# fixture は bare origin + seed（origin へ push する側）+ ROOT（clone した起動元のメイン checkout）。
# ROOT の origin の URL は bare origin のパス（<owner>/<repo> を決められない）。repo 別の節を読む test は
# set_origin_url で GitHub の URL にする。user 設定は HOME を一時ディレクトリに向けて実行者の環境から切り離す。

setup() {
    HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/devflow-config.sh"

    ORIGIN="$BATS_TEST_TMPDIR/origin.git"
    git init --bare -q "$ORIGIN"
    SEED="$BATS_TEST_TMPDIR/seed"
    git init -q -b main "$SEED"
    git -C "$SEED" config user.name "Test"
    git -C "$SEED" config user.email "test@example.com"
    echo "# seed" > "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "init"
    git -C "$SEED" remote add origin "$ORIGIN"
    git -C "$SEED" push -q origin main

    ROOT="$BATS_TEST_TMPDIR/root"
    git clone -q "$ORIGIN" "$ROOT"
    git -C "$ROOT" config user.name "Test"
    git -C "$ROOT" config user.email "test@example.com"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    unset SKILL_CONFIG_PATH
    source "$HELPER"
}

# 第 1 引数のパス（seed 相対）に第 2 引数の内容を書いて origin/main へ push し、ROOT で fetch する
push_base_config() {
    mkdir -p "$(dirname "$SEED/$1")"
    printf '%s\n' "$2" > "$SEED/$1"
    git -C "$SEED" add "$1"
    git -C "$SEED" commit -q -m "config $1"
    git -C "$SEED" push -q origin main
    git -C "$ROOT" fetch -q origin
}

# 第 1 引数のパス（HOME 相対）に第 2 引数の内容の user 設定を書く
write_user_config() {
    mkdir -p "$(dirname "$HOME/$1")"
    printf '%s\n' "$2" > "$HOME/$1"
}

# ROOT の origin の URL を第 1 引数にする。fetch は insteadOf で bare origin に向けたままにする
set_origin_url() {
    git -C "$ROOT" remote set-url origin "$1"
    git -C "$ROOT" config url."$ORIGIN".insteadOf "$1"
}

@test "どこにも無ければ null" {
    run devflow_config "$ROOT" main ci_verify
    [ "$status" -eq 0 ]
    [ "$output" = "null" ]
}

@test "origin/<base> の skill-config.json → .claude/skill-config.json → user 設定の順に、キーごとに最初に null でない値を返す" {
    write_user_config .claude/skill-config.json '{"dev-flow": {"ci_verify": "user", "local_verify": "user", "pr_title_format": "user"}}'
    push_base_config .claude/skill-config.json '{"dev-flow": {"ci_verify": "base-dot-claude", "local_verify": "base-dot-claude"}}'
    push_base_config skill-config.json '{"dev-flow": {"ci_verify": {"label": "base-root"}, "local_verify": null}}'

    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '{"label":"base-root"}' ]
    # skill-config.json の null は未設定（次の候補を見る）
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"base-dot-claude"' ]
    # base のどちらにも無いキーは user 設定
    run devflow_config "$ROOT" main pr_title_format
    [ "$output" = '"user"' ]
    # base が空なら base branch は見ない
    run devflow_config "$ROOT" "" ci_verify
    [ "$output" = '"user"' ]
}

@test "user 設定は SKILL_CONFIG_PATH → ~/.config/skills/config.json → ~/.claude/skill-config.json の順" {
    write_user_config .claude/skill-config.json '{"dev-flow": {"security_reviewer": "home-claude"}}'
    run devflow_config "$ROOT" main security_reviewer
    [ "$output" = '"home-claude"' ]

    write_user_config .config/skills/config.json '{"dev-flow": {"security_reviewer": "xdg"}}'
    run devflow_config "$ROOT" main security_reviewer
    [ "$output" = '"xdg"' ]

    printf '%s\n' '{"dev-flow": {"security_reviewer": "explicit"}}' > "$BATS_TEST_TMPDIR/explicit.json"
    SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/explicit.json" run devflow_config "$ROOT" main security_reviewer
    [ "$output" = '"explicit"' ]
}

@test "JSON として読めないファイルは未設定として扱い、次の候補を読む" {
    write_user_config .claude/skill-config.json '{"dev-flow": {"pr_title_format": "user"}}'
    write_user_config .config/skills/config.json '{"dev-flow": '
    push_base_config .claude/skill-config.json '{"dev-flow": {"pr_title_format": "base-dot-claude"}}'
    push_base_config skill-config.json 'not json'

    run devflow_config "$ROOT" main pr_title_format
    [ "$output" = '"base-dot-claude"' ]

    git -C "$SEED" rm -q .claude/skill-config.json
    git -C "$SEED" commit -q -m "drop"
    git -C "$SEED" push -q origin main
    git -C "$ROOT" fetch -q origin
    run devflow_config "$ROOT" main pr_title_format
    [ "$output" = '"user"' ]
}

@test "メイン checkout・worktree の作業ツリーにある設定ファイルの値は使わない（独自コミットで書き換えても origin/<base> の値）" {
    push_base_config skill-config.json '{"dev-flow": {"ci_verify": "base"}}'
    git -C "$ROOT" merge -q --ff-only origin/main

    # メイン checkout の作業ツリー（未コミット）と .claude/ の設定
    printf '%s\n' '{"dev-flow": {"ci_verify": "root-tree", "local_verify": "root-tree"}}' > "$ROOT/skill-config.json"
    mkdir -p "$ROOT/.claude"
    printf '%s\n' '{"dev-flow": {"local_verify": "root-tree"}}' > "$ROOT/.claude/skill-config.json"

    # worktree の独自コミットと未コミットの変更
    WT="$BATS_TEST_TMPDIR/wt"
    git -C "$ROOT" worktree add -q -b feature/issue-1 "$WT" origin/main
    printf '%s\n' '{"dev-flow": {"ci_verify": "worktree", "local_verify": "worktree"}}' > "$WT/skill-config.json"
    git -C "$WT" commit -q -am "rewrite config"
    mkdir -p "$WT/.claude"
    printf '%s\n' '{"dev-flow": {"local_verify": "worktree"}}' > "$WT/.claude/skill-config.json"

    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '"base"' ]
    run devflow_config "$WT" main ci_verify
    [ "$output" = '"base"' ]
    run devflow_config "$ROOT" main local_verify
    [ "$output" = "null" ]
    run devflow_config "$WT" main local_verify
    [ "$output" = "null" ]
}

# ---- user 設定の repo 別の節 "dev-flow".repos["<owner>/<repo>"]（issue #1215）----

@test "user 設定の repo 別の節 → origin/<base> → user 設定の順に、キーごとに最初に null でない値を返す" {
    set_origin_url https://github.com/acme/app.git
    write_user_config .claude/skill-config.json '{"dev-flow": {"ci_verify": "user", "local_verify": "user", "pr_title_format": "user", "security_reviewer": "user", "repos": {"acme/app": {"ci_verify": "user-repo", "local_verify": null}}}}'
    push_base_config skill-config.json '{"dev-flow": {"ci_verify": "base", "local_verify": "base"}}'

    # (1) repo 別の節が origin/<base> と user 設定より先
    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '"user-repo"' ]
    # 節の null は未設定（(2) の origin/<base> を見る）
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"base"' ]
    # 節にも base にも無いキーは (3) の user 設定
    run devflow_config "$ROOT" main pr_title_format
    [ "$output" = '"user"' ]
    # base が空でも repo 別の節は読む
    run devflow_config "$ROOT" "" ci_verify
    [ "$output" = '"user-repo"' ]

    # repo 別の節も user 設定のファイルの順（SKILL_CONFIG_PATH → ~/.config/skills/config.json → ~/.claude/skill-config.json）
    write_user_config .config/skills/config.json '{"dev-flow": {"ci_verify": "xdg", "repos": {"acme/app": {"ci_verify": "xdg-repo"}}}}'
    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '"xdg-repo"' ]
    printf '%s\n' '{"dev-flow": {"security_reviewer": "explicit", "repos": {"acme/app": {"ci_verify": {"label": "explicit-repo"}}}}}' > "$BATS_TEST_TMPDIR/explicit.json"
    SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/explicit.json" run devflow_config "$ROOT" main ci_verify
    [ "$output" = '{"label":"explicit-repo"}' ]
    # 後のファイルの repo 別の節は、前のファイルの "dev-flow".<key> より先
    write_user_config .claude/skill-config.json '{"dev-flow": {"repos": {"acme/app": {"security_reviewer": "home-claude-repo"}}}}'
    SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/explicit.json" run devflow_config "$ROOT" main security_reviewer
    [ "$output" = '"home-claude-repo"' ]
}

@test "repo 別の節は origin の URL の <owner>/<repo> と大文字・小文字を区別せずに照合し、一致しない節は使わない" {
    write_user_config .claude/skill-config.json '{"dev-flow": {"ci_verify": "user", "repos": {"acme/other": {"ci_verify": "other"}, "acme/app-x": {"ci_verify": "prefix"}, "ACME/App": {"local_verify": "repo"}}}}'

    set_origin_url https://github.com/acme/app.git
    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '"user"' ]
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"repo"' ]

    set_origin_url git@github.com:Acme/APP.git
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"repo"' ]
    set_origin_url ssh://git@github.com/acme/app/
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"repo"' ]

    # 別 repo の origin では acme/app の節を読まない
    set_origin_url https://github.com/acme/other
    run devflow_config "$ROOT" main local_verify
    [ "$output" = "null" ]
    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '"other"' ]
}

@test "devflow_origin_repo は https / git@ / ssh:// の GitHub の URL から <owner>/<repo> を決め、決められなければ何も出さない" {
    set_origin_url https://github.com/acme/app.git
    run devflow_origin_repo "$ROOT"
    [ "$output" = "acme/app" ]
    set_origin_url git@github.com:acme/app
    run devflow_origin_repo "$ROOT"
    [ "$output" = "acme/app" ]
    set_origin_url ssh://git@github.com/Acme/App.git/
    run devflow_origin_repo "$ROOT"
    [ "$output" = "Acme/App" ]

    set_origin_url https://gitlab.com/acme/app.git
    run devflow_origin_repo "$ROOT"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    set_origin_url https://github.com/acme/app/sub
    run devflow_origin_repo "$ROOT"
    [ -z "$output" ]
}

@test "origin の URL から <owner>/<repo> を決められない checkout では repo 別の節を読まず、origin/<base> → user 設定の値になる" {
    write_user_config .claude/skill-config.json '{"dev-flow": {"ci_verify": "user", "local_verify": "user", "repos": {"acme/app": {"ci_verify": "repo", "local_verify": "repo"}}}}'
    push_base_config skill-config.json '{"dev-flow": {"ci_verify": "base"}}'

    # origin の URL が bare origin のパス（GitHub の形でない）
    run devflow_config "$ROOT" main ci_verify
    [ "$status" -eq 0 ]
    [ "$output" = '"base"' ]
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"user"' ]

    # origin が無い（origin/<base> の追跡 ref だけが残る）
    base_sha="$(git -C "$ROOT" rev-parse origin/main)"
    git -C "$ROOT" remote remove origin
    git -C "$ROOT" update-ref refs/remotes/origin/main "$base_sha"
    run devflow_config "$ROOT" main ci_verify
    [ "$status" -eq 0 ]
    [ "$output" = '"base"' ]
    run devflow_config "$ROOT" main local_verify
    [ "$output" = '"user"' ]
}

@test "object でない \"dev-flow\".repos・repo 別の節は未設定として扱い、節の値は検証せずそのまま返す" {
    set_origin_url https://github.com/acme/app.git
    push_base_config skill-config.json '{"dev-flow": {"ci_verify": "base"}}'
    write_user_config .config/skills/config.json '{"dev-flow": {"repos": ["acme/app"]}}'
    write_user_config .claude/skill-config.json '{"dev-flow": {"pr_title_format": "user", "repos": {"acme/app": "codex"}}}'

    run devflow_config "$ROOT" main ci_verify
    [ "$status" -eq 0 ]
    [ "$output" = '"base"' ]
    run devflow_config "$ROOT" main pr_title_format
    [ "$output" = '"user"' ]

    # 値の検証は workflow（prerun-setup.mjs の normalize* と security_reviewer の enum）が行う
    write_user_config .config/skills/config.json '{"dev-flow": {"repos": {"acme/app": {"security_reviewer": "gemini", "ci_verify": 42}}}}'
    run devflow_config "$ROOT" main security_reviewer
    [ "$output" = '"gemini"' ]
    run devflow_config "$ROOT" main ci_verify
    [ "$output" = '42' ]
}
