#!/usr/bin/env bash
# pre-push-hook.sh - push せずに対象 worktree の pre-push hook を 1 回だけ切り離して実行する exec-proxy（issue #1435）。
#
# Usage:
#   pre-push-hook start <worktree>
#   pre-push-hook wait  <worktree> [--wait-sec <n=450>]
#   pre-push-hook stop  <worktree> [--timeout-sec <n=60>]
#   （内部）pre-push-hook supervise --state-dir <dir> / pre-push-hook run <log-dir> <url>
#
# PR phase の push（pr-push）が失敗したとき、原因が対象 repo の pre-push hook かを workflow が確かめるために使う。
# push・fetch はしない（network I/O を持たない）。remote の ref・HEAD・実 index は書かない。
#
# hook には `git push origin HEAD` が渡すのと同じ形の入力を渡す:
#   stdin: `<local ref> <local sha> <remote ref> <remote sha>` の 1 行。local は worktree の HEAD とその branch、remote ref は
#          同名の branch、remote sha は remote-tracking ref（refs/remotes/origin/<branch>）の値で、無ければ全 0（新規 branch）
#   引数:  remote 名（origin）と push 先の URL
# hook の解決と起動は git に任せる: 有無は `git hook list pre-push` の exit code（0 = ある / 1 = 無い）、起動は
# `git hook run pre-push` だけで行う。hook を飛ばす・無効化する手段（環境変数・設定の上書き）は使わない — ここで通しても
# 次の push が同じ hook に落ちる。sandbox 内で動かす（hook は repo の任意コード。excludedCommands に登録しない）。
#
# 切り離し実行: hook（build・テスト等）は Bash 1 回の上限（600 秒）を超えうるので、start は hook を切り離して起動して
# すぐ返り、wait が最大 --wait-sec 待つ。stop は hook を止める。supervisor・状態ファイルは _lib/scripts/bg-job.sh が持ち、
# state dir は <worktree>/.devflow-tmp/pre-push-hook.job。同じ worktree の hook が走っている間の start は新しく起動せず
# running を返す。止まらないまま残らないよう PRE_PUSH_HOOK_TIMEOUT_SEC で打ち切る（workflow の待機の累計上限より長くして、
# 普段は workflow の stop で止まる）。
# hook は pr-push と同じ repo 単位の push lock（_lib/scripts/push-lock.sh）を取ってから起動する — 並行 run の push hook と
# 同時に走ると CPU を奪い合って相手の push も自分の結果も落ちるため。待ち上限を超えたら hook を起動せず error（lock_timeout）。
#
# 出力（stdout, JSON 1 行。呼び出し側 agent は verbatim で転写するだけ）:
#   {"hook":"none|passed|failed|error|running","exit":N|null,"log":"...","error":"..."}
#   none    — pre-push hook が無い。何も実行しない
#   running — hook が走っている（結果は wait で受け取る）
#   passed  — hook が exit 0
#   failed  — hook が exit 非 0。exit は hook の終了コード
#   error   — hook の結果を確定できない（引数不正・git の work tree でない・branch 上に居ない・origin が無い・stop や
#             打ち切りで止めた等。error に理由）
#   log は hook の出力全文のパス（$TMPDIR 配下 = worktree の外）。hook の出力そのものは返さない（PR が書いたファイル名・
#   ソース行が載るので、呼び出し側の prompt に流さない）。
#   stop だけは bg_job_stop の {"ok":bool,"stopped":bool,"was_running":bool} を返す。
# exit: JSON を出力したら 0（判定は JSON の hook）/ hook を起動する前の失敗（引数不正等）は 2（hook "error" の JSON を出す）。
set -uo pipefail

HOOK_TIMEOUT_SEC="${PRE_PUSH_HOOK_TIMEOUT_SEC:-4200}"
WAIT_SEC_DEFAULT=450
# pr-push と同じ lock を同じ待ち上限で取る（_lib/scripts/push-lock.sh）
LOCK_WAIT_SEC="${PR_PUSH_LOCK_WAIT_SECONDS:-1800}"
LOCK_POLL_SEC="${PR_PUSH_LOCK_POLL_SECONDS:-2}"
LOCK_TIMEOUT_EXIT=75
USAGE="usage: pre-push-hook start <worktree> | wait <worktree> [--wait-sec <n>] | stop <worktree> [--timeout-sec <n>]"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_lib/scripts/bg-job.sh
source "$SCRIPT_DIR/../../_lib/scripts/bg-job.sh"
BG_JOB_NAME=pre-push-hook
BG_JOB_SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

log=""

# $1 hook / $2 exit（JSON の数値か null）/ $3 error（空なら出さない）
emit() {
    jq -nc --arg h "$1" --argjson x "$2" --arg l "$log" --arg e "$3" \
        '{hook: $h, exit: $x, log: $l} + (if $e == "" then {} else {error: $e} end)'
}

fail() {
    emit error null "$1"
    exit 2
}

# state dir を決め、起動済みなら spec に残した log のパスを読む（bg-job の command の出力先もそこにする）
job_paths() {
    bg_job_paths "$1"
    if [[ -f "$BG_JOB_SPEC" ]]; then
        log="$(bg_job_read_field "$BG_JOB_SPEC" .log)"
        [[ -z "$log" ]] || BG_JOB_CMD_LOG="$log"
    fi
}

enter_worktree() {
    [[ -n "${1:-}" ]] || fail "$USAGE"
    cd "$1" 2>/dev/null || fail "cd failed: $1"
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git work tree: $PWD"
    job_paths "$PWD/.devflow-tmp/pre-push-hook.job"
}

# bg-job の応答を pre-push-hook の JSON に写す。passed / failed 以外で終わった実行（stop・打ち切り・supervisor の異常）は
# hook の成否が分からないので error にする
emit_job_response() {
    local res="$1" status
    status="$(jq -r '.status // empty' <<<"$res" 2>/dev/null)"
    case "$status" in
        running) emit running null "" ;;
        passed) emit passed 0 "" ;;
        failed)
            if [[ -n "$log" && -e "${log%/*}/lock_timeout" ]]; then
                emit error null "lock_timeout: another push in this repo still holds the push lock; hook not run"
            else
                emit failed "$(jq -c '.exit_code // null' <<<"$res")" ""
            fi
            ;;
        *) emit error null "${status:-no status}: $(jq -r '.error // .reason // "hook did not finish"' <<<"$res" 2>/dev/null)" ;;
    esac
}

hook_running() {
    [[ -f "$BG_JOB_STATE" ]] || return 1
    bg_job_is_alive "$(bg_job_read_field "$BG_JOB_STATE" .supervisor_pid)" \
        && [[ "$(bg_job_read_field "$BG_JOB_STATE" .phase)" != done ]]
}

cmd_start() {
    local list_rc ref sha remote_sha url log_dir reset cmd
    if hook_running; then
        emit running null ""
        return
    fi
    log=""
    git hook list pre-push >/dev/null 2>&1
    list_rc=$?
    if [[ $list_rc -eq 1 ]]; then
        emit none null ""
        return
    fi
    [[ $list_rc -eq 0 ]] || fail "git hook list failed (exit $list_rc)"

    ref="$(git symbolic-ref -q HEAD)" || fail "HEAD is not on a branch"
    sha="$(git rev-parse --verify -q HEAD)" || fail "cannot resolve HEAD"
    remote_sha="$(git rev-parse --verify -q "refs/remotes/origin/${ref#refs/heads/}")" \
        || remote_sha="$(printf '%s' "$sha" | tr '0-9a-f' '0')"
    url="$(git remote get-url --push origin 2>/dev/null)" || fail "remote origin has no push URL"

    log_dir="$(mktemp -d "${TMPDIR:-/tmp}/pre-push-hook-XXXXXX")" || fail "cannot create log dir under ${TMPDIR:-/tmp}"
    printf '%s %s %s %s\n' "$ref" "$sha" "$ref" "$remote_sha" >"$log_dir/stdin"

    reset="$(bg_job_reset "$PWD")" || fail "$(jq -r '.error // "cannot reset the state dir"' <<<"$reset" 2>/dev/null)"
    log="$log_dir/hook.log"
    : >"$log"
    BG_JOB_CMD_LOG="$log"
    printf -v cmd '%q ' bash "$BG_JOB_SELF" run "$log_dir" "$url"
    bg_job_write_json "$BG_JOB_SPEC" --arg cwd "$PWD" --arg cmd "$cmd" --argjson timeout "$HOOK_TIMEOUT_SEC" --arg log "$log" \
        '{cwd: $cwd, command: $cmd, timeout_seconds: $timeout, log: $log}'
    emit_job_response "$(bg_job_start)"
}

SUBCOMMAND="${1:-}"
[[ $# -eq 0 ]] || shift
case "$SUBCOMMAND" in
    start)
        [[ $# -eq 1 ]] || fail "$USAGE"
        enter_worktree "$1"
        cmd_start
        ;;
    wait|stop)
        flag=--wait-sec
        [[ "$SUBCOMMAND" == wait ]] || flag=--timeout-sec
        [[ $# -eq 1 || ( $# -eq 3 && "$2" == "$flag" && "$3" =~ ^[0-9]+$ ) ]] || fail "$USAGE"
        enter_worktree "$1"
        if [[ "$SUBCOMMAND" == wait ]]; then
            emit_job_response "$(bg_job_wait "${3:-$WAIT_SEC_DEFAULT}")"
        else
            bg_job_stop "${3:-}"
        fi
        ;;
    supervise)
        [[ $# -eq 2 && "$1" == "--state-dir" ]] || fail "$USAGE"
        job_paths "$2"
        bg_job_supervise
        ;;
    run)
        # supervisor が cwd を worktree に移し、stdout / stderr を hook の log に向けて起動する中身。
        # pr-push と同じ repo 単位の lock の下で hook を起動する（並行 run の push hook と CPU を奪い合わない）
        [[ $# -eq 2 ]] || exit 2
        # shellcheck source=../../_lib/scripts/push-lock.sh
        source "$SCRIPT_DIR/../../_lib/scripts/push-lock.sh"
        push_lock_acquire "$LOCK_WAIT_SEC" "$LOCK_POLL_SEC" pre-push-hook
        case $? in
            0) ;;
            1) : >"$1/lock_timeout"; exit "$LOCK_TIMEOUT_EXIT" ;;
            *) exit 2 ;;
        esac
        git hook run pre-push "--to-stdin=$1/stdin" -- origin "$2"
        exit $?
        ;;
    *)
        fail "$USAGE"
        ;;
esac
exit 0
