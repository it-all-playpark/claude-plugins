#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/pr-push.sh
#
# push は pre-push hook を含めて Bash 1 回の上限を超えうるので、start で切り離して wait で待つ。
# hook の出力が tool 出力上限を超えると末尾（hook の最終行と git の `failed to push` 行）が agent から見えなくなるので、
# pr-push は出力全文を log に残し、末尾行だけを JSON で返す。出力全体の長さに関係なく、返す量は末尾数行に固定される。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pr-push.sh"

setup() {
    export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
    export BG_JOB_POLL_SEC=0.1
    export PR_PUSH_LOCK_POLL_SECONDS=0.2
    REMOTE="$BATS_TEST_TMPDIR/remote.git"
    WT="$BATS_TEST_TMPDIR/wt"
    LOG="$WT/.devflow-tmp/push-output.log"
    LOCK="$WT/.git/dev-flow-pr-push.lock"
    git init -q --bare "$REMOTE"
    git init -q -b main "$WT"
    git -C "$WT" config user.name "Test"
    git -C "$WT" config user.email "test@example.com"
    git -C "$WT" remote add origin "$REMOTE"
    echo x >"$WT/a.txt"
    git -C "$WT" add a.txt
    git -C "$WT" commit -q -m init
    git -C "$WT" checkout -q -b feature/issue-1
}

teardown() {
    bash "$SCRIPT" stop "$LOG" --timeout-sec 15 >/dev/null 2>&1 3>&- || true
}

# pre-push hook を置く。$1 は hook 本体（sh）。
install_hook() {
    printf '#!/bin/sh\n%s\n' "$1" >"$WT/.git/hooks/pre-push"
    chmod +x "$WT/.git/hooks/pre-push"
}

# 直前の run の JSON のフィールド
field() {
    jq -r "$1" <<<"$output"
}

# wait を status が running でなくなるまで繰り返す。最後の JSON を $output に残し、running の回数を WAIT_RUNNING に残す。$1 は log。
wait_until_done() {
    local i
    WAIT_RUNNING=0
    for ((i = 0; i < 100; i++)); do
        run bash "$SCRIPT" wait "$1" --wait-sec 1 3>&-
        [ "$status" -eq 0 ]
        [ "$(field .status)" = running ] || return 0
        WAIT_RUNNING=$((WAIT_RUNNING + 1))
    done
    echo "wait が終わらない: $output" >&2
    return 1
}

# cwd = $WT で start して結果まで待つ
push_and_wait() {
    cd "$WT"
    run bash "$SCRIPT" start "$LOG" 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .status)" = running ]
    wait_until_done "$LOG"
}

remote_has_branch() {
    git -C "$REMOTE" rev-parse --verify --quiet refs/heads/feature/issue-1 >/dev/null
}

@test "start は pre-push hook の完了を待たずに返り、1 回の wait より長い hook を wait の反復で待ち切って remote に届く" {
    install_hook 'sleep 3; echo "✓ all checks passed"; exit 0'
    cd "$WT"
    started=$SECONDS
    run bash "$SCRIPT" start "$LOG" 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .status)" = running ]
    [ "$(field .exit_code)" = null ]
    [ "$(field .log)" = "$LOG" ]
    [ $((SECONDS - started)) -lt 3 ]
    run remote_has_branch
    [ "$status" -ne 0 ]
    wait_until_done "$LOG"
    [ "$WAIT_RUNNING" -ge 1 ]
    [ "$(field .status)" = passed ]
    [ "$(field .exit_code)" = 0 ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
}

@test "wait の running は exit code も末尾行も持たない（転写の量を増やさない）" {
    install_hook 'echo "in progress"; sleep 3; exit 0'
    cd "$WT"
    run bash "$SCRIPT" start "$LOG" 3>&-
    run bash "$SCRIPT" wait "$LOG" --wait-sec 0 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .status)" = running ]
    [ "$(field .exit_code)" = null ]
    [ "$(field .tail)" = "" ]
    [ "$(field .log)" = "$LOG" ]
}

@test "stop は hook ごと push を止めて lock を解放し、以後の wait は stopped を返す" {
    install_hook "touch '$BATS_TEST_TMPDIR/hook-started'; sleep 30; touch '$BATS_TEST_TMPDIR/hook-finished'; exit 0"
    cd "$WT"
    run bash "$SCRIPT" start "$LOG" 3>&-
    for ((i = 0; i < 100; i++)); do
        [ -e "$BATS_TEST_TMPDIR/hook-started" ] && break
        sleep 0.1
    done
    [ -e "$BATS_TEST_TMPDIR/hook-started" ]
    [ -d "$LOCK" ]
    run bash "$SCRIPT" stop "$LOG" --timeout-sec 15 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .ok)" = true ]
    [ "$(field .was_running)" = true ]
    run bash "$SCRIPT" wait "$LOG" --wait-sec 1 3>&-
    [ "$(field .status)" = stopped ]
    [[ "$(field .tail)" == *"command を止めた"* ]]
    [ ! -e "$LOCK" ]
    [ ! -e "$BATS_TEST_TMPDIR/hook-finished" ]
    remote_has_branch && false
    true
}

@test "同じ worktree で push が走っている間の start は新しい push を起動せず running を返し、走っている push の結果を wait で受け取る" {
    events="$BATS_TEST_TMPDIR/hook-events"
    install_hook "echo run >>'$events'; sleep 2; exit 0"
    cd "$WT"
    run bash "$SCRIPT" start "$LOG" 3>&-
    [ "$(field .status)" = running ]
    for ((i = 0; i < 100; i++)); do
        [ -s "$events" ] && break
        sleep 0.1
    done
    [ -s "$events" ]
    run bash "$SCRIPT" start "$LOG" 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .status)" = running ]
    [ "$(field .exit_code)" = null ]
    [ "$(field .log)" = "$LOG" ]
    wait_until_done "$LOG"
    [ "$(field .status)" = passed ]
    [ "$(wc -l <"$events" | tr -d ' ')" -eq 1 ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
}

@test "前の push が終わった後の start は新しい push を起動する" {
    install_hook 'exit 0'
    push_and_wait
    [ "$(field .status)" = passed ]
    git -C "$WT" commit -q --allow-empty -m second
    push_and_wait
    [ "$(field .status)" = passed ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
}

@test "start していない log の stop は何もせず ok を返し、wait は error を返す" {
    cd "$WT"
    run bash "$SCRIPT" stop "$LOG" 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .ok)" = true ]
    [ "$(field .was_running)" = false ]
    run bash "$SCRIPT" wait "$LOG" --wait-sec 0 3>&-
    [ "$status" -eq 0 ]
    [ "$(field .status)" = error ]
    [ "$(field .exit_code)" = null ]
    [[ "$(field .tail)" == *"起動していない"* ]]
}

@test "hook が大量に出力して失敗しても、tail に hook の最終行と git の failed to push 行が入り、返す量は小さい" {
    install_hook 'i=1; while [ $i -le 6000 ]; do echo "  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any ($i)"; i=$((i+1)); done
echo "✓ Lint passed"
echo "❌ Pre-push checks failed: unit tests"
exit 1'
    push_and_wait
    [ "$(field .status)" = failed ]
    [ "$(field .exit_code)" = 1 ]
    [ "$(field .log)" = "$LOG" ]
    tail="$(field .tail)"
    [[ "$tail" == *"❌ Pre-push checks failed: unit tests"* ]]
    [[ "$tail" == *"failed to push some refs"* ]]
    # hook の最終行の直後が git の failed to push 行
    [ "$(printf '%s\n' "$tail" | grep -A1 -F '❌ Pre-push checks failed: unit tests' | tail -n 1 | grep -c 'failed to push')" -eq 1 ]
    # 出力全体（約 50 万字）に関係なく、返す量は末尾数行に収まる
    [ "${#output}" -lt 4000 ]
    [ "$(printf '%s\n' "$tail" | wc -l | tr -d ' ')" -le 5 ]
    # push が失敗しても lock は残らない
    [ ! -e "$LOCK" ]
}

@test "出力全文が log に残る（先頭の warning から git の failed to push 行まで）" {
    install_hook 'i=1; while [ $i -le 6000 ]; do echo "warning line $i"; i=$((i+1)); done
echo "❌ Pre-push checks failed"
exit 1'
    push_and_wait
    [ "$(field .exit_code)" = 1 ]
    [ -f "$LOG" ]
    [ "$(grep -c '^warning line ' "$LOG")" -eq 6000 ]
    grep -qx 'warning line 1' "$LOG"
    grep -q 'failed to push some refs' "$LOG"
}

@test "tail は ANSI エスケープと \\r と空行を落とす" {
    install_hook 'printf "lint ok\n\033[31m❌ Pre-push checks failed\033[0m\n\n\n"
printf "progress 1\rprogress 2\n"
exit 1'
    push_and_wait
    [ "$(field .exit_code)" = 1 ]
    tail="$(field .tail)"
    printf '%s\n' "$tail" | grep -qx '❌ Pre-push checks failed'
    printf '%s\n' "$tail" | grep -qx 'progress 2'
    [ "$(printf '%s\n' "$tail" | grep -c "$(printf '\033')")" -eq 0 ]
    [ "$(printf '%s\n' "$tail" | grep -c "$(printf '\r')")" -eq 0 ]
    [ "$(printf '%s\n' "$tail" | grep -cx '')" -eq 0 ]
}

@test "1 行が極端に長くても返す行は 500 バイトで切る" {
    install_hook 'head -c 100000 /dev/zero | tr "\0" "x"; echo
exit 1'
    push_and_wait
    [ "${#output}" -lt 4000 ]
    [ "$(field .exit_code)" = 1 ]
    while IFS= read -r line; do
        [ "$(printf '%s' "$line" | LC_ALL=C wc -c | tr -d ' ')" -le 500 ]
    done <<< "$(field .tail)"
}

@test "500 バイトの切れ目が多バイト文字の途中でも JSON は壊れない" {
    install_hook 'i=0; while [ $i -lt 400 ]; do printf "あ"; i=$((i+1)); done; echo
exit 1'
    push_and_wait
    [ "$(field .exit_code)" = 1 ]
    [[ "$(field .tail)" == *"あ"* ]]
}

@test "hook が通れば exit_code 0 で同名 branch へ push され、.git/config に upstream を書かない" {
    install_hook 'echo "✓ all checks passed"; exit 0'
    push_and_wait
    [ "$(field .status)" = passed ]
    [ "$(field .exit_code)" = 0 ]
    [ "$(field .log)" = "$LOG" ]
    printf '%s\n' "$(field .tail)" | grep -qx '✓ all checks passed'
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
    run git -C "$WT" config --get "branch.feature/issue-1.merge"
    [ "$status" -ne 0 ]
    [ ! -e "$LOCK" ]
}

@test "push.default が simple（upstream 無し）でも同名 branch へ届く" {
    install_hook 'exit 0'
    git -C "$WT" config push.default simple
    cd "$WT"
    # 環境の GIT_CONFIG_*（wrapper の push.default=current）を外し、repo の simple を効かせる
    run env -u GIT_CONFIG_COUNT bash "$SCRIPT" start "$LOG" 3>&-
    [ "$status" -eq 0 ]
    wait_until_done "$LOG"
    [ "$(field .exit_code)" = 0 ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
}

@test "log 引数が無ければ push せず exit 2 と error の JSON を返す" {
    install_hook 'exit 0'
    cd "$WT"
    run bash "$SCRIPT" start 3>&-
    [ "$status" -eq 2 ]
    [ "$(field .status)" = error ]
    run git -C "$REMOTE" rev-parse --verify --quiet refs/heads/feature/issue-1
    [ "$status" -ne 0 ]
}

@test "git repo の外では push を起動せず exit 2 と error の JSON を返す" {
    outside="$BATS_TEST_TMPDIR/outside"
    mkdir -p "$outside"
    cd "$outside"
    run bash "$SCRIPT" start "$outside/push.log" 3>&-
    [ "$status" -eq 2 ]
    [ "$(field .status)" = error ]
    [ ! -e "$outside/push.log.job" ]
}

# 以下は repo 単位の push lock。同じ repo の並行 run の pre-push hook が重なると、テストが
# CPU を奪い合って落ちる。lock は git-common-dir 配下に mkdir / rmdir で取る。

@test "同じ repo の 2 つの worktree から同時に起動すると、2 つ目の push（pre-push hook）は 1 つ目の終了後に始まる" {
    events="$BATS_TEST_TMPDIR/hook-events"
    install_hook "echo \"start \$(date +%s)\" >>'$events'; sleep 2; echo \"end \$(date +%s)\" >>'$events'; exit 0"
    WT2="$BATS_TEST_TMPDIR/wt2"
    LOG2="$WT2/.devflow-tmp/push-output.log"
    git -C "$WT" worktree add -q -b feature/issue-2 "$WT2"
    cd "$WT"
    run bash "$SCRIPT" start "$LOG" 3>&-
    cd "$WT2"
    run bash "$SCRIPT" start "$LOG2" 3>&-
    wait_until_done "$LOG"
    [ "$(field .exit_code)" = 0 ]
    wait_until_done "$LOG2"
    [ "$(field .exit_code)" = 0 ]
    # hook の start / end は交互に並び（重ならない）、2 つ目の start 時刻は 1 つ目の end 時刻以降
    [ "$(cut -d' ' -f1 "$events" | tr '\n' ' ')" = "start end start end " ]
    [ "$(sed -n 3p "$events" | cut -d' ' -f2)" -ge "$(sed -n 2p "$events" | cut -d' ' -f2)" ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-2)" = "$(git -C "$WT2" rev-parse HEAD)" ]
    [ ! -e "$LOCK" ]
}

@test "生きているプロセスが lock を持ったまま待ち上限を超えると、push せず exit_code 75 と pr-push: lock_timeout 行を返す" {
    install_hook "touch '$BATS_TEST_TMPDIR/hook-ran'; exit 0"
    sleep 30 >/dev/null 2>&1 3>&- &
    holder=$!
    mkdir -p "$LOCK/pid-$holder"
    export PR_PUSH_LOCK_WAIT_SECONDS=1
    push_and_wait
    kill "$holder"
    [ "$(field .status)" = failed ]
    [ "$(field .exit_code)" = 75 ]
    [ "$(field .log)" = "$LOG" ]
    [[ "$(field .tail)" == "pr-push: lock_timeout "* ]]
    [ ! -e "$BATS_TEST_TMPDIR/hook-ran" ]
    run git -C "$REMOTE" rev-parse --verify --quiet refs/heads/feature/issue-1
    [ "$status" -ne 0 ]
    # 他のプロセスの lock は消さない
    [ -d "$LOCK/pid-$holder" ]
}

@test "記録した PID が生きていない stale lock は奪って push し、push 後に lock を残さない" {
    install_hook 'exit 0'
    (exit 0) &
    dead=$!
    wait "$dead" || true
    mkdir -p "$LOCK/pid-$dead"
    export PR_PUSH_LOCK_WAIT_SECONDS=5
    push_and_wait
    [ "$(field .exit_code)" = 0 ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
    [ ! -e "$LOCK" ]
}

@test "kill -0 が EPERM を返す PID の lock は生きている扱いで奪わない" {
    # 非 root からの kill -0 1（init / launchd）は EPERM
    [ "$(id -u)" -ne 0 ] || skip "root では kill -0 1 が EPERM にならない"
    install_hook 'exit 0'
    mkdir -p "$LOCK/pid-1"
    export PR_PUSH_LOCK_WAIT_SECONDS=1
    push_and_wait
    [ "$(field .exit_code)" = 75 ]
    run git -C "$REMOTE" rev-parse --verify --quiet refs/heads/feature/issue-1
    [ "$status" -ne 0 ]
    [ -d "$LOCK/pid-1" ]
}

@test "exec-proxy.md の失敗ポリシー表の lock_timeout 行は exit code を実装の定数名で指し、fail-closed にする" {
    doc="$(dirname "$SCRIPT")/../references/exec-proxy.md"
    row="$(grep '^| pr-push の lock_timeout' "$doc")"
    [ -n "$row" ]
    grep -q '^LOCK_TIMEOUT_EXIT=' "$SCRIPT"
    [[ "$row" == *'exit `LOCK_TIMEOUT_EXIT`'* ]]
    [[ "$row" == *'| fail-closed'* ]]
}

@test "push は git push origin HEAD の 1 回だけで、--no-verify を使わない" {
    run grep -v '^[[:space:]]*#' "$SCRIPT"
    [ "$(printf '%s\n' "$output" | grep -c 'git push')" -eq 1 ]
    printf '%s\n' "$output" | grep -qx 'git push origin HEAD'
    [ "$(printf '%s\n' "$output" | grep -c -- '--no-verify')" -eq 0 ]
}
