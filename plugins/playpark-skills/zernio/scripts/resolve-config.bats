#!/usr/bin/env bats
# Tests for zernio/scripts/resolve-config.sh
#
# The project layer is resolved from the git root of the CWD (no argument).
# HOME / SKILL_CONFIG_PATH are isolated so the real global layer never leaks in.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/zernio/scripts/resolve-config.sh"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    unset SKILL_CONFIG_PATH

    PROJECT="$BATS_TEST_TMPDIR/project"
    mkdir -p "$PROJECT/post/blog" "$PROJECT/.claude"
    git -C "$PROJECT" init -q
    # git rev-parse --show-toplevel resolves symlinks (/var → /private/var on macOS)
    ROOT="$(git -C "$PROJECT" rev-parse --show-toplevel)"
}

@test "reads zernio from skill-config.json at the git root when CWD is a subdirectory" {
    echo '{"zernio":{"profile_id":"proj-1","sync_dirs":["/abs/blog","/abs/bip"]}}' > "$PROJECT/skill-config.json"
    cd "$PROJECT/post/blog"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = '{"profile_id":"proj-1","sync_dirs":["/abs/blog","/abs/bip"]}' ]
}

@test "reads zernio from .claude/skill-config.json alone" {
    echo '{"zernio":{"profile_id":"legacy-1","sync_dirs":["/abs/blog"]}}' > "$PROJECT/.claude/skill-config.json"
    cd "$PROJECT/post"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = '{"profile_id":"legacy-1","sync_dirs":["/abs/blog"]}' ]
}

@test "global config only: uses the global zernio section" {
    export SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/global.json"
    echo '{"zernio":{"profile_id":"global-1","sync_dirs":["/abs/global"]}}' > "$SKILL_CONFIG_PATH"
    cd "$PROJECT"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = '{"profile_id":"global-1","sync_dirs":["/abs/global"]}' ]
}

@test "global and project config: project wins" {
    export SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/global.json"
    echo '{"zernio":{"profile_id":"global-1","sync_dirs":["/abs/global"]}}' > "$SKILL_CONFIG_PATH"
    echo '{"zernio":{"profile_id":"proj-1","sync_dirs":["/abs/blog","/abs/bip"]}}' > "$PROJECT/skill-config.json"
    cd "$PROJECT"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = '{"profile_id":"proj-1","sync_dirs":["/abs/blog","/abs/bip"]}' ]
}

@test "no config: profile_id is null and sync_dirs is empty" {
    cd "$PROJECT"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = '{"profile_id":null,"sync_dirs":[]}' ]
}

@test "relative sync_dirs resolve against the git root, absolute ones are kept" {
    echo '{"zernio":{"sync_dirs":["./post/blog","post/bip","/abs/other"]}}' > "$PROJECT/skill-config.json"
    cd "$PROJECT/post/blog"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(jq -c '.sync_dirs' <<< "$output")" = "[\"$ROOT/post/blog\",\"$ROOT/post/bip\",\"/abs/other\"]" ]
}

@test "outside a git repo: global config is used and relative sync_dirs resolve against CWD" {
    export SKILL_CONFIG_PATH="$BATS_TEST_TMPDIR/global.json"
    echo '{"zernio":{"profile_id":"global-1","sync_dirs":["./post/blog","/abs/other"]}}' > "$SKILL_CONFIG_PATH"
    OUTSIDE="$BATS_TEST_TMPDIR/outside"
    mkdir -p "$OUTSIDE"
    cd "$OUTSIDE"
    export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "{\"profile_id\":\"global-1\",\"sync_dirs\":[\"$PWD/post/blog\",\"/abs/other\"]}" ]
}
