#!/usr/bin/env bats
# Tests for _shared/scripts/pre-commit-hook.sh
#
# Strategy: mktemp -d で隔離した git repo に pre-commit hook を置き（置かないケースも含む）、
# スクリプトの exit code・JSON 出力・HEAD / 実 index が動かないことを検証する。
# 実行者の git 設定（global の hooks パス等）が hook の解決に混ざらないよう global / system config を読ませない。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pre-commit-hook.sh"
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_NOSYSTEM=1

    REPO="$(mktemp -d)"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    printf 'base\n' > "$REPO/file.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m base
    HEAD_BEFORE="$(git -C "$REPO" rev-parse HEAD)"
}

teardown() {
    rm -rf "$REPO"
}

# $1: hook の本文（#!/bin/sh の後に置く）。<repo>/.git/hooks/pre-commit に実行ビット付きで置く
put_hook() {
    printf '#!/bin/sh\n%s\n' "$1" > "$REPO/.git/hooks/pre-commit"
    chmod +x "$REPO/.git/hooks/pre-commit"
}

json_field() {
    printf '%s\n' "$1" | jq -r "$2"
}

@test "exit 1 の hook + stage した変更 -> 非 0 で終わり hook の出力を返す。HEAD は動かない" {
    put_hook 'echo "SC2016: Expressions do not expand in single quotes" >&2; exit 1'
    printf 'changed\n' > "$REPO/file.txt"
    git -C "$REPO" add file.txt

    run bash "$SCRIPT" "$REPO"
    [ "$status" -ne 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    [ "$(json_field "$output" .hook)" = "failed" ]
    [ "$(json_field "$output" .exit)" = "1" ]
    [[ "$(json_field "$output" .tail)" == *"SC2016: Expressions do not expand in single quotes"* ]]
    [ -f "$(json_field "$output" .log)" ]
    [ "$(git -C "$REPO" rev-parse HEAD)" = "$HEAD_BEFORE" ]
    [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
}

@test "exit 0 の hook -> 0 を返す。HEAD は動かない" {
    put_hook 'exit 0'
    printf 'changed\n' > "$REPO/file.txt"
    git -C "$REPO" add file.txt

    run bash "$SCRIPT" "$REPO"
    [ "$status" -eq 0 ]
    [ "$(json_field "$output" .hook)" = "passed" ]
    [ "$(json_field "$output" .exit)" = "0" ]
    [ "$(git -C "$REPO" rev-parse HEAD)" = "$HEAD_BEFORE" ]
    [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
}

@test "pre-commit hook が無い -> 何も実行せず 0（hook none）" {
    printf 'changed\n' > "$REPO/file.txt"

    run bash "$SCRIPT" "$REPO"
    [ "$status" -eq 0 ]
    [ "$(json_field "$output" .hook)" = "none" ]
    [ "$(json_field "$output" .exit)" = "null" ]
    [ "$(git -C "$REPO" rev-parse HEAD)" = "$HEAD_BEFORE" ]
}

@test "実行ビットの無い .git/hooks/pre-commit は hook として扱わない -> 0（hook none）" {
    printf '#!/bin/sh\nexit 1\n' > "$REPO/.git/hooks/pre-commit"
    chmod -x "$REPO/.git/hooks/pre-commit"

    run bash "$SCRIPT" "$REPO"
    [ "$status" -eq 0 ]
    [ "$(json_field "$output" .hook)" = "none" ]
}

@test "core.hooksPath の hook を起動する" {
    mkdir -p "$REPO/.githooks"
    printf '#!/bin/sh\necho from-hooks-path\nexit 7\n' > "$REPO/.githooks/pre-commit"
    chmod +x "$REPO/.githooks/pre-commit"
    git -C "$REPO" config core.hooksPath .githooks

    run bash "$SCRIPT" "$REPO"
    [ "$status" -ne 0 ]
    [ "$(json_field "$output" .hook)" = "failed" ]
    [ "$(json_field "$output" .exit)" = "7" ]
    [[ "$(json_field "$output" .tail)" == *"from-hooks-path"* ]]
}

@test "hook には add -A のあと .devflow-tmp を外した stage 内容が見え、実 index は変わらない" {
    put_hook 'git diff --cached --name-only; exit 1'
    printf 'changed\n' > "$REPO/file.txt"
    printf 'new\n' > "$REPO/new.txt"
    mkdir -p "$REPO/.devflow-tmp"
    printf 'scratch\n' > "$REPO/.devflow-tmp/commit-msg.txt"

    run bash "$SCRIPT" "$REPO"
    [ "$status" -ne 0 ]
    tail_out="$(json_field "$output" .tail)"
    [[ "$tail_out" == *"file.txt"* ]]
    [[ "$tail_out" == *"new.txt"* ]]
    [[ "$tail_out" != *".devflow-tmp"* ]]
    # 実 index は書かない: 変更は未 stage のまま、new.txt は untracked のまま
    [ -z "$(git -C "$REPO" diff --cached --name-only)" ]
    [ "$(git -C "$REPO" ls-files --others --exclude-standard -- new.txt)" = "new.txt" ]
}

@test "末尾だけを tail に入れる（長い出力の先頭は落ちる）" {
    put_hook 'i=1; while [ $i -le 100 ]; do echo "line-$i"; i=$((i+1)); done; exit 1'

    run bash "$SCRIPT" "$REPO"
    [ "$status" -ne 0 ]
    tail_out="$(json_field "$output" .tail)"
    [[ "$tail_out" == *"line-100"* ]]
    [[ "$tail_out" != *"line-1"$'\n'* ]]
    [ "$(printf '%s\n' "$tail_out" | wc -l | tr -d ' ')" -eq 40 ]
}

@test "引数が無い -> exit 2 と hook error" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [ "$(json_field "$output" .hook)" = "error" ]
}

@test "git の work tree でない -> exit 2 と hook error" {
    plain="$(mktemp -d)"
    run bash "$SCRIPT" "$plain"
    rm -rf "$plain"
    [ "$status" -eq 2 ]
    [ "$(json_field "$output" .hook)" = "error" ]
}
