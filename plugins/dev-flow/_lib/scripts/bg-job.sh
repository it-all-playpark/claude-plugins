# bg-job.sh - exec-proxy の command を切り離して実行し、Bash 1 回の上限（600 秒）を超えて待てるようにする共有ライブラリ（source 専用。単体では実行しない）
#
# プロセスモデル:
#   別の Bash 呼び出しからは kill できない（sandbox が別実体への signal を EPERM にする）ので、start は
#   detached な supervisor を 1 本起こし、command の起動・停止・後片付けはすべて supervisor が行う。
#   止めるときは state dir に stop file を置く。結果は supervisor が result.json に atomic に書く。
#   生存確認は kill -0 だけで行う（pgrep 等のプロセス一覧は sandbox 内で失敗する）。
#   sandbox 内で動かすので、source するスクリプトを excludedCommands に入れない。認証付きの network I/O を持たない。
#
# 出力契約: bg_job_start / bg_job_wait / bg_job_stop は stdout に JSON 1 行を出す。
#   1 回の Bash 呼び出しに収まるよう、start は phase が running になるまで最大 wait_sec（既定 300）、
#   wait は最大 wait_sec（既定 480）だけ待ち、終わっていなければ status:"running" を返す。
#   status: running / passed（exit 0）/ failed（exit 非 0 か bg_job_hook_check_success の理由あり）/
#           timeout（timeout_seconds 超過で停止）/ stopped（stop・TERM で停止）/ error /
#           bg_job_abort に渡した status（command を起動せずに終えた）
#
# source する側の手順:
#   source 後に BG_JOB_NAME（log と error の表記）と BG_JOB_SELF（自分の絶対パス）を設定し、必要な hook を上書きする。
#   BG_JOB_SELF は `supervise --state-dir <dir>` で起動されるので、その形を bg_job_paths → bg_job_supervise に渡す。
#   start は bg_job_reset <cwd>（失敗時は JSON を出し済み）→ $BG_JOB_SPEC に {cwd, command, timeout_seconds} を
#   bg_job_write_json で書く → bg_job_start の順に呼ぶ。spec の他のキーは hook が読むためのもので、この中では読まない。
#
# BG_JOB_POLL_SEC は状態確認の間隔（bats が短くするための上書き口）。

: "${BG_JOB_POLL_SEC:=1}"
BG_JOB_STOP_GRACE_SEC=10
# wait が返す log の末尾（dev-implementer への差し戻しに添える）。行数と文字数の両方で切る。
BG_JOB_TAIL_LINES=60
BG_JOB_TAIL_BYTES=4000

_BG_JOB_CMD_PID=''

# ---------------------------------------------------------------------------
# hook（source する側が上書きする。既定は何もしない）
# ---------------------------------------------------------------------------

# supervisor で command の起動前に呼ぶ。起動しないときは bg_job_abort で終える。
bg_job_hook_prepare() { :; }
# command のサブシェルで cwd に移った後に呼ぶ。ここでの export は command にだけ渡る。
bg_job_hook_command_env() { :; }
# command が exit 0 で終わった後に呼ぶ。stdout に理由を出すと failed にする（理由は log にも残す）。
bg_job_hook_check_success() { :; }
# supervisor の終わりに呼ぶ。正常経路と EXIT trap の両方から呼ばれるので、2 回呼ばれても 1 回分だけ働くように書く。
# 結果の読み手が片付いた状態を見られるよう、正常経路では result.json を書く前に呼ぶ。
bg_job_hook_cleanup() { :; }
# bg_job_stop が supervisor の不在を確かめた後に呼ぶ。KILL 等で trap を走らせずに居なくなった場合の片付け。
bg_job_hook_orphan_cleanup() { :; }
# 結果（wait）と stop の JSON に足すフィールドを object で stdout に出す。
bg_job_hook_extra_fields() { echo '{}'; }

# ---------------------------------------------------------------------------
# 共通
# ---------------------------------------------------------------------------

bg_job_paths() {
    BG_JOB_STATE_DIR="$1"
    BG_JOB_SPEC="$BG_JOB_STATE_DIR/spec.json"
    BG_JOB_STATE="$BG_JOB_STATE_DIR/state.json"
    BG_JOB_RESULT="$BG_JOB_STATE_DIR/result.json"
    BG_JOB_STOP_FILE="$BG_JOB_STATE_DIR/stop"
    BG_JOB_LOG_DIR="$BG_JOB_STATE_DIR/logs"
    BG_JOB_CMD_LOG="$BG_JOB_LOG_DIR/command.log"
    BG_JOB_SUP_LOG="$BG_JOB_LOG_DIR/supervisor.log"
}

_bg_job_now() { date +%s; }

# jq で組んだ JSON を atomic に書く（読み手が書きかけを読まないように）
bg_job_write_json() {
    local path="$1"; shift
    local tmp="$path.$$.tmp"
    jq -n "$@" > "$tmp" && mv "$tmp" "$path"
}

bg_job_read_field() { jq -r "$2 // empty" "$1" 2>/dev/null; }

bg_job_emit() { jq -nc "$@"; }

# 別 sandbox 実体のプロセスへの kill -0 は EPERM になる。EPERM は「存在する」と読む。
bg_job_is_alive() {
    local pid="$1" err
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    err="$(kill -0 "$pid" 2>&1)" && return 0
    [[ "$err" == *"not permitted"* ]]
}

_bg_job_log_tail() {
    [[ -f "$BG_JOB_CMD_LOG" ]] || { printf ''; return; }
    tail -n "$BG_JOB_TAIL_LINES" "$BG_JOB_CMD_LOG" | tail -c "$BG_JOB_TAIL_BYTES"
}

# ---------------------------------------------------------------------------
# supervise（detached。prepare → command の実行 → 停止 → 後片付け）
# ---------------------------------------------------------------------------

bg_job_set_phase() {
    local phase="$1"; shift
    local prev='{}'
    [[ -f "$BG_JOB_STATE" ]] && prev="$(cat "$BG_JOB_STATE")"
    bg_job_write_json "$BG_JOB_STATE" --argjson prev "$prev" --arg phase "$phase" --argjson pid "$$" "$@" \
        '$prev + {phase: $phase, supervisor_pid: $pid} + ($ARGS.named | del(.prev, .phase, .pid))'
}

# prepare で command を起動せずに終える。start は phase に置いた status と reason を返す。
bg_job_abort() {
    local status="$1" reason="$2"
    bg_job_write_json "$BG_JOB_RESULT" --arg status "$status" --arg reason "$reason" '{status: $status, exit_code: null, reason: $reason}'
    bg_job_set_phase "$status" --arg reason "$reason"
    exit 0
}

_bg_job_kill_command() {
    [[ -n "$_BG_JOB_CMD_PID" ]] || return 0
    kill -TERM -- "-$_BG_JOB_CMD_PID" 2>/dev/null || kill -TERM "$_BG_JOB_CMD_PID" 2>/dev/null
    local until=$(( $(_bg_job_now) + BG_JOB_STOP_GRACE_SEC ))
    while kill -0 "$_BG_JOB_CMD_PID" 2>/dev/null && (( $(_bg_job_now) < until )); do sleep "$BG_JOB_POLL_SEC"; done
    kill -KILL -- "-$_BG_JOB_CMD_PID" 2>/dev/null
    kill -KILL "$_BG_JOB_CMD_PID" 2>/dev/null
    return 0
}

_bg_job_on_exit() {
    _bg_job_kill_command
    bg_job_hook_cleanup
    [[ -f "$BG_JOB_RESULT" ]] || bg_job_write_json "$BG_JOB_RESULT" '{status: "stopped", exit_code: null}'
    bg_job_set_phase done
}

bg_job_supervise() {
    trap _bg_job_on_exit EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    trap '' HUP  # 起動元の shell が終わっても生き続ける

    local cwd cmd timeout rc
    cwd="$(bg_job_read_field "$BG_JOB_SPEC" .cwd)"
    cmd="$(bg_job_read_field "$BG_JOB_SPEC" .command)"
    timeout="$(bg_job_read_field "$BG_JOB_SPEC" .timeout_seconds)"

    bg_job_set_phase preparing
    bg_job_hook_prepare
    bg_job_set_phase running --argjson started_at "$(_bg_job_now)"

    # command は自分の process group で起こす（止めるときに孫まで届くように）
    set -m
    ( cd "$cwd" && bg_job_hook_command_env && exec bash -c "$cmd" ) </dev/null >>"$BG_JOB_CMD_LOG" 2>&1 &
    _BG_JOB_CMD_PID=$!
    set +m

    local deadline=$(( $(_bg_job_now) + timeout )) stop_reason=''
    while kill -0 "$_BG_JOB_CMD_PID" 2>/dev/null; do
        if [[ -e "$BG_JOB_STOP_FILE" ]]; then stop_reason=stopped; break; fi
        if (( $(_bg_job_now) >= deadline )); then stop_reason=timeout; break; fi
        sleep "$BG_JOB_POLL_SEC"
    done
    if [[ -n "$stop_reason" ]]; then
        _bg_job_kill_command
        echo "[$BG_JOB_NAME] command を止めた（${stop_reason}）" >>"$BG_JOB_CMD_LOG"
    fi
    wait "$_BG_JOB_CMD_PID" 2>/dev/null; rc=$?
    _BG_JOB_CMD_PID=''

    local reason='' status
    if [[ -z "$stop_reason" ]] && (( rc == 0 )); then reason="$(bg_job_hook_check_success)"; fi
    if [[ -n "$stop_reason" ]]; then status="$stop_reason"
    elif [[ -n "$reason" ]]; then
        status=failed
        echo "[$BG_JOB_NAME] $reason" >>"$BG_JOB_CMD_LOG"
    elif (( rc == 0 )); then status=passed
    else status=failed
    fi
    bg_job_hook_cleanup
    bg_job_write_json "$BG_JOB_RESULT" --arg status "$status" --argjson code "$rc" --arg reason "$reason" \
        '{status: $status, exit_code: $code} + (if $reason != "" then {reason: $reason} else {} end)'
    trap - EXIT
    bg_job_set_phase done
}

# ---------------------------------------------------------------------------
# start / wait / stop
# ---------------------------------------------------------------------------

# result.json があれば最終形を出して 0、無ければ 1。
_bg_job_emit_result() {
    [[ -f "$BG_JOB_RESULT" ]] || return 1
    bg_job_emit --argjson r "$(cat "$BG_JOB_RESULT")" --arg log_path "$BG_JOB_CMD_LOG" --arg log_tail "$(_bg_job_log_tail)" --argjson extra "$(bg_job_hook_extra_fields)" \
        '{ok: ($r.status == "passed"), status: $r.status, exit_code: $r.exit_code, log_path: $log_path, log_tail: $log_tail}
         + $extra + (if $r.reason then {reason: $r.reason} else {} end)'
    return 0
}

# bg_job_stop [timeout_sec=60]
bg_job_stop() {
    local timeout_sec="${1:-60}"
    [[ -f "$BG_JOB_STATE" ]] || { bg_job_emit '{ok: true, stopped: false, was_running: false}'; return; }
    local pid phase was_running=false
    pid="$(bg_job_read_field "$BG_JOB_STATE" .supervisor_pid)"
    phase="$(bg_job_read_field "$BG_JOB_STATE" .phase)"
    if bg_job_is_alive "$pid" && [[ "$phase" != done ]]; then
        was_running=true
        date +%s > "$BG_JOB_STOP_FILE"
        local until=$(( $(_bg_job_now) + timeout_sec ))
        while bg_job_is_alive "$pid" && [[ "$(bg_job_read_field "$BG_JOB_STATE" .phase)" != done ]] && (( $(_bg_job_now) < until )); do sleep "$BG_JOB_POLL_SEC"; done
    fi
    local alive=false
    bg_job_is_alive "$pid" && [[ "$(bg_job_read_field "$BG_JOB_STATE" .phase)" != done ]] && alive=true
    if [[ "$alive" == true ]]; then
        bg_job_emit --argjson was "$was_running" --argjson extra "$(bg_job_hook_extra_fields)" --arg error "supervisor (pid $pid) が ${timeout_sec}s 以内に止まらなかった。stop file は残すので timeout_seconds で止まる" \
            '{ok: false, stopped: false, was_running: $was} + $extra + {error: $error}'
    else
        bg_job_hook_orphan_cleanup
        bg_job_emit --argjson was "$was_running" --argjson extra "$(bg_job_hook_extra_fields)" \
            '{ok: true, stopped: $was, was_running: $was} + $extra'
    fi
}

# bg_job_wait [wait_sec=480]
bg_job_wait() {
    local wait_sec="${1:-480}"
    [[ -f "$BG_JOB_SPEC" ]] || { bg_job_emit --arg error "$BG_JOB_NAME が起動していない（先に start する）" '{ok: false, status: "error", error: $error}'; return; }
    local until=$(( $(_bg_job_now) + wait_sec )) pid
    while :; do
        _bg_job_emit_result && return
        pid="$(bg_job_read_field "$BG_JOB_STATE" .supervisor_pid)"
        if [[ -n "$pid" ]] && ! bg_job_is_alive "$pid"; then
            _bg_job_emit_result && return
            bg_job_emit --arg error 'supervisor が結果を残さず終了した' --arg log_path "$BG_JOB_SUP_LOG" '{ok: false, status: "error", error: $error, log_path: $log_path}'
            return
        fi
        if (( $(_bg_job_now) >= until )); then
            bg_job_emit --arg log_path "$BG_JOB_CMD_LOG" --arg log_tail "$(_bg_job_log_tail)" '{ok: false, status: "running", log_path: $log_path, log_tail: $log_tail}'
            return
        fi
        sleep "$BG_JOB_POLL_SEC"
    done
}

# 同じ state dir の前の実行を止め、state dir を作り直す。続行できないときは JSON を出して 1 を返す。
# bg_job_reset <cwd> [stop_timeout_sec=30]
bg_job_reset() {
    local cwd="$1" stop_timeout="${2:-30}" stopped
    case "$cwd/" in
        "${BG_JOB_STATE_DIR%/}/"*) bg_job_emit --arg error "--state-dir ($BG_JOB_STATE_DIR) が worktree と同じかその親になっている" '{ok: false, status: "error", error: $error}'; return 1 ;;
    esac
    if [[ -f "$BG_JOB_STATE" ]]; then
        stopped="$(bg_job_stop "$stop_timeout")"
        # 止まっていない supervisor の state dir を消して起動すると二重に走る
        if [[ "$(jq -r '.ok' <<<"$stopped")" != true ]]; then
            bg_job_emit --arg error "前の実行を止められないので起動しない: $(jq -r '.error // empty' <<<"$stopped")" '{ok: false, status: "error", error: $error}'
            return 1
        fi
    fi
    rm -rf "$BG_JOB_STATE_DIR"
    mkdir -p "$BG_JOB_LOG_DIR"
}

# bg_job_reset と spec の書き込みの後に呼ぶ。supervisor を起こして phase が running になるまで待つ。
# bg_job_start [wait_sec=300]
bg_job_start() {
    local wait_sec="${1:-300}"
    set -m
    nohup bash "$BG_JOB_SELF" supervise --state-dir "$BG_JOB_STATE_DIR" </dev/null >>"$BG_JOB_SUP_LOG" 2>&1 &
    local sup=$!
    set +m
    disown "$sup" 2>/dev/null

    # prepare（DB の確保等）が終わるまで待つ。終わらなければ running を返し、残りは wait が待つ。
    local until=$(( $(_bg_job_now) + wait_sec )) phase
    while :; do
        phase="$(bg_job_read_field "$BG_JOB_STATE" .phase)"
        case "$phase" in
            running) bg_job_emit --arg log_path "$BG_JOB_CMD_LOG" '{ok: true, status: "running", log_path: $log_path}'; return ;;
            done) _bg_job_emit_result || bg_job_emit --arg error 'supervisor が結果を残さず終了した' '{ok: false, status: "error", error: $error}'; return ;;
            ''|preparing) ;;
            *) bg_job_emit --arg status "$phase" --arg reason "$(bg_job_read_field "$BG_JOB_STATE" .reason)" '{ok: false, status: $status, reason: $reason}'; return ;;
        esac
        if ! bg_job_is_alive "$sup" && [[ "$(bg_job_read_field "$BG_JOB_STATE" .phase)" != done ]]; then
            _bg_job_emit_result && return
            bg_job_emit --arg error 'supervisor が起動直後に終了した' --arg log_path "$BG_JOB_SUP_LOG" '{ok: false, status: "error", error: $error, log_path: $log_path}'
            return
        fi
        if (( $(_bg_job_now) >= until )); then bg_job_emit --arg log_path "$BG_JOB_CMD_LOG" '{ok: true, status: "running", log_path: $log_path}'; return; fi
        sleep "$BG_JOB_POLL_SEC"
    done
}
