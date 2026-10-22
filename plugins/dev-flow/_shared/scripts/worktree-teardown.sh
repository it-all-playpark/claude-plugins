#!/usr/bin/env bash
# worktree-teardown.sh - dev-flow 管理下の worktree を teardown する。
#
# 実行文脈: human terminal と Claude の sandbox 内のどちらでも動く（.git/config を書かない）。
#
# 使い方: worktree-teardown.sh <worktree-path> [--force]
#
# 動作:
#   1. <worktree-path> が git worktree であることを検証(非 worktree はエラー)
#   2. main repo を解決し `git worktree remove [--force] <worktree-path>` を実行し、
#      その exit code をそのまま本スクリプトの exit code として返す
#      (remove が block された場合は --force で再実行できる旨を stderr に案内)
#
# 出力: JSON なし。人間向け stderr/stdout メッセージ + exit code が契約。
#
# Exit:
#   0: teardown 成功
#   非0: git worktree remove 失敗(untracked/modified files 等。exit code はそのまま伝播)
#   2: 引数不足 / <worktree-path> が git worktree ではない / git-common-dir 解決失敗
set -uo pipefail

# ============================================================================
# Args
# ============================================================================

if [ $# -lt 1 ]; then
    echo "Usage: worktree-teardown.sh <worktree-path> [--force]" >&2
    exit 2
fi

WT="$1"
shift

FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --force)
            FORCE=1
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

# ============================================================================
# Validate <worktree-path> is a git worktree
# ============================================================================

if ! git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: not a git worktree: $WT" >&2
    exit 2
fi

# ============================================================================
# Resolve main repo and remove the worktree
# ============================================================================

common_dir="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
if [ -z "$common_dir" ]; then
    echo "Error: failed to resolve git-common-dir for $WT" >&2
    exit 2
fi
MAIN_REPO="$(dirname "$common_dir")"

remove_args=(worktree remove)
if [ "$FORCE" -eq 1 ]; then
    remove_args+=(--force)
fi
remove_args+=("$WT")

remove_stderr_tmp="$(mktemp "${TMPDIR:-/tmp}/worktree-teardown-remove-stderr.XXXXXX")"
trap 'rm -f "$remove_stderr_tmp"' EXIT

git -C "$MAIN_REPO" "${remove_args[@]}" 2>"$remove_stderr_tmp"
remove_exit=$?

remove_stderr="$(cat "$remove_stderr_tmp")"
if [ -n "$remove_stderr" ]; then
    echo "$remove_stderr" >&2
fi

if [ "$remove_exit" -ne 0 ]; then
    echo "worktree-teardown: worktree は残っている。--force で再実行可能" >&2
fi

exit "$remove_exit"
