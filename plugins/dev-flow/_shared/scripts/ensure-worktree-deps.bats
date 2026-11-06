#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/ensure-worktree-deps.sh
#
# Strategy: mktemp -d で一時ディレクトリを作成し、ファイルの有無で挙動を検証する。
# NOTE: F2 でスクリプトが実装されるまでこれらのテストは fail (red) になる。

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/ensure-worktree-deps.sh"
    TMP_DIR="$(mktemp -d)"
}

teardown() {
    rm -rf "$TMP_DIR"
}

@test "依存ファイル皆無のディレクトリで exit 0 かつ no_dependencies を含む JSON を stdout に出す" {
    # TMP_DIR は空 — 依存ファイルなし
    run "$SCRIPT" --path "$TMP_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no_dependencies"* ]]
}

@test "--path 未指定で非 0 exit (必須引数エラー)" {
    run "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "package.json のみ (lock なし) のディレクトリでも exit 0 (pm_not_found 経由)" {
    # lock ファイルなし、package.json のみ → npm-no-lock として検出
    # テスト環境に npm がある場合でも install 失敗 / already_installed / installed いずれかで exit 0
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR"
    [ "$status" -eq 0 ]
}

@test "detect-and-install.sh が存在しないパスで呼ばれても exit 0 かつ status:failed の JSON を返す" {
    # /nonexistent/xyz を渡すと detect-and-install.sh が die_json で exit 1 する
    run "$SCRIPT" --path "/nonexistent/xyz_$$"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status":"failed"'* ]]
}

@test "委譲先失敗時の JSON に path フィールドが含まれる" {
    run "$SCRIPT" --path "/nonexistent/xyz_$$"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"path"'* ]]
}

@test "委譲先失敗時のフォールバック JSON が jq で parse でき status が failed である" {
    # JSON は stdout、診断 warning は stderr に出る。bats の run は両者を $output に
    # 結合するため、jq parse には stdout のみを渡す (2>/dev/null で stderr を分離)。
    run bash -c "'$SCRIPT' --path '/nonexistent/xyz_$$' 2>/dev/null"
    [ "$status" -eq 0 ]
    # Validate JSON is well-formed and status field equals "failed".
    # printf '%s' (not echo) so literal "\n" inside the JSON string stays as data
    # regardless of the shell's echo escape semantics (zsh / xpg_echo).
    printf '%s\n' "$output" | jq -e '.status == "failed"'
}

# --- issue #291 (F3): --lockfile-only / --skip-custom flag forwarding ---

@test "(g) package.json のみ + --lockfile-only は exit 0 かつ no_dependencies を含む JSON を出す" {
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR" --lockfile-only
    [ "$status" -eq 0 ]
    [[ "$output" == *"no_dependencies"* ]]
}

@test "(h) 空 dir + --lockfile-only --skip-custom は exit 0 かつ no_dependencies を含む JSON を出す (未知フラグエラーにならない)" {
    run "$SCRIPT" --path "$TMP_DIR" --lockfile-only --skip-custom
    [ "$status" -eq 0 ]
    [[ "$output" == *"no_dependencies"* ]]
}

# --- issue #868: --setup（dev-flow wrapper の deps 段。prerun とは別の Bash 呼び出しで install する）---

# dev-flow-prerun の ok:true 出力相当を <WT>/.devflow-tmp/prerun-setup.json に置く
make_setup() {
    WT="$TMP_DIR/wt"
    mkdir -p "$WT/.devflow-tmp"
    jq -n --arg wt "$WT" '{ok: true, issue: 1, base: "dev", worktree: $wt, branch: "feature/issue-1", head: "abc", worktree_status: "created", worktree_removed: false, hooks_not_running: [], clean: {ok: true}, stack: {frameworks: []}, analyze: {ok: true}, ci_verify: null, local_verify: null, epoch: 1000, plugin_commit: null}' \
        >"$WT/.devflow-tmp/prerun-setup.json"
    export DEVFLOW_DEPS_CACHE_DIR="$TMP_DIR/deps-cache"
    STUB_DIR="$TMP_DIR/stub-bin"
    mkdir -p "$STUB_DIR"
}

@test "(s1) --setup: setup の worktree で npm ci を実行し、setup に deps と install 完了後の epoch_end を足して 1 行で返す" {
    make_setup
    echo '{"name":"t","version":"1.0.0"}' > "$WT/package.json"
    echo '{"lockfileVersion":3}' > "$WT/package-lock.json"
    cat >"$STUB_DIR/npm" <<STUB
#!/usr/bin/env bash
printf '%s|%s\n' "\$PWD" "\$*" >> "$TMP_DIR/npm-calls.log"
mkdir -p "\$PWD/node_modules"
STUB
    chmod +x "$STUB_DIR/npm"
    before="$(date +%s)"

    PATH="$STUB_DIR:$PATH" run --separate-stderr "$SCRIPT" --setup "$WT/.devflow-tmp/prerun-setup.json"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = "1" ]
    [ "$(cat "$TMP_DIR/npm-calls.log")" = "$WT|ci" ]
    printf '%s' "$output" | jq -e '.deps == {ok: true, note: "npm:installed"}'
    printf '%s' "$output" | jq -e --argjson b "$before" '.epoch_end >= $b and .epoch == 1000'
    # prerun の出力キーはそのまま残る
    printf '%s' "$output" | jq -e --slurpfile s "$WT/.devflow-tmp/prerun-setup.json" 'del(.deps, .epoch_end) == $s[0]'
}

@test "(s2) --setup: pnpm workspace で依存を宣言した package に node_modules が無い -> deps.ok=false、note に欠けた package（exit 0）" {
    make_setup
    mkdir -p "$WT/packages/backend"
    echo '{"name":"root","private":true}' > "$WT/package.json"
    printf 'lockfileVersion: 9.0\n' > "$WT/pnpm-lock.yaml"
    printf "packages:\n  - 'packages/*'\n" > "$WT/pnpm-workspace.yaml"
    echo '{"name":"backend","devDependencies":{"vitest":"^3.0.0"}}' > "$WT/packages/backend/package.json"
    # root の node_modules だけを作る pnpm（workspace package の node_modules を作らない）
    cat >"$STUB_DIR/pnpm" <<'STUB'
#!/usr/bin/env bash
mkdir -p "$PWD/node_modules/.pnpm"
STUB
    chmod +x "$STUB_DIR/pnpm"

    PATH="$STUB_DIR:$PATH" run --separate-stderr "$SCRIPT" --setup "$WT/.devflow-tmp/prerun-setup.json"
    [ "$status" -eq 0 ]
    printf '%s' "$output" | jq -e '.deps.ok == false and (.deps.note | test("packages/backend"))'
    printf '%s' "$output" | jq -e '.ok == true and (.epoch_end | type) == "number"'
}

@test "(s3) --setup: 読めない・ok:true でない setup は exit 2・stdout 空で install しない" {
    make_setup
    echo '{"name":"t","version":"1.0.0"}' > "$WT/package.json"
    echo '{"lockfileVersion":3}' > "$WT/package-lock.json"
    cat >"$STUB_DIR/npm" <<STUB
#!/usr/bin/env bash
echo called >> "$TMP_DIR/npm-calls.log"
STUB
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run --separate-stderr "$SCRIPT" --setup "$TMP_DIR/missing.json"
    [ "$status" -eq 2 ]
    [ -z "$output" ]

    jq '.ok = false' "$WT/.devflow-tmp/prerun-setup.json" > "$TMP_DIR/not-ok.json"
    PATH="$STUB_DIR:$PATH" run --separate-stderr "$SCRIPT" --setup "$TMP_DIR/not-ok.json"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    [[ "$stderr" == *"dev-flow-prerun"* ]]
    [ ! -f "$TMP_DIR/npm-calls.log" ]
}

@test "(s4) --setup は --path / --lockfile-only と併用できない（exit 2）" {
    make_setup
    run "$SCRIPT" --setup "$WT/.devflow-tmp/prerun-setup.json" --path "$WT"
    [ "$status" -eq 2 ]
}

# husky の形の repo を worktree に作る。.husky/_ が無いので、prerun の時点の hooks_not_running は ["pre-commit"]
make_husky_setup() {
    make_setup
    git init -q -b main "$WT"
    git -C "$WT" config user.name "Test"
    git -C "$WT" config user.email "test@example.com"
    git -C "$WT" config core.hooksPath .husky/_
    mkdir -p "$WT/.husky"
    echo "#!/bin/sh" >"$WT/.husky/pre-commit"
    echo '{"name":"t","version":"1.0.0"}' >"$WT/package.json"
    echo '{"lockfileVersion":3}' >"$WT/package-lock.json"
    git -C "$WT" add .husky package.json package-lock.json
    git -C "$WT" commit -q -m "track husky hook"
    jq '.hooks_not_running = ["pre-commit"]' "$WT/.devflow-tmp/prerun-setup.json" >"$TMP_DIR/setup.json"
    cp "$TMP_DIR/setup.json" "$WT/.devflow-tmp/prerun-setup.json"
}

@test "(s5) --setup: install の prepare が .husky/_ を生成すると hooks_not_running は []" {
    make_husky_setup
    cat >"$STUB_DIR/npm" <<'STUB'
#!/usr/bin/env bash
mkdir -p "$PWD/node_modules" "$PWD/.husky/_"
printf '#!/bin/sh\nexit 0\n' >"$PWD/.husky/_/pre-commit"
chmod +x "$PWD/.husky/_/pre-commit"
STUB
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run --separate-stderr "$SCRIPT" --setup "$WT/.devflow-tmp/prerun-setup.json"
    [ "$status" -eq 0 ]
    printf '%s' "$output" | jq -e '.hooks_not_running == []'
}

@test "(s6) --setup: install が .husky/_ を生成しなければ hooks_not_running は残る" {
    make_husky_setup
    cat >"$STUB_DIR/npm" <<'STUB'
#!/usr/bin/env bash
mkdir -p "$PWD/node_modules"
STUB
    chmod +x "$STUB_DIR/npm"

    PATH="$STUB_DIR:$PATH" run --separate-stderr "$SCRIPT" --setup "$WT/.devflow-tmp/prerun-setup.json"
    [ "$status" -eq 0 ]
    printf '%s' "$output" | jq -e '.hooks_not_running == ["pre-commit"]'
}
