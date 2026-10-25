#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh → _lib/scripts/security-review-codex-prep.mjs。issue #1087 / #1097）
#
# Codex 経路の security review の入力を、security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX）に
# 用意する: prompt.md（prompt + diff）・schema.json（strict 形）と、codex の -C に渡す新しい空の mkdtemp（保存先の直下）。
# stdout の binding は保存先のパスと書いた 2 つの中身の sha256（hook が出力先へ複製した中身と照合する）。
# codex が -o で書く出力先は、realpath が自身と一致する実ディレクトリの絶対パスで、出力先と全祖先のどこにも prep（sandbox の中）から
# ファイルを作れないものだけを受け付ける。
# 起動形そのもの（codexSecurityReviewCommand）と hook の一致は _lib/security-review.test.mjs が確かめる。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-prep"
HEAD_SHA="$(printf 'a%.0s' {1..40})"
PREV_NONCE="$(printf '0123456789abcdef%.0s' 1 2)"
PREV_BINDING="$(printf '0123456789abcdef%.0s' 1 2 3 4)"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

setup() {
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$TMPDIR"
    TMP_P="$(cd "$TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
    printf 'diff --git a/run.sh b/run.sh\n+echo "$1" | sh\n' >"$D/pr.diff"
    # 出力先: 人が用意した、prep からは書けないディレクトリ（sandbox の外の場所の代わりに書き込み権限を外す）
    BATS_P="$(cd "$BATS_TEST_TMPDIR" && pwd -P)"
    O="$BATS_P/codex-out"
    mkdir -p "$O"
    chmod a-w "$O"
    # 出力先の祖先（$BATS_TEST_TMPDIR・/tmp 等）はテスト環境では書けてしまうので、sandbox の書き込み拒否を真似る:
    # FAKE_SANDBOX_WRITABLE の配下でないディレクトリへの prep の writeFileSync は EPERM になる
    export NODE_OPTIONS="--import $(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/security-review-codex-prep.fake-sandbox.mjs"
    export FAKE_SANDBOX_WRITABLE="$TMP_P"
}

teardown() {
    chmod u+w "$O" 2>/dev/null || true
}

# 出力先に前回の round の結果ファイル（第 1 引数の issues）を置く（人の操作の代わりに一時的に書き込み権限を戻す）
write_prev_result() {
    chmod u+w "$O"
    jq -n --argjson issues "$1" --arg sha "$HEAD_SHA" --arg n "$PREV_NONCE" '{nonce: $n, reviewed_sha: $sha, issues: $issues, summary: "s"}' >"$O/dev-flow-codex-result-$PREV_NONCE-$PREV_BINDING.json"
    chmod a-w "$O"
}

@test "保存先に prompt.md（diff を末尾に置く）と strict 形の schema.json を書き、保存先の直下の新しい空の mkdtemp と binding を返す" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg d "$D" '.ok == true and .review_dir == $d and has("error") == false'
    cwd="$(echo "$output" | jq -r '.cwd_dir')"
    [[ "$cwd" == "$D"/dev-flow-codex-cwd-* ]]
    # binding: sha256("<保存先>\n<sha256(prompt.md)>\n<sha256(schema.json)>\n")
    binding="$(echo "$output" | jq -r '.binding')"
    expected="$(printf '%s\n%s\n%s\n' "$D" "$(sha256_of <"$D/prompt.md")" "$(sha256_of <"$D/schema.json")" | sha256_of)"
    [ "$binding" = "$expected" ]
    [[ "$(basename "$cwd")" =~ ^dev-flow-codex-cwd-[A-Za-z0-9]{6}$ ]]
    [ -d "$cwd" ]
    [ -z "$(ls -A "$cwd")" ]
    # nonce: round ごとの 32 桁 hex。sandbox の中から読める保存先・作業ディレクトリのどのファイルにも書かない
    nonce="$(echo "$output" | jq -r '.nonce')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]]
    [ -z "$(grep -rlF "$nonce" "$D" "$cwd")" ]
    # prompt.md: PR 番号・head・脅威モデル、diff は DATA 区間の末尾
    grep -qF '# Security review of PR #5' "$D/prompt.md"
    grep -qxF "head_sha: $HEAD_SHA" "$D/prompt.md"
    grep -qxF 'verify_items: []' "$D/prompt.md"
    grep -qF '利用者自身が設定する環境変数は攻撃者の入力に含めない' "$D/prompt.md"
    [ "$(tail -n 2 "$D/prompt.md")" = "$(cat "$D/pr.diff")" ]
    # schema.json: 全 object が additionalProperties:false・全 property が required・maxLength 無し
    jq -e '[.. | objects | select(.type == "object")] | length == 2 and all(.additionalProperties == false and ((.required | sort) == (.properties | keys)))' "$D/schema.json"
    jq -e '[.. | objects | has("maxLength")] | any | not' "$D/schema.json"
    [ ! -e "$D/result.json" ]
    # 出力先には何も作らない
    [ -z "$(ls -A "$O")" ]
}

@test "出力先が未設定・相対パス・起動形に入れられない・実在しない・symlink・ディレクトリでないなら ok:false で何も作らない" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "output_dir_unset" and .cwd_dir == null and .nonce == null'

    run bash "$BIN" "$D" "$HEAD_SHA" 5 codex-out
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid"'

    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O/../codex-out"
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid"'

    mkdir -p "$BATS_TEST_TMPDIR/a b"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$BATS_TEST_TMPDIR/a b"
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid"'

    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$BATS_TEST_TMPDIR/missing"
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid"'

    # 書けない実ディレクトリを指す symlink も受け付けない（symlink の先を差し替えられる）
    ln -s "$O" "$BATS_TEST_TMPDIR/codex-out-link"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$BATS_TEST_TMPDIR/codex-out-link"
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid"'

    : >"$BATS_TEST_TMPDIR/codex-out-file"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$BATS_TEST_TMPDIR/codex-out-file"
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid"'

    [ ! -e "$D/prompt.md" ] && [ ! -e "$D/schema.json" ] && [ ! -e "$D/prepared_at" ]
    [ -z "$(find "$D" -maxdepth 1 -name 'dev-flow-codex-cwd-*')" ]
}

@test "出力先の祖先に symlink がある（realpath が自身と一致しない）なら ok:false" {
    mkdir -p "$BATS_P/real/codex-out"
    chmod a-w "$BATS_P/real/codex-out"
    ln -s "$BATS_P/real" "$BATS_P/alias"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$BATS_P/alias/codex-out"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "output_dir_invalid" and .cwd_dir == null'
    [ ! -e "$D/prompt.md" ]
    chmod u+w "$BATS_P/real/codex-out"
}

@test "出力先の祖先に prep からファイルを作れる（出力先を symlink に差し替えられる）なら、作ったファイルを消してから ok:false" {
    export FAKE_SANDBOX_WRITABLE="$TMP_P:$BATS_P"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "output_dir_writable" and .cwd_dir == null and .nonce == null'
    [ -z "$(find "$BATS_P" -maxdepth 1 -name '.dev-flow-codex-write-probe-*')" ]
    [ ! -e "$D/prompt.md" ] && [ ! -e "$D/schema.json" ] && [ ! -e "$D/prepared_at" ]
    [ -z "$(find "$D" -maxdepth 1 -name 'dev-flow-codex-cwd-*')" ]
}

@test "出力先に prep からファイルを作れる（sandbox の中から書ける）なら、作ったファイルを消してから ok:false" {
    chmod u+w "$O"
    export FAKE_SANDBOX_WRITABLE="$TMP_P:$O"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "output_dir_writable" and .cwd_dir == null and .nonce == null'
    [ -z "$(ls -A "$O")" ]
    [ ! -e "$D/prompt.md" ] && [ ! -e "$D/schema.json" ] && [ ! -e "$D/prepared_at" ]
    [ -z "$(find "$D" -maxdepth 1 -name 'dev-flow-codex-cwd-*')" ]
}

@test "--verify-from: 出力先の前回の nonce と binding の結果ファイルの critical/major だけを verify_items にする" {
    write_prev_result '[{"severity":"critical","topic":"cmd-injection","file":"run.sh","line":2,"description":"D1","suggestion":"S1"},{"severity":"minor","topic":"hardening","file":"run.sh","line":null,"description":"D2","suggestion":"S2"}]'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --verify-from "$PREV_NONCE" "$PREV_BINDING"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    verify="$(sed -n 's/^verify_items: //p' "$D/prompt.md")"
    echo "$verify" | jq -e '. == [{topic: "cmd-injection", severity: "critical", file: "run.sh", line: 2, description: "D1"}]'
}

@test "--verify-from の結果ファイルが無い・schema や nonce が合わない・nonce や binding の形でないなら ok:false で何も書かない" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --verify-from "$PREV_NONCE" "$PREV_BINDING"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable" and .cwd_dir == null'
    chmod u+w "$O"
    jq -n '{reviewed_sha: "x", issues: [], summary: "s", approved: true}' >"$O/dev-flow-codex-result-$PREV_NONCE-$PREV_BINDING.json"
    chmod a-w "$O"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --verify-from "$PREV_NONCE" "$PREV_BINDING"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable"'
    chmod u+w "$O"
    jq -n --arg sha "$HEAD_SHA" '{nonce: "ffffffffffffffffffffffffffffffff", reviewed_sha: $sha, issues: [], summary: "s"}' >"$O/dev-flow-codex-result-$PREV_NONCE-$PREV_BINDING.json"
    chmod a-w "$O"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --verify-from "$PREV_NONCE" "$PREV_BINDING"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable"'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --verify-from "$D" "$PREV_BINDING"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_invalid"'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --verify-from "$PREV_NONCE" abc
    echo "$output" | jq -e '.ok == false and .error == "verify_from_invalid"'
    [ ! -e "$D/prompt.md" ] && [ ! -e "$D/schema.json" ]
}

@test "prompt.md・schema.json・result.json が既にある保存先には書かない（前の結果と取り違えない）" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == true'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "review_dir_not_fresh"'

    D2="$TMP_P/dev-flow-security-review-Res001"
    mkdir -p "$D2"
    printf 'diff\n' >"$D2/pr.diff"
    printf '{}\n' >"$D2/result.json"
    run bash "$BIN" "$D2" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_not_fresh"'
    [ ! -e "$D2/prompt.md" ]
}

@test "保存先が mkdtemp の形でない・symlink・pr.diff が無い・起動形に入れられないパスなら ok:false" {
    mkdir -p "$TMP_P/not-a-review-dir"
    printf 'diff\n' >"$TMP_P/not-a-review-dir/pr.diff"
    run bash "$BIN" "$TMP_P/not-a-review-dir" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    ln -s "$D" "$TMP_P/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-Lnk001" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    run bash "$BIN" "$TMP_P/x/../dev-flow-security-review-Ab12Cd" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    mkdir -p "$TMP_P/a b/dev-flow-security-review-Spc001"
    printf 'diff\n' >"$TMP_P/a b/dev-flow-security-review-Spc001/pr.diff"
    run bash "$BIN" "$TMP_P/a b/dev-flow-security-review-Spc001" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    mkdir -p "$TMP_P/dev-flow-security-review-NoDf01"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-NoDf01" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "diff_unavailable"'
    [ ! -e "$D/prompt.md" ]
}

@test "保存先（-C の親）とその祖先に .git / AGENTS.md / AGENTS.override.md / CLAUDE.md があれば作業場所を作らず ok:false" {
    for name in .git AGENTS.md AGENTS.override.md CLAUDE.md; do
        # 保存先の祖先（TMPDIR の外の親）
        P="$BATS_TEST_TMPDIR/rv-$name"
        mkdir -p "$P/sub"
        RP="$(cd "$P" && pwd -P)"
        R="$RP/sub/dev-flow-security-review-Tnt001"
        mkdir -p "$R"
        printf 'diff\n' >"$R/pr.diff"
        if [ "$name" = .git ]; then mkdir "$RP/.git"; else : >"$RP/$name"; fi
        run bash "$BIN" "$R" "$HEAD_SHA" 5 "$O"
        [ "$status" -eq 0 ]
        echo "$output" | jq -e '.ok == false and .error == "workspace_tainted" and .cwd_dir == null'
        [ ! -e "$R/prompt.md" ] && [ ! -e "$R/schema.json" ] && [ ! -e "$R/prepared_at" ]

        # -C を作る保存先自身（-C の親）
        if [ "$name" = .git ]; then mkdir "$D/.git"; else : >"$D/$name"; fi
        run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
        echo "$output" | jq -e '.ok == false and .error == "workspace_tainted"'
        [ -z "$(find "$D" -maxdepth 1 -name 'dev-flow-codex-cwd-*')" ]
        [ ! -e "$D/prompt.md" ]
        rm -rf "${D:?}/$name"
    done
    # dangling symlink も「ある」とみなす
    ln -s /nonexistent "$D/CLAUDE.md"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == false and .error == "workspace_tainted"'
}

@test "prep 時刻（epoch ms）を保存先の prepared_at に書く" {
    before="$(($(date +%s) * 1000))"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O"
    echo "$output" | jq -e '.ok == true'
    at="$(cat "$D/prepared_at")"
    [[ "$at" =~ ^[1-9][0-9]*$ ]]
    [ "$at" -ge "$before" ]
}

@test "引数不正は exit 2" {
    run bash "$BIN" "$D" "$HEAD_SHA"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" abc 5 "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 0 "$O"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" --unknown
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$HEAD_SHA" 5 "$O" extra
    [ "$status" -eq 2 ]
    [ ! -e "$D/prompt.md" ]
}
