#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-codex-prep（_shared/scripts/security-review-codex-prep.sh → _lib/scripts/security-review-codex-prep.mjs。issue #1087）
#
# Codex 経路の security review の入力を、security-review-scope --save-diff が作った保存先（dev-flow-security-review-XXXXXX）に
# 用意する: prompt.md（prompt + diff）・schema.json（strict 形）と、codex の -C に渡す新しい空の mkdtemp。
# 起動形そのもの（codexSecurityReviewCommand）と hook の一致は _lib/security-review.test.mjs が確かめる。

BIN="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/bin/security-review-codex-prep"
HEAD_SHA="$(printf 'a%.0s' {1..40})"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

setup() {
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$TMPDIR"
    TMP_P="$(cd "$TMPDIR" && pwd -P)"
    D="$TMP_P/dev-flow-security-review-Ab12Cd"
    mkdir -p "$D"
    printf 'diff --git a/run.sh b/run.sh\n+echo "$1" | sh\n' >"$D/pr.diff"
    O="fedcba9876543210fedcba9876543210"
}

# prep は保存先と出力の置き場を mode 0300（一覧を取れない）にするので、bats が消せるよう戻す
teardown() {
    chmod -R u+rwx "$BATS_TEST_TMPDIR" 2>/dev/null || true
}

# 第 1 引数のディレクトリに result.json（第 2 引数の issues）を書く
write_result() {
    jq -n --argjson issues "$2" --arg sha "$HEAD_SHA" '{nonce: "0123456789abcdef0123456789abcdef", reviewed_sha: $sha, issues: $issues, summary: "s"}' >"$1/result.json"
}

@test "保存先に prompt.md（diff を末尾に置く）と strict 形の schema.json を書き、新しい空の mkdtemp を返す" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg d "$D" '.ok == true and .review_dir == $d and has("error") == false'
    cwd="$(echo "$output" | jq -r '.cwd_dir')"
    [[ "$cwd" == "$TMPDIR"/dev-flow-codex-cwd-* ]]
    [[ "$(basename "$cwd")" =~ ^dev-flow-codex-cwd-[A-Za-z0-9]{6}$ ]]
    [ -d "$cwd" ]
    # -C は空の .git（通常ファイル）だけを持つ（codex の project root を -C に止め、祖先の .git・AGENTS.md を読ませない）
    [ "$(ls -A "$cwd")" = .git ]
    [ -f "$cwd/.git" ] && [ ! -L "$cwd/.git" ] && [ ! -s "$cwd/.git" ]
    # nonce: round ごとの 32 桁 hex。sandbox の中から読める保存先・作業ディレクトリのどのファイルにも書かない
    nonce="$(echo "$output" | jq -r '.nonce')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]]
    # out_name: codex の -o の置き場（保存先の中の乱数名のディレクトリ）。nonce と別の値で、ファイルには書かない
    out="$(echo "$output" | jq -r '.out_name')"
    [[ "$out" =~ ^[0-9a-f]{32}$ ]] && [ "$out" != "$nonce" ]
    for f in pr.diff prompt.md schema.json prepared_at; do
        ! grep -qF -e "$nonce" -e "$out" "$D/$f"
    done
    # 保存先・out・置き場は mode 0300（一覧を取れない — 置き場の名前・result.json を見つけさせない）。置き場は空
    [ "$(stat -c %a "$D" 2>/dev/null || stat -f %Lp "$D")" = 300 ]
    [ "$(stat -c %a "$D/out" 2>/dev/null || stat -f %Lp "$D/out")" = 300 ]
    [ "$(stat -c %a "$D/out/$out" 2>/dev/null || stat -f %Lp "$D/out/$out")" = 300 ]
    [ -d "$D/out/$out" ] && [ ! -L "$D/out/$out" ]
    ! ls "$D" >/dev/null 2>&1
    # 保存先の一覧を読めても（chmod の前に開かれた fd の readdir）、置き場の名前は出ず、out は一覧を取れない
    chmod 700 "$D"
    [ "$(ls -A "$D" | sort | tr '\n' ' ')" = "out pr.diff prepared_at prompt.md schema.json " ]
    ! ls "$D/out" >/dev/null 2>&1
    chmod 300 "$D"
    chmod 700 "$D/out/$out"
    [ -z "$(ls -A "$D/out/$out")" ]
    chmod 300 "$D/out/$out"
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
    # 読んだ pr.diff・書いた prompt.md・schema.json の sha256（workflow が scope の値と照合し、result が codex の後に照合する）
    echo "$output" | jq -e --arg d "$(sha256_of "$D/pr.diff")" --arg p "$(sha256_of "$D/prompt.md")" --arg s "$(sha256_of "$D/schema.json")" \
        '.diff_sha256 == $d and .prompt_sha256 == $p and .schema_sha256 == $s'
    # 書く前の pr.diff と書いた後の保存先・入力・-C の statDigest（照合の規則は security-review-codex-result.bats）
    echo "$output" | jq -e '(.diff_stat_sha256 | test("^[0-9a-f]{64}$")) and (.stat_sha256 | test("^[0-9a-f]{64}$"))'
}

@test "prep の返した値で、codex が置き場に書いた result.json を security-review-codex-result が clear と判定する" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == true'
    prep="$output"
    v() { echo "$prep" | jq -r ".$1"; }
    out="$(v out_name)"
    chmod 700 "$D/out/$out"
    jq -n --arg sha "$HEAD_SHA" --arg n "$(v nonce)" '{nonce: $n, reviewed_sha: $sha, issues: [], summary: "s"}' >"$D/out/$out/result.json"
    RES_BIN="$(dirname "$BIN")/security-review-codex-result"
    run bash "$RES_BIN" "$D" "$HEAD_SHA" "$(v nonce)" "$(v cwd_dir)" "$out" "$(v prompt_sha256)" "$(v schema_sha256)" "$(v stat_sha256)"
    echo "$output" | jq -e '.ok == true and .cleared == true'
    # out の mode を戻して一覧を取った（置き場の名前を読んだ）round は clear にしない
    chmod 700 "$D/out"
    ls "$D/out" >/dev/null
    chmod 300 "$D/out"
    run bash "$RES_BIN" "$D" "$HEAD_SHA" "$(v nonce)" "$(v cwd_dir)" "$out" "$(v prompt_sha256)" "$(v schema_sha256)" "$(v stat_sha256)"
    echo "$output" | jq -e '.ok == false and .error == "input_changed"'
}

@test "--verify-from: 前回の置き場（保存先/out/out_name）の result.json の critical/major だけを verify_items にする" {
    PREV="$TMP_P/dev-flow-security-review-Prev01"
    mkdir -p "$PREV/out/$O"
    write_result "$PREV/out/$O" '[{"severity":"critical","topic":"cmd-injection","file":"run.sh","line":2,"description":"D1","suggestion":"S1"},{"severity":"minor","topic":"hardening","file":"run.sh","line":null,"description":"D2","suggestion":"S2"}]'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV/out/$O"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    verify="$(sed -n 's/^verify_items: //p' "$D/prompt.md")"
    echo "$verify" | jq -e '. == [{topic: "cmd-injection", severity: "critical", file: "run.sh", line: 2, description: "D1"}]'
}

@test "--verify-from の result.json が読めない・schema に適合しない・保存先の形でないなら ok:false で何も書かない" {
    PREV="$TMP_P/dev-flow-security-review-Prev02"
    mkdir -p "$PREV/out/$O"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV/out/$O"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable" and .cwd_dir == null and .out_name == null and .prompt_sha256 == null and .schema_sha256 == null and .stat_sha256 == null'
    jq -n '{reviewed_sha: "x", issues: [], summary: "s", approved: true}' >"$PREV/out/$O/result.json"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV/out/$O"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_unreadable"'
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$TMP_P"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_invalid"'
    # 置き場の名前の無い保存先そのもの・out を挟まない置き場（旧形）
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_invalid"'
    mkdir -p "$PREV/$O"
    run bash "$BIN" "$D" "$HEAD_SHA" 5 --verify-from "$PREV/$O"
    echo "$output" | jq -e '.ok == false and .error == "verify_from_invalid"'
    [ ! -e "$D/prompt.md" ] && [ ! -e "$D/schema.json" ]
}

@test "prompt.md・schema.json・result.json が既にある保存先には書かない（前の結果と取り違えない）" {
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == true'
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .error == "review_dir_not_fresh"'

    D2="$TMP_P/dev-flow-security-review-Res001"
    mkdir -p "$D2"
    printf 'diff\n' >"$D2/pr.diff"
    write_result "$D2" '[]'
    run bash "$BIN" "$D2" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_not_fresh"'
    [ ! -e "$D2/prompt.md" ]
}

@test "保存先が mkdtemp の形でない・symlink・pr.diff が無い・起動形に入れられないパスなら ok:false" {
    mkdir -p "$TMP_P/not-a-review-dir"
    printf 'diff\n' >"$TMP_P/not-a-review-dir/pr.diff"
    run bash "$BIN" "$TMP_P/not-a-review-dir" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'

    ln -s "$D" "$TMP_P/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMP_P/dev-flow-security-review-Lnk001" "$HEAD_SHA" 5
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
    [ ! -e "$D/prompt.md" ]
}

@test "保存先・-C の親（TMPDIR）の祖先に .git / AGENTS.md / AGENTS.override.md / CLAUDE.md があれば作業場所を作らず ok:false" {
    for name in .git AGENTS.md AGENTS.override.md CLAUDE.md; do
        # 保存先の祖先（TMPDIR の外の親）
        P="$BATS_TEST_TMPDIR/rv-$name"
        mkdir -p "$P/sub"
        RP="$(cd "$P" && pwd -P)"
        R="$RP/sub/dev-flow-security-review-Tnt001"
        mkdir -p "$R"
        printf 'diff\n' >"$R/pr.diff"
        if [ "$name" = .git ]; then mkdir "$RP/.git"; else : >"$RP/$name"; fi
        run bash "$BIN" "$R" "$HEAD_SHA" 5
        [ "$status" -eq 0 ]
        echo "$output" | jq -e '.ok == false and .error == "workspace_tainted" and .cwd_dir == null'
        [ ! -e "$R/prompt.md" ] && [ ! -e "$R/schema.json" ] && [ ! -e "$R/prepared_at" ]

        # -C を作る TMPDIR 自身（-C の親）
        if [ "$name" = .git ]; then mkdir "$TMPDIR/.git"; else : >"$TMPDIR/$name"; fi
        run bash "$BIN" "$D" "$HEAD_SHA" 5
        echo "$output" | jq -e '.ok == false and .error == "workspace_tainted"'
        [ -z "$(find "$TMPDIR" -maxdepth 1 -name 'dev-flow-codex-cwd-*')" ]
        [ ! -e "$D/prompt.md" ]
        rm -rf "${TMPDIR:?}/$name"
    done
    # dangling symlink も「ある」とみなす
    ln -s /nonexistent "$TMPDIR/CLAUDE.md"
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == false and .error == "workspace_tainted"'
}

@test "prep 時刻（epoch ms）を保存先の prepared_at に書く" {
    before="$(($(date +%s) * 1000))"
    run bash "$BIN" "$D" "$HEAD_SHA" 5
    echo "$output" | jq -e '.ok == true'
    at="$(cat "$D/prepared_at")"
    [[ "$at" =~ ^[1-9][0-9]*$ ]]
    [ "$at" -ge "$before" ]
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
    [ ! -e "$D/prompt.md" ]
}
