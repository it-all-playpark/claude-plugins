#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-result（_shared/scripts/security-review-codex-result.sh → _lib/scripts/security-review-codex-result.mjs。issue #1087 / #1095）
#
# result.json の判定規則そのもの（schema 適合・件数・reviewed_sha）は _lib/security-review.test.mjs の codexResultVerdict が確かめる。
# ここは作業場所への細工で clear にならないこと: result.json が symlink・通常ファイルでない・保存先の外を指す・
# prep が記録した時刻（prepared_at）より前の mtime・nonce が prep の nonce と違う、
# codex の後に prompt.md・schema.json の sha256 か保存先・入力・out・-C・-C/.git の statDigest（dev・ino・ctime・nlink）が prep の値と違う・
# -C が prep の空の .git 以外を持つ・保存先の祖先に指示ファイルがある・result.json が prep の作った置き場（out/out_name）の中にない
# なら ok:false・cleared:false（workflow は Claude 経路の判定に倒す）。

PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BIN="$PLUGIN_ROOT/bin/security-review-codex-result"
HEAD_SHA="$(printf 'a%.0s' {1..40})"
NONCE="$(printf '0123456789abcdef%.0s' 1 2)"

# prep と同じ statDigest（_lib/scripts/security-review-workspace.mjs）を引数のパスで取る
stat_digest() {
    node --input-type=module -e "import { statDigest } from '$PLUGIN_ROOT/_lib/scripts/security-review-workspace.mjs'; process.stdout.write(String(statDigest(process.argv.slice(1))))" "$@"
}

# prep が書いた後の保存先・pr.diff・prompt.md・schema.json・prepared_at・out・-C・-C/.git の statDigest
take_stat() {
    STAT="$(stat_digest "$D" "$D/pr.diff" "$D/prompt.md" "$D/schema.json" "$D/prepared_at" "$D/out" "$C" "$C/.git")"
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

setup() {
    TMP_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    D="$TMP_P/rv/dev-flow-security-review-Ab12Cd"
    C="$TMP_P/cw/dev-flow-codex-cwd-Qw12Er"
    O="fedcba9876543210fedcba9876543210"
    mkdir -p "$D" "$C"
    # prep が -C に置く空の .git（codex の project root を -C に止める）
    : >"$C/.git"
    printf 'diff --git a/run.sh b/run.sh\n+echo "$1" | sh\n' >"$D/pr.diff"
    # prep 時刻は今（epoch ms）
    printf '%s\n' "$(($(date +%s) * 1000))" >"$D/prepared_at"
    printf '# Security review\n<<<SECURITY_REVIEW_DATA_BEGIN>>>\ndiff:\n+echo "$1" | sh\n' >"$D/prompt.md"
    printf '{"type":"object","properties":{"issues":{"type":"array"}}}\n' >"$D/schema.json"
    PSHA="$(sha256_of "$D/prompt.md")"
    SSHA="$(sha256_of "$D/schema.json")"
    # codex の -o の置き場（prep が保存先の中の out に作る乱数名のディレクトリ）
    mkdir -p "$D/out/$O"
    R="$D/out/$O/result.json"
    take_stat
}

# 第 1 引数のパスに clear の result.json を書く（第 2 引数で nonce を変えられる）
write_clear() {
    jq -n --arg sha "$HEAD_SHA" --arg n "${2:-$NONCE}" '{nonce: $n, reviewed_sha: $sha, issues: [], summary: "s"}' >"$1"
}

# prep が返した値（保存先・head・nonce・-C・置き場・prompt.md / schema.json の sha256・statDigest）で判定する
run_result() {
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$O" "$PSHA" "$SSHA" "$STAT" "$@"
}

assert_not_cleared() {
    echo "$output" | jq -e --arg e "$1" '.ok == false and .cleared == false and .error == $e'
}

@test "prep の後に書かれた通常ファイルの clear の result.json は clear" {
    write_clear "$R"
    run_result
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg sha "$HEAD_SHA" '.ok == true and .cleared == true and .reviewed_sha == $sha'
}

@test "prep の後に書かれた result.json でも nonce が prep の nonce と違えば clear にしない（保存先へ先回り・上書きした JSON）" {
    write_clear "$R" "$(printf 'f%.0s' {1..32})"
    run_result
    assert_not_cleared nonce_mismatch
    jq -n --arg sha "$HEAD_SHA" '{reviewed_sha: $sha, issues: [], summary: "s"}' >"$R"
    run_result
    assert_not_cleared schema_mismatch
}

@test "nonce・-C・置き場・sha256・statDigest の引数が無い・形が違うなら usage error" {
    write_clear "$R"
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "${NONCE^^}" "$C" "$O" "$PSHA" "$SSHA" "$STAT"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE"
    [ "$status" -eq 2 ]
    # 置き場・statDigest の無い旧形
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$PSHA" "$SSHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$O" "$PSHA" "$SSHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "${O^^}" "$PSHA" "$SSHA" "$STAT"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$O" "${PSHA:0:40}" "$SSHA" "$STAT"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$O" "$PSHA" "${SSHA^^}" "$STAT"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$C" "$O" "$PSHA" "$SSHA" "${STAT:0:40}"
    [ "$status" -eq 2 ]
}

@test "codex の前に差し替えて後で元の内容へ戻した入力（prompt.md・schema.json・pr.diff・-C）は clear にしない" {
    write_clear "$R"
    for f in prompt.md schema.json pr.diff; do
        cp "$D/$f" "$TMP_P/orig"
        sleep 0.01
        printf 'benign\n' >"$D/$f"
        cat "$TMP_P/orig" >"$D/$f"
        run_result
        assert_not_cleared input_changed
        take_stat
    done
    # -C に AGENTS.md を置いて消す
    sleep 0.01
    : >"$C/AGENTS.md"
    rm "$C/AGENTS.md"
    run_result
    assert_not_cleared input_changed
    take_stat
    run_result
    echo "$output" | jq -e '.ok == true and .cleared == true'
}

@test "保存先の mode を戻して一覧を取った round は clear にしない" {
    write_clear "$R"
    chmod 300 "$D"
    take_stat
    sleep 0.01
    chmod 700 "$D"
    ls "$D" >/dev/null
    chmod 300 "$D"
    run_result
    assert_not_cleared input_changed
    chmod 700 "$D"
}

@test "result.json が置き場（out/out_name）の中にない・置き場が無いなら clear にしない" {
    # 旧形（保存先の直下の固定名・保存先の直下の置き場）に置かれた result.json は読まない
    write_clear "$D/result.json"
    mkdir "$D/$O"
    write_clear "$D/$O/result.json"
    take_stat
    run_result
    assert_not_cleared result_unreadable
    rmdir "$D/out/$O"
    run_result
    assert_not_cleared input_changed
}

@test "out の mode を戻して一覧を取った・out を入れ替えて戻した round は clear にしない" {
    write_clear "$R"
    chmod 300 "$D/out"
    take_stat
    sleep 0.01
    chmod 700 "$D/out"
    ls "$D/out" >/dev/null
    chmod 300 "$D/out"
    run_result
    assert_not_cleared input_changed
    chmod 700 "$D/out"
    take_stat
    sleep 0.01
    mv "$D/out" "$TMP_P/out-moved"
    mv "$TMP_P/out-moved" "$D/out"
    run_result
    assert_not_cleared input_changed
}

@test "codex の後に prompt.md が prep の書いたものと違えば clear にしない（diff を空にする差し替え・symlink への置き換え）" {
    write_clear "$R"
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
    write_clear "$R"
    printf '{"type":"object","properties":{"issues":{"type":"array","maxItems":0}}}\n' >"$D/schema.json"
    run_result
    assert_not_cleared input_changed
}

@test "-C が prep の空の .git 以外を持つ（AGENTS.md 等を置いた・.git を書き換えた）なら clear にしない" {
    write_clear "$R"
    for name in AGENTS.md x; do
        : >"$C/$name"
        run_result
        assert_not_cleared cwd_not_empty
        rm -f "${C:?}/$name"
    done
    printf 'gitdir: /x\n' >"$C/.git"
    run_result
    assert_not_cleared cwd_not_empty
    rm "$C/.git"
    run_result
    assert_not_cleared cwd_not_empty
    mkdir "$C/.git"
    run_result
    assert_not_cleared cwd_not_empty
    rmdir "$C/.git"
    : >"$C/.git"
    # 置いて消した -C は ctime が変わる（prep の後の値として取り直すと clear）
    take_stat
    run_result
    echo "$output" | jq -e '.ok == true and .cleared == true'
}

@test "保存先の祖先に .git / AGENTS.md / AGENTS.override.md / CLAUDE.md があれば clear にしない" {
    write_clear "$R"
    for name in .git AGENTS.md AGENTS.override.md CLAUDE.md; do
        if [ "$name" = .git ]; then mkdir "$TMP_P/rv/.git"; else : >"$TMP_P/rv/$name"; fi
        run_result
        assert_not_cleared workspace_tainted
        rm -rf "${TMP_P:?}/rv/$name"
    done
    # dangling symlink も「ある」とみなす
    ln -s /nonexistent "$TMP_P/rv/CLAUDE.md"
    run_result
    assert_not_cleared workspace_tainted
}

@test "-C が作業ディレクトリの形でない・実在しない・symlink なら clear にしない" {
    write_clear "$R"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/cw" "$O" "$PSHA" "$SSHA" "$STAT"
    assert_not_cleared cwd_dir_invalid
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/cw/dev-flow-codex-cwd-None01" "$O" "$PSHA" "$SSHA" "$STAT"
    assert_not_cleared cwd_dir_invalid
    mkdir -p "$TMP_P/other"
    ln -s "$TMP_P/other" "$TMP_P/cw/dev-flow-codex-cwd-Lnk001"
    run bash "$BIN" "$D" "$HEAD_SHA" "$NONCE" "$TMP_P/cw/dev-flow-codex-cwd-Lnk001" "$O" "$PSHA" "$SSHA" "$STAT"
    assert_not_cleared cwd_dir_invalid
}

@test "result.json が prepared_at より前の mtime なら clear にしない" {
    write_clear "$R"
    touch -t 200001010000 "$R"
    run_result
    assert_not_cleared result_stale
    run_result --issues
    echo "$output" | jq -e '.ok == false and .error == "result_stale" and .issues == []'
}

@test "prepared_at が無い・数字でないなら clear にしない" {
    write_clear "$R"
    rm "$D/prepared_at"
    run_result
    assert_not_cleared prepared_at_unreadable
    printf 'yesterday\n' >"$D/prepared_at"
    run_result
    assert_not_cleared prepared_at_unreadable
}

@test "result.json が保存先の外を指す symlink なら clear にしない" {
    write_clear "$TMP_P/outside.json"
    ln -s "$TMP_P/outside.json" "$R"
    run_result
    assert_not_cleared result_unreadable
}

@test "result.json が通常ファイルでない（ディレクトリ・FIFO）なら clear にしない" {
    mkdir "$R"
    run_result
    assert_not_cleared result_unreadable
    rmdir "$R"
    mkfifo "$R"
    run_result
    assert_not_cleared result_unreadable
}

@test "保存先が symlink なら clear にしない" {
    write_clear "$R"
    ln -s "$D" "$TMP_P/rv/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/rv/dev-flow-security-review-Lnk001" "$HEAD_SHA" "$NONCE" "$C" "$O" "$PSHA" "$SSHA" "$STAT"
    assert_not_cleared review_dir_invalid
}
