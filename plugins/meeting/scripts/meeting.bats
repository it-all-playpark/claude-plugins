#!/usr/bin/env bats
# meeting.sh の macOS 非依存部分（引数処理・未インストール時の案内・録音一覧・launchd plist 生成）のテスト。
# 録音 / ビルド / launchctl は macOS 実機でしか動かないので対象外。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/meeting.sh"
    export HOME="$BATS_TEST_TMPDIR/home"
    export MEETING_HOME="$BATS_TEST_TMPDIR/meetings"
    export MEETING_PREFIX="$BATS_TEST_TMPDIR/prefix"
    mkdir -p "$HOME" "$MEETING_HOME"
    unset MEETING_AUTO_NOTES MEETING_NOTES_DIR MEETING_APPS
}

@test "引数なしは usage を出して exit 2" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [[ "$output" == *"meeting setup"* ]]
    [[ "$output" == *"meeting install"* ]]
    [[ "$output" != *"set -euo"* ]]
}

@test "help は exit 0" {
    run bash "$SCRIPT" help
    [ "$status" -eq 0 ]
    [[ "$output" == *"meeting skip"* ]]
}

@test "bin/meeting wrapper から起動できる" {
    run bash "$BATS_TEST_DIRNAME/../bin/meeting" help
    [ "$status" -eq 0 ]
    [[ "$output" == *"meeting rec"* ]]
}

@test "未インストールで rec / install / transcribe / watch は setup を案内して失敗する" {
    for sub in rec install transcribe watch; do
        run bash "$SCRIPT" "$sub"
        [ "$status" -eq 1 ]
        [[ "$output" == *"meeting setup"* ]]
    done
}

@test "インストール済みのコピー (ソースなし) から setup すると plugin 側での実行を案内する" {
    mkdir -p "$MEETING_PREFIX/bin"
    cp "$SCRIPT" "$MEETING_PREFIX/bin/meeting"
    run bash "$MEETING_PREFIX/bin/meeting" setup
    [ "$status" -eq 1 ]
    [[ "$output" == *"plugin 側"* ]]
}

@test "ls は文字起こし済みの録音に ✓ を付ける" {
    mkdir -p "$MEETING_HOME/2026-01-01_1000-a" "$MEETING_HOME/2026-01-02_1000-b"
    echo '{}' > "$MEETING_HOME/2026-01-02_1000-b/transcript.json"
    run bash "$SCRIPT" ls
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "  2026-01-01_1000-a" ]
    [ "${lines[1]}" = "✓ 2026-01-02_1000-b" ]
}

@test "notes は transcript.json が無ければ失敗する" {
    mkdir -p "$MEETING_HOME/2026-01-01_1000-a"
    run bash "$SCRIPT" notes "$MEETING_HOME/2026-01-01_1000-a"
    [ "$status" -eq 1 ]
    [[ "$output" == *"transcript.json"* ]]
}

@test "print-plist は固定パスのバイナリを --watch で起動し、設定を環境変数で引き継ぐ" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR=/tmp/vault run bash "$SCRIPT" print-plist
    [ "$status" -eq 0 ]
    echo "$output" > "$BATS_TEST_TMPDIR/p.plist"
    run python3 - "$BATS_TEST_TMPDIR/p.plist" "$MEETING_PREFIX" "$MEETING_HOME" <<'PY'
import plistlib, sys
p = plistlib.load(open(sys.argv[1], "rb"))
prefix, home = sys.argv[2], sys.argv[3]
assert p["Label"] == "jp.co.playpark.meeting-watch", p["Label"]
assert p["ProgramArguments"] == [f"{prefix}/bin/meeting-rec", "--watch", "--home", home, "--on-stop", f"{prefix}/bin/meeting"], p["ProgramArguments"]
env = p["EnvironmentVariables"]
assert env["MEETING_AUTO_NOTES"] == "1" and env["MEETING_NOTES_DIR"] == "/tmp/vault" and env["MEETING_HOME"] == home, env
assert "PATH" in env and p["KeepAlive"] and p["RunAtLoad"]
PY
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "post の自動議事録は git の確認だけ許可し Web を閉じた claude -p にプロンプトを渡す" {
    # 文字起こし (第三者の発言) を読む非対話の claude なので、許可ツールとプロンプトの位置を固定する
    mkdir -p "$MEETING_PREFIX/bin" "$MEETING_PREFIX/transcribe" "$BATS_TEST_TMPDIR/stub" "$BATS_TEST_TMPDIR/notes"
    : > "$MEETING_PREFIX/bin/meeting-rec"
    chmod +x "$MEETING_PREFIX/bin/meeting-rec"
    : > "$MEETING_PREFIX/transcribe/transcribe.py"
    printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stub/uv"
    printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stub/osascript"
    printf '#!/bin/sh\npwd -P > "%s/claude.cwd"\nfor a in "$@"; do printf "%%s\\n" "$a"; done > "%s/claude.args"\n' \
        "$BATS_TEST_TMPDIR" "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stub/claude"
    chmod +x "$BATS_TEST_TMPDIR/stub/"*
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/claude.cwd")" = "$(cd "$BATS_TEST_TMPDIR/notes" && pwd -P)" ]
    mapfile -t args < "$BATS_TEST_TMPDIR/claude.args"
    [ "${args[0]}" = "-p" ]
    [ "${args[1]}" = "/meeting-notes $dir --non-interactive" ]
    grep -qxF -- '--allowedTools' "$BATS_TEST_TMPDIR/claude.args"
    grep -qxF -- 'Bash(git check-ignore:*),Bash(git rev-parse:*)' "$BATS_TEST_TMPDIR/claude.args"
    grep -qxF -- '--disallowedTools' "$BATS_TEST_TMPDIR/claude.args"
    grep -qxF -- 'WebFetch,WebSearch' "$BATS_TEST_TMPDIR/claude.args"
}
