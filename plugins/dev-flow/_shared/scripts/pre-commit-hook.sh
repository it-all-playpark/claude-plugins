#!/usr/bin/env bash
# pre-commit-hook.sh - Validate の各回（commit-hook#i）で対象 repo の pre-commit hook を 1 回だけ実行する exec-proxy（issue #1188）。
# Usage: pre-commit-hook.sh <worktree>
#
# PR phase の記録（prPhasePrompt）は対象 repo の pre-commit hook を通り、そこで初めて lint / format の失敗が出ると
# リトライも green-fix も無いまま pr_phase_failed で終わる。同じ hook を Validate で先に回し、失敗を green-fix に渡す。
#
# stage 内容: PR phase の stage（PR_STAGE_COMMANDS = add -A → .devflow-tmp を外す）と同じものを一時 index に作り、
# GIT_INDEX_FILE で hook に渡す（hook 内の `git diff --cached` 等はこの index を読む）。一時 index は実 index の
# コピーから作る（HEAD の tree から作ると skip-worktree ビットが落ち、取り出していないパスを add -A が削除として
# stage する。PR phase の実 index ではその削除は stage されない）。実 index は書かない — Validate の後の run-tests / redgreen-verify / diff-hash が見る index を変えないため。
# HEAD は動かさない（ここでは何も記録しない）。
#
# hook の解決と起動は git に任せる: 有無は `git hook list pre-commit` の exit code（0 = ある / 1 = 無い）で決め、
# 起動は `git hook run pre-commit` だけで行う（hooks のパス設定・.git/hooks・config の hook.<name> を git が解決する）。
# hook を飛ばす・無効化する手段（環境変数・設定の上書き）は使わない — ここで通しても PR phase で同じ hook に落ちる。
# hook が formatter で working tree を書き換えた場合はそのまま残す（次のテストと PR phase の stage に入る）。
#
# 出力（stdout, JSON 1 行）:
#   {"hook":"none|passed|failed|error","exit":N|null,"tail":"...","log":"...","error":"..."}
#   none   — pre-commit hook が無い。何も実行しない
#   passed — hook が exit 0
#   failed — hook が exit 非 0。exit は hook の終了コード、tail は hook の stdout / stderr の末尾（TAIL_LINES 行・TAIL_MAX 字まで）
#   error  — hook を起動する前に失敗した（引数不正・git の work tree でない・一時 index を作れない等。error に理由）
#   log は hook の出力全文のパス（$TMPDIR 配下 = worktree の外。worktree 内に置くと diff-hash が untracked を含む）
# exit: none / passed は 0、failed は 1、error は 2
set -uo pipefail

TAIL_LINES=40
TAIL_MAX=4000

emit() {
    # $1 hook / $2 exit（数値 or null）/ $3 tail / $4 log / $5 error（空なら出さない）
    jq -nc --arg h "$1" --argjson x "$2" --arg t "$3" --arg l "$4" --arg e "$5" \
        '{hook: $h, exit: $x, tail: $t, log: $l} + (if $e == "" then {} else {error: $e} end)'
}

if [[ $# -ne 1 || -z "$1" ]]; then
    emit error null "" "" "usage: pre-commit-hook <worktree>"
    exit 2
fi
WT=$(cd "$1" 2>/dev/null && pwd) || { emit error null "" "" "cd failed: $1"; exit 2; }
cd "$WT" || { emit error null "" "" "cd failed: $WT"; exit 2; }

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    emit error null "" "" "not a git work tree: $WT"
    exit 2
fi

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pre-commit-hook-XXXXXX") \
    || { emit error null "" "" "cannot create log dir under ${TMPDIR:-/tmp}"; exit 2; }
LOG="$LOG_DIR/hook.log"
INDEX="$LOG_DIR/index"
trap 'rm -f "$INDEX"' EXIT

git hook list pre-commit >/dev/null 2>"$LOG_DIR/list.log"
list_rc=$?
if [[ $list_rc -eq 1 ]]; then
    emit none null "" "" ""
    exit 0
elif [[ $list_rc -ne 0 ]]; then
    emit error null "$(tail -n 3 "$LOG_DIR/list.log")" "$LOG_DIR/list.log" "git hook list failed (exit $list_rc)"
    exit 2
fi

REAL_INDEX=$(git rev-parse --path-format=absolute --git-path index 2>/dev/null) \
    || { emit error null "" "" "cannot resolve the index path"; exit 2; }
if ! { cp "$REAL_INDEX" "$INDEX" \
        && GIT_INDEX_FILE="$INDEX" git add -A \
        && GIT_INDEX_FILE="$INDEX" git reset -q -- .devflow-tmp; } >"$LOG_DIR/stage.log" 2>&1; then
    emit error null "$(tail -n 3 "$LOG_DIR/stage.log")" "$LOG_DIR/stage.log" "cannot build the temporary index"
    exit 2
fi

GIT_INDEX_FILE="$INDEX" git hook run pre-commit </dev/null >"$LOG" 2>&1
rc=$?

if [[ $rc -eq 0 ]]; then
    emit passed 0 "" "$LOG" ""
    exit 0
fi
tail_out=$(tail -n "$TAIL_LINES" "$LOG")
if [[ ${#tail_out} -gt $TAIL_MAX ]]; then
    tail_out="${tail_out: -$TAIL_MAX}"
fi
emit failed "$rc" "$tail_out" "$LOG" ""
exit 1
