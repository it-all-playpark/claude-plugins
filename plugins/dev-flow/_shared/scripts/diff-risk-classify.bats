#!/usr/bin/env bats
# Tests for _shared/scripts/diff-risk-classify.sh
#
# Strategy: mktemp -d で隔離 git repo を作成し、各 danger class の陽性/陰性 diff を
# commit してスクリプトの出力を検証する。
#
# 速度: base commit だけの repo と FAKE_BIN は setup_file で 1 回だけ作り、各 test は
# その repo を cp -R で複製する (test ごとの git init / commit / which を省く)。
# 同じ assertion を入力違いで並べる陽性群・無害変更群は、1 repo に複数ファイルを
# 1 回 commit して 1 回の実行で hits[] をファイルごとに照合する表駆動にしている。
#
# Class 文字列: auth / crypto / config / data-migration / public-api / exec-sink /
# dependency / test-weakening (issue #361/#362 spike -- 8th class, has an optional
# "pattern" sub-field: skip / only / todo / xfail / tautology / exclude-cfg)

setup_file() {
    TEMPLATE_REPO="$(mktemp -d)"
    git -C "$TEMPLATE_REPO" init -q
    git -C "$TEMPLATE_REPO" config user.email t@t
    git -C "$TEMPLATE_REPO" config user.name t
    git -C "$TEMPLATE_REPO" commit -q --allow-empty -m base
    BASE="$(git -C "$TEMPLATE_REPO" rev-parse HEAD)"

    # FAKE_BIN: minimal PATH containing exactly the external commands the script
    # needs (bash/git/grep/sed/cut/sort/cat/dirname/pwd), symlinked from wherever
    # they really live, but deliberately WITHOUT jq -- used by the fallback-path
    # tests to deterministically exercise the has_jq==false branch regardless of
    # whether the host machine happens to have jq installed.
    FAKE_BIN="$(mktemp -d)"
    for c in bash git grep sed cut sort cat dirname pwd mkdir; do
        real="$(/usr/bin/which -a "$c" 2>/dev/null | head -1)"
        [[ -n "$real" ]] && ln -s "$real" "$FAKE_BIN/$c"
    done
    export TEMPLATE_REPO BASE FAKE_BIN
}

teardown_file() {
    rm -rf "$TEMPLATE_REPO" "$FAKE_BIN"
}

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/_shared/scripts/diff-risk-classify.sh"
    REPO="$(mktemp -d)"
    cp -R "$TEMPLATE_REPO/." "$REPO/"

    # CORE_BIN_DIR: common.sh locator (issue #571) resolves playpark-core's
    # _lib/common.sh via `dirname "$(command -v journal)")/../_lib`, which only
    # works if `journal` is found at its *real* location (not a symlink into a
    # scratch dir -- dirname on a symlink resolves to the symlink's own
    # directory, not the target's). Appended (not symlinked into FAKE_BIN) so
    # jq remains absent for the has_jq==false fallback-path tests.
    PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    CORE_BIN_DIR="$PLUGIN_ROOT/../playpark-core/bin"
}

teardown() {
    rm -rf "$REPO"
}

# hits[] に file × class (× pattern) の hit が 1 件以上あることを確認する。
# 表駆動テストで、どの行が欠けたかを失敗時に出す。
assert_hit() {
    local file="$1" class="$2" pattern="${3:-}"
    printf '%s\n' "$output" | jq -e --arg f "$file" --arg c "$class" --arg p "$pattern" \
        '[.hits[] | select(.file == $f and .class == $c and ($p == "" or .pattern == $p))] | length > 0' >/dev/null \
        || { echo "missing hit: file=$file class=$class pattern=$pattern"; echo "$output"; return 1; }
}

# ---------------------------------------------------------------------------
# 1. auth POSITIVE
# ---------------------------------------------------------------------------
@test "auth POSITIVE: requireAuth を含む src/auth.ts -> class auth の hit オブジェクトを返す" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(user) {\n  return user.isAuthenticated;\n}\n' \
        > "$REPO/src/auth.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
    [[ "$output" == *'auth.ts'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "auth")] | length > 0'
}

# ---------------------------------------------------------------------------
# 3. crypto POSITIVE
# ---------------------------------------------------------------------------
@test "crypto POSITIVE: crypto.createHash を含むファイル -> class crypto の hit オブジェクトを返す" {
    mkdir -p "$REPO/src"
    printf 'const hash = crypto.createHash("sha256");\n' \
        > "$REPO/src/util.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"crypto"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "crypto")] | length > 0'
}

# ---------------------------------------------------------------------------
# 5. config POSITIVE
# ---------------------------------------------------------------------------
@test "config POSITIVE: .env ファイルに API_TOKEN= を追加 -> class config の hit オブジェクトを返す" {
    printf 'API_TOKEN=supersecret\n' > "$REPO/.env"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"config"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "config")] | length > 0'
}

# ---------------------------------------------------------------------------
# 7. data-migration POSITIVE
# ---------------------------------------------------------------------------
@test "data-migration POSITIVE: migrations/ 配下の ALTER TABLE 含むファイル -> class data-migration を返す" {
    mkdir -p "$REPO/migrations"
    printf 'ALTER TABLE users ADD COLUMN verified BOOLEAN;\n' \
        > "$REPO/migrations/0001_add_verified.sql"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"data-migration"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "data-migration")] | length > 0'
}

# ---------------------------------------------------------------------------
# 9. public-api POSITIVE
# ---------------------------------------------------------------------------
@test "public-api POSITIVE: export function を含むファイル -> class public-api を返す" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/api.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# 10. public-api NEGATIVE
# ---------------------------------------------------------------------------
@test "public-api NEGATIVE: export なしの内部関数 -> 出力は []" {
    mkdir -p "$REPO/src"
    printf 'function helper() {\n  return 42;\n}\n' \
        > "$REPO/src/helper.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# 11. exec-sink POSITIVE
# ---------------------------------------------------------------------------
@test "exec-sink POSITIVE: eval( を含むファイル -> class exec-sink を返す" {
    mkdir -p "$REPO/src"
    printf 'const result = eval(userInput);\n' \
        > "$REPO/src/runner.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"exec-sink"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "exec-sink")] | length > 0'
}

# ---------------------------------------------------------------------------
# [EXEC-1] exec-sink NEGATIVE: JS 匿名関数式 function({ ... }) は hit しない
# (Function\( alternative 削除 + case-sensitive 化の pin, issue #616)
# ---------------------------------------------------------------------------
@test "[EXEC-1] exec-sink NEGATIVE: export default function 内の匿名関数式は exec-sink に hit しない" {
    mkdir -p "$REPO/src"
    printf 'export default function make() {\n  return function({ a, b }) {\n    return a + b;\n  };\n}\n' \
        > "$REPO/src/factory.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and ([.hits[] | select(.class == "exec-sink")] | length == 0)'
}

@test "[EXEC-1] exec-sink NEGATIVE: arrow 関数内の匿名関数式は hits 全体が [] になる" {
    mkdir -p "$REPO/src"
    printf 'const make = () => {\n  return function({ label, agentType }) {\n    return label + agentType;\n  };\n};\n' \
        > "$REPO/src/factory2.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# [EXEC-2] exec-sink NEGATIVE: 識別子末尾一致 myEval( / respawn( / reexec( は
# hit しない (語境界 pin, issue #616)
# ---------------------------------------------------------------------------
@test "[EXEC-2] exec-sink NEGATIVE: 識別子末尾一致は exec-sink に hit しない" {
    mkdir -p "$REPO/src"
    printf 'const y = myEval(1);\nrespawn(x);\nreexec(cmd);\nconst z = doExecSync(1);\n' \
        > "$REPO/src/ident.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# 13. dependency POSITIVE
# ---------------------------------------------------------------------------
@test "dependency POSITIVE: package.json に dependencies 変更 -> class dependency を返す" {
    printf '{\n  "name": "app",\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n' \
        > "$REPO/package.json"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"dependency"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "dependency")] | length > 0'
}

# ---------------------------------------------------------------------------
# [HARMLESS] 無害な変更のみ -> {"ok":true,"hits":[]} かつ exit 0
# auth / crypto / config / data-migration / exec-sink / dependency NEGATIVE と
# EMPTY の 7 種の入力を 1 回の commit にまとめ、どのファイルも hit しないことを見る。
# ---------------------------------------------------------------------------
@test "HARMLESS: 無害な変更 7 種を 1 commit にまとめても hits は [] かつ exit 0" {
    mkdir -p "$REPO/src"
    printf 'hello world\n' > "$REPO/README.md"
    printf 'const x = 1;\n' > "$REPO/src/index.js"
    printf 'just a comment\n' > "$REPO/notes.txt"
    printf 'select 1;\n' > "$REPO/query.sql"
    printf 'const x = 2 + 2;\n' > "$REPO/src/math.js"
    printf 'version = "1.0.0"\nauthor = "Alice"\n' > "$REPO/metadata.txt"
    printf 'This is just a changelog entry.\n' > "$REPO/CHANGELOG.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

@test "ERROR: invalid base ref -> ok:false error channel" {
    run bash -c "cd '$REPO' && '$SCRIPT' does-not-exist"
    [ "$status" -ne 0 ]
    printf '%s\n' "$output" | jq -e '.ok == false and .hits == [] and (.error | test("invalid base ref"))'
}

# ---------------------------------------------------------------------------
# 15b. MULTI-CLASS: 1 ファイルが auth と exec-sink の両クラスにヒット -> 2 オブジェクト
# ---------------------------------------------------------------------------
@test "MULTI-CLASS: auth と exec-sink の両方のマーカーを含むファイル -> 2 つの hit オブジェクトを返す" {
    mkdir -p "$REPO/src"
    # requireAuth (auth class) + eval( (exec-sink class) を同一ファイルに
    printf 'function requireAuth(user) { return eval(user.token); }\n' \
        > "$REPO/src/mixed.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "auth")] | length > 0'
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "exec-sink")] | length > 0'
    printf '%s\n' "$output" | jq -e '.hits | length >= 2'
}

# ---------------------------------------------------------------------------
# NON-ASCII: 日本語ファイル名 × content-based クラス (public-api) の regression
# core.quotepath=false なしでは git diff --name-only が "src/\350..." と
# エスケープされ per-file diff が空になり false negative になる。
# ---------------------------------------------------------------------------
@test "NON-ASCII: 日本語ファイル名に export function -> class public-api を返す (core.quotepath regression)" {
    mkdir -p "$REPO/src"
    # 非 ASCII ファイル名（日本語）に public-api トリガーを追加
    printf 'export function 認証API(user) {\n  return user.id;\n}\n' \
        > "$REPO/src/認証api.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
    # file 値が壊れた escape シーケンスでないことを確認
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")][0].file | test("認証api\\.ts$")'
}

# ---------------------------------------------------------------------------
# SUBDIR-CWD: repo サブディレクトリを cwd にして content-based クラスが正しくヒットする
# (regression: per-file diff pathspec が cwd 相対で解釈されると subdir 実行時に
#  added が空になり content-based 6 クラスが silent false-negative になっていた)
# ---------------------------------------------------------------------------
@test "SUBDIR-CWD: repo subdir を cwd にして public-api (export function) が正しくヒットする" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/sub.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    # Run from a subdirectory of the repo, NOT the repo root
    run bash -c "cd '$REPO/src' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# ERROR: git repo 外で実行 -> 非 0 exit
# ---------------------------------------------------------------------------
@test "ERROR: git repo 外 (非 git ディレクトリ) で実行 -> 非 0 exit" {
    NON_GIT="$(mktemp -d)"
    run bash -c "cd '$NON_GIT' && '$SCRIPT' 'HEAD'"
    rm -rf "$NON_GIT"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# docs EXCLUSION: docs ファイルは security 語彙を含んでも HIT しない (issue #155)
# ---------------------------------------------------------------------------
@test "docs EXCLUSION: .md に auth/exec 語彙 -> 除外され [] (false-positive 防止)" {
    printf 'requireAuth と child_process と eval( を解説する docs\n' > "$REPO/AGENTS.md"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

@test "docs EXCLUSION: docs/ 配下の .txt に auth 語彙 -> 除外され []" {
    mkdir -p "$REPO/docs"
    printf 'authenticate jwt bearer session を説明\n' > "$REPO/docs/guide.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

@test "docs EXCLUSION regression: 同じ auth 語彙でも .ts は HIT のまま (非 docs は不変)" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(u) { return u.jwt; }\n' > "$REPO/src/x.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
}

# ---------------------------------------------------------------------------
# [WT-1] working-tree POSITIVE: 未コミット (git add なし) の export function が hit する
# AC#1: --working-tree フラグが worktree の変更を三点 diff ではなく status ベースで分類する
# ---------------------------------------------------------------------------
@test "WT-1 working-tree POSITIVE: 未コミット export function -> class public-api / severity critical が hit" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/api.ts"
    # git add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [WT-2] working-tree staged-only: git add のみ (commit なし) の auth が hit する
# ---------------------------------------------------------------------------
@test "WT-2 working-tree staged-only: git add した requireAuth -> class auth が hit" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(user) { return user.isAuthenticated; }\n' \
        > "$REPO/src/auth.ts"
    git -C "$REPO" add "$REPO/src/auth.ts"
    # commit はしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "auth")] | length > 0'
}

# ---------------------------------------------------------------------------
# [WT-3] working-tree untracked dir: 未追跡サブディレクトリのファイルが hit する
# porcelain -uall なしだと `?? newskill/` に折り畳まれ素通りする regression を pin
# ---------------------------------------------------------------------------
@test "WT-3 working-tree untracked dir: 未追跡サブディレクトリの export function -> class public-api が hit" {
    mkdir -p "$REPO/newskill/scripts"
    printf 'export function build(opts) {\n  return opts;\n}\n' \
        > "$REPO/newskill/scripts/gen.ts"
    # add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [WT-4] working-tree clean: 変更ゼロの worktree で --working-tree -> [] かつ exit 0
# ---------------------------------------------------------------------------
@test "WT-4 working-tree clean: 変更なし -> 出力 [] かつ exit 0" {
    # 何も変更しない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# [WT-5] working-tree BASE-ahead (merge-base pin):
# main に fork 後の commit (auth-helper.ts) を積み、feature branch では
# 無害な変更のみ。BASE=main HEAD を渡して --working-tree 実行 ->
# auth-helper が含まれない (merge-base を取らず git diff $BASE 直接比較だと
# 逆方向差分に混入する regression を pin)
# ---------------------------------------------------------------------------
@test "WT-5 working-tree BASE-ahead merge-base pin: main-ahead commit は --working-tree に混入しない" {
    # fork 点 = 現在の BASE (empty commit)
    FORK_SHA="$BASE"

    # main branch に auth-helper.ts を追加コミット
    mkdir -p "$REPO/other-pr"
    printf 'function authHelper(token) { return token; }\n' \
        > "$REPO/other-pr/auth-helper.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m "main: add auth-helper"
    MAIN_SHA="$(git -C "$REPO" rev-parse HEAD)"

    # feature branch を fork 点から切る
    git -C "$REPO" checkout -q -b feature "$FORK_SHA"

    # feature worktree に無害な未コミット変更のみ
    printf 'const x = 1;\n' > "$REPO/notes-internal.js"

    # BASE=MAIN_SHA で --working-tree 実行
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$MAIN_SHA'"
    [ "$status" -eq 0 ]
    # auth-helper が含まれないこと
    printf '%s\n' "$output" | jq -e '[.hits[] | .file | test("auth-helper")] | any | not'
}

# ---------------------------------------------------------------------------
# [WT-6] default-mode 不変: --working-tree なしの通常モードは未コミット変更を無視する
# AC#2: 三点 diff の従来挙動が壊れていないことを pin
# ---------------------------------------------------------------------------
@test "WT-6 default-mode 不変: 未コミット export function のみ -> フラグなしでは []" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/api.ts"
    # git add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# [WT-7] working-tree NON-ASCII: 日本語ファイル名の未追跡ファイルが hit する
# core.quotepath=false on status の pin
# ---------------------------------------------------------------------------
@test "WT-7 working-tree NON-ASCII: 日本語ファイル名の未追跡 export function -> public-api hit, file 値が正しい" {
    mkdir -p "$REPO/src"
    printf 'export function 認証処理(user) {\n  return user.id;\n}\n' \
        > "$REPO/src/認証処理.ts"
    # add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
    # file 値が壊れたエスケープシーケンスでないことを確認
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")][0].file | test("認証処理\\.ts$")'
}

# ---------------------------------------------------------------------------
# [STALE-1] stale-base fetch: file:// remote で stale な origin/main を fetch で最新化し
# merged-auth が --working-tree 出力に含まれないことを pin (AC#7)
# ---------------------------------------------------------------------------
@test "STALE-1 stale-base fetch: fetch で origin/main を最新化 -> merged-auth は含まれない" {
    # origin となる bare-ish リポジトリを作成
    R="$(mktemp -d)"
    git -C "$R" init -q -b main
    git -C "$R" config user.email t@t
    git -C "$R" config user.name t
    git -C "$R" commit -q --allow-empty -m "init"
    COMMIT_A="$(git -C "$R" rev-parse HEAD)"

    # origin に merged-auth.ts を追加 (commit B)
    mkdir -p "$R/merged"
    printf 'function authHelper(token) { return token; }\n' > "$R/merged/merged-auth.ts"
    git -C "$R" add -A
    git -C "$R" commit -q -m "add merged-auth"
    COMMIT_B="$(git -C "$R" rev-parse HEAD)"

    # clone して feature branch を B から切る
    C="$(mktemp -d)"
    git clone -q "file://$R" "$C"
    git -C "$C" config user.email t@t
    git -C "$C" config user.name t
    git -C "$C" checkout -q -b feature origin/main  # fork 点 = B

    # origin/main を人工的に A に後退させ stale を作る
    git -C "$C" update-ref refs/remotes/origin/main "$COMMIT_A"

    # 無害な未コミット変更のみ
    printf 'const x = 1;\n' > "$C/harmless.js"

    # --working-tree origin/main で実行 (fetch が ref を B に戻し MB=B になる)
    run bash -c "cd '$C' && '$SCRIPT' --working-tree origin/main"
    [ "$status" -eq 0 ]
    # merged-auth が含まれないこと
    printf '%s\n' "$output" | jq -e '[.hits[] | .file | test("merged-auth")] | any | not'

    rm -rf "$R" "$C"
}

# ---------------------------------------------------------------------------
# [STALE-2] fetch 不能 fail-safe: remote 未設定リポジトリで origin/main ref だけ存在する場合
# fetch 失敗は警告のみで分類続行 -> exit 0 かつ public-api hit
# ---------------------------------------------------------------------------
@test "STALE-2 fetch 不能 fail-safe: fetch 失敗でも exit 0 かつ分類は続行" {
    # remote 未設定の隔離 repo (= $REPO) に origin/main ref を人工的に作成
    git -C "$REPO" update-ref refs/remotes/origin/main "$BASE"

    # 未コミットの export function を置く
    mkdir -p "$REPO/src"
    printf 'export function build(opts) {\n  return opts;\n}\n' \
        > "$REPO/src/build.ts"

    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree origin/main"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [CRYPTO-1] boundary NEGATIVE: PATH_TRAVERSAL 定数 (rsa 部分一致 false positive の解消 pin)
# AC#5: crypto パターンから不要な rsa 部分一致が取り除かれていることを pin
# ---------------------------------------------------------------------------
@test "CRYPTO-1 boundary NEGATIVE: PATH_TRAVERSAL 定数 -> crypto は hit しない (rsa 部分一致 FP 解消 pin)" {
    mkdir -p "$REPO/src"
    printf 'const PATH_TRAVERSAL = "../";\n' > "$REPO/src/path.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# [CRYPTO-2] boundary POSITIVE: bare createHmac 呼び出し (crypto. prefix なし) が hit する
# 両側 boundary 化により createHmac regression が救済されることを pin
# ---------------------------------------------------------------------------
@test "CRYPTO-2 boundary POSITIVE: bare createHmac 呼び出し -> class crypto が hit" {
    mkdir -p "$REPO/src"
    printf 'const mac = createHmac("sha256", key);\n' > "$REPO/src/sign.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"crypto"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "crypto")] | length > 0'
}

# ---------------------------------------------------------------------------
# [CRYPTO-3] boundary POSITIVE: 単独トークン hmac が hit する
# ---------------------------------------------------------------------------
@test "CRYPTO-3 boundary POSITIVE: 単独トークン hmac -> class crypto が hit" {
    mkdir -p "$REPO/src"
    printf 'const sig = hmac(key, msg);\n' > "$REPO/src/token.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"crypto"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "crypto")] | length > 0'
}

# ---------------------------------------------------------------------------
# [LIB-1] _lib 緩和: _lib/ 配下の export function は public-api に hit しない
# AC#6: _lib パスは public-api クラスから除外されることを pin
# ---------------------------------------------------------------------------
@test "LIB-1 _lib 緩和: _lib/ 配下の export function -> public-api が含まれない" {
    mkdir -p "$REPO/_lib"
    printf 'export function makeSummary(data) {\n  return data.summary;\n}\n' \
        > "$REPO/_lib/devflow-summary-format.test.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length == 0'
}

# ---------------------------------------------------------------------------
# [LIB-2] _lib 緩和の狭さ: _lib/ 配下でも exec-sink は hit する
# 緩和は public-api クラス限定であることを pin
# ---------------------------------------------------------------------------
@test "LIB-2 _lib 緩和の狭さ: _lib/ 配下の eval -> exec-sink は hit する (緩和は public-api 限定)" {
    mkdir -p "$REPO/_lib"
    printf 'function run(input) { return eval(input); }\n' \
        > "$REPO/_lib/runner.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"exec-sink"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "exec-sink")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TOOLS-1] tools 緩和: tools/ 配下の export function は public-api に hit しない
# AC: tools/ は repo 内部の generator/dev CLI 置き場で外部 consumer 不在のため
#     public-api critical の構造的 false positive を除外する
# ---------------------------------------------------------------------------
@test "TOOLS-1 tools 緩和: tools/ 配下の export function -> public-api が含まれない" {
    mkdir -p "$REPO/tools"
    printf 'export function buildConfig(opts) {\n  return opts;\n}\n' \
        > "$REPO/tools/gen-config.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length == 0'
}

# ---------------------------------------------------------------------------
# [TOOLS-2] tools 緩和の狭さ: tools/ 配下でも exec-sink は hit する
# 緩和は public-api クラス限定であることを pin
# ---------------------------------------------------------------------------
@test "TOOLS-2 tools 緩和の狭さ: tools/ 配下の child_process+spawn -> exec-sink は hit する (緩和は public-api 限定)" {
    mkdir -p "$REPO/tools"
    printf 'const { spawn } = require("child_process");\nspawn("ls");\n' \
        > "$REPO/tools/runner.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"exec-sink"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "exec-sink")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TOOLS-3] tools 緩和の narrow ガード: mytools/ は除外されない
# (^|/)tools/ が mytools/ にはマッチしない = 除外が narrow であることを pin
# ---------------------------------------------------------------------------
@test "TOOLS-3 tools 緩和の narrow ガード: mytools/ 配下の export function -> public-api に hit する" {
    mkdir -p "$REPO/mytools"
    printf 'export function publicApi() {}\n' \
        > "$REPO/mytools/api.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TW-a] test-weakening POSITIVE: test.skip( on a *.test.* file -> class
# test-weakening / pattern skip / severity critical
# ---------------------------------------------------------------------------
@test "TW-a test-weakening POSITIVE: test.skip( in *.test.ts -> class test-weakening / pattern skip" {
    mkdir -p "$REPO/src"
    printf "test.skip('checks value', () => {\n  expect(1).toBe(1);\n});\n" \
        > "$REPO/src/sample.test.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"test-weakening"'* ]]
    [[ "$output" == *'"pattern":"skip"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "test-weakening" and .pattern == "skip")] | length > 0'
}

# A match near the top of a large added text must not be lost to SIGPIPE under pipefail
# (grep -q exits early while the added text is still being written). Large makes it deterministic.
@test "TW-a3 test-weakening POSITIVE: test.skip( at the top of a large added test file still hits pattern skip" {
    mkdir -p "$REPO/src"
    {
        printf "test.skip('checks value', () => {});\n"
        for i in $(seq 20000); do printf 'const v%d = %d;\n' "$i" "$i"; done
    } > "$REPO/src/big.test.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "test-weakening" and .pattern == "skip")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TW-a2] test-weakening POSITIVE: Ruby / PHP のテストファイル (*_spec.rb /
# *_test.rb / *Test.php) も test-weakening の対象 (issue #883)。同じ追加行を
# 本番ファイル (foo.rb / Foo.php) に置いても hit しないことを対照に置く
# ---------------------------------------------------------------------------
@test "TW-a2 test-weakening POSITIVE: *_spec.rb / *_test.rb / *Test.php はテストファイルとして hit し、本番 .rb / .php は hit しない" {
    mkdir -p "$REPO/spec" "$REPO/test" "$REPO/tests/Unit" "$REPO/app" "$REPO/src"
    printf "  xit(\"returns 1\") do\n    expect(foo).to eq(1)\n  end\n" > "$REPO/spec/foo_spec.rb"
    printf "  xit(\"returns 1\") do\n    assert_equal 1, foo\n  end\n" > "$REPO/test/foo_test.rb"
    printf "<?php\n\$this->runSuite(exclude: ['slow']);\n" > "$REPO/tests/Unit/FooTest.php"
    printf "  xit(\"returns 1\") do\n  end\n" > "$REPO/app/foo.rb"
    printf "<?php\n\$this->runSuite(exclude: ['slow']);\n" > "$REPO/src/Foo.php"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    assert_hit spec/foo_spec.rb test-weakening skip
    assert_hit test/foo_test.rb test-weakening skip
    assert_hit tests/Unit/FooTest.php test-weakening exclude-cfg
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "test-weakening" and (.file == "app/foo.rb" or .file == "src/Foo.php"))] | length == 0'
}

# ---------------------------------------------------------------------------
# [POS-TABLE] 陽性の表駆動: 1 repo に複数ファイルを 1 回 commit し、1 回の実行で
# hits[] をファイルごとに照合する。
#   EXEC-3a..3i: 既存 exec-sink sink 群が引き続き hit する (回帰 pin, issue #616)
#   TW-b1..b3:   x-prefix skip aliases (xit/xtest/xdescribe) が pattern "skip" になる
#   TW-c1..c4:   only / todo / xfail / tautology が各 pattern になる
# ---------------------------------------------------------------------------
@test "POS-TABLE: EXEC-3a..3i は exec-sink、TW-b1..c4 は test-weakening の各 pattern でファイルごとに hit する" {
    mkdir -p "$REPO/src"
    # EXEC-3a..3i
    printf "const f = new Function('x', 'return x');\n" > "$REPO/src/a.js"
    printf 'const cp = require("child_process");\n' > "$REPO/src/b.js"
    printf 'const out = execSync("ls");\n' > "$REPO/src/c.js"
    printf 'const p = spawn("ls");\n' > "$REPO/src/d.js"
    printf 'const obj = deserialize(buf);\n' > "$REPO/src/e.js"
    printf 'obj = Marshal.load(data)\n' > "$REPO/src/f.rb"
    printf 'obj = pickle.loads(data)\n' > "$REPO/src/g.py"
    printf 'cfg = yaml.load(stream)\n' > "$REPO/src/h.py"
    printf 'execFile("bin", [], cb);\n' > "$REPO/src/i.js"
    # TW-b1..b3
    printf "xit('checks value', () => {\n  expect(1).toBe(1);\n});\n" > "$REPO/src/b1.spec.ts"
    printf "xtest('checks value', () => {\n  expect(1).toBe(1);\n});\n" > "$REPO/src/b2.spec.ts"
    printf "xdescribe('group', () => {\n  it('x', () => { expect(1).toBe(1); });\n});\n" > "$REPO/src/b3.spec.ts"
    # TW-c1..c4
    printf "test.only('x', () => {\n  expect(1).toBe(1);\n});\n" > "$REPO/src/c1.test.js"
    printf "test.todo('x')\n" > "$REPO/src/c2.test.js"
    printf "test.fails('x', () => {\n  expect(1).toBe(2);\n});\n" > "$REPO/src/c3.test.js"
    printf "test('x', () => {\n  expect(true).toBe(true);\n});\n" > "$REPO/src/c4.test.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]

    # file<TAB>class<TAB>pattern (pattern 空 = class のみ照合)
    local expected
    expected="$(printf '%s\n' \
        $'src/a.js\texec-sink\t' \
        $'src/b.js\texec-sink\t' \
        $'src/c.js\texec-sink\t' \
        $'src/d.js\texec-sink\t' \
        $'src/e.js\texec-sink\t' \
        $'src/f.rb\texec-sink\t' \
        $'src/g.py\texec-sink\t' \
        $'src/h.py\texec-sink\t' \
        $'src/i.js\texec-sink\t' \
        $'src/b1.spec.ts\ttest-weakening\tskip' \
        $'src/b2.spec.ts\ttest-weakening\tskip' \
        $'src/b3.spec.ts\ttest-weakening\tskip' \
        $'src/c1.test.js\ttest-weakening\tonly' \
        $'src/c2.test.js\ttest-weakening\ttodo' \
        $'src/c3.test.js\ttest-weakening\txfail' \
        $'src/c4.test.js\ttest-weakening\ttautology')"
    local rows=0 f c p
    while IFS=$'\t' read -r f c p; do
        assert_hit "$f" "$c" "$p"
        rows=$((rows + 1))
    done <<< "$expected"
    [ "$rows" -eq 16 ]
}

# ---------------------------------------------------------------------------
# [TW-d] test-weakening POSITIVE: exclude: [...] added to vitest.config.mjs
# (config file, NOT a *.test.*/*.spec.*/*.bats file) -> pattern exclude-cfg
# ---------------------------------------------------------------------------
@test "TW-d test-weakening POSITIVE: exclude: [ added to vitest.config.mjs -> pattern exclude-cfg" {
    printf "export default {\n  test: {\n    exclude: ['tests/flaky.test.ts'],\n  },\n};\n" \
        > "$REPO/vitest.config.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"test-weakening"'* ]]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "test-weakening" and .pattern == "exclude-cfg")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TW-e] test-weakening NEGATIVE: same skip marker in a non-test file -> no hit
# (content patterns 1-5 are restricted to test files)
# ---------------------------------------------------------------------------
@test "TW-e test-weakening NEGATIVE: test.skip( string in non-test file src/foo.mjs -> no test-weakening hit" {
    mkdir -p "$REPO/src"
    printf "// helper referencing test.skip( as a string, not an actual test file\nconst marker = 'test.skip(';\n" \
        > "$REPO/src/foo.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "test-weakening")] | length == 0'
}

# ---------------------------------------------------------------------------
# [TW-f] test-weakening NEGATIVE: docs file exclusion wins over test-file-name
# lookalike (docs continue happens before class checks run at all)
# ---------------------------------------------------------------------------
@test "TW-f test-weakening NEGATIVE: docs file notes.test.md with skip marker -> excluded, no hit" {
    printf "This doc mentions test.skip( as prose, not code.\n" \
        > "$REPO/notes.test.md"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .hits == []'
}

# ---------------------------------------------------------------------------
# [TW-g] test-weakening NEGATIVE: deleting a test file (no content addition)
# does NOT produce a test-weakening hit (file-deletion detection intentionally
# not implemented -- spike FP 3-4/25, follow-up only)
# ---------------------------------------------------------------------------
@test "TW-g test-weakening NEGATIVE: deleting a *.test.ts file -> no test-weakening hit" {
    mkdir -p "$REPO/src"
    printf "test('x', () => {\n  expect(1).toBe(1);\n});\n" \
        > "$REPO/src/sample.test.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m "add test file"
    DEL_BASE="$(git -C "$REPO" rev-parse HEAD)"

    rm "$REPO/src/sample.test.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m "delete test file"

    run bash -c "cd '$REPO' && '$SCRIPT' '$DEL_BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "test-weakening")] | length == 0'
}

# ---------------------------------------------------------------------------
# [TW-h] REGRESSION: existing 7 classes emit no "pattern" key (only
# test-weakening hits carry the optional sub-field)
# ---------------------------------------------------------------------------
@test "TW-h REGRESSION: auth hit has no pattern key (pattern is test-weakening-only)" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(user) {\n  return user.isAuthenticated;\n}\n' \
        > "$REPO/src/auth.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.hits[] | select(.class == "auth")][0] | has("pattern") | not'
}

# ---------------------------------------------------------------------------
# [TW-i] jq-absent fallback path: pattern key still appears for test-weakening
# hits, and is still absent for the 7 legacy classes, when jq is unavailable
# on PATH (FAKE_BIN excludes jq -- see setup_file()).
# ---------------------------------------------------------------------------
@test "TW-i jq-absent fallback: test-weakening hit still carries pattern key" {
    mkdir -p "$REPO/src"
    printf "test.skip('checks value', () => {\n  expect(1).toBe(1);\n});\n" \
        > "$REPO/src/sample.test.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change

    # Sanity: confirm jq is truly unreachable under FAKE_BIN before trusting the
    # fallback-path assertions below.
    run bash -c "PATH='$FAKE_BIN' command -v jq"
    [ "$status" -ne 0 ]

    run bash -c "cd '$REPO' && PATH='$FAKE_BIN:$CORE_BIN_DIR' '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"test-weakening"'* ]]
    [[ "$output" == *'"pattern":"skip"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
}

@test "TW-i2 jq-absent fallback: legacy 7-class hit carries no pattern key" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(user) {\n  return user.isAuthenticated;\n}\n' \
        > "$REPO/src/auth.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change

    run bash -c "cd '$REPO' && PATH='$FAKE_BIN:$CORE_BIN_DIR' '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
    [[ "$output" != *'"pattern"'* ]]
}

# ---------------------------------------------------------------------------
# [OUT] --out flag removed (issue #544): unknown-flag rejection path covers it,
# no legacy fallback / silent-ignore is provided.
# ---------------------------------------------------------------------------

@test "OUT-1 --out は撤去済みで unknown flag として ok:false + 非0 exit で拒否される" {
    OUTDIR="$(mktemp -d)"
    OUTFILE="$OUTDIR/out.json"
    run bash -c "cd '$REPO' && '$SCRIPT' --out '$OUTFILE' '$BASE'"
    [ "$status" -ne 0 ]
    [ ! -e "$OUTFILE" ]
    printf '%s\n' "$output" | jq -e '.ok == false and (.error | test("unknown flag"))'
    rm -rf "$OUTDIR"
}
