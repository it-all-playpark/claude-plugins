#!/usr/bin/env bats
# Tests for _shared/scripts/secfloor-classify.sh (issue #544, P1)
#
# Strategy: mktemp -d の隔離 git fixture repo を worktree-path として扱い、
# secfloor-classify.sh を実行して JSON 出力の各フィールド (risk/files/struct/diffhash)
# を検証する。フィールド独立性(1 フィールドの失敗が他へ波及しない)は PATH 細工
# (jq 不在シミュレート・fake git read-tree 失敗・DIFFT_BIN シーム)で個別に誘発する。
#
# NOTE: 実装されるまでこれらのテストは fail (red) になる想定 (TDD)。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/secfloor-classify.sh"

    REPO="$(mktemp -d)"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    printf 'hello\n' > "$REPO/base.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m base
    BASE_REF="$(git -C "$REPO" rev-parse HEAD)"

    ORIG_PATH="$PATH"

    # NO_JQ_BIN: diff-risk-classify.bats と同じ precedent -- 実行に必要な外部コマンドのみを
    # symlink した最小 PATH で、意図的に jq を含めない (has_jq==false 分岐を、ホストに
    # jq が入っているかどうかに関係なく決定論的に踏むため)。
    NO_JQ_BIN="$(mktemp -d)"
    for c in bash git grep sed cut sort cat dirname pwd mkdir mktemp rm date tr; do
        real="$(/usr/bin/which -a "$c" 2>/dev/null | head -1)"
        [[ -n "$real" ]] && ln -s "$real" "$NO_JQ_BIN/$c"
    done
    # CORE_BIN_DIR: common.sh locator (issue #571) resolves playpark-core's
    # _lib/common.sh via `dirname "$(command -v journal)")/../_lib`, which needs
    # `journal` reachable at its real bin/ location. Appended (not symlinked
    # into NO_JQ_BIN) so jq stays absent for the has_jq==false fallback tests.
    PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    CORE_BIN_DIR="$PLUGIN_ROOT/../playpark-core/bin"
}

teardown() {
    rm -rf "$REPO" "$NO_JQ_BIN"
    PATH="$ORIG_PATH"
}

# ---------------------------------------------------------------------------
# (a) クリーンな fixture -> 全フィールド正常
# ---------------------------------------------------------------------------
@test "クリーンな worktree -> risk.ok==true, files==[], struct/diffhash 非null" {
    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .risk.ok == true and
        (.risk.hits | length) == 0 and
        .files == [] and
        .struct != null and
        .diffhash != null
    '
}

# ---------------------------------------------------------------------------
# (b) danger パターンを含むファイル追加 -> risk.hits に該当 class
# ---------------------------------------------------------------------------
@test "danger パターン(exec-sink)を含む新規ファイル -> risk.hits に該当 class" {
    printf 'const x = eval(userInput);\n' > "$REPO/danger.js"
    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .risk.ok == true and
        (.risk.hits | map(select(.class == "exec-sink")) | length) > 0
    '
}

# ---------------------------------------------------------------------------
# (c) 変更ファイルあり -> files に該当パス(ステータスコード除去・リネーム右側)
# ---------------------------------------------------------------------------
@test "変更ファイルあり -> files に該当パスが載る(通常変更 + リネーム右側)" {
    printf 'v1\n' > "$REPO/mod.txt"
    printf 'to-rename\n' > "$REPO/old-name.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m setup2

    printf 'v2\n' > "$REPO/mod.txt"
    git -C "$REPO" mv old-name.txt new-name.txt

    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        (.files | index("mod.txt")) != null and
        (.files | index("new-name.txt")) != null and
        (.files | index("old-name.txt")) == null and
        (.files | map(select(test(" -> ")))) == []
    '
}

# ---------------------------------------------------------------------------
# (c2) lines: tracked の追加/削除行数 + untracked file の行数 (issue #740)
# ---------------------------------------------------------------------------
@test "lines: tracked 変更は numstat の追加/削除、untracked file は wc -l を追加行として返す" {
    printf 'a\nb\nc\nd\n' > "$REPO/gone.txt"
    printf 'k1\nk2\n' > "$REPO/keep.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m setup-lines

    git -C "$REPO" rm -q gone.txt
    printf 'k1\nk2x\nk3\n' > "$REPO/keep.txt"
    mkdir -p "$REPO/sub"
    printf 'n1\nn2\nn3\n' > "$REPO/sub/new.txt"

    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        (.lines | map({key: .path, value: [.added, .deleted]}) | from_entries) as $m
        | $m["gone.txt"] == [0, 4]
        and $m["keep.txt"] == [2, 1]
        and $m["sub/new.txt"] == [3, 0]
        and (.lines | length) == 3
        and (.files | index("sub/new.txt")) != null
    '
}

@test "lines: クリーンな worktree -> lines==[]" {
    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.lines == []'
}

@test "lines: tracked binary の変更は要素を出さない (行数が無い file は呼び出し側で file 数判定に戻す)" {
    printf '\000\001\002' > "$REPO/blob.bin"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m setup-bin
    printf '\000\003\004\005' > "$REPO/blob.bin"
    printf 'x\n' >> "$REPO/base.txt"

    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        (.files | index("blob.bin")) != null
        and (.lines | map(.path)) == ["base.txt"]
    '
}

@test "lines: numstat 失敗 -> lines==null だが files/risk は正常のまま" {
    REAL_GIT="$(command -v git)"
    GIT_STUB_BIN="$(mktemp -d)"
    cat > "$GIT_STUB_BIN/git" <<STUB
#!/usr/bin/env bash
for arg in "\$@"; do
    if [[ "\$arg" == "--numstat" ]]; then
        exit 1
    fi
done
exec "$REAL_GIT" "\$@"
STUB
    chmod +x "$GIT_STUB_BIN/git"
    printf 'x\n' >> "$REPO/base.txt"

    run bash -c "PATH='$GIT_STUB_BIN:$ORIG_PATH' bash '$SCRIPT' '$REPO' '$BASE_REF'"
    rm -rf "$GIT_STUB_BIN"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .lines == null and
        .files == ["base.txt"] and
        .risk.ok == true
    '
}

# ---------------------------------------------------------------------------
# secreview: realized diff（tracked + untracked）を security-review-target の判定にかける (issue #1063)
# ---------------------------------------------------------------------------
@test "secreview: untracked file のパス書き込み・tracked file の excludedCommands を対象として返す" {
    printf 'const cfg = {}\n' > "$REPO/conf.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m setup-conf
    printf 'cp "$src" "$dst"\n' > "$REPO/new.sh"
    printf 'cfg.excludedCommands = ["x"]\n' >> "$REPO/conf.js"
    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .secreview.target == true
        and (.secreview.reasons | sort) == (["path_write: new.sh", "sandbox_boundary: conf.js"] | sort)
    '
}

@test "secreview: docs だけの変更は対象外" {
    printf 'sandbox.excludedCommands に足す\n' > "$REPO/notes.md"
    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.secreview == {target: false, reasons: []}'
}

@test "secreview: realized diff を取れない（git diff 失敗）-> 対象に倒す (fail-safe) が files/risk は正常のまま" {
    REAL_GIT="$(command -v git)"
    GIT_STUB_BIN="$(mktemp -d)"
    cat > "$GIT_STUB_BIN/git" <<STUB
#!/usr/bin/env bash
for arg in "\$@"; do
    [[ "\$arg" == "--no-renames" ]] && exit 2
done
exec "$REAL_GIT" "\$@"
STUB
    chmod +x "$GIT_STUB_BIN/git"
    printf 'x\n' >> "$REPO/base.txt"

    run bash -c "PATH='$GIT_STUB_BIN:$ORIG_PATH' bash '$SCRIPT' '$REPO' '$BASE_REF'"
    rm -rf "$GIT_STUB_BIN"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .secreview.target == true
        and (.secreview.reasons[0] | startswith("unavailable:"))
        and .files == ["base.txt"]
        and .risk.ok == true
    '
}

# ---------------------------------------------------------------------------
# (d) base-ref 不正 -> risk.ok==false (fail-closed) かつ exit 0
# ---------------------------------------------------------------------------
@test "base-ref 不正 -> risk.ok==false (fail-closed) かつ exit 0" {
    run bash "$SCRIPT" "$REPO" "definitely-invalid-ref-xyz"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false and (.risk.hits | length) == 0'
}

# ---------------------------------------------------------------------------
# (e) worktree-diff-hash.sh のみ失敗 -> diffhash==null だが risk は正常 (フィールド独立性)
# ---------------------------------------------------------------------------
@test "worktree-diff-hash.sh のみ失敗 -> diffhash==null だが risk/files は正常のまま" {
    REAL_GIT="$(command -v git)"
    GIT_STUB_BIN="$(mktemp -d)"
    cat > "$GIT_STUB_BIN/git" <<STUB
#!/usr/bin/env bash
# worktree-diff-hash.sh だけが呼ぶ "git ... read-tree ..." を狙い撃ちで失敗させる。
# diff-risk-classify.sh / structural-classify.sh / secfloor-classify.sh 本体の
# git 呼び出しには read-tree が現れないため、他フィールドには波及しない。
for arg in "\$@"; do
    if [[ "\$arg" == "read-tree" ]]; then
        exit 1
    fi
done
exec "$REAL_GIT" "\$@"
STUB
    chmod +x "$GIT_STUB_BIN/git"

    run bash -c "PATH='$GIT_STUB_BIN:$ORIG_PATH' bash '$SCRIPT' '$REPO' '$BASE_REF'"
    rm -rf "$GIT_STUB_BIN"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .diffhash == null and
        .risk.ok == true and
        .files == []
    '
}

# ---------------------------------------------------------------------------
# (f) difft 不在 PATH -> struct.available==false でも risk/files 正常
# ---------------------------------------------------------------------------
@test "difft 不在 -> struct.available==false でも risk/files は正常" {
    run bash -c "DIFFT_BIN='difft-definitely-not-installed' PATH='$ORIG_PATH' bash '$SCRIPT' '$REPO' '$BASE_REF'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        .struct.ok == true and
        .struct.available == false and
        .risk.ok == true and
        .files == []
    '
}

# ---------------------------------------------------------------------------
# (g) 引数不足・worktree 不在 -> usage error, exit 非0, 全フィールド安全側 degrade
# ---------------------------------------------------------------------------
@test "引数不足(0引数) -> usage error で exit 非0" {
    run bash "$SCRIPT"
    [ "$status" -ne 0 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false and .files == null and .struct == null and .diffhash == null and .lines == null'
}

@test "引数不足(worktree-pathのみ) -> usage error で exit 非0" {
    run bash "$SCRIPT" "$REPO"
    [ "$status" -ne 0 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false and .files == null and .struct == null and .diffhash == null'
}

@test "worktree パス不在 -> usage error で exit 非0" {
    run bash "$SCRIPT" "/nonexistent-worktree-path-xyz" "$BASE_REF"
    [ "$status" -ne 0 ]
    printf '%s\n' "$output" | jq -e '.risk.ok == false and .files == null and .struct == null and .diffhash == null'
}

# ---------------------------------------------------------------------------
# (extra) jq 不在 -> risk.ok==false(jq_not_installed) の全 degrade JSON を exit 0 で返す
# ---------------------------------------------------------------------------
@test "jq 不在 -> risk.ok==false(jq_not_installed) の全 degrade JSON を exit 0 で返す" {
    run bash -c "PATH='$NO_JQ_BIN:$CORE_BIN_DIR' bash '$SCRIPT' '$REPO' '$BASE_REF'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"jq_not_installed"'
    printf '%s\n' "$output" | grep -q '"files":null'
    printf '%s\n' "$output" | grep -q '"struct":null'
    printf '%s\n' "$output" | grep -q '"diffhash":null'
}

# ---------------------------------------------------------------------------
# (extra) 出力は JSON 1 行
# ---------------------------------------------------------------------------
@test "出力は JSON 1 行" {
    run bash "$SCRIPT" "$REPO" "$BASE_REF"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
}
