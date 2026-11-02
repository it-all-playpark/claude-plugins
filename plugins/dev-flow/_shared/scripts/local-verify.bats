#!/usr/bin/env bats
# Tests for _shared/scripts/local-verify.sh（issue #863）
#
# Strategy: pg-broker は LOCAL_VERIFY_PG_BROKER でスタブに差し替え、呼ばれた argv を $BROKER_CALLS に 1 行ずつ残す。
# 宣言コマンドは fixture worktree の .claude/skill-config.json に書く（exit 0 / 非 0 / 長い sleep）。
# supervisor はバックグラウンドで残るので、start は fd 3 を閉じて呼ぶ（bats が子の終了を待って止まらないように）。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/local-verify.sh"
    WT="$BATS_TEST_TMPDIR/wt"
    STATE_DIR="$BATS_TEST_TMPDIR/state"
    BROKER_CALLS="$BATS_TEST_TMPDIR/broker-calls"
    mkdir -p "$WT/.claude"
    : > "$BROKER_CALLS"
    cat > "$BATS_TEST_TMPDIR/pg-broker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$BROKER_CALLS"
case "$1" in
    create)
        if [ -n "${STUB_BROKER_UNREACHABLE:-}" ]; then
            echo "pg-broker: cannot reach /stub/broker.sock: [Errno 2] No such file or directory" >&2
            exit 1
        fi
        echo '{"id":"0123456789ab","database_url":"postgresql://app@localhost/app?host=/stub/sock","socket_dir":"/stub/sock","expires_at":"2026-10-07T00:00:00Z"}'
        ;;
    delete) echo "{\"id\":\"$2\",\"deleted\":true}" ;;
esac
EOF
    chmod +x "$BATS_TEST_TMPDIR/pg-broker"
    export BROKER_CALLS
    export LOCAL_VERIFY_PG_BROKER="$BATS_TEST_TMPDIR/pg-broker"
    export LOCAL_VERIFY_POLL_SEC=0.1
}

teardown() {
    bash "$SCRIPT" stop --state-dir "$STATE_DIR" --timeout-sec 15 >/dev/null 2>&1 3>&- || true
}

# $1 = command, $2 = timeout_seconds（既定 60）
declare_local_verify() {
    jq -n --arg cmd "$1" --argjson timeout "${2:-60}" \
        '{"dev-flow": {local_verify: {command: $cmd, db: {engine: "postgres", version: "17"}, env: "E2E_EXTERNAL_DATABASE_URL", timeout_seconds: $timeout}}}' \
        > "$WT/.claude/skill-config.json"
}

start_verify() {
    run bash "$SCRIPT" start --worktree "$WT" --state-dir "$STATE_DIR" --wait-sec 20 3>&-
}

wait_verify() {
    run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 20
}

# supervisor が後片付け（DB の DELETE）まで終えるのを待つ
wait_supervisor_done() {
    local i
    for i in $(seq 1 100); do
        [ "$(jq -r '.phase' "$STATE_DIR/state.json" 2>/dev/null)" = done ] && return 0
        sleep 0.1
    done
    return 1
}

@test "exit 0: env に database_url を入れて command を実行し passed を返す。stop を呼ばずに終わっても DB を DELETE する" {
    declare_local_verify 'echo "db=$E2E_EXTERNAL_DATABASE_URL"; echo "cwd=$PWD"'
    start_verify
    [ "$status" -eq 0 ]
    # command がすぐ終わると start の poll より先に done になり、start が最終結果を返す（呼び出し側はどちらも扱う）
    echo "$output" | jq -e '.status == "running" or .status == "passed"'
    grep -qx 'create --version 17' "$BROKER_CALLS"

    wait_verify
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0'
    echo "$output" | jq -e --arg p "$STATE_DIR/logs/command.log" '.log_path == $p'
    echo "$output" | jq -e '.log_tail | contains("db=postgresql://app@localhost/app?host=/stub/sock")'
    echo "$output" | jq -e --arg wt "$WT" '.log_tail | contains("cwd=" + $wt)'

    # stop は呼んでいない
    wait_supervisor_done
    grep -qx 'delete 0123456789ab' "$BROKER_CALLS"
}

@test "exit 非 0: failed と exit code・log の末尾を返し、DB を DELETE する" {
    declare_local_verify 'echo "tenant-isolation.spec.ts: expected 403, got 200"; exit 3'
    start_verify
    wait_verify
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "failed" and .exit_code == 3'
    echo "$output" | jq -e '.log_tail | contains("expected 403, got 200")'
    wait_supervisor_done
    grep -qx 'delete 0123456789ab' "$BROKER_CALLS"
}

@test "supervisor が TERM で止められても（stop を呼ばない異常終了）command を止めて DB を DELETE する" {
    declare_local_verify 'sleep 30'
    start_verify
    echo "$output" | jq -e '.status == "running"'
    sup="$(jq -r '.supervisor_pid' "$STATE_DIR/state.json")"
    kill -TERM "$sup"
    wait_supervisor_done
    grep -qx 'delete 0123456789ab' "$BROKER_CALLS"
    jq -e '.ok == true' "$STATE_DIR/db-deleted.json"
}

@test "timeout_seconds を超えたら command を止めて timeout を返し、DB を DELETE する" {
    declare_local_verify 'echo started; sleep 30' 1
    start_verify
    wait_verify
    echo "$output" | jq -e '.ok == false and .status == "timeout"'
    echo "$output" | jq -e '.log_tail | contains("started")'
    wait_supervisor_done
    grep -qx 'delete 0123456789ab' "$BROKER_CALLS"
}

@test "stop: 実行中の command を止めて DB を DELETE し、2 回目は no-op" {
    declare_local_verify 'sleep 30'
    start_verify
    run bash "$SCRIPT" stop --state-dir "$STATE_DIR" --timeout-sec 15
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .stopped == true and .db_deleted == true'
    grep -qx 'delete 0123456789ab' "$BROKER_CALLS"

    wait_verify
    echo "$output" | jq -e '.status == "stopped"'

    run bash "$SCRIPT" stop --state-dir "$STATE_DIR"
    echo "$output" | jq -e '.ok == true and .stopped == false'
    [ "$(grep -c '^delete ' "$BROKER_CALLS")" -eq 1 ]
}

@test "pg-broker のソケットに届かない: unavailable と理由を返し、command は実行しない" {
    declare_local_verify 'echo ran > ran.txt'
    export STUB_BROKER_UNREACHABLE=1
    start_verify
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "unavailable"'
    echo "$output" | jq -e '.reason | contains("cannot reach /stub/broker.sock")'
    [ ! -e "$WT/ran.txt" ]
    ! grep -q '^delete ' "$BROKER_CALLS"
}

@test "pg-broker が無い: unavailable を返す" {
    declare_local_verify 'true'
    export LOCAL_VERIFY_PG_BROKER="$BATS_TEST_TMPDIR/no-such-pg-broker"
    start_verify
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.status == "unavailable" and (.reason | contains("PATH に無い"))'
}

@test "宣言が無い・不正: error を返し pg-broker を呼ばない" {
    start_verify
    echo "$output" | jq -e '.status == "error" and (.error | contains("local_verify が無い"))'

    jq -n '{"dev-flow": {local_verify: {command: "true", db: {engine: "mysql", version: "8"}, env: "E2E_EXTERNAL_DATABASE_URL", timeout_seconds: 60}}}' > "$WT/.claude/skill-config.json"
    start_verify
    echo "$output" | jq -e '.status == "error" and (.error | contains("db.engine"))'
    [ ! -s "$BROKER_CALLS" ]
}

# dev-flow が渡す --config-pct（Setup 時に検証した宣言の JSON を percent-encoding した 1 トークン）
# $1 = command
setup_config_pct() {
    jq -rn --arg cmd "$1" '{command: $cmd, db: {engine: "postgres", version: "17"}, env: "E2E_EXTERNAL_DATABASE_URL", timeout_seconds: 60} | tojson | @uri'
}

start_verify_pct() {
    run bash "$SCRIPT" start --worktree "$WT" --state-dir "$STATE_DIR" --wait-sec 20 --config-pct "$1" 3>&-
}

@test "--config-pct: worktree の宣言が Setup 時の宣言と一致すれば、Setup 時の宣言の command を実行する" {
    declare_local_verify "  echo 'setup-command ran'  "
    start_verify_pct "$(setup_config_pct "echo 'setup-command ran'")"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.status == "running" or .status == "passed"'
    wait_verify
    echo "$output" | jq -e '.status == "passed" and (.log_tail | contains("setup-command ran"))'
}

@test "--config-pct: 実装が worktree の宣言を書き換えた（command を true に）なら error を返し、command も pg-broker も実行しない" {
    declare_local_verify 'true'
    start_verify_pct "$(setup_config_pct 'exit 1')"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "error" and (.error | contains("Setup 時の宣言と異なる"))'
    [ ! -s "$BROKER_CALLS" ]

    # 宣言を消しても同じ
    echo '{}' > "$WT/.claude/skill-config.json"
    start_verify_pct "$(setup_config_pct 'exit 1')"
    echo "$output" | jq -e '.status == "error" and (.error | contains("消えている"))'
    [ ! -s "$BROKER_CALLS" ]
}

@test "--config-pct: percent-encoding の形でない値は error" {
    declare_local_verify 'true'
    start_verify_pct "{\"command\":\"true\"}"
    echo "$output" | jq -e '.status == "error" and (.error | contains("percent-encoding"))'
    [ ! -s "$BROKER_CALLS" ]
}

# db の無い宣言（dev-flow が AC の inline code から凍結したコマンド。issue #1203）の --config-pct
# $1 = command, $2 = expect_paths の JSON 配列（既定 []）
ac_config_pct() {
    jq -rn --arg cmd "$1" --argjson paths "${2:-[]}" '{command: $cmd, expect_paths: $paths, timeout_seconds: 60} | tojson | @uri'
}

@test "db の無い宣言: pg-broker を呼ばずに command を実行し、worktree の宣言とは突き合わせない" {
    # worktree に宣言は無い（AC コマンドは repo の宣言ではない）
    start_verify_pct "$(ac_config_pct 'echo "db=${E2E_EXTERNAL_DATABASE_URL:-none}"; echo "cwd=$PWD"')"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.status == "running" or .status == "passed"'
    wait_verify
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0'
    echo "$output" | jq -e '.log_tail | contains("db=none")'
    echo "$output" | jq -e --arg wt "$WT" '.log_tail | contains("cwd=" + $wt)'
    wait_supervisor_done
    [ ! -s "$BROKER_CALLS" ]

    # pg-broker が PATH に無くても unavailable にしない
    export LOCAL_VERIFY_PG_BROKER="$BATS_TEST_TMPDIR/no-such-pg-broker"
    start_verify_pct "$(ac_config_pct 'true')"
    wait_verify
    echo "$output" | jq -e '.status == "passed"'
}

@test "expect_paths: exit 0 でも終了後の worktree に無いパスがあれば failed（理由付き）、全部あれば passed" {
    start_verify_pct "$(ac_config_pct 'mkdir -p out && echo ok > out/index.html' '["out/index.html", "out/404.html"]')"
    wait_verify
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "failed" and .exit_code == 0'
    echo "$output" | jq -e '(.reason | contains("out/404.html")) and (.reason | contains("out/index.html") | not)'
    echo "$output" | jq -e '.log_tail | contains("expect_paths が worktree に無い: out/404.html")'
    wait_supervisor_done

    rm -rf "$WT/out"
    start_verify_pct "$(ac_config_pct 'mkdir -p out && echo ok > out/index.html && echo nf > out/404.html' '["out/index.html", "out/404.html"]')"
    wait_verify
    echo "$output" | jq -e '.ok == true and .status == "passed" and .exit_code == 0 and (has("reason") | not)'
    wait_supervisor_done
    [ ! -s "$BROKER_CALLS" ]
}

@test "expect_paths: / 始まり・.. を含むパスは宣言不正の error で、command を実行しない" {
    start_verify_pct "$(ac_config_pct 'echo ran > ran.txt' '["../outside.html"]')"
    echo "$output" | jq -e '.status == "error" and (.error | contains("expect_paths"))'
    start_verify_pct "$(ac_config_pct 'echo ran > ran.txt' '["/etc/hosts"]')"
    echo "$output" | jq -e '.status == "error" and (.error | contains("expect_paths"))'
    [ ! -e "$WT/ran.txt" ]
    [ ! -s "$BROKER_CALLS" ]
}

@test "wait: start 前は error、usage error は exit 2" {
    run bash "$SCRIPT" wait --state-dir "$STATE_DIR" --wait-sec 1
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .status == "error"'
    run bash "$SCRIPT" wait
    [ "$status" -eq 2 ]
}
