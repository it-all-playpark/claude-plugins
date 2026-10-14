#!/usr/bin/env bash
# run-node-tests.sh - Run the vitest suite (`**/*.test.mjs`) via node_modules/.bin/vitest.
#
# Usage: run-node-tests.sh [--strict]
#
# Behavior (post issue #356 vitest migration):
#   - Test discovery (include/exclude) is owned by `vitest.config.mjs`
#     (include `**/*.test.mjs`, excluding `.git`, `node_modules`, `.serena`,
#     `.system`, and `.claude/worktrees` to avoid double-running
#     tests in shared worktrees). This script no longer discovers files
#     itself.
#   - If `node` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have node yet).
#       - `--strict` mode: exits 1 (use this in CI to require node).
#   - If `node_modules/.bin/vitest` is not installed (e.g. `npm ci` was
#     never run):
#       - Default mode: prints a warning and exits 0 (graceful skip).
#       - `--strict` mode: exits 1 (use this in CI to require vitest).
#     There is no fallback to `node --test` — after the vitest migration,
#     that path is unmaintained and would silently mask an unresolved
#     dependency install.
#   - Otherwise: `exec`s `node_modules/.bin/vitest run`, passing through its
#     exit code as-is.
#   - Explicit file list: dev-flow's run-tests --files passes
#     `DEVFLOW_TEST_FILES` (absolute path of a file listing repo-relative test
#     files, one per line) to rerun only the files that failed. When set, only
#     the listed `*.test.mjs` files are passed to vitest; none listed means
#     vitest is not started (exit 0) — other runners own the other files. An
#     unreadable list falls back to the full suite.
#
# Designed to be called from CI (GitHub Actions) with Node 24.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# plugin install 時と同じ bin/ 解決環境を再現する（cross-plugin の _lib/common.sh
# locator が PATH 上の bin/journal をアンカーに解決するため、単体実行でも前置が必要）。
export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
    STRICT=true
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[run-node-tests] node is not installed." >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-node-tests] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-node-tests] skipping (non-strict mode)." >&2
    exit 0
fi

VITEST_BIN="$REPO_ROOT/node_modules/.bin/vitest"

if [[ ! -x "$VITEST_BIN" ]]; then
    echo "[run-node-tests] vitest is not installed. Run 'npm ci' to enable tests." >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-node-tests] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-node-tests] skipping (non-strict mode)." >&2
    exit 0
fi

# vitest resolves its config/root relative to the process cwd, not to
# $REPO_ROOT, so this script must cd into $REPO_ROOT itself before
# invoking it (callers may run this script from any cwd via an absolute
# path). Without this, vitest.config.mjs's include/exclude denylist would
# be bypassed entirely in favor of vitest's own defaults.
cd "$REPO_ROOT" || exit 1

TEST_FILES=()
if [[ -n "${DEVFLOW_TEST_FILES:-}" ]]; then
    if [[ -f "$DEVFLOW_TEST_FILES" && -r "$DEVFLOW_TEST_FILES" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            [[ "$line" == *.test.mjs ]] && TEST_FILES+=("$line")
        done < "$DEVFLOW_TEST_FILES"
        if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
            echo "[run-node-tests] DEVFLOW_TEST_FILES lists no .test.mjs file — vitest not started."
            exit 0
        fi
    else
        echo "[run-node-tests] DEVFLOW_TEST_FILES is not a readable file: $DEVFLOW_TEST_FILES — running all."
    fi
fi

# --configLoader runner: 既定の bundle loader は config を node_modules/.vite-temp に書き出してから
# import する。sandbox 内（dev-flow の run-tests 経由を含む）ではその書き込みが EPERM になり、
# テストが 1 本も走らないまま exit 1 になる（偽 red）。runner loader は書き出さずに読む。
exec "$VITEST_BIN" run --configLoader runner ${TEST_FILES[@]+"${TEST_FILES[@]}"}
