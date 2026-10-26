#!/usr/bin/env bash
# detect-and-install.sh - Auto-detect and install project dependencies
# Usage: detect-and-install.sh [--path <dir>] [--dry-run] [--skip-custom] [--lockfile-only]
#
# --lockfile-only: restrict detection to ecosystems that already have a
# lockfile present (package-lock.json / pnpm-lock.yaml / yarn.lock /
# bun.lockb / poetry.lock / uv.lock / Pipfile.lock / go.sum / Gemfile.lock /
# Cargo.lock / composer.lock). Manifest-only setups (e.g. package.json with
# no lockfile) are skipped rather than running a lockfile-generating install
# (npm install, pip install -e ., etc.), which would mutate the tree
# non-deterministically. Default: off (existing behavior unchanged). Used by
# dev-flow's Setup phase via ensure-worktree-deps.sh (issue #291).
#
# Node install skip cache (issue #375): install_node() skips `npm ci` /
# `pnpm install` / etc. when the target lockfile's sha256 matches the hash
# recorded from the last successful install (cache file:
# .devflow-tmp/deps-lockfile-hash, content "<pm>:<sha256>"). Hash lookup
# failure or missing cache info fails open (install still runs) so a broken
# cache never causes a missed install.
#
# Scope note (PR #386 review): the cache_hit condition requires both
# node_modules and the cache file to already exist in this worktree, so it
# only fires on a *repeat* install against an unchanged lockfile within the
# same worktree (e.g. re-running Setup after a failed later phase). It is a
# strict subset of the old node_modules-exists skip and does not reduce the
# per-run fixed cost of installing into a fresh dev-flow worktree (which has
# neither node_modules nor a cache file yet). The effect delivered here is
# correctness: previously a stale node_modules was skipped even when the
# lockfile had changed since the last install; now it re-installs. The
# cross-worktree sharing problem noted above is resolved by the shared
# cache mechanism below (issue #387).
#
# Cross-worktree shared cache (issue #387): install_node() additionally
# keys a *shared* (cross-worktree) cache by "<pm>-<sha256(lockfile)>" under
# ${DEVFLOW_DEPS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/devflow-deps}/.
# This is layered on top of, not a replacement for, the in-worktree cache
# above: the two are mutually exclusive by node_modules presence (the
# shared-cache restore path only fires when node_modules does *not* yet
# exist in this worktree; the in-worktree cache_hit path only fires when it
# already does). The mechanism only activates when --lockfile-only is
# passed (dev-flow's fixed Setup contract flag via
# ensure-worktree-deps.sh); without it, the shared cache is never read or
# written. On a fresh worktree with a hash match, node_modules is restored
# from the shared cache (status "cross_worktree_restore") instead of
# running the install command. After a real install succeeds, node_modules
# is copied into the shared cache under a staging dir and atomically
# renamed into place, so concurrent dev-flow runs populating the same hash
# race safely (loser's staging dir is discarded, first writer wins). Every
# shared-cache read/write/copy/mkdir/mktemp/mv failure fails open into the
# normal install path — a broken or inaccessible shared cache never changes
# install correctness or the script's exit code.
#
# Workspaces (issue #748): a cache entry holds the root node_modules *and*
# every workspace package's node_modules (pnpm-workspace.yaml `packages:` /
# package.json `workspaces`), mirrored as <entry>/<rel>/node_modules, plus a
# manifest listing the saved <rel> dirs. Only entries with a manifest are
# restored — an entry holding just the root node_modules restores a tree in
# which workspace packages cannot resolve vitest / tsc, yet reports success.
# For pnpm (isolated linker: each workspace package with dependencies gets
# its own node_modules), a workspace package that declares dependencies but
# has no node_modules after restore / install / cache_hit is reported as
# status "failed" with `missing_node_modules`, so deps never reads ok:true
# over a tree the tests cannot run in. npm / yarn / bun hoist into the root
# and are not checked per package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TARGET_PATH=""
DRY_RUN=false
SKIP_CUSTOM=false
LOCKFILE_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path) TARGET_PATH="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --skip-custom) SKIP_CUSTOM=true; shift ;;
        --lockfile-only) LOCKFILE_ONLY=true; shift ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Default to current directory
if [[ -z "$TARGET_PATH" ]]; then
    TARGET_PATH=$(pwd)
fi

# Resolve to absolute path
TARGET_PATH=$(cd "$TARGET_PATH" && pwd) || die_json "Path does not exist: $TARGET_PATH" 1

# Cross-worktree shared cache root (issue #387). Overridable via
# DEVFLOW_DEPS_CACHE_DIR (used by tests to stay hermetic and never touch
# $HOME). Falls back to XDG_CACHE_HOME or $HOME/.cache. ${HOME:-} guards
# against an unbound $HOME under `set -u`; if the resolved value is still
# empty, the shared cache is treated as disabled (fail-open — every
# consumer below gates on `-n "$SHARED_CACHE_ROOT"`).
SHARED_CACHE_ROOT="${DEVFLOW_DEPS_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:-}/.cache}/devflow-deps}"
# Per-entry list of saved node_modules dirs relative to the project root
# ("." = root). Written last into the staging dir, so its presence marks a
# complete entry.
CACHE_MANIFEST="node_modules.list"

# ============================================================================
# Detection
# ============================================================================

detect_node_pm() {
    if [[ -f "$TARGET_PATH/pnpm-lock.yaml" ]]; then
        echo "pnpm"
    elif [[ -f "$TARGET_PATH/yarn.lock" ]]; then
        echo "yarn"
    elif [[ -f "$TARGET_PATH/bun.lockb" ]]; then
        echo "bun"
    elif [[ -f "$TARGET_PATH/package-lock.json" ]]; then
        echo "npm"
    elif [[ "$LOCKFILE_ONLY" == true ]]; then
        # --lockfile-only: package.json-only (no lockfile) is intentionally not
        # detected here. Installing without a lockfile (npm install) would
        # generate a new package-lock.json and mutate the worktree tree
        # non-deterministically, which pollutes the realized diff used for
        # the effective shape decision (issue #291).
        echo ""
    elif [[ -f "$TARGET_PATH/package.json" ]]; then
        echo "npm-no-lock"
    else
        echo ""
    fi
}

detect_python_pm() {
    if [[ -f "$TARGET_PATH/Pipfile.lock" ]]; then
        echo "pipenv"
    elif [[ "$LOCKFILE_ONLY" == true ]]; then
        # --lockfile-only: only install when a lockfile is present. Pipfile
        # (without .lock), bare pyproject.toml (pip-pyproject), and
        # requirements.txt (pip) are non-deterministic / lockfile-less
        # installs and are skipped (issue #291).
        if [[ -f "$TARGET_PATH/pyproject.toml" ]] && grep -q '\[tool\.poetry\]' "$TARGET_PATH/pyproject.toml" 2>/dev/null && [[ -f "$TARGET_PATH/poetry.lock" ]]; then
            echo "poetry"
        elif [[ -f "$TARGET_PATH/uv.lock" ]]; then
            echo "uv"
        else
            echo ""
        fi
    elif [[ -f "$TARGET_PATH/Pipfile" ]]; then
        echo "pipenv"
    elif [[ -f "$TARGET_PATH/pyproject.toml" ]]; then
        # Check for poetry or uv
        if grep -q '\[tool\.poetry\]' "$TARGET_PATH/pyproject.toml" 2>/dev/null; then
            echo "poetry"
        elif command -v uv &>/dev/null; then
            echo "uv"
        else
            echo "pip-pyproject"
        fi
    elif [[ -f "$TARGET_PATH/requirements.txt" ]]; then
        echo "pip"
    else
        echo ""
    fi
}

detect_other_pm() {
    local detected=()
    if [[ "$LOCKFILE_ONLY" == true ]]; then
        # --lockfile-only: require the lockfile itself, not just the
        # manifest, to avoid non-deterministic lockfile-generating installs
        # (issue #291).
        [[ -f "$TARGET_PATH/go.sum" ]] && detected+=("go")
        [[ -f "$TARGET_PATH/Gemfile.lock" ]] && detected+=("bundler")
        [[ -f "$TARGET_PATH/Cargo.lock" ]] && detected+=("cargo")
        [[ -f "$TARGET_PATH/composer.lock" ]] && detected+=("composer")
    else
        [[ -f "$TARGET_PATH/go.mod" ]] && detected+=("go")
        [[ -f "$TARGET_PATH/Gemfile" || -f "$TARGET_PATH/Gemfile.lock" ]] && detected+=("bundler")
        [[ -f "$TARGET_PATH/Cargo.toml" || -f "$TARGET_PATH/Cargo.lock" ]] && detected+=("cargo")
        [[ -f "$TARGET_PATH/composer.json" || -f "$TARGET_PATH/composer.lock" ]] && detected+=("composer")
    fi
    echo "${detected[*]:-}"
}

# ============================================================================
# Install Helpers
# ============================================================================

# Run install command without eval - splits cmd string into args safely
# Redirects command output to stderr to keep stdout clean for JSON
run_install_cmd() {
    local cmd_str="$1"
    # shellcheck disable=SC2086
    (cd "$TARGET_PATH" && $cmd_str) >&2 2>&1
}

# Resolve the actual binary name for command -v check
resolve_bin() {
    local pm="$1"
    case "$pm" in
        npm-no-lock|pip-pyproject) echo "${pm%%-*}" ;;
        bundler) echo "bundle" ;;
        *) echo "$pm" ;;
    esac
}

# Hash a lockfile for the install skip cache (issue #375). Prefers
# sha256sum (Linux), falls back to shasum -a 256 (macOS). Returns non-zero
# (empty stdout) if neither tool is available or the file can't be read, so
# callers can fail open.
hash_lockfile() {
    local f="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$f" 2>/dev/null | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$f" 2>/dev/null | awk '{print $1}'
    else
        return 1
    fi
}

# Copy a directory tree, preferring a copy-on-write (CoW) clone for speed
# and falling back to a full (independent-inode) copy on platforms/
# filesystems where CoW cloning isn't available. -a/-R preserve symlinks
# (node_modules/.bin etc.) so the restored tree stays functionally intact.
# Used by the cross-worktree shared cache (issue #387). Returns 0 on the
# first successful strategy, 1 if all of them fail (caller fails open).
#
# Deliberately does NOT use `cp -al` (hardlink clone): measured on this
# runtime (macOS 26.5, both BSD /bin/cp and GNU coreutils cp via nix
# profile), `-l` succeeds and creates a real hardlink shared between the
# source and destination inode — same as on Linux. Because node_modules is
# restored into every fresh worktree from, and later populated into, the
# single persistent shared cache dir, a hardlinked tree means any later
# in-place rewrite of a file (truncate+write, which package managers and
# build tools commonly do) in one worktree is immediately visible in every
# sibling worktree and in the shared cache itself, breaking the worktree
# isolation invariant. (A previous version of this comment claimed "macOS
# cp has no -l" as the safety rationale for using -l here; that claim does
# not hold on this runtime and is corrected above.)
#
# CoW cloning gives comparable copy speed to hardlinking without the
# shared-inode hazard: `cp -c` uses APFS clonefile(2) on macOS (BSD cp),
# `cp --reflink=auto` uses filesystem reflink on Linux (GNU coreutils,
# e.g. btrfs/XFS) and transparently falls back to a real copy when the
# filesystem doesn't support it (documented GNU behavior — never fails,
# never links inodes). Either way, each clone gets independent
# copy-on-write semantics: a later in-place write causes the OS to
# transparently break the sharing for just that file, never mutating the
# original.
copy_tree() {
    local src="$1"
    local dst="$2"
    cp -Rc "$src" "$dst" 2>/dev/null && return 0
    cp -a --reflink=auto "$src" "$dst" 2>/dev/null && return 0
    cp -a "$src" "$dst" 2>/dev/null && return 0
    cp -R "$src" "$dst" 2>/dev/null && return 0
    return 1
}

# workspace_patterns / workspace_glob_match / workspace_pkg_dirs (issue #748)
# live in workspace-packages.sh, shared with workspace-prebuild.sh (issue #754).
# shellcheck source=workspace-packages.sh
source "$SCRIPT_DIR/workspace-packages.sh"

# pnpm workspace packages (relative dirs, one per line) that declare
# dependencies but have no node_modules in this worktree (issue #748).
# Empty for npm / yarn / bun, which hoist into the root node_modules.
missing_workspace_node_modules() {
    local pm="$1"
    [[ "$pm" == "pnpm" ]] || return 0
    local rel
    while IFS= read -r rel; do
        [[ -n "$rel" ]] || continue
        jq -e '[.dependencies, .devDependencies, .optionalDependencies] | map(. // {} | length) | add > 0' \
            "$TARGET_PATH/$rel/package.json" >/dev/null 2>&1 || continue
        [[ -d "$TARGET_PATH/$rel/node_modules" ]] || printf '%s\n' "$rel"
    done <<< "$(workspace_pkg_dirs "$pm")"
    return 0
}

# Emit the node result for a pnpm tree whose workspace packages lack
# node_modules: status "failed" plus the missing dirs.
node_missing_result() {
    local pm="$1" cmd="$2" missing="$3"
    jq -nc --arg pm "$pm" --arg cmd "$cmd" --arg m "$missing" \
        '{ecosystem: "node", pm: $pm, status: "failed", command: $cmd, missing_node_modules: ($m | split("\n") | map(select(. != "")))}'
}

# True when any node_modules listed in the manifest $1 (restored into this
# worktree) holds a symlink whose target does not exist. The links are
# collected first and checked afterwards: returning from a `find | while`
# reader would SIGPIPE find and fail the pipeline under pipefail.
has_dangling_symlink() {
    local manifest="$1" rel links link
    while IFS= read -r rel; do
        [[ -n "$rel" ]] || continue
        links=$(find "$TARGET_PATH/$rel/node_modules" -type l 2>/dev/null || true)
        while IFS= read -r link; do
            [[ -n "$link" ]] || continue
            [[ -e "$link" ]] || return 0
        done <<< "$links"
    done < "$manifest"
    return 1
}

# Restore node_modules for ($pm, $hash) from the cross-worktree shared
# cache into this worktree (issue #387): every dir listed in the entry's
# manifest — the root and each workspace package (issue #748). On success,
# also writes the in-worktree cache file so a subsequent run in the same
# worktree hits the existing (issue #375) in-worktree cache_hit path.
# Returns 1 when the entry has no manifest, a listed dir is absent on
# either side, a copy fails, or pnpm workspace packages still lack
# node_modules afterwards, so the caller falls open into the normal install
# path (which repairs the partially restored tree).
restore_from_shared_cache() {
    local pm="$1"
    local hash="$2"
    local entry="$SHARED_CACHE_ROOT/${pm}-${hash}"
    [[ -f "$entry/$CACHE_MANIFEST" ]] || return 1
    local rel
    while IFS= read -r rel; do
        [[ -n "$rel" ]] || continue
        [[ -d "$entry/$rel/node_modules" && -d "$TARGET_PATH/$rel" ]] || return 1
        copy_tree "$entry/$rel/node_modules" "$TARGET_PATH/$rel/node_modules" || return 1
    done < "$entry/$CACHE_MANIFEST"
    # Relative symlinks that leave the tree (pnpm's global virtual store links
    # node_modules/<pkg> to ~/Library/pnpm/store/.../links, issue #1118) only
    # resolve at the depth of the worktree that populated the entry. Drop a
    # restored tree with a dangling link: pnpm reports such a tree "Already up
    # to date" and leaves the links broken, so the install must start clean.
    if has_dangling_symlink "$entry/$CACHE_MANIFEST"; then
        while IFS= read -r rel; do
            [[ -n "$rel" ]] || continue
            rm -rf "$TARGET_PATH/$rel/node_modules" 2>/dev/null || true
        done < "$entry/$CACHE_MANIFEST"
        return 1
    fi
    [[ -z "$(missing_workspace_node_modules "$pm")" ]] || return 1
    if [[ "$pm" == "pnpm" ]]; then rebase_pnpm_workspace_state; fi
    { mkdir -p "$TARGET_PATH/.devflow-tmp" && printf '%s\n' "${pm}:${hash}" > "$TARGET_PATH/.devflow-tmp/deps-lockfile-hash"; } 2>/dev/null || true
    return 0
}

# pnpm records the absolute path of every workspace project as the keys of
# .projects in node_modules/.pnpm-workspace-state*.json. A restored tree
# carries the paths of the worktree that populated the cache entry, so pnpm
# (verifyDepsBeforeRun) treats the deps as out of date and installs before
# `pnpm run` / `pnpm test`. That install runs inside the Bash sandbox for the
# Validate test agent and workspace-prebuild, where pnpm 12 cannot reach the
# registry (TLS fails), so the run fails. Rebase the keys from the source
# root (the shortest key; every other project lives under it) onto this
# worktree. Fail-open: an unreadable state is left as is, and pnpm falls back
# to installing before the run as it did before this rebase existed.
rebase_pnpm_workspace_state() {
    local state tmp
    for state in "$TARGET_PATH"/node_modules/.pnpm-workspace-state*.json; do
        [[ -f "$state" ]] || continue
        tmp="$state.devflow-rebase.$$"
        if jq -c --arg dst "$TARGET_PATH" '
            if (.projects | type) == "object" and (.projects | length) > 0 then
              (.projects | keys | min_by(length)) as $src
              | .projects |= with_entries(
                  if .key == $src then .key = $dst
                  elif (.key | startswith($src + "/")) then .key = $dst + (.key | ltrimstr($src))
                  else . end)
            else . end' "$state" > "$tmp" 2>/dev/null; then
            mv "$tmp" "$state" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
        else
            rm -f "$tmp" 2>/dev/null || true
        fi
    done
    return 0
}

# Publish this worktree's freshly-installed node_modules — the root and
# every workspace package that has one (issue #748) — into the
# cross-worktree shared cache for ($pm, $hash) (issue #387), so later
# fresh worktrees with the same lockfile hash can restore instead of
# installing. Copies into a staging dir first (manifest written last) and
# renames it into place atomically, so a concurrent dev-flow run populating
# the same hash can never observe a partially-written cache entry (first
# writer to complete the rename wins; the loser's staging dir is
# discarded). No-ops if a manifest-bearing entry already exists; an entry
# without a manifest is never restored, so it is removed to make room.
# Every failure (mkdir/mktemp/copy/mv/rm) is swallowed — populate is
# best-effort and never affects the caller's install result.
populate_shared_cache() {
    local pm="$1"
    local hash="$2"
    local final="$SHARED_CACHE_ROOT/${pm}-${hash}"
    [[ -f "$final/$CACHE_MANIFEST" ]] && return 0
    mkdir -p "$SHARED_CACHE_ROOT" 2>/dev/null || return 0
    local staging
    staging=$(mktemp -d "$SHARED_CACHE_ROOT/.staging.XXXXXX" 2>/dev/null) || return 0
    local rels="." rel
    while IFS= read -r rel; do
        [[ -n "$rel" && -d "$TARGET_PATH/$rel/node_modules" ]] && rels+=$'\n'"$rel"
    done <<< "$(workspace_pkg_dirs "$pm")"
    while IFS= read -r rel; do
        if ! { mkdir -p "$staging/$rel" && copy_tree "$TARGET_PATH/$rel/node_modules" "$staging/$rel/node_modules"; } 2>/dev/null; then
            rm -rf "$staging" 2>/dev/null || true
            return 0
        fi
    done <<< "$rels"
    if ! printf '%s\n' "$rels" > "$staging/$CACHE_MANIFEST" 2>/dev/null; then
        rm -rf "$staging" 2>/dev/null || true
        return 0
    fi
    [[ -e "$final" && ! -f "$final/$CACHE_MANIFEST" ]] && { rm -rf "$final" 2>/dev/null || true; }
    mv "$staging" "$final" 2>/dev/null || rm -rf "$staging" 2>/dev/null || true
    return 0
}

# ============================================================================
# Install Functions
# ============================================================================

install_node() {
    local pm="$1"
    local cmd=""

    case "$pm" in
        # Global virtual store (issue #1118): packages are imported into the
        # pnpm store instead of node_modules/.pnpm, so a package shipping a
        # .gitmodules (which the worktree sandbox refuses to write) installs.
        pnpm)   cmd="pnpm install --frozen-lockfile --config.enable-global-virtual-store=true" ;;
        yarn)   cmd="yarn install --frozen-lockfile" ;;
        bun)    cmd="bun install --frozen-lockfile" ;;
        npm)    cmd="npm ci" ;;
        npm-no-lock) cmd="npm install" ;;
    esac

    # Lockfile-hash skip cache (issue #375): if node_modules already exists
    # and the lockfile's hash matches the hash recorded from the last
    # successful install for this pm, skip the install deterministically.
    # npm-no-lock has no lockfile to hash (the --lockfile-only dev-flow
    # entrypoint never selects npm-no-lock, so this only matters for
    # direct/manual invocations) and falls back to the coarse
    # already_installed check below. Any failure to establish a hash match
    # (missing tools, unreadable lockfile, no cache file, mismatched
    # content) fails open into the normal install path below.
    local lockfile=""
    case "$pm" in
        pnpm) lockfile="pnpm-lock.yaml" ;;
        yarn) lockfile="yarn.lock" ;;
        bun)  lockfile="bun.lockb" ;;
        npm)  lockfile="package-lock.json" ;;
    esac

    local cache_file="$TARGET_PATH/.devflow-tmp/deps-lockfile-hash"
    local current_hash=""
    if [[ -n "$lockfile" ]]; then
        current_hash=$(hash_lockfile "$TARGET_PATH/$lockfile" 2>/dev/null || true)
        if [[ -d "$TARGET_PATH/node_modules" && -n "$current_hash" && -f "$cache_file" ]]; then
            local cached
            cached=$(cat "$cache_file" 2>/dev/null || true)
            # A hash match over a tree whose pnpm workspace packages lack
            # node_modules is not a hit — fall through and install (issue #748).
            if [[ "$cached" == "${pm}:${current_hash}" && -z "$(missing_workspace_node_modules "$pm")" ]]; then
                echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"cache_hit\",\"command\":\"$cmd\"}"
                return 0
            fi
        fi
    fi

    if [[ "$pm" == "npm-no-lock" && -d "$TARGET_PATH/node_modules" ]]; then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"already_installed\",\"command\":\"$cmd\"}"
        return 0
    fi

    # Cross-worktree shared cache restore (issue #387): only for pms with a
    # lockfile, only when this worktree has no node_modules yet (mutually
    # exclusive with the in-worktree cache_hit / already_installed branches
    # above, which both require node_modules to already exist), and only
    # under the --lockfile-only dev-flow Setup contract (so direct/manual
    # invocations without the flag never touch the shared cache).
    if [[ "$LOCKFILE_ONLY" == true && -n "$lockfile" && -n "$current_hash" && ! -d "$TARGET_PATH/node_modules" && -n "$SHARED_CACHE_ROOT" && -f "$SHARED_CACHE_ROOT/${pm}-${current_hash}/$CACHE_MANIFEST" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"cross_worktree_restore\",\"command\":\"$cmd\"}"
            return 0
        fi
        if restore_from_shared_cache "$pm" "$current_hash"; then
            echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"cross_worktree_restore\",\"command\":\"$cmd\"}"
            return 0
        fi
        # restore failed (e.g. unreadable shared cache entry) — fall
        # through to the normal install path below (fail-open).
    fi

    local bin
    bin=$(resolve_bin "$pm")
    if ! command -v "$bin" &>/dev/null; then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"pm_not_found\",\"command\":\"$cmd\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"dry_run\",\"command\":\"$cmd\"}"
        return 0
    fi

    if run_install_cmd "$cmd"; then
        local missing
        missing=$(missing_workspace_node_modules "$pm")
        if [[ -n "$missing" ]]; then
            node_missing_result "$pm" "$cmd" "$missing"
            return 1
        fi
        if [[ -n "$lockfile" && -n "$current_hash" ]]; then
            { mkdir -p "$TARGET_PATH/.devflow-tmp" && printf '%s\n' "${pm}:${current_hash}" > "$cache_file"; } 2>/dev/null || true
        fi
        if [[ "$LOCKFILE_ONLY" == true && -n "$lockfile" && -n "$current_hash" && -n "$SHARED_CACHE_ROOT" && -d "$TARGET_PATH/node_modules" ]]; then
            populate_shared_cache "$pm" "$current_hash" || true
        fi
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"installed\",\"command\":\"$cmd\"}"
    else
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"failed\",\"command\":\"$cmd\"}"
        return 1
    fi
}

install_python() {
    local pm="$1"
    local cmd=""

    case "$pm" in
        pip)          cmd="pip install -r requirements.txt" ;;
        pipenv)       cmd="pipenv install" ;;
        poetry)       cmd="poetry install" ;;
        uv)           cmd="uv sync" ;;
        pip-pyproject) cmd="pip install -e ." ;;
    esac

    local bin
    bin=$(resolve_bin "$pm")
    if ! command -v "$bin" &>/dev/null; then
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"pm_not_found\",\"command\":\"$cmd\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"dry_run\",\"command\":\"$cmd\"}"
        return 0
    fi

    if run_install_cmd "$cmd"; then
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"installed\",\"command\":\"$cmd\"}"
    else
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"failed\",\"command\":\"$cmd\"}"
        return 1
    fi
}

install_other() {
    local pm="$1"
    local cmd=""

    case "$pm" in
        go)       cmd="go mod download" ;;
        bundler)  cmd="bundle install" ;;
        cargo)    cmd="cargo fetch" ;;
        composer) cmd="composer install" ;;
    esac

    local bin
    bin=$(resolve_bin "$pm")
    if ! command -v "$bin" &>/dev/null; then
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"pm_not_found\",\"command\":\"$cmd\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"dry_run\",\"command\":\"$cmd\"}"
        return 0
    fi

    if run_install_cmd "$cmd"; then
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"installed\",\"command\":\"$cmd\"}"
    else
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"failed\",\"command\":\"$cmd\"}"
        return 1
    fi
}

# ============================================================================
# Custom Setup
# ============================================================================

run_custom_setup() {
    local setup_script="$TARGET_PATH/.claude/setup.sh"

    if [[ ! -f "$setup_script" ]]; then
        echo "{\"custom_setup\":\"not_found\"}"
        return 0
    fi

    if [[ "$SKIP_CUSTOM" == true ]]; then
        echo "{\"custom_setup\":\"skipped\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"custom_setup\":\"dry_run\",\"script\":\"$setup_script\"}"
        return 0
    fi

    if (cd "$TARGET_PATH" && bash "$setup_script") >&2 2>&1; then
        echo "{\"custom_setup\":\"executed\",\"script\":\"$setup_script\"}"
    else
        warn "Custom setup script failed (non-blocking): $setup_script"
        echo "{\"custom_setup\":\"failed\",\"script\":\"$setup_script\"}"
    fi
}

# ============================================================================
# Main
# ============================================================================

RESULTS="[]"
OVERALL_STATUS="success"

# Detect and install Node.js dependencies
NODE_PM=$(detect_node_pm)
if [[ -n "$NODE_PM" ]]; then
    result=$(install_node "$NODE_PM" 2>/dev/null) || OVERALL_STATUS="partial"
    RESULTS=$(echo "$RESULTS" | jq --argjson r "$result" '. + [$r]')
fi

# Detect and install Python dependencies
PYTHON_PM=$(detect_python_pm)
if [[ -n "$PYTHON_PM" ]]; then
    result=$(install_python "$PYTHON_PM" 2>/dev/null) || OVERALL_STATUS="partial"
    RESULTS=$(echo "$RESULTS" | jq --argjson r "$result" '. + [$r]')
fi

# Detect and install other dependencies
OTHER_PMS=$(detect_other_pm)
if [[ -n "$OTHER_PMS" ]]; then
    for pm in $OTHER_PMS; do
        result=$(install_other "$pm" 2>/dev/null) || OVERALL_STATUS="partial"
        RESULTS=$(echo "$RESULTS" | jq --argjson r "$result" '. + [$r]')
    done
fi

# Run custom setup
CUSTOM_RESULT=$(run_custom_setup 2>/dev/null)

# Check if anything was detected
if [[ $(echo "$RESULTS" | jq 'length') -eq 0 ]]; then
    echo "{\"status\":\"no_dependencies\",\"path\":\"$TARGET_PATH\",\"results\":[],\"custom\":$CUSTOM_RESULT}"
    exit 0
fi

echo "{\"status\":\"$OVERALL_STATUS\",\"path\":\"$TARGET_PATH\",\"results\":$RESULTS,\"custom\":$CUSTOM_RESULT}"
