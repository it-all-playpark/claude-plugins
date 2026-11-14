#!/usr/bin/env bats
# Tests for _shared/scripts/pre-push-hook.sh
#
# Strategy: mktemp -d で隔離した git repo と bare remote を作り、1 commit を push してから local だけ 1 commit 進める。
# pre-push hook を置いて（置かないケースも含む）start / wait / stop の JSON と、hook が受け取った stdin・引数、
# 実行後に bare remote の ref と worktree の HEAD が動いていないことを検証する。
# 実行者の git 設定（global の hooks パス等）が hook の解決に混ざらないよう global / system config を読ませない。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pre-push-hook.sh"
    export GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_NOSYSTEM=1

    ROOT="$(cd "$(mktemp -d)" && pwd -P)"
    REMOTE="$ROOT/remote.git"
    REPO="$ROOT/repo"
    OUT="$ROOT/out"
    mkdir -p "$OUT"
    git init -q --bare "$REMOTE"
    git init -q "$REPO"
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    git -C "$REPO" checkout -q -b feature/x
    printf 'base\n' > "$REPO/file.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin "$REMOTE"
    git -C "$REPO" push -q origin HEAD
    printf 'next\n' > "$REPO/file.txt"
    git -C "$REPO" commit -q -am next
    HEAD_BEFORE="$(git -C "$REPO" rev-parse HEAD)"
    REMOTE_BEFORE="$(git -C "$REMOTE" rev-parse refs/heads/feature/x)"
}

teardown() {
    bash "$SCRIPT" stop "$REPO" --timeout-sec 20 >/dev/null 2>&1 || true
    rm -rf "$ROOT"
}

# $1: hook の本文（#!/bin/sh の後に置く）。<repo>/.git/hooks/pre-push に実行ビット付きで置く
put_hook() {
    printf '#!/bin/sh\n%s\n' "$1" > "$REPO/.git/hooks/pre-push"
    chmod +x "$REPO/.git/hooks/pre-push"
}

json_field() {
    printf '%s\n' "$1" | jq -r "$2"
}

# start の後、hook が終わるまで wait を繰り返す（$1: 1 回の wait の秒数）。最後の JSON を RESULT、wait の回数を WAITS に入れる
run_to_end() {
    local wait_sec="${1:-10}"
    RESULT="$(bash "$SCRIPT" start "$REPO")"
    WAITS=0
    while [ "$(json_field "$RESULT" .hook)" = "running" ]; do
        [ "$WAITS" -lt 30 ] || return 1
        RESULT="$(bash "$SCRIPT" wait "$REPO" --wait-sec "$wait_sec")"
        WAITS=$((WAITS + 1))
    done
}

assert_not_pushed() {
    [ "$(git -C "$REPO" rev-parse HEAD)" = "$HEAD_BEFORE" ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/x)" = "$REMOTE_BEFORE" ]
    [ "$REMOTE_BEFORE" != "$HEAD_BEFORE" ]
}

@test "exit 1 の hook -> failed と exit 1。出力全文は worktree の外の log に残り、remote の ref と HEAD は動かない" {
    put_hook 'echo "TS2741: Property is missing" >&2; exit 1'

    run_to_end
    [ "$(printf '%s\n' "$RESULT" | wc -l | tr -d ' ')" -eq 1 ]
    [ "$(json_field "$RESULT" .hook)" = "failed" ]
    [ "$(json_field "$RESULT" .exit)" = "1" ]
    log="$(json_field "$RESULT" .log)"
    [ -f "$log" ]
    [[ "$log" != "$REPO"/* ]]
    grep -q 'TS2741: Property is missing' "$log"
    # hook の出力そのものは JSON に載せない
    [[ "$RESULT" != *"TS2741"* ]]
    assert_not_pushed
}

@test "exit 0 の hook -> passed と exit 0。remote の ref と HEAD は動かない" {
    put_hook 'exit 0'

    run_to_end
    [ "$(json_field "$RESULT" .hook)" = "passed" ]
    [ "$(json_field "$RESULT" .exit)" = "0" ]
    assert_not_pushed
}

@test "pre-push hook が無い -> 何も起動せず none" {
    run bash "$SCRIPT" start "$REPO"
    [ "$status" -eq 0 ]
    [ "$(json_field "$output" .hook)" = "none" ]
    [ "$(json_field "$output" .exit)" = "null" ]
    [ ! -e "$REPO/.devflow-tmp/pre-push-hook.job" ]
    assert_not_pushed
}

@test "core.hooksPath の hook を起動する" {
    mkdir -p "$REPO/.githooks"
    printf '#!/bin/sh\nexit 7\n' > "$REPO/.githooks/pre-push"
    chmod +x "$REPO/.githooks/pre-push"
    git -C "$REPO" config core.hooksPath .githooks

    run_to_end
    [ "$(json_field "$RESULT" .hook)" = "failed" ]
    [ "$(json_field "$RESULT" .exit)" = "7" ]
}

@test "1 回の wait より長くかかる hook は running を返し、wait の反復で待ち切る" {
    put_hook 'sleep 4; exit 0'

    run_to_end 1
    [ "$(json_field "$RESULT" .hook)" = "passed" ]
    [ "$WAITS" -ge 2 ]
    assert_not_pushed
}

@test "hook は git push と同じ形の stdin（local ref / HEAD の sha / remote ref / remote の sha）と引数（remote 名と URL）を受け取る" {
    put_hook "cat > '$OUT/stdin'; printf '%s\n' \"\$@\" > '$OUT/args'; exit 0"

    run_to_end
    [ "$(json_field "$RESULT" .hook)" = "passed" ]
    [ "$(wc -l < "$OUT/stdin" | tr -d ' ')" -eq 1 ]
    read -r local_ref local_sha remote_ref remote_sha < "$OUT/stdin"
    [ "$local_ref" = "refs/heads/feature/x" ]
    [ "$local_sha" = "$HEAD_BEFORE" ]
    [ "$remote_ref" = "refs/heads/feature/x" ]
    [ "$remote_sha" = "$REMOTE_BEFORE" ]
    [ "$(sed -n 1p "$OUT/args")" = "origin" ]
    [ "$(sed -n 2p "$OUT/args")" = "$REMOTE" ]
    [ "$(wc -l < "$OUT/args" | tr -d ' ')" -eq 2 ]
}

@test "origin に同名 branch が無ければ remote sha は全 0" {
    git -C "$REPO" checkout -q -b feature/new
    put_hook "cat > '$OUT/stdin'; exit 0"

    run_to_end
    [ "$(json_field "$RESULT" .hook)" = "passed" ]
    read -r local_ref local_sha remote_ref remote_sha < "$OUT/stdin"
    [ "$local_ref" = "refs/heads/feature/new" ]
    [ "$local_sha" = "$HEAD_BEFORE" ]
    [ "$remote_ref" = "refs/heads/feature/new" ]
    [[ "$remote_sha" =~ ^0+$ ]]
    [ "${#remote_sha}" -eq "${#local_sha}" ]
}

@test "stop は走っている hook を止め、その後の wait は passed / failed にしない" {
    put_hook "touch '$OUT/started'; sleep 120; exit 0"

    run bash "$SCRIPT" start "$REPO"
    [ "$(json_field "$output" .hook)" = "running" ]
    run bash "$SCRIPT" stop "$REPO" --timeout-sec 30
    [ "$(json_field "$output" .ok)" = "true" ]
    [ "$(json_field "$output" .stopped)" = "true" ]
    run bash "$SCRIPT" wait "$REPO" --wait-sec 5
    [ "$(json_field "$output" .hook)" = "error" ]
    [ "$(json_field "$output" .exit)" = "null" ]
}

@test "走っている間の start は hook を二重に起動せず running を返す" {
    put_hook "echo run >> '$OUT/runs'; sleep 3; exit 0"

    run bash "$SCRIPT" start "$REPO"
    [ "$(json_field "$output" .hook)" = "running" ]
    first_log="$(json_field "$output" .log)"
    run bash "$SCRIPT" start "$REPO"
    [ "$(json_field "$output" .hook)" = "running" ]
    [ "$(json_field "$output" .log)" = "$first_log" ]
    RESULT="$(bash "$SCRIPT" wait "$REPO" --wait-sec 30)"
    [ "$(json_field "$RESULT" .hook)" = "passed" ]
    [ "$(wc -l < "$OUT/runs" | tr -d ' ')" -eq 1 ]
}

# hook は pr-push と同じ repo 単位の push lock（git-common-dir 配下の dev-flow-pr-push.lock/）の下で起動する。
# 並行 run の push hook と同時に走ると CPU を奪い合って両方が落ちるため。

@test "同じ repo の 2 つの worktree から同時に起動すると、2 つ目の hook は 1 つ目の終了後に始まり、lock を残さない" {
    events="$OUT/hook-events"
    put_hook "echo \"start \$(date +%s)\" >>'$events'; sleep 2; echo \"end \$(date +%s)\" >>'$events'; exit 0"
    export PR_PUSH_LOCK_POLL_SECONDS=0.2
    REPO2="$ROOT/repo2"
    git -C "$REPO" worktree add -q -b feature/y "$REPO2"

    first="$(bash "$SCRIPT" start "$REPO")"
    second="$(bash "$SCRIPT" start "$REPO2")"
    [ "$(json_field "$first" .hook)" = "running" ]
    [ "$(json_field "$second" .hook)" = "running" ]
    r1="$(bash "$SCRIPT" wait "$REPO" --wait-sec 30)"
    r2="$(bash "$SCRIPT" wait "$REPO2" --wait-sec 30)"
    bash "$SCRIPT" stop "$REPO2" --timeout-sec 20 >/dev/null 2>&1 || true
    [ "$(json_field "$r1" .hook)" = "passed" ]
    [ "$(json_field "$r2" .hook)" = "passed" ]
    # hook の start / end は交互に並び（重ならない）、2 つ目の start 時刻は 1 つ目の end 時刻以降
    [ "$(cut -d' ' -f1 "$events" | tr '\n' ' ')" = "start end start end " ]
    [ "$(sed -n 3p "$events" | cut -d' ' -f2)" -ge "$(sed -n 2p "$events" | cut -d' ' -f2)" ]
    [ ! -e "$REPO/.git/dev-flow-pr-push.lock" ]
}

@test "生きているプロセスが push lock を持ったまま待ち上限を超えると、hook を起動せず error（lock_timeout）を返し lock を消さない" {
    put_hook "touch '$OUT/hook-ran'; exit 0"
    sleep 30 >/dev/null 2>&1 &
    holder=$!
    mkdir -p "$REPO/.git/dev-flow-pr-push.lock/pid-$holder"
    export PR_PUSH_LOCK_WAIT_SECONDS=1
    export PR_PUSH_LOCK_POLL_SECONDS=0.2

    run_to_end 5
    kill "$holder"
    [ "$(json_field "$RESULT" .hook)" = "error" ]
    [ "$(json_field "$RESULT" .exit)" = "null" ]
    [[ "$(json_field "$RESULT" .error)" == lock_timeout* ]]
    [ ! -e "$OUT/hook-ran" ]
    [ -d "$REPO/.git/dev-flow-pr-push.lock/pid-$holder" ]
}

@test "引数が不正 -> exit 2 と hook error" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [ "$(json_field "$output" .hook)" = "error" ]
    run bash "$SCRIPT" wait "$REPO" --wait-sec abc
    [ "$status" -eq 2 ]
    [ "$(json_field "$output" .hook)" = "error" ]
}

@test "git の work tree でない -> exit 2 と hook error" {
    plain="$(mktemp -d)"
    run bash "$SCRIPT" start "$plain"
    rm -rf "$plain"
    [ "$status" -eq 2 ]
    [ "$(json_field "$output" .hook)" = "error" ]
}
