#!/usr/bin/env bash
# pr-push.sh - dev-flow の PR phase と pr-iterate の push を切り離して実行し、出力全文を log に残して末尾行だけを JSON で返す
#
# Usage:
#   pr-push start <log-file>
#   pr-push wait  <log-file> [--wait-sec <n=480>]
#   pr-push stop  <log-file> [--timeout-sec <n=60>]
#   （内部）pr-push supervise --state-dir <dir> / pr-push run
#
# cwd（PR の worktree）で `git push origin HEAD` を 1 回だけ実行する（--no-verify は付けない・
# リトライしない。-u は付けない — 起動元 repo の .git/config は sandbox 内から書けないので upstream を書かない）。
#
# 切り離し実行: lock 待ちと pre-push hook を含む push は Bash 1 回の上限（600 秒）を超えうるので、start は push を
# 切り離して起動してすぐ返り、wait が最大 --wait-sec 待つ。stop は push を止める（TERM は hook まで届き、lock も解放する）。
# supervisor・状態ファイルは _lib/scripts/bg-job.sh が持ち、state dir は <log-file>.job（終わった前回の残りは start が作り直す）。
# 同じ log の push が走っている間の start は新しい push を起動せず running を返し、走っている push はそのまま続ける（結果は wait で受け取る）。
# fix#i-retry のような再 spawn が start から実行し直しても、push を二重にせず、途中まで進んだ hook も捨てない。
# 止まらないまま残らないよう、切り離した push は PR_PUSH_TIMEOUT_SEC で打ち切る（status "timeout"）。workflow の待機の累計上限
# （PR_PUSH_MAX_WAIT_SEC）より長くして、普段は workflow の stop で止まる。これは run が落ちて stop が呼ばれないときのための上限。
#
# 出力（stdout, JSON 1 行。呼び出し側 agent は verbatim で転写するだけ）:
#   {"status":"running|passed|failed|timeout|stopped|error","exit_code":N|null,"log":"<log-file の絶対パス>","tail":"...","epoch":N}
#   status は bg-job の status（passed = exit 0 / failed = exit 非 0）。running の exit_code は null、tail は空文字。
#   stop だけは bg_job_stop の {"ok":bool,"stopped":bool,"was_running":bool} を返す。
# exit: JSON を出力したら 0（判定は JSON の status）/ 引数不正・log ディレクトリ作成失敗・git repo 外は push せず 2（status "error" の JSON を出す）。
# lock の待ち上限超過は push せず exit_code LOCK_TIMEOUT_EXIT で、tail に `pr-push: lock_timeout ...` を返す。
#
# pre-push hook の出力（全リポジトリの lint warning 等）は呼び出し側 agent の tool 出力上限を超えると
# 途中で切れ、hook の最終行と git の `failed to push` 行が見えなくなる。返す量を末尾数行に固定して、
# 出力全体の長さに関係なく末尾を渡す。全文は <log-file> に残るので、人間はそこで失敗した段を確認する。
# tail は ANSI エスケープと \r 区切りの進捗表示を落とし、PUSH_TAIL_LINES 行・1 行 PUSH_TAIL_MAX_COLS バイトで切る
# （1 行が極端に長い出力でも返す量の上限を固定するため）。
#
# 認証付き network I/O を内部に持つ exec-proxy の例外（.claude/rules/dev-flow.md）。sandbox 内で動き、
# pre-push hook（repo の任意コード）も sandbox 内で走る。hook が sandbox 内で前提を満たせない処理（docker 等）は
# その repo の hook 側で skip する（E2E は CI が回す）。
#
# push は repo 単位の排他 lock（git-common-dir 配下の dev-flow-pr-push.lock/、worktree 間で共有）を取ってから行う。
# 同じ repo の並行 run の pre-push hook が同時に走ると、テストが CPU を奪い合って落ちるため。
# lock は mkdir / rmdir だけで取得・解放する（sandbox 内から書ける場所。$TMPDIR はセッションごとに別なので使えない）。
# 保持者は lock 内の pid-<PID>/ で記録し、`kill -0` が ESRCH のときだけ stale として奪う — sandbox 内の
# `kill -0` は生きている他プロセスにも EPERM を返すので、EPERM は生きている扱い。
# PR_PUSH_LOCK_WAIT_SECONDS 秒待っても取れなければ push せず、log に `pr-push: lock_timeout ...` を書いて
# exit LOCK_TIMEOUT_EXIT で終了する（hook 失敗の exit 1 と区別する）。待ち上限は workflow の待機の累計上限
# （PR_PUSH_MAX_WAIT_SEC）の半分に置き、残りを push 自体に充てる。

set -uo pipefail

PUSH_TAIL_LINES=5
PUSH_TAIL_MAX_COLS=500
PUSH_LOCK_WAIT_SECONDS="${PR_PUSH_LOCK_WAIT_SECONDS:-1800}"
PUSH_LOCK_POLL_SECONDS="${PR_PUSH_LOCK_POLL_SECONDS:-2}"
LOCK_TIMEOUT_EXIT=75
PUSH_TIMEOUT_SEC="${PR_PUSH_TIMEOUT_SEC:-4200}"
USAGE="usage: pr-push start <log-file> | wait <log-file> [--wait-sec <n>] | stop <log-file> [--timeout-sec <n>]"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_lib/scripts/bg-job.sh
source "$SCRIPT_DIR/../../_lib/scripts/bg-job.sh"
BG_JOB_NAME=pr-push
BG_JOB_SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

log=""

# $1 status / $2 exit_code（JSON の数値か null）/ $3 tail
emit() {
    jq -nc --arg s "$1" --argjson c "$2" --arg l "$log" --arg t "$3" --argjson e "$(date +%s)" \
        '{status: $s, exit_code: $c, log: $l, tail: $t, epoch: $e}'
}

usage_error() {
    emit error null "$USAGE"
    exit 2
}

# bg-job の command の出力先を <log-file> にする（stop・timeout で止めた行も全文の末尾に残り、tail に載る）
job_paths() {
    log="$1"
    bg_job_paths "$log.job"
    BG_JOB_CMD_LOG="$log"
}

# log の引数を絶対パスにする（supervisor は cwd を移るので、相対パスのままだと別の場所を指す）
resolve_log() {
    [[ -n "${1:-}" ]] || usage_error
    local dir
    if ! mkdir -p "$(dirname "$1")" || ! dir="$(cd "$(dirname "$1")" && pwd)"; then
        log="$1"
        emit error null "cannot create log directory for: $1"
        exit 2
    fi
    job_paths "$dir/$(basename "$1")"
}

log_tail() {
    [[ -f "$log" ]] || return 0
    local esc
    esc="$(printf '\033')"
    LC_ALL=C tr '\r' '\n' <"$log" \
        | LC_ALL=C sed "s/${esc}\[[0-9;?]*[A-Za-z]//g" \
        | LC_ALL=C grep -v '^[[:space:]]*$' \
        | tail -n "$PUSH_TAIL_LINES" \
        | LC_ALL=C cut -c "1-${PUSH_TAIL_MAX_COLS}"
}

# bg-job の応答を pr-push の JSON に写す。読み手が見るのはこの形だけ。push を起動できなかった等で log に何も無いときは
# bg-job の理由を tail に入れる
emit_job_response() {
    local res="$1" status code tail
    status="$(jq -r '.status // empty' <<<"$res" 2>/dev/null)"
    if [[ "$status" == running ]]; then
        emit running null ""
        return
    fi
    code="$(jq -c '.exit_code // null' <<<"$res" 2>/dev/null)"
    tail="$(log_tail)"
    [[ -n "$tail" ]] || tail="$(jq -r '.error // .reason // ""' <<<"$res" 2>/dev/null)"
    emit "${status:-error}" "${code:-null}" "$tail"
}

push_running() {
    [[ -f "$BG_JOB_STATE" ]] || return 1
    bg_job_is_alive "$(bg_job_read_field "$BG_JOB_STATE" .supervisor_pid)" \
        && [[ "$(bg_job_read_field "$BG_JOB_STATE" .phase)" != done ]]
}

cmd_start() {
    local reset cmd
    if ! git rev-parse --path-format=absolute --git-common-dir >/dev/null 2>&1; then
        emit error null "not a git repository: $PWD"
        exit 2
    fi
    if push_running; then
        emit running null ""
        return
    fi
    reset="$(bg_job_reset "$PWD")" || { emit_job_response "$reset"; return; }
    : >"$log"
    printf -v cmd '%q ' bash "$BG_JOB_SELF" run
    bg_job_write_json "$BG_JOB_SPEC" --arg cwd "$PWD" --arg cmd "$cmd" --argjson timeout "$PUSH_TIMEOUT_SEC" \
        '{cwd: $cwd, command: $cmd, timeout_seconds: $timeout}'
    emit_job_response "$(bg_job_start)"
}

SUBCOMMAND="${1:-}"
[[ $# -eq 0 ]] || shift
case "$SUBCOMMAND" in
    start)
        [[ $# -eq 1 ]] || usage_error
        resolve_log "$1"
        cmd_start
        exit 0
        ;;
    wait|stop)
        flag=--wait-sec
        [[ "$SUBCOMMAND" == wait ]] || flag=--timeout-sec
        [[ $# -eq 1 || ( $# -eq 3 && "$2" == "$flag" && "$3" =~ ^[0-9]+$ ) ]] || usage_error
        resolve_log "$1"
        if [[ "$SUBCOMMAND" == wait ]]; then
            emit_job_response "$(bg_job_wait "${3:-}")"
        else
            bg_job_stop "${3:-}"
        fi
        exit 0
        ;;
    supervise)
        [[ $# -eq 2 && "$1" == "--state-dir" ]] || usage_error
        job_paths "${2%.job}"
        bg_job_supervise
        exit 0
        ;;
    run)
        # 以下は supervisor が cwd を worktree に移し、stdout / stderr を <log-file> に向けて起動する中身
        ;;
    *)
        usage_error
        ;;
esac

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || exit 2
lock="${common_dir}/dev-flow-pr-push.lock"
held=0

release_lock() {
    [[ "$held" -eq 1 ]] || return 0
    rmdir "${lock}/pid-$$" "$lock" 2>/dev/null
    held=0
}
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# 保持者の PID が ESRCH（存在しない）なら、その pid-<PID>/ のパスを出して 0 を返す。
# 保持者の記録がまだ無い（mkdir 直後）・生きている・EPERM のときは 1。
stale_holder() {
    local entry pid err
    for entry in "$lock"/pid-*; do
        [[ -d "$entry" ]] || continue
        pid="${entry##*/pid-}"
        err="$(export LC_ALL=C; kill -0 "$pid" 2>&1)" && return 1
        [[ "$err" == *"No such process"* ]] || return 1
        echo "$entry"
        return 0
    done
    return 1
}

wait_start=$SECONDS
while ! mkdir "$lock" 2>/dev/null; do
    # pid-<PID>/ を消せた 1 プロセスだけが lock 本体を消す（同時に奪いに来た側は rmdir に失敗して待ちに戻る）
    if stale="$(stale_holder)" && rmdir "$stale" 2>/dev/null && rmdir "$lock" 2>/dev/null; then
        continue
    fi
    if (( SECONDS - wait_start >= PUSH_LOCK_WAIT_SECONDS )); then
        echo "pr-push: lock_timeout waited=${PUSH_LOCK_WAIT_SECONDS}s lock=${lock} (another push in this repo still holds the lock; not pushed)"
        exit "$LOCK_TIMEOUT_EXIT"
    fi
    sleep "$PUSH_LOCK_POLL_SECONDS"
done
held=1
mkdir "${lock}/pid-$$"

git push origin HEAD
exit $?
