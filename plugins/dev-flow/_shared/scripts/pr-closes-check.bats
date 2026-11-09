#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/pr-closes-check.sh (issue #1311)
#
# Strategy: PATH 先頭の gh スタブ (受けた argv を GH_STUB_LOG に 1 行ずつ記録し、GH_STUB_RESPONSE の fixture JSON を
# 返す。GH_STUB_EXIT を設定するとその exit code で落ちる) で `gh pr view --json body` の応答を差し替え、stdout が
# true / false の 1 語だけで、取得失敗・引数不正は stdout を空のまま非 0 exit になることを確かめる。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pr-closes-check.sh"
    PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    CORE_BIN_DIR="$PLUGIN_ROOT/../playpark-core/bin"

    STUB_BIN="$(mktemp -d)"
    export GH_STUB_LOG="$STUB_BIN/gh-argv.log"
    export GH_STUB_RESPONSE="$STUB_BIN/gh-response.json"
    cat > "$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
if [[ -n "${GH_STUB_EXIT:-}" ]]; then
    echo "HTTP 404: Could not resolve to a PullRequest" >&2
    exit "$GH_STUB_EXIT"
fi
cat "$GH_STUB_RESPONSE"
EOF
    chmod +x "$STUB_BIN/gh"
    ORIG_PATH="$PATH"
    PATH="$STUB_BIN:$CORE_BIN_DIR:$PATH"
}

teardown() {
    rm -rf "$STUB_BIN"
    PATH="$ORIG_PATH"
    unset GH_STUB_EXIT
}

write_body() {
    jq -nc --arg body "$1" '{body: $body}' > "$GH_STUB_RESPONSE"
}

gh_call_count() {
    if [[ -f "$GH_STUB_LOG" ]]; then wc -l < "$GH_STUB_LOG" | tr -d ' '; else echo 0; fi
}

@test "本文に Closes #824 -> stdout は true だけ (本文を出さない)、gh は pr view 5 --repo o/r --json body で 1 回" {
    write_body "$(printf 'Secret summary line\n\nCloses #824\n')"
    run --separate-stderr bash "$SCRIPT" --pr 5 --repo o/r --issue 824
    [ "$status" -eq 0 ]
    [ "$output" = "true" ]
    [ "$(gh_call_count)" = "1" ]
    [ "$(cat "$GH_STUB_LOG")" = "pr view 5 --repo o/r --json body" ]
}

@test "本文が Closes #8240 だけ -> stdout は false" {
    write_body "Closes #8240"
    run --separate-stderr bash "$SCRIPT" --pr 5 --repo o/r --issue 824
    [ "$status" -eq 0 ]
    [ "$output" = "false" ]
}

@test "--repo 省略 -> gh の argv に --repo を付けない" {
    write_body "Closes #824"
    run --separate-stderr bash "$SCRIPT" --pr 5 --issue 824
    [ "$status" -eq 0 ]
    [ "$output" = "true" ]
    [ "$(cat "$GH_STUB_LOG")" = "pr view 5 --json body" ]
}

@test "gh が失敗 -> stdout は空で非 0 exit (false と同一視しない)" {
    export GH_STUB_EXIT=1
    run --separate-stderr bash "$SCRIPT" --pr 5 --repo o/r --issue 824
    [ "$status" -ne 0 ]
    [ -z "$output" ]
    [[ "$stderr" == *"HTTP 404"* ]]
}

@test "gh の応答に文字列の body が無い -> stdout は空で非 0 exit" {
    printf '{"body":null}\n' > "$GH_STUB_RESPONSE"
    run --separate-stderr bash "$SCRIPT" --pr 5 --repo o/r --issue 824
    [ "$status" -ne 0 ]
    [ -z "$output" ]

    printf 'not json\n' > "$GH_STUB_RESPONSE"
    run --separate-stderr bash "$SCRIPT" --pr 5 --repo o/r --issue 824
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "引数の形が不正 -> gh を呼ばずに stdout 空で非 0 exit" {
    write_body "Closes #824"
    for args in \
        "--pr abc --repo o/r --issue 824" \
        "--pr 0 --repo o/r --issue 824" \
        "--pr 5 --repo o/r --issue x9" \
        "--pr 5 --repo o --issue 824" \
        "--pr 5 --repo o/r/x --issue 824" \
        "--repo o/r --issue 824" \
        "--pr 5 --repo o/r" \
        "--pr 5 --repo o/r --issue 824 --jq .body"; do
        # shellcheck disable=SC2086
        run --separate-stderr bash "$SCRIPT" $args
        [ "$status" -ne 0 ]
        [ -z "$output" ]
    done
    run --separate-stderr bash "$SCRIPT" --pr '5; id' --repo o/r --issue 824
    [ "$status" -ne 0 ]
    [ -z "$output" ]
    [ "$(gh_call_count)" = "0" ]
}

@test "bin/pr-closes-check launcher 経由でも同じ結果を返す" {
    write_body "Closes #824"
    run --separate-stderr "$PLUGIN_ROOT/bin/pr-closes-check" --pr 5 --repo o/r --issue 824
    [ "$status" -eq 0 ]
    [ "$output" = "true" ]
}
