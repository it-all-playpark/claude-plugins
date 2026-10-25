#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh → _lib/scripts/security-review-codex-prep.mjs。issue #1087）
#
# Codex 経路の security review の入力を、security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX）に
# 用意する: prompt.md（prompt + diff）・schema.json（strict 形）・空の cwd/（codex の -C）。
# 起動形そのもの（codexSecurityReviewCommand）と hook の一致は _lib/security-review.test.mjs が確かめる。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-prep"
HEAD_SHA="$(printf 'a%.0s' {1..40})"

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
    printf 'diff --git a/run.sh b/run.sh\n+echo "$1" | sh\n' >"$D/pr.diff"
    PREV="$TMP_P/dev-flow-security-review-Prev01"
    mkdir -p "$PREV"
}

# 前回の round の保存先に result.json（第 1 引数の issues）を置く
write_prev_result() {
    jq -n --argjson issues "$1" --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: $issues, summary: "s"}' >"$PREV/result.json"
}

@test "保存先に prompt.md（境界の節を持ち、diff を末尾に置く）・strict 形の schema.json・空の cwd/ を作る" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: true}'
    grep -qF '# Security review of PR #5' "$D/prompt.md"
    grep -qxF "head_sha: $HEAD_SHA" "$D/prompt.md"
    grep -qxF 'verify_items: []' "$D/prompt.md"
    grep -qF '## 境界（次は critical / major にしない。書くなら minor）' "$D/prompt.md"
    [ "$(tail -n 2 "$D/prompt.md")" = "$(cat "$D/pr.diff")" ]
    # schema.json: 全 object が additionalProperties:false・全 property が required・maxLength 無し
    jq -e '[.. | objects | select(.type == "object")] | length == 2 and all(.additionalProperties == false and ((.required | sort) == (.properties | keys)))' "$D/schema.json"
    jq -e '[.. | objects | has("maxLength")] | any | not' "$D/schema.json"
    [ -d "$D/cwd" ] && [ -z "$(ls -A "$D/cwd")" ]
    [ ! -e "$D/result.json" ]
}

@test "--verify-from: 前回の保存先の result.json の critical/major だけを verify_items にする" {
    write_prev_result '[{"severity":"critical","topic":"cmd-injection","file":"run.sh","line":2,"description":"D1","suggestion":"S1"},{"severity":"minor","topic":"hardening","file":"run.sh","line":null,"description":"D2","suggestion":"S2"}]'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    verify="$(sed -n 's/^verify_items: //p' "$D/prompt.md")"
    echo "$verify" | jq -e '. == [{topic: "cmd-injection", severity: "critical", file: "run.sh", line: 2, description: "D1"}]'
}

@test "--verify-from の result.json が無い・schema に合わない・保存先の名前でないなら ok:false で何も書かない" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable"'
    jq -n '{reviewed_sha: "x", issues: [], summary: "s", approved: true}' >"$PREV/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable"'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$TMP_P"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_invalid"'
    [ ! -e "$D/prompt.md" ] && [ ! -e "$D/schema.json" ] && [ ! -e "$D/cwd" ]
}

@test "prompt.md・schema.json・result.json・cwd が既にある保存先には書かない（前の結果と取り違えない）" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == true'
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "review_dir_not_fresh"'

    D2="$TMP_P/dev-flow-security-review-Res001"
    mkdir -p "$D2"
    printf 'diff\n' >"$D2/pr.diff"
    printf '{}\n' >"$D2/result.json"
    run bash "$BIN" "$D2" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_not_fresh"'
    [ ! -e "$D2/prompt.md" ]
}

@test "保存先が mkdtemp の形でない・ディレクトリでない・起動形に入れられない・pr.diff が無いなら ok:false" {
    mkdir -p "$TMP_P/not-a-review-dir"
    printf 'diff\n' >"$TMP_P/not-a-review-dir/pr.diff"
    run bash "$BIN" "$TMP_P/not-a-review-dir" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    : >"$TMP_P/dev-flow-security-review-File01"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-File01" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    run bash "$BIN" "$TMP_P/x/../dev-flow-security-review-Ab12Cd" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    mkdir -p "$TMP_P/a b/dev-flow-security-review-Spc001"
    printf 'diff\n' >"$TMP_P/a b/dev-flow-security-review-Spc001/pr.diff"
    run bash "$BIN" "$TMP_P/a b/dev-flow-security-review-Spc001" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    mkdir -p "$TMP_P/dev-flow-security-review-NoDf01"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-NoDf01" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "diff_unavailable"'
    [ ! -e "$TMP_P/dev-flow-security-review-NoDf01/prompt.md" ]
}

@test "引数不正は exit 2" {
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" abc 5
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 0
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --unknown
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 5 extra
    [ "$status" -eq 2 ]
    [ ! -e "$D/prompt.md" ]
}
