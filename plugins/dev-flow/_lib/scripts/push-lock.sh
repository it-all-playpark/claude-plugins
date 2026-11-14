# push-lock.sh - repo 単位の push lock（source 専用。単体では実行しない）
#
# 同じ repo の並行 run の pre-push hook が同時に走ると、テストが CPU を奪い合って落ちる。pre-push hook を起動する
# exec-proxy（pr-push の push・pre-push-hook の単体実行）は、hook を起動する前にこの lock を取って直列にする。
#
# lock は git-common-dir 配下の dev-flow-pr-push.lock/（worktree 間で共有）を mkdir / rmdir だけで取得・解放する
# （sandbox 内から書ける場所。$TMPDIR はセッションごとに別なので使えない）。
# 保持者は lock 内の pid-<PID>/ で記録し、`kill -0` が ESRCH のときだけ stale として奪う — sandbox 内の
# `kill -0` は生きている他プロセスにも EPERM を返すので、EPERM は生きている扱い。
#
# Usage（cwd は対象の worktree）:
#   push_lock_acquire <wait-sec> <poll-sec> <name>
#     取れたら 0（EXIT で解放し、HUP / INT / TERM で exit する trap を張る）。<wait-sec> 待っても取れなければ
#     `<name>: lock_timeout ...` の 1 行を stdout（呼び出し側の log）に出して 1。git repo の外なら 2。
#     lock の保持はこの shell の PID で記録するので、コマンド置換などのサブシェルで呼ばない。

PUSH_LOCK_DIR=""
_push_lock_held=0

push_lock_release() {
    [[ "$_push_lock_held" -eq 1 ]] || return 0
    rmdir "${PUSH_LOCK_DIR}/pid-$$" "$PUSH_LOCK_DIR" 2>/dev/null
    _push_lock_held=0
}

# 保持者の PID が ESRCH（存在しない）なら、その pid-<PID>/ のパスを出して 0 を返す。
# 保持者の記録がまだ無い（mkdir 直後）・生きている・EPERM のときは 1。
_push_lock_stale_holder() {
    local entry pid err
    for entry in "$PUSH_LOCK_DIR"/pid-*; do
        [[ -d "$entry" ]] || continue
        pid="${entry##*/pid-}"
        err="$(export LC_ALL=C; kill -0 "$pid" 2>&1)" && return 1
        [[ "$err" == *"No such process"* ]] || return 1
        echo "$entry"
        return 0
    done
    return 1
}

push_lock_acquire() {
    local wait_sec="$1" poll_sec="$2" name="$3" common_dir stale wait_start
    common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || return 2
    PUSH_LOCK_DIR="${common_dir}/dev-flow-pr-push.lock"
    trap push_lock_release EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    wait_start=$SECONDS
    while ! mkdir "$PUSH_LOCK_DIR" 2>/dev/null; do
        # pid-<PID>/ を消せた 1 プロセスだけが lock 本体を消す（同時に奪いに来た側は rmdir に失敗して待ちに戻る）
        if stale="$(_push_lock_stale_holder)" && rmdir "$stale" 2>/dev/null && rmdir "$PUSH_LOCK_DIR" 2>/dev/null; then
            continue
        fi
        if (( SECONDS - wait_start >= wait_sec )); then
            echo "${name}: lock_timeout waited=${wait_sec}s lock=${PUSH_LOCK_DIR} (another push in this repo still holds the lock; not run)"
            return 1
        fi
        sleep "$poll_sec"
    done
    _push_lock_held=1
    mkdir "${PUSH_LOCK_DIR}/pid-$$"
}
