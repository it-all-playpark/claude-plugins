#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh → _lib/scripts/security-review-codex-result.mjs。issue #1087 / #1095）
#
# result.json の判定規則そのもの（schema 適合・件数・reviewed_sha）は _lib/security-review.test.mjs の codexResultVerdict が確かめる。
# ここは作業場所への細工で clear にならないこと: result.json が symlink・通常ファイルでない・保存先の外を指す・
# prep が記録した時刻（prepared_at）より前の mtime・nonce が prep の nonce と違う、
# codex の後に prompt.md・schema.json の sha256 が prep の値と違う・-C が空でない・-C と保存先の祖先に指示ファイルがある
# なら ok:false・cleared:false（workflow は Claude 経路の判定に倒す）。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-result"
HEAD_SHA="$(printf 'a%.0s' {1..40})"
NONCE="$(printf '0123456789abcdef%.0s' 1 2)"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/rv/dev-flow-security-review-Ab12Cd"
    C="$TMP_P/cw/dev-flow-codex-cwd-Qw12Er"
    mkdir -p "$D" "$C"
    # prep 時刻は今（epoch ms）
    printf '%s\n' "$(($(date +%s) * 1000))" >"$D/prepared_at"
    printf '# Security review\n<<<SECURITY_REVIEW_DATA_BEGIN>>>\ndiff:\n+echo "$1" | sh\n' >"$D/prompt.md"
    printf '{"type":"object","properties":{"issues":{"type":"array"}}}\n' >"$D/schema.json"
    PSHA="$(sha256_of "$D/prompt.md")"
    SSHA="$(sha256_of "$D/schema.json")"
}

# 第 1 引数のパスに clear の result.json を書く（第 2 引数で nonce を変えられる）
write_clear() {
    jq -n --arg sha "$HEAD_SHA" --arg n "${2:-$NONCE}" '{nonce: $n, reviewed_sha: $sha, issues: [], summary: "s"}' >"$1"
}

# prep が返した値（保存先・head・nonce・-C・prompt.md / schema.json の sha256）で判定する
run_result() {
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$PSHA" "$SSHA" "$@"
}

assert_not_cleared() {
    echo "$output" | jq -e --arg e "$1" '.ok == false and .cleared == false and .error == $e'
}

@test "prep の後に書かれた通常ファイルの clear の result.json は clear" {
    write_clear "$D/result.json"
    run_result
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg sha "$HEAD_SHA" '.ok == true and .cleared == true and .reviewed_sha == $sha'
}

@test "prep の後に書かれた result.json でも nonce が prep の nonce と違えば clear にしない（保存先へ先回り・上書きした JSON）" {
    write_clear "$D/result.json" "$(printf 'f%.0s' {1..32})"
    run_result
    assert_not_cleared nonce_mismatch
    jq -n --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: [], summary: "s"}' >"$D/result.json"
    run_result
    assert_not_cleared schema_mismatch
}

@test "nonce・-C・sha256 の引数が無い・形が違うなら usage error" {
    write_clear "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "${NONCE^^}" "$C" "$PSHA" "$SSHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$PSHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "${PSHA:0:40}" "$SSHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$PSHA" "${SSHA^^}"
    [ "$status" -eq 2 ]
}

@test "codex の後に prompt.md が prep の書いたものと違えば clear にしない（diff を空にする差し替え・symlink への置き換え）" {
    write_clear "$D/result.json"
    printf '# Security review\n<<<SECURITY_REVIEW_DATA_BEGIN>>>\ndiff:\n' >"$D/prompt.md"
    run_result
    assert_not_cleared input_changed
    run_result --issues
    echo "$output" | jq -e '.ok == false and .error == "input_changed" and .issues == []'
    # 同じ内容でも symlink は prep が書いた通常ファイルでない
    printf '# Security review\n<<<SECURITY_REVIEW_DATA_BEGIN>>>\ndiff:\n+echo "$1" | sh\n' >"$TMP_P/prompt.md"
    rm "$D/prompt.md"
    ln -s "$TMP_P/prompt.md" "$D/prompt.md"
    [ "$(sha256_of "$D/prompt.md")" = "$PSHA" ]
    run_result
    assert_not_cleared input_changed
    rm "$D/prompt.md"
    run_result
    assert_not_cleared input_changed
}

@test "codex の後に schema.json が prep の書いたものと違えば clear にしない（issues を maxItems:0 にする差し替え）" {
    write_clear "$D/result.json"
    printf '{"type":"object","properties":{"issues":{"type":"array","maxItems":0}}}\n' >"$D/schema.json"
    run_result
    assert_not_cleared input_changed
}

@test "-C が空でない（AGENTS.md 等を置いた）なら clear にしない" {
    write_clear "$D/result.json"
    for name in AGENTS.md .git x; do
        if [ "$name" = .git ]; then mkdir "$C/.git"; else : >"$C/$name"; fi
        run_result
        assert_not_cleared cwd_not_empty
        rm -rf "${C:?}/$name"
    done
    run_result
    echo "$output" | jq -e '.ok == true and .cleared == true'
}

@test "-C と保存先の祖先に .git / AGENTS.md / AGENTS.override.md / CLAUDE.md があれば clear にしない" {
    write_clear "$D/result.json"
    for parent in "$TMP_P/cw" "$TMP_P/rv"; do
        for name in .git AGENTS.md AGENTS.override.md CLAUDE.md; do
            if [ "$name" = .git ]; then mkdir "$parent/.git"; else : >"$parent/$name"; fi
            run_result
            assert_not_cleared workspace_tainted
            rm -rf "${parent:?}/$name"
        done
    done
    # dangling symlink も「ある」とみなす
    ln -s /nonexistent "$TMP_P/cw/CLAUDE.md"
    run_result
    assert_not_cleared workspace_tainted
}

@test "-C が作業ディレクトリの形でない・実在しない・symlink なら clear にしない" {
    write_clear "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/cw" "$PSHA" "$SSHA"
    assert_not_cleared cwd_dir_invalid
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/cw/dev-flow-codex-cwd-None01" "$PSHA" "$SSHA"
    assert_not_cleared cwd_dir_invalid
    mkdir -p "$TMP_P/other"
    ln -s "$TMP_P/other" "$TMP_P/cw/dev-flow-codex-cwd-Lnk001"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/cw/dev-flow-codex-cwd-Lnk001" "$PSHA" "$SSHA"
    assert_not_cleared cwd_dir_invalid
}

@test "result.json が prepared_at より前の mtime なら clear にしない" {
    write_clear "$D/result.json"
    touch -t 200001010000 "$D/result.json"
    run_result
    assert_not_cleared result_stale
    run_result --issues
    echo "$output" | jq -e '.ok == false and .error == "result_stale" and .issues == []'
}

@test "prepared_at が無い・数字でないなら clear にしない" {
    write_clear "$D/result.json"
    rm "$D/prepared_at"
    run_result
    assert_not_cleared prepared_at_unreadable
    printf 'yesterday\n' >"$D/prepared_at"
    run_result
    assert_not_cleared prepared_at_unreadable
}

@test "result.json が保存先の外を指す symlink なら clear にしない" {
    write_clear "$TMP_P/outside.json"
    ln -s "$TMP_P/outside.json" "$D/result.json"
    run_result
    assert_not_cleared result_unreadable
}

@test "result.json が通常ファイルでない（ディレクトリ・FIFO）なら clear にしない" {
    mkdir "$D/result.json"
    run_result
    assert_not_cleared result_unreadable
    rmdir "$D/result.json"
    mkfifo "$D/result.json"
    run_result
    assert_not_cleared result_unreadable
}

@test "保存先が symlink なら clear にしない" {
    write_clear "$D/result.json"
    ln -s "$D" "$TMP_P/rv/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/rv/dev-flow-security-review-Lnk001" "$HEAD_SHA" "$NONCE" "$C" "$PSHA" "$SSHA"
    assert_not_cleared review_dir_invalid
}
