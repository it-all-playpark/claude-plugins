#!/usr/bin/env bats
# Tests for _lib/scripts/bg-job.sh（issue #1223）
#
# Strategy: bg-job.sh を source するだけの偽の exec-proxy（$HOST）を setup で書き、そこの start / wait / stop を叩く。
# supervisor はバックグラウンドで残るので、start は fd 3 を閉じて呼ぶ（bats が子の終了を待って止まらないように）。
# DB・環境変数・expect_paths の hook を載せた形は local-verify.bats が確かめる。

setup() {
    LIB="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/bg-job.sh"
    CWD="$BATS_TEST_TMPDIR/cwd"
    STATE_DIR="$BATS_TEST_TMPDIR/state"
    HOST="$BATS_TEST_TMPDIR/host.sh"
    mkdir -p "$CWD"
    cat > "$HOST" <<EOF
#!/usr/bin/env bash
set -uo pipefail
source "$LIB"
BG_JOB_NAME=fake-job
BG_JOB_SELF="\$0"
EOF
    cat >> "$HOST" <<'EOF'
# FAKE_PREPARE_SLEEP: supervisor が prepare で止まっていて stop file を読まない状況を作る
bg_job_hook_prepare() { sleep "${FAKE_PREPARE_SLEEP:-0}"; }
sub="$1"; shift
case "$sub" in
    # supervise --state-dir <state-dir>（ライブラリが起動する形）
    supervise) bg_job_paths "$2"; bg_job_supervise ;;
    # start <state-dir> <cwd> <timeout_seconds> <wait-sec> <command> [stop-timeout-sec]
    start)
        bg_job_paths "$1"
        bg_job_reset "$2" "${6:-}" || exit 0
        bg_job_write_json "$BG_JOB_SPEC" --arg cwd "$2" --argjson timeout "$3" --arg cmd "$5" '{cwd: $cwd, command: $cmd, timeout_seconds: $timeout}'
        bg_job_start "$4" ;;
    wait) bg_job_paths "$1"; bg_job_wait "$2" ;;
    stop) bg_job_paths "$1"; bg_job_stop "$2" ;;
esac
EOF
    export BG_JOB_POLL_SEC=0.1
    # bats は start と wait を同じ Bash 呼び出しの中で叩くので、切り離した supervisor は start の後も残る。
    # bats を走らせる環境の判定に任せず「残れる環境」に固定し、「残れない環境」は run_call_scoped で再現する
    export BG_JOB_CALL_SCOPED=0
}

teardown() {
    bash "$HOST" stop "$STATE_DIR" 15 >/dev/null 2>&1 3>&- || true
}

# $1 = command, $2 = timeout_seconds（既定 60）, $3 = stop の上限秒（既定はライブラリの値）
start_job() {
    run bash "$HOST" start "$STATE_DIR" "$CWD" "${2:-60}" 20 "$1" "${3:-}" 3>&-
}

wait_job() {
    run bash "$HOST" wait "$STATE_DIR" "${1:-20}"
}

# $1 = pid が消えるまで待つ
wait_gone() {
    local i
    for i in $(seq 1 100); do
        kill -0 "$1" 2>/dev/null || return 0
        sleep 0.1
    done
    return 1
}

# $1 = ファイルができるまで待つ
wait_file() {
    local i
    for i in $(seq 1 100); do
        [ -s "$1" ] && return 0
        sleep 0.1
    done
    return 1
}

supervisor_pid() { jq -r '.supervisor_pid' "$STATE_DIR/state.json"; }

# Bash 呼び出しごとに PID namespace を切る sandbox の再現: 呼び出しが終わると、その呼び出しから起きたプロセスが
# （nohup・setsid・disown で切り離したものも含めて）すべて消える。呼び出しの環境変数に印を付け（子孫は切り離しても
# 環境変数を引き継ぐ）、印を持つプロセスが居なくなるまで KILL する。
# call_mark は印を $CALL_MARK に作る。kill_call は $CALL_MARK の呼び出しから起きたプロセスを消す
call_mark() {
    [ -r /proc/self/environ ] || skip "プロセスの環境変数を /proc から読めない OS では再現できない"
    CALL_MARK="BG_JOB_BATS_CALL=$BATS_TEST_NUMBER.$RANDOM"
}

kill_call() {
    local environ pids
    while :; do
        pids=()
        for environ in /proc/[0-9]*/environ; do
            if grep -qzxF -- "$CALL_MARK" "$environ" 2>/dev/null; then
                environ="${environ#/proc/}"
                pids+=("${environ%/environ}")
            fi
        done
        [ "${#pids[@]}" -gt 0 ] || return 0
        kill -KILL "${pids[@]}" 2>/dev/null || true
    done
}

# $@ = コマンド。残れない環境の 1 回の呼び出しとして実行し、返った後にその呼び出しのプロセスを消す
run_call_scoped() {
    call_mark
    run env "$CALL_MARK" BG_JOB_CALL_SCOPED=1 "$@" 3>&-
    kill_call
}

# $1 = pid。この後に起こすプロセスから見た $1 への kill -0 を ESRCH にする（別の PID namespace に居て見えない pid の再現）。
# 起動済みのプロセスには効かない
hide_pid() {
    export HIDDEN_PID="$1"
    kill() {
        if [ "$1" = -0 ] && [ "$2" = "$HIDDEN_PID" ]; then
            echo "kill: ($2) - No such process" >&2
            return 1
        fi
        builtin kill "$@"
    }
    export -f kill
}

@test "start: command の終了を待たずに JSON 1 行を返し、呼び出し元の shell が終わった後に結果ファイルができる" {
    # command は gate ができるまで終わらないので、start が返った時点の未完了を秒数に頼らず確かめられる。
    # gate が来なければ command は上限で exit 1 するので、command の終了を待つ start でもハングせずに落ちる。
    # wait-sec は gate の上限（30 秒以上）より長くする。短いと「終了か wait-sec まで待つ」start も running を返して通ってしまう
    run bash "$HOST" start "$STATE_DIR" "$CWD" 60 600 'i=0; while [ ! -e "$PWD/gate" ]; do i=$((i+1)); [ $i -le 300 ] || exit 1; sleep 0.1; done; echo finished; exit 7' 3>&-
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.ok == true and .status == "running"'
    echo "$output" | jq -e --arg p "$STATE_DIR/logs/command.log" '.log_path == $p'
    [ ! -e "$STATE_DIR/result.json" ]

    # start を呼んだ shell（run の子）はもう居ない。wait も呼ばずに、残った supervisor が結果を書く
    kill -0 "$(supervisor_pid)"
    touch "$CWD/gate"
    wait_file "$STATE_DIR/result.json"
    jq -e '.status == "failed" and .exit_code == 7' "$STATE_DIR/result.json"
    grep -q finished "$STATE_DIR/logs/command.log"
}

@test "結果ファイルは atomic に書く: 読み手から書きかけ（空のファイル）が見えない" {
    # jq の出力を遅らせ、書き込み先を直接開いていれば空のファイルが見える時間を作る
    local real_jq i seen=''
    real_jq="$(command -v jq)"
    mkdir -p "$BATS_TEST_TMPDIR/slow-bin"
    cat > "$BATS_TEST_TMPDIR/slow-bin/jq" <<EOF
#!/usr/bin/env bash
sleep 0.2
exec "$real_jq" "\$@"
EOF
    chmod +x "$BATS_TEST_TMPDIR/slow-bin/jq"
    # sleep は start が返って下の監視が始まるより後に結果を書かせるため
    PATH="$BATS_TEST_TMPDIR/slow-bin:$PATH" start_job 'sleep 2'
    "$real_jq" -e '.status == "running"' <<<"$output"
    for i in $(seq 1 1000); do
        if [ -e "$STATE_DIR/result.json" ]; then
            seen=1
            [ -s "$STATE_DIR/result.json" ]
            break
        fi
        sleep 0.01
    done
    [ -n "$seen" ]
    "$real_jq" -e '.status == "passed" and .exit_code == 0' "$STATE_DIR/result.json"
}

@test "wait: 終わっていれば結果と log の末尾を返す" {
    start_job 'echo hello; exit 0'
    wait_job
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0'
    echo "$output" | jq -e '.log_tail | contains("hello")'
    echo "$output" | jq -e --arg p "$STATE_DIR/logs/command.log" '.log_path == $p'
}

@test "wait: 終わっていなければ --wait-sec 秒待って status:running と log の末尾を返す" {
    start_job 'echo progress; sleep 30'
    wait_file "$STATE_DIR/logs/command.log"
    local began=$SECONDS
    wait_job 2
    [ "$status" -eq 0 ]
    [ $(( SECONDS - began )) -ge 1 ]
    echo "$output" | jq -e '.ok == false and .status == "running"'
    echo "$output" | jq -e '.log_tail | contains("progress")'
}

@test "wait: supervisor が結果を書かずに居なくなっていれば、待たずに status:error を返す" {
    start_job 'echo $$ > "$PWD/cmd.pid"; exec sleep 30'
    wait_file "$CWD/cmd.pid"
    local sup
    sup="$(supervisor_pid)"
    kill -KILL "$sup"
    wait_gone "$sup"

    # --wait-sec の待ちは sleep の poll で回る。sleep を呼ぶと印を残す sleep に差し替え、
    # 1 度も待たずに返ったことを秒数に頼らず確かめる（待ってから返す wait は --wait-sec の後に落ちる）
    local real_sleep slept="$BATS_TEST_TMPDIR/slept"
    real_sleep="$(command -v sleep)"
    mkdir -p "$BATS_TEST_TMPDIR/marking-bin"
    cat > "$BATS_TEST_TMPDIR/marking-bin/sleep" <<EOF
#!/usr/bin/env bash
touch "$slept"
exec "$real_sleep" "\$@"
EOF
    chmod +x "$BATS_TEST_TMPDIR/marking-bin/sleep"
    PATH="$BATS_TEST_TMPDIR/marking-bin:$PATH" wait_job 20
    [ "$status" -eq 0 ]
    [ ! -e "$slept" ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("結果を残さず"))'
    # trap を走らせずに消えた supervisor の command は残るので、ここで片付ける
    kill -KILL "$(cat "$CWD/cmd.pid")"
}

@test "wait: kill -0 が EPERM の supervisor（pid 1）は生きているとみなし、error にしない" {
    mkdir -p "$STATE_DIR"
    echo '{}' > "$STATE_DIR/spec.json"
    echo '{"phase":"running","supervisor_pid":1}' > "$STATE_DIR/state.json"
    # teardown の stop が stop file を置いて待たないよう、wait だけ確かめて state を消す
    wait_job 0
    rm -f "$STATE_DIR/state.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "running"'
}

@test "呼び出しの終了でプロセスが全部消える環境: start が返った後にプロセスを消しても、別プロセスの wait が結果を受け取る" {
    # command の sleep は「running で返る start」を確実に落とすためのもの（返った時点で command が終わっておらず、
    # 消されて結果が残らない）。結果まで待つ start は sleep の長さによらず通る
    run_call_scoped bash "$HOST" start "$STATE_DIR" "$CWD" 60 20 'sleep 1; echo hello'
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    # start が running 以外を返せば、workflow は wait せずにこの応答を結果として使う
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0'

    BG_JOB_CALL_SCOPED=1 wait_job
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0'
    echo "$output" | jq -e '.log_tail | contains("hello")'
    jq -e '.status == "passed" and .exit_code == 0' "$STATE_DIR/result.json"
}

# $1 = /proc/self/ns/pid の readlink が返す値。PATH の先頭に置く偽 readlink を作り、その bin dir を stdout に出す
fake_pid_ns_bin() {
    local real_readlink dir="$BATS_TEST_TMPDIR/ns-bin"
    real_readlink="$(command -v readlink)"
    mkdir -p "$dir"
    cat > "$dir/readlink" <<EOF
#!/usr/bin/env bash
if [ "\$1" = /proc/self/ns/pid ]; then echo '$1'; exit 0; fi
exec "$real_readlink" "\$@"
EOF
    chmod +x "$dir/readlink"
    echo "$dir"
}

@test "BG_JOB_CALL_SCOPED が無ければ、初期でない PID namespace（呼び出しの終了で消える環境）を判定して結果まで待つ" {
    local bin
    bin="$(fake_pid_ns_bin 'pid:[4026532422]')"
    call_mark
    run env -u BG_JOB_CALL_SCOPED "$CALL_MARK" PATH="$bin:$PATH" bash "$HOST" start "$STATE_DIR" "$CWD" 60 20 'sleep 1; echo hello' 3>&-
    kill_call
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0'
    jq -e '.status == "passed" and .exit_code == 0' "$STATE_DIR/result.json"
}

@test "BG_JOB_CALL_SCOPED が無ければ、初期の PID namespace（4026531836）を判定して待たずに running を返す" {
    local bin
    bin="$(fake_pid_ns_bin 'pid:[4026531836]')"
    run env -u BG_JOB_CALL_SCOPED PATH="$bin:$PATH" bash "$HOST" start "$STATE_DIR" "$CWD" 60 20 'sleep 5; echo hello' 3>&-
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .status == "running"'
    [ ! -e "$STATE_DIR/result.json" ]
}

@test "wait / stop: 別の呼び出しから pid が見えない（kill -0 が ESRCH）だけの動いている supervisor を、居ないと判定しない" {
    export BG_JOB_CALL_SCOPED=1
    # 終わっていない start の呼び出しを残す（＝別の呼び出しの PID namespace で supervisor が動いている）
    bash "$HOST" start "$STATE_DIR" "$CWD" 60 20 'echo $$ > "$PWD/cmd.pid"; exec sleep 30' >/dev/null 2>&1 3>&- &
    wait_file "$CWD/cmd.pid"
    hide_pid "$(supervisor_pid)"

    wait_job 1
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "running"'
    # stop（bg_job_reset も同じ判定で前の実行を止める）は居ないものとして片付けず、stop file で止める
    run bash "$HOST" stop "$STATE_DIR" 15
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .stopped == true and .was_running == true'
    wait_job
    echo "$output" | jq -e '.ok == false and .status == "stopped"'
    unset -f kill
    wait_gone "$(cat "$CWD/cmd.pid")"
}

@test "wait: 呼び出しごと消えた supervisor（heartbeat が途絶えた）には、--wait-sec を待ち切らずに status:error を返す" {
    export BG_JOB_STALE_SEC=2
    call_mark
    env "$CALL_MARK" BG_JOB_CALL_SCOPED=1 bash "$HOST" start "$STATE_DIR" "$CWD" 60 20 'echo $$ > "$PWD/cmd.pid"; exec sleep 30' >/dev/null 2>&1 3>&- &
    wait_file "$CWD/cmd.pid"
    kill_call

    local began=$SECONDS
    BG_JOB_CALL_SCOPED=1 wait_job 60
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("結果を残さず"))'
    [ $(( SECONDS - began )) -lt 30 ]
}

@test "上限秒数を超えたら command の process group（孫まで）を止めて status:timeout にする" {
    start_job 'sleep 30 & echo $! > "$PWD/child.pid"; echo $$ > "$PWD/cmd.pid"; wait' 1
    wait_job
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "timeout"'
    wait_gone "$(cat "$CWD/cmd.pid")"
    wait_gone "$(cat "$CWD/child.pid")"
}

@test "stop: 実行中の command の process group を止めて status:stopped にする" {
    start_job 'sleep 30 & echo $! > "$PWD/child.pid"; echo $$ > "$PWD/cmd.pid"; wait'
    wait_file "$CWD/cmd.pid"
    run bash "$HOST" stop "$STATE_DIR" 15
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.ok == true and .stopped == true and .was_running == true'
    wait_gone "$(cat "$CWD/cmd.pid")"
    wait_gone "$(cat "$CWD/child.pid")"
    wait_job
    echo "$output" | jq -e '.ok == false and .status == "stopped"'
}

@test "同じ state dir で start をもう一度呼ぶと、前の実行を止めてから起動する" {
    start_job 'echo $$ > "$PWD/first.pid"; exec sleep 30'
    wait_file "$CWD/first.pid"
    local first_sup first_cmd
    first_sup="$(supervisor_pid)"
    first_cmd="$(cat "$CWD/first.pid")"

    start_job 'echo $$ > "$PWD/second.pid"; exec sleep 30'
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .status == "running"'
    # 2 本目の start が返った時点で 1 本目の command は消えている（supervisor は done を書いた後に終わる）
    if kill -0 "$first_cmd" 2>/dev/null; then return 1; fi
    wait_gone "$first_sup"
    wait_file "$CWD/second.pid"
    kill -0 "$(cat "$CWD/second.pid")"
    [ "$(supervisor_pid)" != "$first_sup" ]
}

@test "前の実行が止まらないときの start は、起動せずに error を返す（二重に走らせない）" {
    export FAKE_PREPARE_SLEEP=4
    run bash "$HOST" start "$STATE_DIR" "$CWD" 60 0 'echo first > "$PWD/first.txt"' '' 3>&-
    wait_file "$STATE_DIR/state.json"
    local first_sup
    first_sup="$(supervisor_pid)"

    start_job 'echo second > "$PWD/second.txt"' 60 1
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("止められない"))'
    [ "$(supervisor_pid)" = "$first_sup" ]
    wait_gone "$first_sup"
    [ ! -e "$CWD/second.txt" ]
}

@test "start: state dir が cwd と同じかその親なら、消さずに error を返す" {
    echo keep > "$CWD/keep.txt"
    run bash "$HOST" start "$BATS_TEST_TMPDIR" "$CWD" 60 20 'true' 3>&-
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("同じかその親"))'
    [ -e "$CWD/keep.txt" ]
}

@test "local-verify の start: state dir が worktree の親なら exit 0 + status:error を返す" {
    local verify config
    verify="$(dirname "$LIB")/../../_shared/scripts/local-verify.sh"
    config="$(jq -rn '{command: "true", timeout_seconds: 60} | tojson | @uri')"
    echo keep > "$CWD/keep.txt"
    run bash "$verify" start --worktree "$CWD" --state-dir "$BATS_TEST_TMPDIR" --config-pct "$config" 3>&-
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("同じかその親"))'
    [ -e "$CWD/keep.txt" ]
}

@test "local-verify の start: 前の実行を止められないなら exit 0 + status:error を返す" {
    # 実物の local-verify.sh と bg_job_reset のまま、stop の結果だけを「止まらなかった」にする（実際に止まらない
    # supervisor を作ると reset の上限 30 秒を待つことになる）
    local tree="$BATS_TEST_TMPDIR/tree" state="$BATS_TEST_TMPDIR/stuck-state"
    mkdir -p "$tree/_shared/scripts" "$tree/_lib/scripts" "$state"
    cp "$(dirname "$LIB")/../../_shared/scripts/local-verify.sh" "$tree/_shared/scripts/"
    cat > "$tree/_lib/scripts/bg-job.sh" <<EOF
source "$LIB"
bg_job_stop() { jq -nc '{ok: false, stopped: false, error: "stuck"}'; }
EOF
    echo '{"phase":"running","supervisor_pid":1}' > "$state/state.json"
    local config
    config="$(jq -rn '{command: "true", timeout_seconds: 60} | tojson | @uri')"
    run bash "$tree/_shared/scripts/local-verify.sh" start --worktree "$CWD" --state-dir "$state" --config-pct "$config" 3>&-
    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("止められない"))'
    [ -e "$state/state.json" ]
    [ ! -e "$state/spec.json" ]
}

@test "local-verify の start / wait / stop / supervise は bg-job.sh の関数を通る" {
    # 同じ相対位置に local-verify.sh を置き、bg-job.sh の入口を印付きに差し替える
    local tree="$BATS_TEST_TMPDIR/tree"
    mkdir -p "$tree/_shared/scripts" "$tree/_lib/scripts"
    cp "$(dirname "$LIB")/../../_shared/scripts/local-verify.sh" "$tree/_shared/scripts/"
    cat > "$tree/_lib/scripts/bg-job.sh" <<EOF
source "$LIB"
bg_job_start() { echo via-start; }
bg_job_wait() { echo via-wait; }
bg_job_stop() { echo via-stop; }
bg_job_supervise() { echo via-supervise; }
EOF
    local verify="$tree/_shared/scripts/local-verify.sh" config
    config="$(jq -rn '{command: "true", timeout_seconds: 60} | tojson | @uri')"
    run bash "$verify" start --worktree "$CWD" --state-dir "$STATE_DIR" --config-pct "$config" 3>&-
    [ "$output" = via-start ]
    run bash "$verify" wait --state-dir "$STATE_DIR"
    [ "$output" = via-wait ]
    run bash "$verify" stop --state-dir "$STATE_DIR"
    [ "$output" = via-stop ]
    run bash "$verify" supervise --state-dir "$STATE_DIR"
    [ "$output" = via-supervise ]
}
