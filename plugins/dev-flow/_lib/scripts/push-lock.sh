# push-lock.sh - repo 単位の push lock（source 専用。単体では実行しない）
#
# 同じ repo の並行 run の pre-push hook が同時に走ると、テストが CPU を奪い合って落ちる。pre-push hook を起動する
# exec-proxy（pr-push の push・pre-push-hook の単体実行）は、hook を起動する前にこの lock を取って直列にする。
#
# lock は git-common-dir 配下の dev-flow-pr-push.lock/（worktree 間で共有）を mkdir / rmdir で取得・解放する
# （sandbox 内から書ける場所。$TMPDIR はセッションごとに別なので使えない）。
# 保持者は lock 内の holder-<token> に時刻を書き続け（heartbeat）、PUSH_LOCK_STALE_SEC 以上更新が無い記録だけを
# stale として奪う。保持者の pid は見ない — Bash 呼び出しごとに PID namespace を切る sandbox では、別の呼び出しの
# 保持者の pid は見えない（ESRCH）か無関係のプロセスを指すので、pid の見え方では生死を決められない。heartbeat は
# namespace をまたいで同じファイルに見え、保持者が呼び出しごと消えれば更新も止まる。
# 前の版が残した pid-<PID>/ は stale として奪う。
#
# Usage（cwd は対象の worktree）:
#   push_lock_acquire <wait-sec> <poll-sec> <name>
#     取れたら 0（EXIT で解放し、HUP / INT / TERM で exit する trap を張る）。<wait-sec> 待っても取れなければ
#     `<name>: lock_timeout ...` の 1 行を stdout（呼び出し側の log）に出して 1。git repo の外なら 2。
#     heartbeat を書く子はこの shell の生存を見て止まるので、コマンド置換などのサブシェルで呼ばない。
#
# PUSH_LOCK_STALE_SEC は heartbeat が途絶えたとみなす秒数（bats が短くするための上書き口）。

: "${PUSH_LOCK_STALE_SEC:=15}"
PUSH_LOCK_BEAT_SEC=1

PUSH_LOCK_DIR=""
_push_lock_held=0
_push_lock_holder=""
_push_lock_beater=""

push_lock_release() {
    [[ "$_push_lock_held" -eq 1 ]] || return 0
    # 消した後の記録を heartbeat が書き戻さないよう、止まるのを待ってから消す
    kill "$_push_lock_beater" 2>/dev/null
    wait "$_push_lock_beater" 2>/dev/null
    rm -f "$_push_lock_holder"
    rmdir "$PUSH_LOCK_DIR" 2>/dev/null
    _push_lock_held=0
}

# stale な保持者の記録があれば「<記録のパス><TAB><読んだ heartbeat>」を出して 0 を返す。
# 保持者の記録がまだ無い（mkdir 直後）・heartbeat が新しい・読めないときは 1。
_push_lock_stale_holder() {
    local entry beat
    for entry in "$PUSH_LOCK_DIR"/holder-* "$PUSH_LOCK_DIR"/pid-*; do
        [[ -e "$entry" ]] || continue
        if [[ -d "$entry" ]]; then
            printf '%s\t\n' "$entry"
            return 0
        fi
        beat="$(cat "$entry" 2>/dev/null)"
        [[ "$beat" =~ ^[0-9]+$ ]] || return 1
        (( $(date +%s) - beat >= PUSH_LOCK_STALE_SEC )) || return 1
        printf '%s\t%s\n' "$entry" "$beat"
        return 0
    done
    return 1
}

push_lock_acquire() {
    local wait_sec="$1" poll_sec="$2" name="$3" common_dir stale seen='' entry wait_start
    common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || return 2
    PUSH_LOCK_DIR="${common_dir}/dev-flow-pr-push.lock"
    trap push_lock_release EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    wait_start=$SECONDS
    while ! mkdir "$PUSH_LOCK_DIR" 2>/dev/null; do
        if stale="$(_push_lock_stale_holder)"; then
            # 同じ記録を同じ heartbeat のまま 2 回続けて stale と見たときだけ奪う。マシンの suspend から戻った直後は、
            # 生きている保持者の heartbeat も次の更新まで古く見える。
            # 記録を消せた 1 プロセスだけが lock 本体を消す（同時に奪いに来た側は消すのに失敗して待ちに戻る）
            entry="${stale%%$'\t'*}"
            if [[ "$stale" == "$seen" ]] && { rmdir "$entry" 2>/dev/null || rm "$entry" 2>/dev/null; } && rmdir "$PUSH_LOCK_DIR" 2>/dev/null; then
                seen=''
                continue
            fi
            seen="$stale"
        else
            seen=''
        fi
        if (( SECONDS - wait_start >= wait_sec )); then
            echo "${name}: lock_timeout waited=${wait_sec}s lock=${PUSH_LOCK_DIR} (another push in this repo still holds the lock; not run)"
            return 1
        fi
        sleep "$poll_sec"
    done
    _push_lock_held=1
    _push_lock_holder="${PUSH_LOCK_DIR}/holder-$$-$(date +%s)-${RANDOM}"
    date +%s > "$_push_lock_holder"
    # この shell（同じ呼び出しの中の自分の親なので pid は確かに見える）が居なくなるか、記録を奪われたら止まる
    ( while kill -0 "$$" 2>/dev/null && [[ -e "$_push_lock_holder" ]]; do
          sleep "$PUSH_LOCK_BEAT_SEC"
          [[ -e "$_push_lock_holder" ]] && date +%s > "$_push_lock_holder"
      done ) </dev/null >/dev/null 2>&1 &
    _push_lock_beater=$!
}
