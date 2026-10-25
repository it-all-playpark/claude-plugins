#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh → _lib/scripts/security-review-codex-result.mjs。issue #1087）
#
# result.json の判定規則そのもの（schema 適合・件数・reviewed_sha）は _lib/security-review.test.mjs の codexResultVerdict が確かめる。
# ここは CLI の配線: 保存先の result.json を読み、判定（自由文なし）と --issues（指摘の本文）を返し、読めない・schema に合わない
# 結果は ok:false・cleared:false にすること。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-result"
HEAD_SHA="$(printf 'a%.0s' {1..40})"

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
}

write_result() {
    jq -n --arg sha "${2:-$HEAD_SHA}" --argjson issues "$1" '{reviewed_sha: $sha, issues: $issues, summary: "s"}' >"$D/result.json"
}

MAJOR='[{"severity":"major","topic":"t","file":"a.sh","line":null,"description":"d","suggestion":"s"}]'

assert_not_cleared() {
    echo "$output" | jq -e --arg e "$1" '.ok == false and .cleared == false and .error == $e'
}

@test "critical/major 0 件で reviewed_sha が head と一致すれば clear" {
    write_result '[]'
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg sha "$HEAD_SHA" '.ok == true and .cleared == true and .reviewed_sha == $sha and .counts == {critical: 0, major: 0, minor: 0}'
}

@test "major があれば clear にせず、判定は自由文を出さない。--issues は指摘の本文を返す" {
    write_result "$MAJOR"
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .cleared == false and .reason == "blocking" and .counts.major == 1 and (has("issues") | not)'
    run bash "$BIN" "$D" "$HEAD_SHA" --issues
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .issues[0].topic == "t" and .issues[0].description == "d"'
}

@test "reviewed_sha が head と違えば clear にしない" {
    write_result '[]' "$(printf 'b%.0s' {1..40})"
    run bash "$BIN" "$D" "$HEAD_SHA"
    echo "$output" | jq -e '.ok == true and .cleared == false and .reason == "sha_mismatch"'
}

@test "result.json が無い・JSON でない・schema に合わないなら判定できない" {
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared result_unreadable
    run bash "$BIN" "$D" "$HEAD_SHA" --issues
    echo "$output" | jq -e '.ok == false and .error == "result_unreadable" and .issues == []'
    printf 'not json' >"$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared result_unreadable
    jq -n --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: []}' >"$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    assert_not_cleared schema_mismatch
}

@test "保存先の名前でないパスは判定できない。引数の数・sha の形が違えば usage error" {
    write_result '[]'
    run bash "$BIN" "$TMP_P" "$HEAD_SHA"
    assert_not_cleared review_dir_invalid
    run bash "$BIN" "$D"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" abc
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" --other
    [ "$status" -eq 2 ]
}
