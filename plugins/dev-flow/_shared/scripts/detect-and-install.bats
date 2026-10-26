#!/usr/bin/env bats
# Tests for _shared/scripts/detect-and-install.sh
#
# Strategy: mktemp -d で一時ディレクトリを作成し、依存ファイルの有無で --lockfile-only の
# 挙動を検証する。実 install を避けるため全ケース --dry-run を併用する (issue #291 / F3)。

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/detect-and-install.sh"
    TMP_DIR="$(mktemp -d)"
    # Isolate the cross-worktree shared cache (issue #387) to a directory
    # under TMP_DIR by default, so tests never read from or write into the
    # real $HOME/.cache/devflow-deps. Individual shared-cache tests below
    # re-export DEVFLOW_DEPS_CACHE_DIR to their own TMP_DIR-scoped path,
    # which simply overrides this default; both stay hermetic.
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/.default-shared-cache"
}

teardown() {
    chmod 644 "$TMP_DIR/package-lock.json" 2>/dev/null || true
    rm -rf "$TMP_DIR"
    unset DEVFLOW_DEPS_CACHE_DIR
}

# Mirrors the sha256sum -> shasum -a 256 fallback used by hash_lockfile() in
# detect-and-install.sh, so tests can compute the expected cache value
# (issue #375).
compute_hash() {
    local f="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$f" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$f" | awk '{print $1}'
    else
        return 1
    fi
}

@test "(a) package.json のみ (lock なし) + --lockfile-only --dry-run では node の result が含まれない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | map(select(.ecosystem == "node")) | length == 0'
    printf '%s\n' "$output" | jq -e '.status == "no_dependencies"'
}

@test "(b) package.json + package-lock.json + --lockfile-only --dry-run は npm ci の dry_run result を含む" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run" and .command == "npm ci")'
}

@test "(c) pnpm-lock.yaml + --lockfile-only --dry-run は pm 'pnpm' を検出する" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    : > "$TMP_DIR/pnpm-lock.yaml"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm")'
}

@test "(d) requirements.txt のみ + --lockfile-only --dry-run では python の result が含まれない" {
    echo 'requests==2.0.0' > "$TMP_DIR/requirements.txt"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | map(select(.ecosystem == "python")) | length == 0'
}

@test "(e) go.mod のみ (go.sum なし) + --lockfile-only --dry-run では go の result が含まれない" {
    echo 'module example.com/foo' > "$TMP_DIR/go.mod"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | map(select(.ecosystem == "go")) | length == 0'
}

@test "(e-2) go.mod + go.sum + --lockfile-only --dry-run では go の result が含まれる" {
    echo 'module example.com/foo' > "$TMP_DIR/go.mod"
    : > "$TMP_DIR/go.sum"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "go")'
}

@test "(f) フラグなしの既存挙動は不変: package.json のみ + --dry-run は pm 'npm-no-lock' / command 'npm install'" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm-no-lock" and .command == "npm install")'
}

@test "(g) lockfile hash がキャッシュと一致 + node_modules ありは cache_hit で skip する (issue #375)" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    printf 'npm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit")'
}

@test "(h) lockfile hash がキャッシュと不一致は fail-open で再 install パス (dry_run) を取る" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    printf 'npm:deadbeef\n' > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit") | not'
}

@test "(i) cache 情報なし (node_modules ありだが cache file なし) は fail-open で install パス (dry_run) を取る" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "already_installed") | not'
}

@test "(j) lockfile 読み取り不能 (hash取得失敗) は fail-open で install パス (dry_run) を取る" {
    [[ "${EUID:-0}" -eq 0 ]] && skip "root では chmod 000 が読み取り制限にならない"
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    printf 'npm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    chmod 000 "$TMP_DIR/package-lock.json"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    chmod 644 "$TMP_DIR/package-lock.json"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
}

@test "(k) install 成功時に cache を保存し、2回目は cache_hit で stub npm を再実行しない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    STUB_LOG="$TMP_DIR/npm-invocations.log"
    : > "$STUB_LOG"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
echo "\$@" >> "$STUB_LOG"
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
    [ -f "$TMP_DIR/.devflow-tmp/deps-lockfile-hash" ]
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    [ "$(cat "$TMP_DIR/.devflow-tmp/deps-lockfile-hash")" = "npm:$hash" ]

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit")'
    [ "$(wc -l < "$STUB_LOG" | tr -d ' ')" -eq 1 ]
}

@test "(l) pnpm でも lockfile hash 一致で cache_hit する" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    : > "$TMP_DIR/pnpm-lock.yaml"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/pnpm-lock.yaml")
    printf 'pnpm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "cache_hit")'
}

# ============================================================================
# Cross-worktree shared cache (issue #387).
#
# The shared cache root is overridable via DEVFLOW_DEPS_CACHE_DIR so tests
# stay hermetic (never touch $HOME). Layout: <root>/<pm>-<sha256(lockfile)>/
# node_modules (+ <rel>/node_modules per workspace package) and a manifest
# <root>/<pm>-<sha256(lockfile)>/node_modules.list (issue #748). The
# mechanism only activates when --lockfile-only is passed
# (dev-flow's fixed Setup contract flag); without it, the shared cache is
# never touched. New status string: "cross_worktree_restore".
# ============================================================================

@test "(m) fresh worktree + 共有キャッシュに hash 一致エントリがあれば --lockfile-only で cross_worktree_restore する" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    mkdir -p "$SHARED/npm-$hash/node_modules"
    : > "$SHARED/npm-$hash/node_modules/.marker"
    printf '.\n' > "$SHARED/npm-$hash/node_modules.list"

    run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cross_worktree_restore")'
    [ -f "$TMP_DIR/node_modules/.marker" ]
    [ -f "$TMP_DIR/.devflow-tmp/deps-lockfile-hash" ]
    [ "$(cat "$TMP_DIR/.devflow-tmp/deps-lockfile-hash")" = "npm:$hash" ]
}

@test "(n) --lockfile-only 無しでは共有キャッシュに一致エントリがあっても使わない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    mkdir -p "$SHARED/npm-$hash/node_modules"
    : > "$SHARED/npm-$hash/node_modules/.marker"

    run "$SCRIPT" --path "$TMP_DIR" --dry-run
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
}

@test "(o) lockfile hash 不一致では共有キャッシュを使わず通常 install パスにフォールバックする" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    mkdir -p "$SHARED/npm-deadbeef/node_modules"

    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "dry_run")'
}

@test "(p) node_modules ありの既存 cache_hit 経路は共有キャッシュがあっても cross_worktree_restore にならない" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    mkdir -p "$TMP_DIR/node_modules"
    mkdir -p "$TMP_DIR/.devflow-tmp"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    printf 'npm:%s\n' "$hash" > "$TMP_DIR/.devflow-tmp/deps-lockfile-hash"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    mkdir -p "$SHARED/npm-$hash/node_modules"

    run "$SCRIPT" --path "$TMP_DIR" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cache_hit")'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
}

@test "(q) install 成功後に共有キャッシュへ populate される" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
    [ -d "$SHARED/npm-$hash/node_modules" ]
}

@test "(r) populate の dest 衝突は crash しない（並行 run 想定）" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    # stub npm がインストールと同時に「別プロセスが先に populate 済み」の状態を
    # 模擬する (populate 時点での dest 衝突を再現するため、restore 判定が走る
    # install 開始前ではなく install 実行中に共有キャッシュを出現させる)。
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
mkdir -p "$SHARED/npm-$hash/node_modules"
: > "$SHARED/npm-$hash/node_modules/.marker"
printf '.\n' > "$SHARED/npm-$hash/node_modules.list"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
    [ -f "$SHARED/npm-$hash/node_modules/.marker" ]
}

@test "(s) 共有キャッシュ書き込み不能時は fail-open で installed を返す" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"
    # DEVFLOW_DEPS_CACHE_DIR を通常ファイルに向け、mkdir -p を構造的に失敗させる
    : > "$TMP_DIR/not-a-dir"
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/not-a-dir"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
}

@test "(t) 共有キャッシュ復元コピー失敗時は fail-open で通常 install パスに落ちる" {
    [[ "${EUID:-0}" -eq 0 ]] && skip "root では chmod 000 が読み取り制限にならない"
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    echo '{}' > "$TMP_DIR/package-lock.json"
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"

    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$TMP_DIR/package-lock.json")
    mkdir -p "$SHARED/npm-$hash/node_modules"
    : > "$SHARED/npm-$hash/node_modules/.marker"
    printf '.\n' > "$SHARED/npm-$hash/node_modules.list"
    # 復元元ディレクトリを読み取り不能にし、cp によるコピーを失敗させる
    chmod 000 "$SHARED/npm-$hash/node_modules"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    chmod 755 "$SHARED/npm-$hash/node_modules"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'
}

# ============================================================================
# Workspaces (issue #748).
#
# pnpm は workspace package ごとに node_modules（.pnpm への symlink 群）を作る。共有キャッシュは
# root と各 workspace package の node_modules を保存・復元し、pnpm で依存を宣言した package に
# node_modules が無ければ node の result を failed（missing_node_modules 付き）にする。
# ============================================================================

# pnpm workspace の fixture を $1 に作る。packages/backend・packages/shared は依存を宣言し、
# packages/nodeps は依存なし、packages/ignored は "!" で除外、packages/backend/fixtures/pkg は
# 'packages/*' の 1 階層に一致しない（いずれも node_modules を要求されない）。
make_pnpm_workspace() {
    local dir="$1"
    mkdir -p "$dir/packages/backend/fixtures/pkg" "$dir/packages/shared" "$dir/packages/nodeps" "$dir/packages/ignored"
    echo '{"name":"root","version":"1.0.0","private":true}' > "$dir/package.json"
    printf 'lockfileVersion: 9.0\n' > "$dir/pnpm-lock.yaml"
    cat > "$dir/pnpm-workspace.yaml" <<'YAML'
packages:
  - 'packages/*'
  - "!packages/ignored"   # 除外
YAML
    echo '{"name":"backend","devDependencies":{"vitest":"^3.0.0"}}' > "$dir/packages/backend/package.json"
    echo '{"name":"fixture","dependencies":{"left-pad":"1.0.0"}}' > "$dir/packages/backend/fixtures/pkg/package.json"
    echo '{"name":"shared","dependencies":{"zod":"^3.0.0"}}' > "$dir/packages/shared/package.json"
    echo '{"name":"nodeps"}' > "$dir/packages/nodeps/package.json"
    echo '{"name":"ignored","dependencies":{"zod":"^3.0.0"}}' > "$dir/packages/ignored/package.json"
}

# stub pnpm: root の node_modules（.pnpm 配下に vitest）を作り、STUB_PNPM_PKGS（空白区切り）の
# package にだけ .pnpm への相対 symlink を張った node_modules を作る。呼び出しは STUB_LOG に残す。
make_stub_pnpm() {
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    STUB_LOG="$TMP_DIR/pnpm-invocations.log"
    : > "$STUB_LOG"
    cat > "$STUB_DIR/pnpm" <<STUBEOF
#!/usr/bin/env bash
echo "\$@" >> "$STUB_LOG"
mkdir -p "\$PWD/node_modules/.pnpm/vitest@3.0.0/node_modules/vitest"
echo '{"name":"vitest"}' > "\$PWD/node_modules/.pnpm/vitest@3.0.0/node_modules/vitest/package.json"
# pnpm 本体と同じく、install した worktree の絶対パスを projects のキーに持つ workspace state を書く
projects='{}'
for p in . \${STUB_PNPM_PKGS:-}; do
    key="\$PWD"; [ "\$p" = . ] || key="\$PWD/\$p"
    projects=\$(jq -c --arg k "\$key" --arg n "\$p" '. + {(\$k): {name: \$n}}' <<< "\$projects")
done
jq -nc --argjson p "\$projects" '{lastValidatedTimestamp: 1, projects: \$p, settings: {}}' > "\$PWD/node_modules/.pnpm-workspace-state-v1.json"
for p in \${STUB_PNPM_PKGS:-}; do
    mkdir -p "\$PWD/\$p/node_modules"
    ln -s ../../../node_modules/.pnpm/vitest@3.0.0/node_modules/vitest "\$PWD/\$p/node_modules/vitest"
done
exit 0
STUBEOF
    chmod +x "$STUB_DIR/pnpm"
}

@test "(u) pnpm workspace: install 後の共有キャッシュに root と各 package の node_modules・manifest が入る" {
    WT_A="$TMP_DIR/wt-a"
    make_pnpm_workspace "$WT_A"
    make_stub_pnpm
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$WT_A/pnpm-lock.yaml")

    STUB_PNPM_PKGS="packages/backend packages/shared" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.status == "success"'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "installed")'
    entry="$SHARED/pnpm-$hash"
    [ -d "$entry/node_modules/.pnpm" ]
    [ -L "$entry/packages/backend/node_modules/vitest" ]
    [ -L "$entry/packages/shared/node_modules/vitest" ]
    [ "$(sort "$entry/node_modules.list" | tr '\n' ' ')" = ". packages/backend packages/shared " ]
}

@test "(v) pnpm workspace: 共有キャッシュから復元すると packages/*/node_modules が揃い、symlink が解決できる (AC-1)" {
    WT_A="$TMP_DIR/wt-a"
    WT_B="$TMP_DIR/wt-b"
    make_pnpm_workspace "$WT_A"
    make_pnpm_workspace "$WT_B"
    make_stub_pnpm
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/shared-cache"

    STUB_PNPM_PKGS="packages/backend packages/shared" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    : > "$STUB_LOG"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_B" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.status == "success"'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "cross_worktree_restore")'
    # 復元経路では pnpm を呼ばない
    [ ! -s "$STUB_LOG" ]
    [ -d "$WT_B/node_modules/.pnpm" ]
    [ -L "$WT_B/packages/backend/node_modules/vitest" ]
    [ -L "$WT_B/packages/shared/node_modules/vitest" ]
    # 相対 symlink が WT_B 自身の root node_modules/.pnpm を指す
    [ -f "$WT_B/packages/backend/node_modules/vitest/package.json" ]
    [[ "$(cd "$WT_B/packages/backend/node_modules/vitest" && pwd -P)" == "$(cd "$WT_B" && pwd -P)/"* ]]
}

@test "(v-2) pnpm workspace: 復元した workspace state の projects を復元先 worktree のパスに付け替える" {
    WT_A="$TMP_DIR/wt-a"
    WT_B="$TMP_DIR/wt-b"
    make_pnpm_workspace "$WT_A"
    make_pnpm_workspace "$WT_B"
    make_stub_pnpm
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/shared-cache"

    STUB_PNPM_PKGS="packages/backend packages/shared" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_B" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore")'
    state="$WT_B/node_modules/.pnpm-workspace-state-v1.json"
    # 復元元（wt-a）のパスが残っていると、pnpm は run の前に install を始める
    jq -e --arg b "$(cd "$WT_B" && pwd)" '.projects | keys == [$b, $b + "/packages/backend", $b + "/packages/shared"]' "$state"
    jq -e '.projects | to_entries | map(.value.name) == [".", "packages/backend", "packages/shared"]' "$state"
    # キャッシュ entry 側は書き換えない
    jq -e --arg a "$(cd "$WT_A" && pwd)" '.projects | has($a)' "$TMP_DIR/shared-cache/"pnpm-*/node_modules/.pnpm-workspace-state-v1.json
}

@test "(v-3) pnpm workspace: workspace state が JSON として読めなくても復元は成功し、ファイルはそのまま残る" {
    WT_A="$TMP_DIR/wt-a"
    WT_B="$TMP_DIR/wt-b"
    make_pnpm_workspace "$WT_A"
    make_pnpm_workspace "$WT_B"
    make_stub_pnpm
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/shared-cache"

    STUB_PNPM_PKGS="packages/backend packages/shared" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    echo 'not json' > "$TMP_DIR/shared-cache/"pnpm-*/node_modules/.pnpm-workspace-state-v1.json

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_B" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore")'
    [ "$(cat "$WT_B/node_modules/.pnpm-workspace-state-v1.json")" = "not json" ]
    [ -z "$(ls "$WT_B/node_modules" | grep -F devflow-tmp)" ]
}

@test "(w) manifest の無い共有キャッシュ entry（root の node_modules のみ）からは復元せず install し、entry を置き換える" {
    WT_A="$TMP_DIR/wt-a"
    make_pnpm_workspace "$WT_A"
    make_stub_pnpm
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$WT_A/pnpm-lock.yaml")
    mkdir -p "$SHARED/pnpm-$hash/node_modules/.pnpm"

    STUB_PNPM_PKGS="packages/backend packages/shared" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "installed")'
    [ -s "$STUB_LOG" ]
    [ -f "$SHARED/pnpm-$hash/node_modules.list" ]
    [ -d "$SHARED/pnpm-$hash/packages/backend/node_modules" ]
}

@test "(x) pnpm workspace: 依存を宣言した package に node_modules が無ければ node は failed・全体は ok にならない (AC-2)" {
    WT_A="$TMP_DIR/wt-a"
    make_pnpm_workspace "$WT_A"
    make_stub_pnpm
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$WT_A/pnpm-lock.yaml")

    # root の node_modules だけ作られ、packages/shared が欠ける
    STUB_PNPM_PKGS="packages/backend" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.status == "partial"'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "failed" and .missing_node_modules == ["packages/shared"])'
    # 欠けた tree は in-worktree cache にも共有キャッシュにも載せない
    [ ! -f "$WT_A/.devflow-tmp/deps-lockfile-hash" ]
    [ ! -d "$SHARED/pnpm-$hash" ]
}

@test "(y) 復元後に package の node_modules が欠ける entry は install に落ち、install でも欠ければ failed (AC-2)" {
    WT_A="$TMP_DIR/wt-a"
    make_pnpm_workspace "$WT_A"
    make_stub_pnpm
    SHARED="$TMP_DIR/shared-cache"
    export DEVFLOW_DEPS_CACHE_DIR="$SHARED"
    hash=$(compute_hash "$WT_A/pnpm-lock.yaml")
    # manifest は root だけを挙げる（packages/*/node_modules を持たない entry）
    mkdir -p "$SHARED/pnpm-$hash/node_modules/.pnpm"
    printf '.\n' > "$SHARED/pnpm-$hash/node_modules.list"

    STUB_PNPM_PKGS="" PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cross_worktree_restore") | not'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "failed" and .missing_node_modules == ["packages/backend","packages/shared"])'
    [ -s "$STUB_LOG" ]
}

@test "(z) pnpm workspace: lockfile hash 一致でも package の node_modules が欠けていれば cache_hit にしない" {
    WT_A="$TMP_DIR/wt-a"
    make_pnpm_workspace "$WT_A"
    mkdir -p "$WT_A/node_modules" "$WT_A/.devflow-tmp"
    hash=$(compute_hash "$WT_A/pnpm-lock.yaml")
    printf 'pnpm:%s\n' "$hash" > "$WT_A/.devflow-tmp/deps-lockfile-hash"

    run "$SCRIPT" --path "$WT_A" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .status == "cache_hit") | not'

    mkdir -p "$WT_A/packages/backend/node_modules" "$WT_A/packages/shared/node_modules"
    run "$SCRIPT" --path "$WT_A" --dry-run --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "cache_hit")'
}

# ============================================================================
# Global virtual store (issue #1118).
#
# pnpm は global virtual store で install する（node_modules/.pnpm に展開すると .gitmodules を含む
# パッケージが worktree の sandbox で EPERM になる）。node_modules/<pkg> は worktree 外の store への
# 相対 symlink になるので、深さの違う worktree へ共有キャッシュから復元すると解決しない。
# ============================================================================

# stub pnpm: global virtual store と同じく、node_modules/vitest を $TMP_DIR/store/links/vitest への
# 相対 symlink にする（install した worktree の深さから ../ の数を決める）。呼び出しは STUB_LOG に残す。
make_stub_pnpm_gvs() {
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR" "$TMP_DIR/store/links/vitest"
    echo '{"name":"vitest"}' > "$TMP_DIR/store/links/vitest/package.json"
    STUB_LOG="$TMP_DIR/pnpm-invocations.log"
    : > "$STUB_LOG"
    cat > "$STUB_DIR/pnpm" <<STUBEOF
#!/usr/bin/env bash
echo "\$@" >> "$STUB_LOG"
up="../"
IFS=/ read -ra parts <<< "\${PWD#$TMP_DIR/}"
for _ in "\${parts[@]}"; do up+="../"; done
mkdir -p "\$PWD/node_modules"
ln -s "\${up}store/links/vitest" "\$PWD/node_modules/vitest"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/pnpm"
}

make_pnpm_project() {
    mkdir -p "$1"
    echo '{"name":"app","devDependencies":{"vitest":"^3.0.0"}}' > "$1/package.json"
    printf 'lockfileVersion: 9.0\n' > "$1/pnpm-lock.yaml"
}

@test "(ab) pnpm の install は global virtual store を有効にして実行する (issue #1118)" {
    WT_A="$TMP_DIR/wt-a"
    make_pnpm_project "$WT_A"
    make_stub_pnpm_gvs

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "installed")'
    [ "$(cat "$STUB_LOG")" = "install --frozen-lockfile --config.enable-global-virtual-store=true" ]
    [ -f "$WT_A/node_modules/vitest/package.json" ]
}

@test "(ac) 共有キャッシュから深さの違う worktree へ復元して symlink が解決しなければ、復元せず install する (issue #1118)" {
    WT_A="$TMP_DIR/wt-a"
    WT_SAME="$TMP_DIR/wt-same"
    WT_DEEP="$TMP_DIR/nested/wt-deep"
    make_pnpm_project "$WT_A"
    make_pnpm_project "$WT_SAME"
    make_pnpm_project "$WT_DEEP"
    make_stub_pnpm_gvs
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/shared-cache"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "installed")'
    : > "$STUB_LOG"

    # 同じ深さなら相対 symlink は解決するので復元する
    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_SAME" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "cross_worktree_restore")'
    [ ! -s "$STUB_LOG" ]

    # 深さが違うと復元した symlink が解決しない → 復元を捨てて install する
    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_DEEP" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.status == "success"'
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "pnpm" and .status == "installed")'
    [ -s "$STUB_LOG" ]
    [ -f "$WT_DEEP/node_modules/vitest/package.json" ]
}

@test "(aa) npm workspaces（package.json workspaces）でも package の node_modules を共有キャッシュ経由で復元する" {
    WT_A="$TMP_DIR/wt-a"
    WT_B="$TMP_DIR/wt-b"
    for d in "$WT_A" "$WT_B"; do
        mkdir -p "$d/apps/web"
        echo '{"name":"root","private":true,"workspaces":{"packages":["./apps/*"]}}' > "$d/package.json"
        echo '{}' > "$d/package-lock.json"
        echo '{"name":"web","dependencies":{"react":"^19.0.0"}}' > "$d/apps/web/package.json"
    done
    STUB_DIR="$TMP_DIR/.stubbin"
    mkdir -p "$STUB_DIR"
    cat > "$STUB_DIR/npm" <<STUBEOF
#!/usr/bin/env bash
mkdir -p "\$PWD/node_modules" "\$PWD/apps/web/node_modules/react"
exit 0
STUBEOF
    chmod +x "$STUB_DIR/npm"
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/shared-cache"

    PATH="$STUB_DIR:$PATH" run "$SCRIPT" --path "$WT_A" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "installed")'

    run "$SCRIPT" --path "$WT_B" --lockfile-only
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.results | any(.ecosystem == "node" and .pm == "npm" and .status == "cross_worktree_restore")'
    [ -d "$WT_B/apps/web/node_modules/react" ]
}
