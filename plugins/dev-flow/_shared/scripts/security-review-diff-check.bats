#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-diff-check（_shared/scripts/security-review-diff-check.sh → _lib/scripts/security-review-diff-check.mjs。issue #1095）
#
# security-review-scope --save-diff は保存先に書いた pr.diff の sha256 を diff_sha256 で返し、security-review-diff-check は保存先の
# pr.diff をその値と照合する（pr-iterate は clear になりそうな round で review の後に照合し、matched:true でなければ clear にしない）。
# 照合を workflow から呼ぶ配線は _lib/priterate-security-review.test.mjs の (G) が確かめる。
# 保存先の祖先ごと差し替えて戻す経路（issue #1105）は照合では見分けられないので、reviewer の Read を read-scope hook に通す
# review_read で、読む時点の dev・ino の確認が良性の diff を読ませないことを確かめる（hook の単体の判定は hooks/*.test.sh）。

DEVFLOW="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BIN="$DEVFLOW/bin/security-review-diff-check"
SCOPE="$DEVFLOW/bin/security-review-scope"

HOOK="$DEVFLOW/hooks/pretool-security-reviewer-read-scope.sh"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

file_id() {
    stat -c '%d-%i' -- "$1" 2>/dev/null || stat -f '%d-%i' -- "$1"
}

# security-reviewer の Read 相当: read-scope hook（PreToolUse）が許可したときだけ $1 を読んで出す。拒否されたら denied を出す
review_read() {
    local input decision
    mkdir -p "$BATS_TEST_TMPDIR/cwd"
    input="$(jq -cn --arg p "$1" --arg cwd "$BATS_TEST_TMPDIR/cwd" \
        '{session_id:"s", hook_event_name:"PreToolUse", cwd:$cwd, agent_type:"dev-flow:security-reviewer", tool_name:"Read", tool_input:{file_path:$p}}')"
    decision="$(printf '%s' "$input" | bash "$HOOK" | jq -r '.hookSpecificOutput.permissionDecision // empty')"
    if [ -n "$decision" ]; then echo denied; else cat -- "$1"; fi
}

setup() {
    # security-review-scope は保存先を os.tmpdir() の配下に作る
    export TMPDIR="$BATS_TEST_TMPDIR/tmp"
    mkdir -p "$TMPDIR"
    REPO="$BATS_TEST_TMPDIR/repo"
    git init -q -b main "$REPO"
    printf 'echo hi\n' >"$REPO/run.sh"
    git -C "$REPO" add run.sh
    git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q -m base
    git -C "$REPO" switch -q -c feature
    printf 'echo "$1" | sh\n' >"$REPO/run.sh"
    git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q -am change
}

# security-review-scope --save-diff の保存先・diff_path・diff_sha256・diff_ino・diff_ctime_ns・dir_ino・dir_ctime_ns を
# D / P / H / I / C / DI / DC に入れる
save_diff() {
    run bash "$SCOPE" "$REPO" main HEAD --save-diff
    [ "$status" -eq 0 ]
    D="$(echo "$output" | jq -r '.review_dir')"
    P="$(echo "$output" | jq -r '.diff_path')"
    H="$(echo "$output" | jq -r '.diff_sha256')"
    I="$(echo "$output" | jq -r '.diff_ino')"
    C="$(echo "$output" | jq -r '.diff_ctime_ns')"
    DI="$(echo "$output" | jq -r '.dir_ino')"
    DC="$(echo "$output" | jq -r '.dir_ctime_ns')"
}

@test "security-review-scope --save-diff は保存先に書いた pr.diff の sha256 を diff_sha256 で返し、照合は matched:true" {
    save_diff
    [[ "$H" =~ ^[0-9a-f]{64}$ ]]
    [ "$H" = "$(sha256_of <"$D/pr.diff")" ]
    [[ "$I" =~ ^[0-9]+$ ]] && [[ "$C" =~ ^[0-9]+$ ]] && [[ "$DI" =~ ^[0-9]+$ ]] && [[ "$DC" =~ ^[0-9]+$ ]]
    # diff_path は pr.diff への hard link で、名前に pr.diff の dev・ino が入る
    [ "$P" = "$D/pr-$(file_id "$D/pr.diff").diff" ]
    [ "$P" -ef "$D/pr.diff" ]
    [[ "$(basename "$P")" =~ ^pr-[0-9]+-${I}\.diff$ ]]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: true, matched: true}'
}

@test "保存先の祖先を退避して同じパスに良性の保存先を置いた間の review の読み取りは hook が拒否する（元へ戻すと照合は一致するので、clear にしないのは読む時点の確認）" {
    export TMPDIR="$BATS_TEST_TMPDIR/tmp/anc"
    mkdir -p "$TMPDIR"
    save_diff
    [ "$(review_read "$P")" = "$(cat "$D/pr.diff")" ]
    # 祖先（os.tmpdir()）を退避し、同じパスに良性の pr.diff と同じ名前の diff を持つ保存先を置く
    mv "$TMPDIR" "$BATS_TEST_TMPDIR/away"
    mkdir -p "$D"
    printf 'diff --git a/README.md b/README.md\n+benign\n' >"$D/pr.diff"
    cp "$D/pr.diff" "$P"
    # review 相当の読み取り: hook が拒否し、良性の diff は reviewer に届かない（reviewer は diff-unreadable の critical を返す）
    [ "$(review_read "$P")" = denied ]
    [ "$(review_read "$D/pr.diff")" = denied ]
    # 元へ戻す
    rm -rf "$TMPDIR"
    mv "$BATS_TEST_TMPDIR/away" "$TMPDIR"
    # pr.diff・保存先自身は動いていないので review の後の照合は一致する（照合だけでは見分けられない）
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '. == {ok: true, matched: true}'
    # 戻した後は scope の書いた diff を読める
    [ "$(review_read "$P")" = "$(cat "$D/pr.diff")" ]
}

@test "review の間に保存先の祖先で無関係なファイルが作られ・消えるだけなら、読み取りは許可され照合も一致する（clear にできる）" {
    save_diff
    run node -e 'console.log(String(require("fs").lstatSync(process.argv[1], { bigint: true }).ctimeNs))' "$TMPDIR"
    ANC_CTIME="$output"
    printf 'x\n' >"$TMPDIR/unrelated.tmp"
    mkdir "$TMPDIR/unrelated-dir"
    [ "$(review_read "$P")" = "$(cat "$D/pr.diff")" ]
    rm "$TMPDIR/unrelated.tmp"
    rmdir "$TMPDIR/unrelated-dir"
    # 祖先の ctime は無関係なファイルの出入りでも変わる（照合値にすると clear にできない）
    run node -e 'console.log(String(require("fs").lstatSync(process.argv[1], { bigint: true }).ctimeNs))' "$TMPDIR"
    [ "$output" != "$ANC_CTIME" ]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: true, matched: true}'
}

@test "--save-diff を付けない判定は diff_sha256 を返さない（null）" {
    run bash "$SCOPE" "$REPO" main HEAD
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .review_dir == null and .diff_sha256 == null and .diff_ino == null and .diff_ctime_ns == null and .dir_ino == null and .dir_ctime_ns == null'
}

@test "review の間に pr.diff を差し替えられたら matched:false" {
    save_diff
    printf 'diff --git a/README.md b/README.md\n+benign\n' >"$D/pr.diff"
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == false'
    # 空にした diff も一致しない
    : >"$D/pr.diff"
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == true and .matched == false'
}

@test "差し替えて元の bytes に書き戻した pr.diff（sha256 は一致）も matched:false" {
    save_diff
    cp "$D/pr.diff" "$BATS_TEST_TMPDIR/orig.diff"
    printf 'diff --git a/README.md b/README.md\n+benign\n' >"$D/pr.diff"
    sleep 0.01
    cat "$BATS_TEST_TMPDIR/orig.diff" >"$D/pr.diff"
    [ "$H" = "$(sha256_of <"$D/pr.diff")" ]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == false'
    # 同じ bytes の別のファイルを rename で置いても（ino が変わる）一致しない
    cp "$BATS_TEST_TMPDIR/orig.diff" "$D/pr.diff.new"
    mv "$D/pr.diff.new" "$D/pr.diff"
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == true and .matched == false'
}

@test "保存先ディレクトリごと退避して良性の pr.diff を持つ同名ディレクトリを置き、後で元へ戻したもの（pr.diff は無傷）も matched:false" {
    save_diff
    mv "$D" "$BATS_TEST_TMPDIR/away"
    mkdir "$D"
    printf 'diff --git a/README.md b/README.md\n+benign\n' >"$D/pr.diff"
    mv "$D" "$BATS_TEST_TMPDIR/benign"
    mv "$BATS_TEST_TMPDIR/away" "$D"
    # pr.diff の sha256・ino・ctime は scope の値のまま
    [ "$H" = "$(sha256_of <"$D/pr.diff")" ]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == false'
    # 保存先ディレクトリの照合値だけを今の値にすると一致する（不一致は保存先ディレクトリの ctime から来る）
    run node -e 'const s = require("fs").lstatSync(process.argv[1], { bigint: true }); console.log(`${s.ino} ${s.ctimeNs}`)' "$D"
    read -r NDI NDC <<<"$output"
    [ "$NDI" = "$DI" ]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$NDI" "$NDC"
    echo "$output" | jq -e '. == {ok: true, matched: true}'
}

@test "pr.diff が無い・symlink（同じ中身の外のファイルを指す）・通常ファイルでないなら ok:false で照合しない" {
    save_diff
    cp "$D/pr.diff" "$BATS_TEST_TMPDIR/outside.diff"
    rm "$D/pr.diff"
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: false, matched: false, error: "diff_unavailable"}'
    ln -s "$BATS_TEST_TMPDIR/outside.diff" "$D/pr.diff"
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "diff_unavailable"'
    rm "$D/pr.diff"
    mkdir "$D/pr.diff"
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == false and .error == "diff_unavailable"'
}

@test "保存先が mkdtemp の形でない・symlink・. / .. を含む・実在しないなら ok:false" {
    save_diff
    mkdir -p "$TMPDIR/not-a-review-dir"
    cp "$D/pr.diff" "$TMPDIR/not-a-review-dir/pr.diff"
    run bash "$BIN" "$TMPDIR/not-a-review-dir" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "review_dir_invalid"'
    ln -s "$D" "$TMPDIR/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMPDIR/dev-flow-security-review-Lnk001" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
    run bash "$BIN" "$TMPDIR/x/../$(basename "$D")" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
    run bash "$BIN" "$TMPDIR/dev-flow-security-review-None01" "$H" "$I" "$C" "$DI" "$DC"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
}

@test "引数不正（sha256・ino・ctime が無い・64 桁の小文字 hex や数字でない・余分な引数）は exit 2" {
    save_diff
    run bash "$BIN" "$D"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$H"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$H" "$I" "$C"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" -1
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$H" "$I" -1 "$DI" "$DC"
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "usage"'
    run bash "$BIN" "$D" "${H:0:63}" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "${H^^}" "$I" "$C" "$DI" "$DC"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$H" "$I" "$C" "$DI" "$DC" extra
    [ "$status" -eq 2 ]
}
