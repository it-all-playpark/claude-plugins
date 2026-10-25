#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-diff-check（_shared/scripts/security-review-diff-check.sh → _lib/scripts/security-review-diff-check.mjs。issue #1095）
#
# Claude 経路の security review の入力（pr.diff）の照合: security-review-scope --save-diff が書いた pr.diff の sha256 と
# statDigest（dev・ino・ctime・nlink）を返し、review の後に security-review-diff-check がその値と保存先の pr.diff を照合する。
# 差し替えた（元の内容へ戻したものを含む）・照合できない pr.diff は
# matched:true にしない（workflow はその round を clear にしない — _lib/priterate-security-review.test.mjs）。

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BIN="$PLUGIN_ROOT/bin/security-review-diff-check"
SCOPE_BIN="$PLUGIN_ROOT/bin/security-review-scope"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

setup() {
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$TMPDIR"
    TMP_P="$(cd "$TMPDIR" && pwd -P)"
    REPO="$BATS_TEST_TMPDIR/repo"
    git init -q -b main "$REPO"
    git -C "$REPO" config user.name t
    git -C "$REPO" config user.email t@example.com
    git -C "$REPO" config commit.gpgsign false
    git -C "$REPO" config core.hooksPath /dev/null
    printf 'echo hi\n' >"$REPO/run.sh"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m init
    git -C "$REPO" checkout -q -b feature
    printf 'echo hi\necho "$1" | sh\n' >"$REPO/run.sh"
    git -C "$REPO" commit -q -am change
    HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
}

# security-review-scope --save-diff で保存先と sha256 を作る
save_diff() {
    run bash "$SCOPE_BIN" "$REPO" main "$HEAD_SHA" --save-diff
    [ "$status" -eq 0 ]
    D="$(echo "$output" | jq -r '.review_dir')"
    DIFF_SHA="$(echo "$output" | jq -r '.diff_sha256')"
    DIFF_STAT="$(echo "$output" | jq -r '.diff_stat_sha256')"
}

@test "security-review-scope --save-diff は書いた pr.diff の sha256 を返し、--save-diff 無しは null" {
    save_diff
    echo "$output" | jq -e '.ok == true and (.diff_sha256 | test("^[0-9a-f]{64}$"))'
    [ "$DIFF_SHA" = "$(sha256_of "$D/pr.diff")" ]
    [[ "$DIFF_STAT" =~ ^[0-9a-f]{64}$ ]]
    grep -qF '+echo "$1" | sh' "$D/pr.diff"
    run bash "$SCOPE_BIN" "$REPO" main "$HEAD_SHA"
    echo "$output" | jq -e '.ok == true and .diff_sha256 == null and .diff_stat_sha256 == null and .review_dir == null'
}

@test "pr.diff を差し替えて review の後に元の内容へ戻した（rename で置き換えた・同じ内容を書き直した）なら matched:false" {
    save_diff
    cp "$D/pr.diff" "$TMP_P/orig.diff"
    # 良性の diff に差し替えてから元の内容を書き戻す（内容の sha256 は scope の値と同じ。ctime が変わる）
    sleep 0.01
    printf 'diff --git a/README.md b/README.md\n+docs\n' >"$D/pr.diff"
    cat "$TMP_P/orig.diff" >"$D/pr.diff"
    [ "$(sha256_of "$D/pr.diff")" = "$DIFF_SHA" ]
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == false'
    # 元の内容のコピーを rename で置く（ino が変わる）
    save_diff
    cp "$D/pr.diff" "$TMP_P/same.diff"
    mv "$TMP_P/same.diff" "$D/pr.diff"
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == true and .matched == false'
}

@test "pr.diff を読むだけ（reviewer の Read）なら matched:true のまま" {
    save_diff
    sleep 0.01
    cat "$D/pr.diff" >/dev/null
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == true and .matched == true'
}

@test "scope が書いたままの pr.diff は matched:true" {
    save_diff
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == true and has("error") == false'
}

@test "pr.diff を良性の diff に差し替えた・空にしたなら matched:false" {
    save_diff
    printf 'diff --git a/README.md b/README.md\n+docs\n' >"$D/pr.diff"
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == false'
    : >"$D/pr.diff"
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == true and .matched == false'
}

@test "pr.diff が symlink（同じ内容でも）・無い・通常ファイルでないなら照合できない（ok:false・matched:false）" {
    save_diff
    cp "$D/pr.diff" "$TMP_P/copy.diff"
    rm "$D/pr.diff"
    ln -s "$TMP_P/copy.diff" "$D/pr.diff"
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "diff_unavailable"'
    rm "$D/pr.diff"
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "diff_unavailable"'
    mkdir "$D/pr.diff"
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "diff_unavailable"'
}

@test "保存先が mkdtemp の形でない・symlink・.. を含むなら照合できない" {
    save_diff
    mkdir -p "$TMP_P/not-a-review-dir"
    cp "$D/pr.diff" "$TMP_P/not-a-review-dir/pr.diff"
    run bash "$BIN" "$TMP_P/not-a-review-dir" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "review_dir_invalid"'
    ln -s "$D" "$TMP_P/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-Lnk001" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
    run bash "$BIN" "$TMP_P/x/../$(basename "$D")" "$DIFF_SHA" "$DIFF_STAT"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
}

@test "引数不正は exit 2" {
    save_diff
    run bash "$BIN" "$D"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$DIFF_SHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "${DIFF_SHA:0:40}" "$DIFF_STAT"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "${DIFF_SHA^^}" "$DIFF_STAT"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$DIFF_SHA" "${DIFF_STAT^^}"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$DIFF_SHA" "$DIFF_STAT" --extra
    [ "$status" -eq 2 ]
}
