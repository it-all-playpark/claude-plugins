#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh → _lib/scripts/security-review-codex-result.mjs。issue #1087）
#
# result.json の判定規則そのもの（schema 適合・件数・reviewed_sha）は _lib/security-review.test.mjs の codexResultVerdict が確かめる。
# ここは作業場所への細工で clear にならないこと（AC-8）: result.json が symlink・通常ファイルでない・保存先の外を指す・
# prep が記録した時刻（prepared_at）より前の mtime なら ok:false・cleared:false。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-result"
HEAD_SHA="$(printf 'a%.0s' {1..40})"

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
    # prep 時刻は今（epoch ms）
    printf '%s\n' "$(($(date +%s) * 1000))" >"$D/prepared_at"
}

# 第 1 引数のパスに clear の result.json を書く
write_clear() {
    jq -n --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: [], summary: "s"}' >"$1"
}

assert_not_cleared() {
    echo "$output" | jq -e --arg e "$1" '.ok == false and .cleared == false and .error == $e'
}

@test "prep の後に書かれた通常ファイルの clear の result.json は clear" {
    write_clear "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg sha "$HEAD_SHA" '.ok == true and .cleared == true and .reviewed_sha == $sha'
}

@test "result.json が prepared_at より前の mtime なら clear にしない" {
    write_clear "$D/result.json"
    touch -t 200001010000 "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared result_stale
    run bash "$BIN" "$D" "$HEAD_SHA" --issues
    echo "$output" | jq -e '.ok == false and .error == "result_stale" and .issues == []'
}

@test "prepared_at が無い・数字でないなら clear にしない" {
    write_clear "$D/result.json"
    rm "$D/prepared_at"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared prepared_at_unreadable
    printf 'yesterday\n' >"$D/prepared_at"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared prepared_at_unreadable
}

@test "result.json が保存先の外を指す symlink なら clear にしない" {
    write_clear "$TMP_P/outside.json"
    ln -s "$TMP_P/outside.json" "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared result_unreadable
}

@test "result.json が通常ファイルでない（ディレクトリ・FIFO）なら clear にしない" {
    mkdir "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared result_unreadable
    rmdir "$D/result.json"
    mkfifo "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared result_unreadable
}

@test "保存先が symlink なら clear にしない" {
    write_clear "$D/result.json"
    ln -s "$D" "$TMP_P/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-Lnk001" "$HEAD_SHA"
    assert_not_cleared review_dir_invalid
}
