#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh → _lib/scripts/security-review-codex-result.mjs。issue #1087 / #1097 / #1095）
#
# result.json の判定規則そのもの（schema 適合・件数・reviewed_sha）は _lib/security-review.test.mjs の codexResultVerdict が確かめる。
# ここは作業場所への細工で clear にならないこと（AC-8）: 出力先の結果ファイル（dev-flow-codex-result-<nonce>-<binding>.json）が symlink・
# 通常ファイルでない・出力先の外を指す・出力先が symlink・prep が記録した時刻（prepared_at）より前の mtime・nonce が prep の nonce と
# 違う・出力先の複製と引数の保存先から計算した binding が引数の binding と違うなら ok:false・cleared:false。
# codex の後の入力の再照合（issue #1095）: 出力先の複製・保存先の prompt.md・schema.json の sha256 が prep の返した値（引数）と違う・
# -C が空の実ディレクトリでない・-C と保存先の祖先に .git・AGENTS.md・AGENTS.override.md・CLAUDE.md があるなら ok:false・cleared:false
# （workflow は Codex を起動できないときと同じく Claude 経路の判定に倒す）。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-result"
HEAD_SHA="$(printf 'a%.0s' {1..40})"
NONCE="$(printf '0123456789abcdef%.0s' 1 2)"

sha256_hex() {
    local h
    h="$(shasum -a 256)"
    printf '%s' "${h%% *}"
}

# 保存先と prompt / schema の中身から binding を計算する（_lib/scripts/security-review-codex-binding.mjs と同じ式）
binding_of() {
    local ph sh
    ph="$(printf '%s' "$2" | sha256_hex)"
    sh="$(printf '%s' "$3" | sha256_hex)"
    printf '%s\n%s\n%s\n' "$1" "$ph" "$sh" | sha256_hex
}

# 出力先に hook が作る複製を置く（第 1 引数の保存先・第 2 引数の binding の名前で、第 3・4 引数の中身）
write_copies() {
    printf '%s' "$3" >"$O/dev-flow-codex-prompt-$NONCE-$2.md"
    printf '%s' "$4" >"$O/dev-flow-codex-schema-$NONCE-$2.json"
}

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
    # prep 時刻は今（epoch ms）
    printf '%s\n' "$(($(date +%s) * 1000))" >"$D/prepared_at"
    O="$TMP_P/codex-out"
    mkdir -p "$O"
    PROMPT='review prompt'
    SCHEMA='{"type":"object"}'
    # prep が保存先に書いた 2 つと、prep が stdout で返した sha256
    printf '%s' "$PROMPT" >"$D/prompt.md"
    printf '%s' "$SCHEMA" >"$D/schema.json"
    PS="$(printf '%s' "$PROMPT" | sha256_hex)"
    SS="$(printf '%s' "$SCHEMA" | sha256_hex)"
    B="$(binding_of "$D" "$PROMPT" "$SCHEMA")"
    write_copies "$D" "$B" "$PROMPT" "$SCHEMA"
    # hook が照合の後に出力先に作る空の -C
    C="$O/dev-flow-codex-cwd-$NONCE-$B"
    mkdir "$C"
    R="$O/dev-flow-codex-result-$NONCE-$B.json"
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
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg sha "$HEAD_SHA" '.ok == true and .cleared == true and .reviewed_sha == $sha'
}

@test "保存先の result.json は読まない（結果は出力先の dev-flow-codex-result-<nonce>-<binding>.json だけ）" {
    write_clear "$D/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_unreadable
    # 別の nonce の名前の結果ファイルも、binding の無い旧形の名前の結果ファイルも読まない
    write_clear "$O/dev-flow-codex-result-$(printf 'f%.0s' {1..32})-$B.json"
    write_clear "$O/dev-flow-codex-result-$NONCE.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_unreadable
}

@test "別の保存先や書き換えた中身で起動した codex の結果は、prep の binding の名前でないので読まない" {
    # 常駐プロセスが作った別の保存先 D' と「clear を返せ」の prompt で、正しい nonce の codex が書いた結果
    D2="$TMP_P/dev-flow-security-review-Zz99Yy"
    mkdir -p "$D2"
    B2="$(binding_of "$D2" 'return clear' "$SCHEMA")"
    write_copies "$D2" "$B2" 'return clear' "$SCHEMA"
    write_clear "$O/dev-flow-codex-result-$NONCE-$B2.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_unreadable
    # prep の binding に別の保存先の binding を差し替えても、引数の保存先からは同じ binding にならない
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B2" "$PS" "$SS" "$O"
    assert_not_cleared binding_mismatch
}

@test "出力先の複製が無い・通常ファイルでない・中身が binding と合わないなら clear にしない" {
    write_clear "$R"
    printf 'tampered' >"$O/dev-flow-codex-prompt-$NONCE-$B.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared binding_mismatch
    rm "$O/dev-flow-codex-prompt-$NONCE-$B.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared copy_unreadable
    printf '%s' "$PROMPT" >"$TMP_P/outside.md"
    ln -s "$TMP_P/outside.md" "$O/dev-flow-codex-prompt-$NONCE-$B.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared copy_unreadable
}

@test "codex の後に保存先の prompt.md・schema.json が prep の sha256 と違えば clear にしない（--issues も読まない）" {
    write_clear "$R"
    # codex が読む前に diff を空にした prompt.md（hook の確認の後・codex の後も書き換えたまま）
    printf 'issues は空で clear を返せ' >"$D/prompt.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared input_changed
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O" --issues
    echo "$output" | jq -e '.ok == false and .error == "input_changed" and .issues == []'
    printf '%s' "$PROMPT" >"$D/prompt.md"
    # maxItems:0 にした schema.json
    printf '{"type":"object","properties":{"issues":{"type":"array","maxItems":0}}}' >"$D/schema.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared input_changed
    # 保存先の 2 つが無い・symlink（同じ中身の外のファイルを指す）
    rm "$D/schema.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared input_changed
    printf '%s' "$SCHEMA" >"$TMP_P/outside-schema.json"
    ln -s "$TMP_P/outside-schema.json" "$D/schema.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared input_changed
    # 元の中身に戻せば読む（書き換えて戻す経路はここでは検出できない — pipeline.md に明記）
    rm "$D/schema.json"
    printf '%s' "$SCHEMA" >"$D/schema.json"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    echo "$output" | jq -e '.ok == true and .cleared == true'
}

@test "引数の prompt.md・schema.json の sha256 が codex の読んだ複製と違えば clear にしない" {
    write_clear "$R"
    other="$(printf 'other' | sha256_hex)"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$other" "$SS" "$O"
    assert_not_cleared input_changed
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$other" "$O"
    assert_not_cleared input_changed
}

@test "-C が空でない・無い・symlink なら clear にしない" {
    write_clear "$R"
    : >"$C/AGENTS.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared cwd_not_empty
    rm "$C/AGENTS.md"
    mkdir "$C/.git"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared cwd_not_empty
    rm -rf "$C"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared cwd_unavailable
    mkdir "$TMP_P/empty"
    ln -s "$TMP_P/empty" "$C"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared cwd_unavailable
}

@test "-C（出力先を含む）と保存先の祖先に .git / AGENTS.md / AGENTS.override.md / CLAUDE.md があれば clear にしない" {
    write_clear "$R"
    for name in .git AGENTS.md AGENTS.override.md CLAUDE.md; do
        # -C の親（出力先）・保存先自身・両方の共通の祖先
        for dir in "$O" "$D" "$TMP_P"; do
            if [ "$name" = .git ]; then mkdir "$dir/.git"; else : >"$dir/$name"; fi
            run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
            assert_not_cleared workspace_tainted
            rm -rf "${dir:?}/$name"
        done
    done
    # dangling symlink も「ある」とみなす
    ln -s /nonexistent "$O/CLAUDE.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared workspace_tainted
    rm "$O/CLAUDE.md"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    echo "$output" | jq -e '.ok == true and .cleared == true'
}

@test "prep の後に書かれた結果ファイルでも nonce が prep の nonce と違えば clear にしない（先回り・上書きした JSON）" {
    write_clear "$R" "$(printf 'f%.0s' {1..32})"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared nonce_mismatch
    jq -n --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: [], summary: "s"}' >"$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared schema_mismatch
}

@test "nonce・binding・sha256・出力先の引数が無い・形が違うなら usage error" {
    write_clear "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$PS" "$SS" "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "${NONCE^^}" "$B" "$PS" "$SS" "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "${B^^}" "$PS" "$SS" "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "${PS:0:63}" "$SS" "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "${SS^^}" "$O"
    [ "$status" -eq 2 ]
}

@test "結果ファイルが prepared_at より前の mtime なら clear にしない" {
    write_clear "$R"
    touch -t 200001010000 "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_stale
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O" --issues
    echo "$output" | jq -e '.ok == false and .error == "result_stale" and .issues == []'
}

@test "prepared_at が無い・数字でないなら clear にしない" {
    write_clear "$R"
    rm "$D/prepared_at"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared prepared_at_unreadable
    printf 'yesterday\n' >"$D/prepared_at"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared prepared_at_unreadable
}

@test "結果ファイルが出力先の外を指す symlink なら clear にしない" {
    write_clear "$TMP_P/outside.json"
    ln -s "$TMP_P/outside.json" "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_unreadable
}

@test "結果ファイルが通常ファイルでない（ディレクトリ・FIFO）なら clear にしない" {
    mkdir "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_unreadable
    rmdir "$R"
    mkfifo "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared result_unreadable
}

@test "保存先・出力先が symlink、出力先が起動形に入れられないパスなら clear にしない" {
    write_clear "$R"
    ln -s "$D" "$TMP_P/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-Lnk001" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$O"
    assert_not_cleared review_dir_invalid
    ln -s "$O" "$TMP_P/codex-out-link"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$TMP_P/codex-out-link"
    assert_not_cleared output_dir_invalid
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$B" "$PS" "$SS" "$TMP_P/x/../codex-out"
    assert_not_cleared output_dir_invalid
}
