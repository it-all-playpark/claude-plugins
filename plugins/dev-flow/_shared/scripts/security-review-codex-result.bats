#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh → _lib/scripts/security-review-codex-result.mjs。issue #1087 / #1097）
#
# result.json の判定規則そのもの（schema 適合・件数・reviewed_sha）は _lib/security-review.test.mjs の codexResultVerdict が確かめる。
# ここは作業場所への細工で clear にならないこと（AC-8）: 出力先の結果ファイル（dev-flow-codex-result-<nonce>.json）が symlink・
# 通常ファイルでない・出力先の外を指す・出力先が symlink・prep が記録した時刻（prepared_at）より前の mtime・nonce が prep の nonce と
# 違うなら ok:false・cleared:false。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-result"
HEAD_SHA="$(printf 'a%.0s' {1..40})"
NONCE="$(printf '0123456789abcdef%.0s' 1 2)"

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
    # prep 時刻は今（epoch ms）
    printf '%s\n' "$(($(date +%s) * 1000))" >"$D/prepared_at"
    O="$TMP_P/codex-out"
    mkdir -p "$O"
    R="$O/dev-flow-codex-result-$NONCE.json"
}

# 第 1 引数のパスに clear の result.json を書く（第 2 引数で nonce を変えられる）
write_clear() {
    jq -n --arg sha "$HEAD_SHA" --arg n "${2:-$NONCE}" '{nonce: $n, reviewed_sha: $sha, issues: [], summary: "s"}' >"$1"
}

assert_not_cleared() {
    echo "$output" | jq -e --arg e "$1" '.ok == false and .cleared == false and .error == $e'
}

@test "prep の後に出力先に書かれた通常ファイルの clear の結果ファイルは clear" {
    write_clear "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg sha "$HEAD_SHA" '.ok == true and .cleared == true and .reviewed_sha == $sha'
}

@test "保存先の result.json は読まない（結果は出力先の dev-flow-codex-result-<nonce>.json だけ）" {
    write_clear "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared result_unreadable
    # 別の nonce の名前の結果ファイルも読まない
    write_clear "$O/dev-flow-codex-result-$(printf 'f%.0s' {1..32}).json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared result_unreadable
}

@test "prep の後に書かれた結果ファイルでも nonce が prep の nonce と違えば clear にしない（先回り・上書きした JSON）" {
    write_clear "$R" "$(printf 'f%.0s' {1..32})"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared nonce_mismatch
    jq -n --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: [], summary: "s"}' >"$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared schema_mismatch
}

@test "nonce・出力先の引数が無い・形が違うなら usage error" {
    write_clear "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "${NONCE^^}" "$O"
    [ "$status" -eq 2 ]
}

@test "結果ファイルが prepared_at より前の mtime なら clear にしない" {
    write_clear "$R"
    touch -t 200001010000 "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared result_stale
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O" --issues
    echo "$output" | jq -e '.ok == false and .error == "result_stale" and .issues == []'
}

@test "prepared_at が無い・数字でないなら clear にしない" {
    write_clear "$R"
    rm "$D/prepared_at"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared prepared_at_unreadable
    printf 'yesterday\n' >"$D/prepared_at"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared prepared_at_unreadable
}

@test "結果ファイルが出力先の外を指す symlink なら clear にしない" {
    write_clear "$TMP_P/outside.json"
    ln -s "$TMP_P/outside.json" "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared result_unreadable
}

@test "結果ファイルが通常ファイルでない（ディレクトリ・FIFO）なら clear にしない" {
    mkdir "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared result_unreadable
    rmdir "$R"
    mkfifo "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared result_unreadable
}

@test "保存先・出力先が symlink、出力先が起動形に入れられないパスなら clear にしない" {
    write_clear "$R"
    ln -s "$D" "$TMP_P/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-Lnk001" "$HEAD_SHA" "$NONCE" "$O"
    assert_not_cleared review_dir_invalid
    ln -s "$O" "$TMP_P/codex-out-link"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/codex-out-link"
    assert_not_cleared output_dir_invalid
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/x/../codex-out"
    assert_not_cleared output_dir_invalid
}
