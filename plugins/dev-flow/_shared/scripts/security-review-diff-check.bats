#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for bin/security-review-diff-check（_shared/scripts/security-review-diff-check.sh → _lib/scripts/security-review-diff-check.mjs。issue #1095）
#
# security-review-scope --save-diff は保存先に書いた pr.diff の sha256 を diff_sha256 で返し、security-review-diff-check は保存先の
# pr.diff をその値と照合する（pr-iterate は clear になりそうな round で review の後に照合し、matched:true でなければ clear にしない）。
# 照合を workflow から呼ぶ配線は _lib/priterate-security-review.test.mjs の (G) が確かめる。

DEVFLOW="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BIN="$DEVFLOW/bin/security-review-diff-check"
SCOPE="$DEVFLOW/bin/security-review-scope"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
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

# security-review-scope --save-diff の保存先と diff_sha256 を D / H に入れる
save_diff() {
    run bash "$SCOPE" "$REPO" main HEAD --save-diff
    [ "$status" -eq 0 ]
    D="$(echo "$output" | jq -r '.review_dir')"
    H="$(echo "$output" | jq -r '.diff_sha256')"
}

@test "security-review-scope --save-diff は保存先に書いた pr.diff の sha256 を diff_sha256 で返し、照合は matched:true" {
    save_diff
    [[ "$H" =~ ^[0-9a-f]{64}$ ]]
    [ "$H" = "$(sha256_of <"$D/pr.diff")" ]
    run bash "$BIN" "$D" "$H"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: true, matched: true}'
}

@test "--save-diff を付けない判定は diff_sha256 を返さない（null）" {
    run bash "$SCOPE" "$REPO" main HEAD
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .review_dir == null and .diff_sha256 == null'
}

@test "review の間に pr.diff を差し替えられたら matched:false" {
    save_diff
    printf 'diff --git a/README.md b/README.md\n+benign\n' >"$D/pr.diff"
    run bash "$BIN" "$D" "$H"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .matched == false'
    # 空にした diff も一致しない
    : >"$D/pr.diff"
    run bash "$BIN" "$D" "$H"
    echo "$output" | jq -e '.ok == true and .matched == false'
}

@test "pr.diff が無い・symlink（同じ中身の外のファイルを指す）・通常ファイルでないなら ok:false で照合しない" {
    save_diff
    cp "$D/pr.diff" "$BATS_TEST_TMPDIR/outside.diff"
    rm "$D/pr.diff"
    run bash "$BIN" "$D" "$H"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '. == {ok: false, matched: false, error: "diff_unavailable"}'
    ln -s "$BATS_TEST_TMPDIR/outside.diff" "$D/pr.diff"
    run bash "$BIN" "$D" "$H"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "diff_unavailable"'
    rm "$D/pr.diff"
    mkdir "$D/pr.diff"
    run bash "$BIN" "$D" "$H"
    echo "$output" | jq -e '.ok == false and .error == "diff_unavailable"'
}

@test "保存先が mkdtemp の形でない・symlink・. / .. を含む・実在しないなら ok:false" {
    save_diff
    mkdir -p "$TMPDIR/not-a-review-dir"
    cp "$D/pr.diff" "$TMPDIR/not-a-review-dir/pr.diff"
    run bash "$BIN" "$TMPDIR/not-a-review-dir" "$H"
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "review_dir_invalid"'
    ln -s "$D" "$TMPDIR/dev-flow-security-review-Lnk001"
    run bash "$BIN" "$TMPDIR/dev-flow-security-review-Lnk001" "$H"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
    run bash "$BIN" "$TMPDIR/x/../$(basename "$D")" "$H"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
    run bash "$BIN" "$TMPDIR/dev-flow-security-review-None01" "$H"
    echo "$output" | jq -e '.ok == false and .error == "review_dir_invalid"'
}

@test "引数不正（sha256 が無い・64 桁の小文字 hex でない・余分な引数）は exit 2" {
    save_diff
    run bash "$BIN" "$D"
    [ "$status" -eq 2 ]
    echo "$output" | jq -e '.ok == false and .matched == false and .error == "usage"'
    run bash "$BIN" "$D" "${H:0:63}"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "${H^^}"
    [ "$status" -eq 2 ]
    run bash "$BIN" "$D" "$H" extra
    [ "$status" -eq 2 ]
}
