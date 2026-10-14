#!/usr/bin/env bash
# run-all-bats.sh - Discover and execute all .bats test files in the repo.
#
# Usage: run-all-bats.sh [--strict]
#
# Behavior:
#   - Discovers `**/*.bats` files under the repository root, excluding
#     `.git`, `node_modules`, `.serena`, `.system`, and worktree dirs.
#   - If `bats` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have bats yet).
#       - `--strict` mode: exits 1 (use this in CI to require bats).
#   - If `bats` is installed: runs the .bats files in parallel (one bats
#     process per file) and aggregates results. Each file's output is
#     buffered and printed in discovery order once all files finish, so logs
#     never interleave. Exit 0 only if all files pass; exit 1 if any test fails.
#   - Parallelism: `RUN_ALL_BATS_JOBS` (positive integer) overrides the
#     default of the online CPU count; set it to 1 to run serially. Files are
#     independent (each test uses mktemp / $BATS_TEST_TMPDIR), and serial
#     execution made dev-flow Validate spend ~7 min per full-suite pass.
#   - Change-based selection: dev-flow's run-tests passes
#     `DEVFLOW_CHANGED_FILES` (absolute path of a file listing the changed
#     paths, repo-relative, one per line). When set, only the .bats files whose
#     body contains a changed file's basename are run. Any doubt falls back to
#     the full suite, because a skipped bats is a silent false green:
#       - the variable is unset / empty, the file is unreadable or has 0 lines
#       - a changed path is under `tests/` or `fixtures/`
#       - a changed path is not `.mjs` / `.js` / `.md` (shell, bats, json, ...)
#       - a changed `.mjs` / `.js` / `.md` basename appears in a shell-side
#         file (`*.sh`, `bin/**`, `hooks/**`; `*.bats` excluded), since those
#         call scripts by name and their own bats would not mention it
#     Matching is a plain basename string match (no import analysis). The
#     decision is printed as one `[run-all-bats] Selection:` line on stdout.
#     CI and manual runs don't set the variable, so they always run everything.
#   - Explicit file list: dev-flow's run-tests --files passes
#     `DEVFLOW_TEST_FILES` (absolute path of a file listing repo-relative test
#     files, one per line) to rerun only the files that failed. When set, it
#     takes precedence over DEVFLOW_CHANGED_FILES: exactly the listed `.bats`
#     files are run (a missing one fails in bats), and none listed means bats
#     is not started (exit 0) — other runners own the other files. An
#     unreadable list falls back to the full suite.
#
# Designed to be called from CI (GitHub Actions) after `brew install bats-core`
# (macOS) or `apt install bats` (ubuntu).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# plugin install 時と同じ bin/ 解決環境を再現する（cross-plugin の _lib/common.sh
# locator が PATH 上の bin/journal をアンカーに解決するため、単体実行でも前置が必要）。
export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
    STRICT=true
fi

if [[ -n "${RUN_ALL_BATS_JOBS:-}" ]]; then
    if [[ ! "$RUN_ALL_BATS_JOBS" =~ ^[1-9][0-9]*$ ]]; then
        echo "[run-all-bats] RUN_ALL_BATS_JOBS must be a positive integer (got: '$RUN_ALL_BATS_JOBS')." >&2
        exit 2
    fi
    JOBS="$RUN_ALL_BATS_JOBS"
else
    JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
    [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || JOBS=4
fi

if ! command -v bats >/dev/null 2>&1; then
    echo "[run-all-bats] bats is not installed." >&2
    echo "[run-all-bats] Install: brew install bats-core (macOS) / apt-get install bats (Ubuntu)" >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-all-bats] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-all-bats] Skipping bats tests (non-strict mode)." >&2
    exit 0
fi

# Discover .bats files
mapfile -t BATS_FILES < <(
    find "$REPO_ROOT" \
        -type d \( -name ".git" -o -name "node_modules" -o -name ".serena" \
                -o -name ".system" \
                -o -path "*/.claude/worktrees" \) -prune -o \
        -type f -name "*.bats" -print | sort
)

if [[ ${#BATS_FILES[@]} -eq 0 ]]; then
    echo "[run-all-bats] No .bats files found."
    exit 0
fi

# Change-based selection (see header). Prints exactly one Selection line; when
# narrowing, sets NARROWED=true and fills SELECTED_BATS (possibly empty).
select_by_changed_files() {
    local list="${DEVFLOW_CHANGED_FILES:-}"
    if [[ -z "$list" ]]; then
        echo "[run-all-bats] Selection: all (DEVFLOW_CHANGED_FILES is unset or empty)"
        return
    fi
    if [[ ! -f "$list" || ! -r "$list" ]]; then
        echo "[run-all-bats] Selection: all (DEVFLOW_CHANGED_FILES is not a readable file: $list)"
        return
    fi

    local changed=() line
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -n "$line" ]] && changed+=("$line")
    done < "$list"
    if [[ ${#changed[@]} -eq 0 ]]; then
        echo "[run-all-bats] Selection: all (DEVFLOW_CHANGED_FILES lists 0 files)"
        return
    fi

    local shell_files=() p
    while IFS= read -r p; do
        shell_files+=("$REPO_ROOT/${p#./}")
    done < <(
        cd "$REPO_ROOT" && find . \
            -type d \( -name ".git" -o -name "node_modules" -o -name ".serena" \
                    -o -name ".system" \
                    -o -path "*/.claude/worktrees" \) -prune -o \
            -type f ! -name "*.bats" \
            \( -name "*.sh" -o -path "*/bin/*" -o -path "*/hooks/*" \) -print | sort
    )

    local base hit
    for p in "${changed[@]}"; do
        if [[ "/$p" == */tests/* ]]; then
            echo "[run-all-bats] Selection: all ($p: under tests/)"
            return
        fi
        if [[ "/$p" == */fixtures/* ]]; then
            echo "[run-all-bats] Selection: all ($p: under fixtures/)"
            return
        fi
        case "$p" in
            *.mjs | *.js | *.md) ;;
            *)
                echo "[run-all-bats] Selection: all ($p: extension is not .mjs/.js/.md)"
                return
                ;;
        esac
        base="${p##*/}"
        if [[ ${#shell_files[@]} -gt 0 ]]; then
            hit="$(grep -lF -e "$base" -- "${shell_files[@]}" 2>/dev/null | head -n 1)"
            if [[ -n "$hit" ]]; then
                echo "[run-all-bats] Selection: all ($p: basename referenced by shell-side file ${hit#$REPO_ROOT/})"
                return
            fi
        fi
    done

    local -A matched=()
    for p in "${changed[@]}"; do
        base="${p##*/}"
        while IFS= read -r hit; do
            [[ -n "$hit" ]] && matched["$hit"]=1
        done < <(grep -lF -e "$base" -- "${BATS_FILES[@]}" 2>/dev/null)
    done

    NARROWED=true
    local f
    for f in "${BATS_FILES[@]}"; do
        [[ -n "${matched[$f]:-}" ]] && SELECTED_BATS+=("$f")
    done
    echo "[run-all-bats] Selection: ${#SELECTED_BATS[@]} of ${#BATS_FILES[@]} .bats file(s) reference a changed basename (DEVFLOW_CHANGED_FILES, ${#changed[@]} file(s))"
}

# Explicit file list (see header). Prints exactly one Selection line.
select_by_test_files() {
    local list="$DEVFLOW_TEST_FILES" line
    if [[ ! -f "$list" || ! -r "$list" ]]; then
        echo "[run-all-bats] Selection: all (DEVFLOW_TEST_FILES is not a readable file: $list)"
        return
    fi
    NARROWED=true
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" == *.bats ]] && SELECTED_BATS+=("$REPO_ROOT/${line#./}")
    done < "$list"
    echo "[run-all-bats] Selection: ${#SELECTED_BATS[@]} .bats file(s) listed in DEVFLOW_TEST_FILES"
}

NARROWED=false
SELECTED_BATS=()
if [[ -n "${DEVFLOW_TEST_FILES:-}" ]]; then
    select_by_test_files
else
    select_by_changed_files
fi

LIST_LABEL="Discovered"
if [[ "$NARROWED" == true ]]; then
    # 0 selected: don't start bats at all.
    [[ ${#SELECTED_BATS[@]} -eq 0 ]] && exit 0
    BATS_FILES=("${SELECTED_BATS[@]}")
    LIST_LABEL="Selected"
fi

echo "[run-all-bats] ${LIST_LABEL} ${#BATS_FILES[@]} .bats file(s):"
for f in "${BATS_FILES[@]}"; do
    echo "  - ${f#$REPO_ROOT/}"
done
echo "[run-all-bats] Running with ${JOBS} parallel job(s)."
echo ""

RESULT_DIR="$(mktemp -d)"
trap 'rm -rf "$RESULT_DIR"' EXIT

# One bats process per file. Output goes to <index>.log and the exit code to
# <index>.rc so the report below can replay them in discovery order.
# xargs appends each (index, file) pair after the fixed "$RESULT_DIR" arg, so
# inside `bash -c` $1 is the result dir and $2/$3 are index/file.
run_one() {
    local idx="$1" file="$2" dir="$3"
    bats "$file" > "$dir/$idx.log" 2>&1
    echo "$?" > "$dir/$idx.rc"
}
export -f run_one

for i in "${!BATS_FILES[@]}"; do
    printf '%s\0%s\0' "$i" "${BATS_FILES[$i]}"
done | xargs -0 -n 2 -P "$JOBS" bash -c 'run_one "$2" "$3" "$1"' _ "$RESULT_DIR"

FAILED=()
PASSED=()
for i in "${!BATS_FILES[@]}"; do
    f="${BATS_FILES[$i]}"
    echo "=== Running: ${f#$REPO_ROOT/} ==="
    cat "$RESULT_DIR/$i.log" 2>/dev/null
    # A missing .rc (worker killed before recording) counts as a failure.
    if [[ "$(cat "$RESULT_DIR/$i.rc" 2>/dev/null)" == "0" ]]; then
        PASSED+=("$f")
    else
        FAILED+=("$f")
    fi
    echo ""
done

echo "=================================================="
echo "[run-all-bats] Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
echo "=================================================="

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "Failed files:"
    for f in "${FAILED[@]}"; do
        echo "  - ${f#$REPO_ROOT/}"
    done
    exit 1
fi

exit 0
