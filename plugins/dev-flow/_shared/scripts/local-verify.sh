#!/usr/bin/env bash
# local-verify.sh - repo が skill-config.json の "dev-flow".local_verify に宣言した検証コマンド（E2E 等）を、
# pg-broker に頼んだ使い捨ての Postgres に向けてバックグラウンドで実行する（issue #863）。
#
# dev-flow は ci の AC（ci_verify で CI の check が判定する AC）がある run で、Validate が green になった後に
# これを呼び、exit 0 ならその AC を satisfied にする（PR を出した後の CI 待ち 1 往復を省く）。
# 宣言コマンドは worktree のコードを実行するので、呼び出し元と同じ sandbox 内で動かす
# （本スクリプトを sandbox の excludedCommands に入れない — 入れると worktree の任意コードが sandbox 外で動く）。
#
# 宣言は --config-pct（JSON を percent-encoding した 1 トークン）か --config（JSON ファイル）でだけ受け取り、どちらも
# 無ければ error。dev-flow は Setup 時に検証した宣言（prerun が origin/<base> と user 設定から読んだ skill-config の
# "dev-flow".local_verify）を --config-pct で渡す。worktree の設定ファイルは読まない — 実装中に書き換えた宣言を
# 判定に使わないことは、読み先を PR の外に置くことで保つ:
#   "dev-flow": { "local_verify": {
#     "command": "pnpm test:e2e:local",              # worktree を cwd に bash -c で実行する
#     "db": { "engine": "postgres", "version": "17" }, # pg-broker create --version に渡す
#     "env": "E2E_EXTERNAL_DATABASE_URL",             # database_url を入れて command に渡す環境変数名
#     "timeout_seconds": 1500,                        # command の上限。超えたら止めて timeout
#     "expect_paths": ["out/index.html"]              # 省略可。command が exit 0 でも、終了後に worktree に無い・
#   } }                                               #   command の開始より前から更新されていないものがあれば failed
#
# expect_paths はその実行で作られた・更新されたことまで確かめる（mtime が command の開始以後）。前の実行や implementer が
# 残したファイルがあるだけで、生成を求めた AC を exit 0 で通さないため。
# db の無い宣言（{command, timeout_seconds, expect_paths?}）は pg-broker を呼ばずに command を実行する（env も渡さない）。
# dev-flow はこれで AC 自体が inline code で指定したコマンドを実行する（issue #1208。AC の文面から凍結した値を
# --config-pct で渡す）。
#
# プロセスモデル:
#   別の Bash 呼び出しからは kill できない（sandbox が別実体への signal を EPERM にする）ので、start は
#   detached な supervisor を 1 本起こし、DB の確保・command の起動・停止・DB の削除はすべて supervisor が行う。
#   止めるときは state dir に stop file を置く。DB の DELETE は supervisor の EXIT trap で必ず呼ぶ
#   — stop が呼ばれずに command が終わっても、timeout でも、supervisor が TERM / INT で止められても消す。
#
# 出力契約: start / wait / stop は常に exit 0 + stdout に JSON 1 行。usage error のみ exit 2。
#   1 回の Bash 呼び出し（上限 600 秒）に収まるよう、start は DB 確保まで最大 --wait-sec（既定 300）、
#   wait は最大 --wait-sec（既定 480）だけ待ち、終わっていなければ status:"running" を返す。
#   status: running（まだ実行中）/ passed（exit 0）/ failed（exit 非 0・exit 0 でも expect_paths が無い・古い — reason 付き）/
#           timeout（timeout_seconds 超過で停止）/
#           stopped（stop で停止）/ unavailable（pg-broker に届かない・DB を確保できない）/ error（宣言不正等）
#
# Usage:
#   local-verify start --worktree <abs> --state-dir <abs> [--config-pct <percent-encoded json> | --config <json file>] [--wait-sec <n=300>]
#   local-verify wait  --state-dir <abs> [--wait-sec <n=480>]
#   local-verify stop  --state-dir <abs> [--timeout-sec <n=60>]
#   （内部）local-verify supervise --state-dir <abs>
#
# LOCAL_VERIFY_PG_BROKER（pg-broker の実体）と LOCAL_VERIFY_POLL_SEC（状態確認の間隔）は bats が
# broker をスタブにし、短い間隔で回すための上書き口（workflow は渡さない）。
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
BROKER="${LOCAL_VERIFY_PG_BROKER:-pg-broker}"
POLL="${LOCAL_VERIFY_POLL_SEC:-1}"
STOP_GRACE_SEC=10
# wait が返す log の末尾（dev-implementer への差し戻しに添える）。行数と文字数の両方で切る。
TAIL_LINES=60
TAIL_BYTES=4000

usage() { echo "local-verify: $1" >&2; exit 2; }

now() { date +%s; }

# jq で組んだ JSON を atomic に書く（読み手が書きかけを読まないように）
write_json() {
    local path="$1"; shift
    local tmp="$path.$$.tmp"
    jq -n "$@" > "$tmp" && mv "$tmp" "$path"
}

read_field() { jq -r "$2 // empty" "$1" 2>/dev/null; }

# 別 sandbox 実体のプロセスへの kill -0 は EPERM になる。EPERM は「存在する」と読む。
is_alive() {
    local pid="$1" err
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    err="$(kill -0 "$pid" 2>&1)" && return 0
    [[ "$err" == *"not permitted"* ]]
}

paths() {
    STATE_DIR="$1"
    SPEC="$STATE_DIR/spec.json"
    STATE="$STATE_DIR/state.json"
    RESULT="$STATE_DIR/result.json"
    DB_DELETED="$STATE_DIR/db-deleted.json"
    STOP_FILE="$STATE_DIR/stop"
    # command を起こす直前に作る印。expect_paths がこれより古ければ、その実行で作られた・更新されたものではない
    CMD_STARTED="$STATE_DIR/command-started"
    LOG_DIR="$STATE_DIR/logs"
    CMD_LOG="$LOG_DIR/command.log"
    SUP_LOG="$LOG_DIR/supervisor.log"
}

log_tail() {
    [[ -f "$CMD_LOG" ]] || { printf ''; return; }
    tail -n "$TAIL_LINES" "$CMD_LOG" | tail -c "$TAIL_BYTES"
}

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

# --config-pct の値（JSON を percent-encoding した 1 トークン）を戻す。形が違えば 1 を返す。
decode_pct() {
    local s="$1"
    [[ "$s" =~ ^[A-Za-z0-9._%-]+$ ]] || return 1
    printf '%b' "${s//%/\\x}"
}

# 宣言（--config-pct か --config）を読み、形を検証して spec に書く。不正・どちらも無ければ理由を stdout に 1 行出して 1 を返す。
load_config() {
    local worktree="$1" config_path="$2" config_pct="$3" raw=''
    if [[ -n "$config_pct" ]]; then
        local decoded
        decoded="$(decode_pct "$config_pct")" || { echo '--config-pct が percent-encoding の形でない'; return 1; }
        raw="$(jq -c '.' <<<"$decoded" 2>/dev/null)" || { echo '--config-pct を JSON として読めない'; return 1; }
    elif [[ -n "$config_path" ]]; then
        raw="$(jq -c '.' "$config_path" 2>/dev/null)" || { echo "--config を JSON として読めない: $config_path"; return 1; }
    else
        echo '宣言が無い（--config-pct か --config で local_verify の宣言を渡す）'; return 1
    fi
    local problem
    problem="$(jq -r '
        if type != "object" then "local_verify が object でない"
        elif (.command | type) != "string" or (.command | test("^\\s*$")) then "command が空でない string でない"
        elif .expect_paths != null and (.expect_paths | type) != "array" then "expect_paths が配列でない"
        elif (.expect_paths // []) | any(type != "string" or test("^\\s*$") or startswith("/") or (split("/") | map(select(. == "..")) | length > 0)) then "expect_paths に worktree からの相対パスでないもの（/ 始まり・.. を含む）がある"
        elif .db != null and ((.db | type) != "object" or .db.engine != "postgres") then "db.engine が \"postgres\" でない"
        elif .db != null and ((.db.version | type) != "string" or (.db.version | test("^\\s*$"))) then "db.version が空でない string でない"
        elif .db != null and ((.env | type) != "string" or (.env | test("^[A-Za-z_][A-Za-z0-9_]*$") | not)) then "env が環境変数名でない"
        elif (.timeout_seconds | type) != "number" or .timeout_seconds <= 0 or (.timeout_seconds | floor) != .timeout_seconds then "timeout_seconds が正の整数でない"
        else empty end' <<<"$raw")"
    [[ -z "$problem" ]] || { echo "local_verify の宣言が不正: $problem"; return 1; }
    write_json "$SPEC" --arg worktree "$worktree" --argjson cfg "$raw" \
        '{worktree: $worktree, command: $cfg.command, engine: $cfg.db.engine, version: $cfg.db.version, env: $cfg.env, timeout_seconds: $cfg.timeout_seconds, expect_paths: ($cfg.expect_paths // [])}'
}

# ---------------------------------------------------------------------------
# supervise（detached。DB の確保 → command の実行 → 停止 → DB の削除）
# ---------------------------------------------------------------------------

DB_ID=''
CMD_PID=''

set_phase() {
    local phase="$1"; shift
    local prev='{}'
    [[ -f "$STATE" ]] && prev="$(cat "$STATE")"
    write_json "$STATE" --argjson prev "$prev" --arg phase "$phase" --argjson pid "$$" "$@" \
        '$prev + {phase: $phase, supervisor_pid: $pid} + ($ARGS.named | del(.prev, .phase, .pid))'
}

# DB を消す。EXIT trap と正常経路の両方から呼ばれるので 1 回だけ実行する。
delete_db() {
    [[ -n "$DB_ID" ]] || return 0
    local id="$DB_ID" out rc
    DB_ID=''
    out="$("$BROKER" delete "$id" 2>&1)"; rc=$?
    if (( rc == 0 )); then
        write_json "$DB_DELETED" --arg id "$id" '{id: $id, ok: true}'
    else
        write_json "$DB_DELETED" --arg id "$id" --arg error "$out" '{id: $id, ok: false, error: $error}'
    fi
}

kill_command() {
    [[ -n "$CMD_PID" ]] || return 0
    kill -TERM -- "-$CMD_PID" 2>/dev/null || kill -TERM "$CMD_PID" 2>/dev/null
    local until=$(( $(now) + STOP_GRACE_SEC ))
    while kill -0 "$CMD_PID" 2>/dev/null && (( $(now) < until )); do sleep "$POLL"; done
    kill -KILL -- "-$CMD_PID" 2>/dev/null
    kill -KILL "$CMD_PID" 2>/dev/null
    return 0
}

on_exit() {
    kill_command
    # pg-broker create の途中で TERM を受けると、create が返った後・DB_ID を代入する前に trap が走る。
    # create の応答は file に残しているので、そこから id を拾って消す。
    if [[ -z "$DB_ID" && ! -f "$DB_DELETED" ]]; then
        DB_ID="$(jq -r '.id // empty' "$STATE_DIR/broker-create.out" 2>/dev/null)"
    fi
    delete_db
    [[ -f "$RESULT" ]] || write_json "$RESULT" '{status: "stopped", exit_code: null}'
    set_phase done
}

supervise() {
    trap on_exit EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap '' HUP  # 起動元の shell が終わっても生き続ける

    local worktree cmd engine version env_name timeout
    worktree="$(read_field "$SPEC" .worktree)"
    cmd="$(read_field "$SPEC" .command)"
    engine="$(read_field "$SPEC" .engine)"
    version="$(read_field "$SPEC" .version)"
    env_name="$(read_field "$SPEC" .env)"
    timeout="$(read_field "$SPEC" .timeout_seconds)"

    local out rc reason='' url=''
    # db の無い宣言は DB を確保せず、env も渡さずに command を実行する
    if [[ -n "$engine" ]]; then
        set_phase creating

        # broker に届かない（未インストール・停止中）・DB を確保できないときは unavailable で終える。
        # 呼び出し側（dev-flow）はこれを fail-open にして CI の check の結果で判定する。
        "$BROKER" create --version "$version" >"$STATE_DIR/broker-create.out" 2>"$STATE_DIR/broker-create.err"; rc=$?
        out="$(cat "$STATE_DIR/broker-create.out" 2>/dev/null)"
        if (( rc != 0 )); then
            reason="$(tail -n 3 "$STATE_DIR/broker-create.err" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
            [[ -n "$reason" ]] || reason="pg-broker create が exit $rc"
            write_json "$RESULT" --arg reason "$reason" '{status: "unavailable", exit_code: null, reason: $reason}'
            set_phase unavailable --arg reason "$reason"
            exit 0
        fi
        DB_ID="$(jq -r '.id // empty' <<<"$out" 2>/dev/null)"
        url="$(jq -r '.database_url // empty' <<<"$out" 2>/dev/null)"
        if [[ -z "$DB_ID" || -z "$url" ]]; then
            reason="pg-broker create の応答に id / database_url が無い: ${out:0:200}"
            write_json "$RESULT" --arg reason "$reason" '{status: "unavailable", exit_code: null, reason: $reason}'
            set_phase unavailable --arg reason "$reason"
            exit 0
        fi
        set_phase running --arg db_id "$DB_ID" --argjson started_at "$(now)"
    else
        set_phase running --argjson started_at "$(now)"
    fi

    : >"$CMD_STARTED"
    # command は自分の process group で起こす（止めるときに孫まで届くように）
    set -m
    if [[ -n "$engine" ]]; then
        ( cd "$worktree" && export "$env_name=$url" && exec bash -c "$cmd" ) </dev/null >>"$CMD_LOG" 2>&1 &
    else
        ( cd "$worktree" && exec bash -c "$cmd" ) </dev/null >>"$CMD_LOG" 2>&1 &
    fi
    CMD_PID=$!
    set +m

    local deadline=$(( $(now) + timeout )) stop_reason=''
    while kill -0 "$CMD_PID" 2>/dev/null; do
        if [[ -e "$STOP_FILE" ]]; then stop_reason=stopped; break; fi
        if (( $(now) >= deadline )); then stop_reason=timeout; break; fi
        sleep "$POLL"
    done
    if [[ -n "$stop_reason" ]]; then
        kill_command
        echo "[local-verify] command を止めた（${stop_reason}）" >>"$CMD_LOG"
    fi
    wait "$CMD_PID" 2>/dev/null; rc=$?
    CMD_PID=''
    # expect_paths: exit 0 でも、宣言したファイルが終了後の worktree に無い・command の開始より前から更新されていなければ
    # failed（理由は log にも残し、log_tail で返す）。mtime が開始の印と同じものはその実行の更新と読む（秒精度の fs で
    # 開始と同じ秒に書かれた生成物を古いと誤判定しないため）
    local missing='' stale='' p paths_list
    if [[ -z "$stop_reason" ]] && (( rc == 0 )); then
        paths_list="$(jq -r '.expect_paths[]?' "$SPEC" 2>/dev/null)"
        while IFS= read -r p; do
            [[ -n "$p" ]] || continue
            if [[ ! -e "$worktree/$p" ]]; then missing+="${missing:+, }$p"
            elif [[ "$CMD_STARTED" -nt "$worktree/$p" ]]; then stale+="${stale:+, }$p"
            fi
        done <<<"$paths_list"
    fi
    local status
    if [[ -n "$stop_reason" ]]; then status="$stop_reason"
    elif [[ -n "$missing" || -n "$stale" ]]; then
        status=failed
        reason="command は exit 0 だが"
        [[ -z "$missing" ]] || reason+=" expect_paths が worktree に無い: $missing"
        [[ -z "$missing" || -z "$stale" ]] || reason+=" /"
        [[ -z "$stale" ]] || reason+=" expect_paths がこの実行で作られて・更新されていない（command の開始より前のまま）: $stale"
        echo "[local-verify] $reason" >>"$CMD_LOG"
    elif (( rc == 0 )); then status=passed
    else status=failed
    fi
    delete_db
    write_json "$RESULT" --arg status "$status" --argjson code "$rc" --arg reason "$reason" \
        '{status: $status, exit_code: $code} + (if $reason != "" then {reason: $reason} else {} end)'
    trap - EXIT
    set_phase done
}

# ---------------------------------------------------------------------------
# start / wait / stop
# ---------------------------------------------------------------------------

emit() { jq -nc "$@"; }

# result.json があれば wait の最終形を出して 0、無ければ 1。
emit_result() {
    [[ -f "$RESULT" ]] || return 1
    local tail_text deleted='null'
    tail_text="$(log_tail)"
    [[ -f "$DB_DELETED" ]] && deleted="$(jq -c '.ok' "$DB_DELETED" 2>/dev/null || echo null)"
    emit --argjson r "$(cat "$RESULT")" --arg log_path "$CMD_LOG" --arg log_tail "$tail_text" --argjson db_deleted "$deleted" \
        '{ok: ($r.status == "passed"), status: $r.status, exit_code: $r.exit_code, log_path: $log_path, log_tail: $log_tail, db_deleted: $db_deleted}
         + (if $r.reason then {reason: $r.reason} else {} end)'
    return 0
}

cmd_stop() {
    local timeout_sec="$1"
    [[ -f "$STATE" ]] || { emit '{ok: true, stopped: false, was_running: false}'; return; }
    local pid phase was_running=false
    pid="$(read_field "$STATE" .supervisor_pid)"
    phase="$(read_field "$STATE" .phase)"
    if is_alive "$pid" && [[ "$phase" != done ]]; then
        was_running=true
        date +%s > "$STOP_FILE"
        local until=$(( $(now) + timeout_sec ))
        while is_alive "$pid" && [[ "$(read_field "$STATE" .phase)" != done ]] && (( $(now) < until )); do sleep "$POLL"; done
    fi
    local alive=false
    is_alive "$pid" && [[ "$(read_field "$STATE" .phase)" != done ]] && alive=true
    # supervisor が KILL 等で trap を走らせずに居なくなったときは、ここで DB を消す
    if [[ "$alive" == false && ! -f "$DB_DELETED" ]]; then
        DB_ID="$(read_field "$STATE" .db_id)"
        delete_db
    fi
    local deleted='null'
    [[ -f "$DB_DELETED" ]] && deleted="$(jq -c '.ok' "$DB_DELETED" 2>/dev/null || echo null)"
    if [[ "$alive" == true ]]; then
        emit --argjson was "$was_running" --arg error "supervisor (pid $pid) が ${timeout_sec}s 以内に止まらなかった。stop file は残すので timeout_seconds で止まる" \
            '{ok: false, stopped: false, was_running: $was, db_deleted: null, error: $error}'
    else
        emit --argjson was "$was_running" --argjson db_deleted "$deleted" \
            '{ok: true, stopped: $was, was_running: $was, db_deleted: $db_deleted}'
    fi
}

cmd_wait() {
    local wait_sec="$1"
    [[ -f "$SPEC" ]] || { emit --arg error 'local-verify が起動していない（先に start する）' '{ok: false, status: "error", error: $error}'; return; }
    local until=$(( $(now) + wait_sec )) pid
    while :; do
        emit_result && return
        pid="$(read_field "$STATE" .supervisor_pid)"
        if [[ -n "$pid" ]] && ! is_alive "$pid"; then
            emit_result && return
            emit --arg error 'supervisor が結果を残さず終了した' --arg log_path "$SUP_LOG" '{ok: false, status: "error", error: $error, log_path: $log_path}'
            return
        fi
        if (( $(now) >= until )); then
            emit --arg log_path "$CMD_LOG" --arg log_tail "$(log_tail)" '{ok: false, status: "running", log_path: $log_path, log_tail: $log_tail}'
            return
        fi
        sleep "$POLL"
    done
}

cmd_start() {
    local worktree="$1" config_path="$2" wait_sec="$3" config_pct="$4"
    case "$worktree/" in
        "${STATE_DIR%/}/"*) emit --arg error "--state-dir ($STATE_DIR) が worktree と同じかその親になっている" '{ok: false, status: "error", error: $error}'; return ;;
    esac
    # 前回 run の残り（同じ state dir）を先に止める
    [[ -f "$STATE" ]] && cmd_stop 30 >/dev/null
    rm -rf "$STATE_DIR"
    mkdir -p "$LOG_DIR"
    local problem
    if ! problem="$(load_config "$worktree" "$config_path" "$config_pct")"; then
        emit --arg error "$problem" '{ok: false, status: "error", error: $error}'
        return
    fi
    if [[ -n "$(read_field "$SPEC" .engine)" ]] && ! command -v "$BROKER" >/dev/null 2>&1; then
        emit --arg reason "pg-broker が PATH に無い（${BROKER}）" '{ok: false, status: "unavailable", reason: $reason}'
        return
    fi
    set -m
    nohup bash "$SELF" supervise --state-dir "$STATE_DIR" </dev/null >>"$SUP_LOG" 2>&1 &
    local sup=$!
    set +m
    disown "$sup" 2>/dev/null

    # DB の確保（pg-broker create）が終わるまで待つ。終わらなければ running を返し、残りは wait が待つ。
    local until=$(( $(now) + wait_sec )) phase
    while :; do
        phase="$(read_field "$STATE" .phase)"
        case "$phase" in
            running) emit --arg log_path "$CMD_LOG" '{ok: true, status: "running", log_path: $log_path}'; return ;;
            unavailable) emit --arg reason "$(read_field "$STATE" .reason)" '{ok: false, status: "unavailable", reason: $reason}'; return ;;
            done) emit_result || emit --arg error 'supervisor が結果を残さず終了した' '{ok: false, status: "error", error: $error}'; return ;;
        esac
        if ! is_alive "$sup" && [[ "$(read_field "$STATE" .phase)" != done ]]; then
            emit_result && return
            emit --arg error 'supervisor が起動直後に終了した' --arg log_path "$SUP_LOG" '{ok: false, status: "error", error: $error, log_path: $log_path}'
            return
        fi
        if (( $(now) >= until )); then emit --arg log_path "$CMD_LOG" '{ok: true, status: "running", log_path: $log_path}'; return; fi
        sleep "$POLL"
    done
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

main() {
    local sub="${1:-}"
    [[ -n "$sub" ]] || usage 'subcommand (start|wait|stop) required'
    shift
    local state_dir='' worktree='' config_path='' config_pct='' wait_sec='' timeout_sec=60
    while (( $# > 0 )); do
        (( $# >= 2 )) || usage "Unknown or incomplete option: $1"
        case "$1" in
            --state-dir) state_dir="$2" ;;
            --worktree) worktree="$2" ;;
            --config) config_path="$2" ;;
            --config-pct) config_pct="$2" ;;
            --wait-sec) wait_sec="$2" ;;
            --timeout-sec) timeout_sec="$2" ;;
            *) usage "Unknown option: $1" ;;
        esac
        shift 2
    done
    [[ -n "$state_dir" ]] || usage '--state-dir is required'
    [[ -z "$wait_sec" || "$wait_sec" =~ ^[0-9]+$ ]] || usage "--wait-sec must be a non-negative integer, got '$wait_sec'"
    [[ "$timeout_sec" =~ ^[0-9]+$ ]] || usage "--timeout-sec must be a non-negative integer, got '$timeout_sec'"
    mkdir -p "$state_dir" 2>/dev/null
    paths "$(cd "$state_dir" 2>/dev/null && pwd || echo "$state_dir")"

    case "$sub" in
        supervise) supervise ;;
        start)
            [[ -n "$worktree" ]] || usage '--worktree is required'
            cmd_start "$(cd "$worktree" 2>/dev/null && pwd || echo "$worktree")" "$config_path" "${wait_sec:-300}" "$config_pct" ;;
        wait) cmd_wait "${wait_sec:-480}" ;;
        stop) cmd_stop "$timeout_sec" ;;
        *) usage "unknown subcommand: $sub" ;;
    esac
}

main "$@"
