#!/usr/bin/env bash
# run-all-bats.sh - Discover and execute all .bats test files in the repo.
#
# Usage: run-all-bats.sh [--strict]
#
# Behavior:
#   - Discovers `**/*.bats` files under the repository root, excluding
#     `.git`, `node_modules`, and worktree dirs.
#   - If `bats` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have bats yet).
#       - `--strict` mode: exits 1 (use this in CI to require bats).
#   - If `bats` is installed: runs the .bats files in parallel (one bats
#     process per file) and aggregates results. Each file's output is
#     buffered and printed in discovery order once all files finish, so logs
#     never interleave. Exit 0 only if all files pass; exit 1 if any test fails.
#     Each file's block ends with `[run-all-bats] Elapsed: <path> <N>s` (whole
#     seconds of that file's bats process, passed or failed), so a CI log shows
#     which file sets the job's wall time.
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
#         call scripts by name and their own bats would not mention it.
#         Lines starting with `#` (leading whitespace ignored) are left out of
#         this shell-side match, so a mention only in comments doesn't force
#         the full suite. This is line-based: a `#`-leading line inside a
#         heredoc body is left out too.
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
#   - Execution order: files start heaviest first (weight = number of
#     `@test` lines) so a long file doesn't start last and become the tail.
#     Output is still printed in discovery order.
#   - Sharding (CI matrix): `RUN_ALL_BATS_SHARD=<i>/<n>` (1 <= i <= n) runs
#     only shard i of n, applied after selection. Files are assigned greedily
#     (heaviest first, to the least-loaded shard; ties to the lowest shard),
#     so for a fixed file set every file lands in exactly one shard — running
#     all n shards runs every file once. A shard with no file exits 0 without
#     starting bats. An invalid value exits 2.
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
        -type d \( -name ".git" -o -name "node_modules" \
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
            -type d \( -name ".git" -o -name "node_modules" \
                    -o -path "*/.claude/worktrees" \) -prune -o \
            -type f ! -name "*.bats" \
            \( -name "*.sh" -o -path "*/bin/*" -o -path "*/hooks/*" \) -print | sort
    )

    local base hit f body
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
            # grep -l narrows the candidates; the comment-line exclusion is a
            # second pass so the reported file is the first non-comment hit.
            hit=""
            while IFS= read -r f; do
                body="$(grep -vE '^[[:space:]]*#' -- "$f")"
                if [[ "$body" == *"$base"* ]]; then
                    hit="$f"
                    break
                fi
            done < <(grep -lF -e "$base" -- "${shell_files[@]}" 2>/dev/null)
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

# Weight of each file (see header) and the indices of BATS_FILES heaviest
# first (ties in discovery order).
declare -A WEIGHT=()
for f in "${BATS_FILES[@]}"; do
    WEIGHT["$f"]="$(grep -c '^@test' -- "$f" 2>/dev/null || true)"
done
heaviest_first() {
    local i
    for i in "${!BATS_FILES[@]}"; do
        printf '%s\t%s\n' "${WEIGHT[${BATS_FILES[$i]}]:-0}" "$i"
    done | sort -t $'\t' -k1,1nr -k2,2n | cut -f2
}

if [[ -n "${RUN_ALL_BATS_SHARD:-}" ]]; then
    if [[ ! "$RUN_ALL_BATS_SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] \
        || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
        echo "[run-all-bats] RUN_ALL_BATS_SHARD must be <i>/<n> with 1 <= i <= n (got: '$RUN_ALL_BATS_SHARD')." >&2
        exit 2
    fi
    SHARD_I="${BASH_REMATCH[1]}"
    SHARD_N="${BASH_REMATCH[2]}"
    LOADS=()
    for ((s = 0; s < SHARD_N; s++)); do LOADS[s]=0; done
    declare -A IN_SHARD=()
    while IFS= read -r i; do
        min=0
        for ((s = 1; s < SHARD_N; s++)); do
            (( LOADS[s] < LOADS[min] )) && min=$s
        done
        # +1 so files without any @test line still spread across shards.
        (( LOADS[min] += ${WEIGHT[${BATS_FILES[$i]}]:-0} + 1 ))
        (( min == SHARD_I - 1 )) && IN_SHARD["${BATS_FILES[$i]}"]=1
    done < <(heaviest_first)
    TOTAL=${#BATS_FILES[@]}
    SHARD_FILES=()
    for f in "${BATS_FILES[@]}"; do
        [[ -n "${IN_SHARD[$f]:-}" ]] && SHARD_FILES+=("$f")
    done
    echo "[run-all-bats] Shard ${SHARD_I}/${SHARD_N}: ${#SHARD_FILES[@]} of ${TOTAL} .bats file(s)"
    [[ ${#SHARD_FILES[@]} -eq 0 ]] && exit 0
    BATS_FILES=("${SHARD_FILES[@]}")
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
    local idx="$1" file="$2" dir="$3" rc
    # SECONDS (bash builtin, whole seconds) works the same on macOS and ubuntu.
    SECONDS=0
    bats "$file" > "$dir/$idx.log" 2>&1
    rc=$?
    echo "$SECONDS" > "$dir/$idx.elapsed"
    echo "$rc" > "$dir/$idx.rc"
}
export -f run_one

while IFS= read -r i; do
    printf '%s\0%s\0' "$i" "${BATS_FILES[$i]}"
done < <(heaviest_first) | xargs -0 -n 2 -P "$JOBS" bash -c 'run_one "$2" "$3" "$1"' _ "$RESULT_DIR"

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
    echo "[run-all-bats] Elapsed: ${f#$REPO_ROOT/} $(cat "$RESULT_DIR/$i.elapsed" 2>/dev/null)s"
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
