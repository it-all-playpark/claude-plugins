#!/usr/bin/env bats
bats_require_minimum_version 1.5.0
# meeting.sh の macOS 非依存部分（引数処理・未インストール時の案内・録音一覧・設定ファイルの読み書き・launchd plist 生成・
# install の常駐登録の手順・setup のビルド元の固定とインストール済みの plugin への引き継ぎ・doctor の各項目・
# 話者の声の切り出し・議事録の話者名の後入れ）のテスト。
# 録音 / 実際のビルド / 実際の launchd 登録 / 実際の再生 / 実際の Keychain は macOS 実機でしか動かないので対象外
# (launchctl / swift / ffmpeg / afplay / security は stub)。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/meeting.sh"
    export HOME="$BATS_TEST_TMPDIR/home"
    export MEETING_PREFIX="$BATS_TEST_TMPDIR/prefix"
    # 録音の保存先。meeting.sh には設定ファイルの home で渡す
    MEETING_HOME="$BATS_TEST_TMPDIR/meetings"
    CONFIG_FILE="$HOME/.config/meeting/config.json"
    mkdir -p "$HOME" "$MEETING_HOME"
    unset MEETING_CONFIG XDG_CONFIG_HOME HF_TOKEN HF_HOME HF_TOKEN_PATH
    write_config
}

# 設定ファイルを {"home": $MEETING_HOME, $1} で書く ($1 は JSON のメンバーの並び)
write_config() {
    mkdir -p "$(dirname "$CONFIG_FILE")"
    printf '{"home": "%s"%s}\n' "$MEETING_HOME" "${1:+, $1}" > "$CONFIG_FILE"
}

# 設定ファイルのキー $1 の値を JSON で出す (無ければ null)
config_value() {
    python3 - "$CONFIG_FILE" "$1" <<'PY'
import json, sys
print(json.dumps(json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2]), ensure_ascii=False))
PY
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

# plugin root のコピーを $1 に作る (setup が読む scripts / recorder / transcribe だけ)
plugin_copy() {
    local root="$1" plugin="$BATS_TEST_DIRNAME/.."
    mkdir -p "$root/scripts" "$root/recorder" "$root/transcribe"
    cp "$SCRIPT" "$root/scripts/meeting.sh"
    cp -R "$plugin/recorder/Sources" "$plugin/recorder/Package.swift" "$plugin/recorder/Info.plist" "$root/recorder/"
    cp "$plugin/transcribe/align.py" "$plugin/transcribe/transcribe.py" "$root/transcribe/"
}

# setup が呼ぶ uname / swift / ffmpeg / uv / launchctl を stub に差し替える。swift は --package-path を
# swift.pkg に 1 行ずつ記録し、実機と同じく「ビルド元のパス + ソースの中身」から決まるバイナリを作る
stub_build() {
    mkdir -p "$BATS_TEST_TMPDIR/stub"
    printf '#!/bin/sh\necho Darwin\n' > "$BATS_TEST_TMPDIR/stub/uname"
    printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stub/ffmpeg"
    printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stub/uv"
    printf '#!/bin/sh\nexit 113\n' > "$BATS_TEST_TMPDIR/stub/launchctl"
    cat > "$BATS_TEST_TMPDIR/stub/swift" <<EOF
#!/bin/sh
while [ \$# -gt 0 ]; do
  case "\$1" in
    --package-path) pkg="\$2"; shift ;;
    --scratch-path) scratch="\$2"; shift ;;
  esac
  shift
done
echo "\$pkg" >> "$BATS_TEST_TMPDIR/swift.pkg"
mkdir -p "\$scratch/release"
{ echo "\$pkg"; find "\$pkg/Sources" -type f | LC_ALL=C sort | while read -r f; do cat "\$f"; done; } > "\$scratch/release/meeting-rec"
EOF
    chmod +x "$BATS_TEST_TMPDIR/stub/"*
}

# CLAUDE_CONFIG_DIR を $BATS_TEST_TMPDIR/claude に向け、$1 (plugins の JSON) を installed_plugins.json に置く
installed_plugins() {
    export CLAUDE_CONFIG_DIR="$BATS_TEST_TMPDIR/claude"
    mkdir -p "$CLAUDE_CONFIG_DIR/plugins"
    printf '{"version": 2, "plugins": %s}\n' "$1" > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
}

# ソースの無いインストール済みのコピー ($MEETING_PREFIX/bin/meeting) を置く
installed_copy() {
    mkdir -p "$MEETING_PREFIX/bin"
    cp "$SCRIPT" "$MEETING_PREFIX/bin/meeting"
}

@test "インストール済みのコピー (ソースなし) から setup すると installed_plugins.json の plugin の setup に引き継ぐ" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    installed_copy
    plugin_copy "$BATS_TEST_TMPDIR/user"
    plugin_copy "$BATS_TEST_TMPDIR/project"
    # 引き継ぎ先の meeting.sh で動いたことを、インストールされたコピーの中身で確かめる
    echo "# user-plugin" >> "$BATS_TEST_TMPDIR/user/scripts/meeting.sh"
    # scope 違いで複数あれば、後から更新した project より user を選ぶ
    installed_plugins "{
      \"meeting@x\": [
        {\"scope\": \"user\", \"installPath\": \"$BATS_TEST_TMPDIR/user\", \"lastUpdated\": \"2026-01-01T00:00:00.000Z\"},
        {\"scope\": \"project\", \"installPath\": \"$BATS_TEST_TMPDIR/project\", \"lastUpdated\": \"2026-02-01T00:00:00.000Z\"}
      ]}"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$MEETING_PREFIX/bin/meeting" setup --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"インストール済みの plugin から setup します: $BATS_TEST_TMPDIR/user"* ]]
    [[ "$output" == *"✓ インストール先: $MEETING_PREFIX"* ]]
    [ "$(cat "$BATS_TEST_TMPDIR/swift.pkg")" = "$MEETING_PREFIX/src/recorder" ]
    cmp "$BATS_TEST_TMPDIR/user/scripts/meeting.sh" "$MEETING_PREFIX/bin/meeting"
}

@test "インストール済みのコピーから setup して plugin が見つからなければ引き継がずに Claude Code での実行を案内して失敗する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    installed_copy
    plugin_copy "$BATS_TEST_TMPDIR/other"
    mkdir -p "$BATS_TEST_TMPDIR/nosrc/scripts"
    cp "$SCRIPT" "$BATS_TEST_TMPDIR/nosrc/scripts/meeting.sh"

    # installed_plugins.json が無い / meeting@ のエントリが無い / installPath にソースが無い
    export CLAUDE_CONFIG_DIR="$BATS_TEST_TMPDIR/claude"
    for plugins in "" \
        "{\"other@x\": [{\"scope\": \"user\", \"installPath\": \"$BATS_TEST_TMPDIR/other\"}]}" \
        "{\"meeting@x\": [{\"scope\": \"user\", \"installPath\": \"$BATS_TEST_TMPDIR/nosrc\"}]}"; do
        [ -z "$plugins" ] || installed_plugins "$plugins"
        PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$MEETING_PREFIX/bin/meeting" setup --no-daemon < /dev/null
        echo "$output"
        [ "$status" -eq 1 ]
        [[ "$output" == *"meeting plugin が見つかりません ($CLAUDE_CONFIG_DIR/plugins/installed_plugins.json)"* ]]
        [[ "$output" == *"Claude Code から meeting setup を実行してください"* ]]
        [[ "$output" != *"から setup します"* ]]
        [ ! -e "$BATS_TEST_TMPDIR/swift.pkg" ]
    done
}

@test "setup は plugin root の場所によらず固定の \$MEETING_PREFIX/src/recorder からビルドし、ソースが同じなら meeting-rec を入れ替えない" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    plugin_copy "$BATS_TEST_TMPDIR/b"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ meeting-rec を更新しました"* ]]
    before="$(cksum < "$MEETING_PREFIX/bin/meeting-rec")"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/b/scripts/meeting.sh" setup --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"= meeting-rec は変更なし (権限はそのまま)"* ]]
    [ "$(cksum < "$MEETING_PREFIX/bin/meeting-rec")" = "$before" ]
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/swift.pkg")" = "$MEETING_PREFIX/src/recorder $MEETING_PREFIX/src/recorder" ]
}

@test "setup は recorder のソースが変わったら meeting-rec を更新する" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    plugin_copy "$BATS_TEST_TMPDIR/b"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    [ "$status" -eq 0 ]
    before="$(cksum < "$MEETING_PREFIX/bin/meeting-rec")"

    echo "// changed" >> "$BATS_TEST_TMPDIR/b/recorder/Sources/meeting-rec/main.swift"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/b/scripts/meeting.sh" setup --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ meeting-rec を更新しました"* ]]
    [ "$(cksum < "$MEETING_PREFIX/bin/meeting-rec")" != "$before" ]
}

@test "setup は plugin 側で消した recorder のソースファイルを固定の場所にも残さない" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    extra="$BATS_TEST_TMPDIR/a/recorder/Sources/meeting-rec/Extra.swift"
    echo "// extra" > "$extra"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    [ "$status" -eq 0 ]
    [ -f "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/Extra.swift" ]

    rm "$extra"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [ ! -e "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/Extra.swift" ]
    [ -f "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/main.swift" ]
}

# security を stub に差し替える。$BATS_TEST_TMPDIR/keychain があれば find-generic-password が成功し、
# add-generic-password はそれを作る。keychain_denied_for_launchd があれば、launchctl の stub から
# (MEETING_TEST_LAUNCHD=1 で) 動いたときだけ読めない
stub_security() {
    mkdir -p "$BATS_TEST_TMPDIR/stub"
    cat > "$BATS_TEST_TMPDIR/stub/security" <<EOF
#!/bin/sh
case "\$1" in
  find-generic-password)
    [ -e "$BATS_TEST_TMPDIR/keychain" ] || exit 44
    if [ -n "\$MEETING_TEST_LAUNCHD" ] && [ -e "$BATS_TEST_TMPDIR/keychain_denied_for_launchd" ]; then exit 51; fi
    echo secret ;;
  add-generic-password) touch "$BATS_TEST_TMPDIR/keychain" ;;
esac
EOF
    chmod +x "$BATS_TEST_TMPDIR/stub/security"
}

@test "端末なしの setup --notes-dir X --asr-backend groq --no-daemon は設定ファイルに書き、繰り返しても値が壊れない" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    stub_security
    touch "$BATS_TEST_TMPDIR/keychain"
    plugin_copy "$BATS_TEST_TMPDIR/a"
    rm "$CONFIG_FILE"
    vault="$BATS_TEST_TMPDIR/vault"
    for i in 1 2; do
        PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup \
            --notes-dir "$vault" --asr-backend groq --no-daemon < /dev/null
        echo "$output"
        [ "$status" -eq 0 ]
        [[ "$output" == *"✓ 設定: $CONFIG_FILE"* ]]
        [[ "$output" == *"常駐は登録しません"* ]]
        [ "$(config_value notes_dir)" = "\"$vault\"" ]
        [ "$(config_value asr_backend)" = '"groq"' ]
    done
    cp "$CONFIG_FILE" "$BATS_TEST_TMPDIR/before.json"

    # 引数なしでは書き換えない。別のキーを足しても既存の値は残る
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    [ "$status" -eq 0 ]
    cmp "$CONFIG_FILE" "$BATS_TEST_TMPDIR/before.json"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup \
        --auto-notes --calendar-tools "mcp__cal__list_events, mcp__cal__get_event" --no-daemon < /dev/null
    [ "$status" -eq 0 ]
    [ "$(config_value notes_dir)" = "\"$vault\"" ]
    [ "$(config_value asr_backend)" = '"groq"' ]
    [ "$(config_value auto_notes)" = true ]
    [ "$(config_value calendar_tools)" = '["mcp__cal__list_events", "mcp__cal__get_event"]' ]
}

@test "端末なしの setup で groq なのに Keychain にキーが無ければ、登録のコマンドを出して常駐を登録せずに終える" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    stub_security
    stub_launchctl 0
    plugin_copy "$BATS_TEST_TMPDIR/a"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --asr-backend groq < /dev/null
    echo "$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *'security add-generic-password -a "$USER" -s meeting-groq -w'* ]]
    [ "$(config_value asr_backend)" = '"groq"' ]
    [ ! -e "$BATS_TEST_TMPDIR/launchctl.log" ]
    [ ! -e "$BATS_TEST_TMPDIR/keychain" ]
}

@test "setup は --no-daemon が無ければ最後に常駐を登録する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    stub_launchctl 0
    plugin_copy "$BATS_TEST_TMPDIR/a"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/launchctl.log")" = "bootout bootstrap" ]
    [ -f "$HOME/Library/LaunchAgents/jp.co.playpark.meeting-watch.plist" ]
}

@test "setup は Hugging Face にログインしていなければ規約の URL とコマンドを出し、話者分離のモデルは取りにいかない" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    printf '#!/bin/sh\necho "$*" >> "%s/uv.args"\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stub/uv"
    plugin_copy "$BATS_TEST_TMPDIR/a"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"https://huggingface.co/pyannote/speaker-diarization-community-1"* ]]
    [[ "$output" == *"uvx --from huggingface_hub hf auth login"* ]]
    [[ "$(cat "$BATS_TEST_TMPDIR/uv.args")" == *"--prefetch --no-diarize" ]]

    mkdir -p "$HOME/.cache/huggingface"
    echo token > "$HOME/.cache/huggingface/token"
    rm "$BATS_TEST_TMPDIR/uv.args"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --no-daemon < /dev/null
    [ "$status" -eq 0 ]
    [[ "$output" != *"hf auth login"* ]]
    [[ "$(cat "$BATS_TEST_TMPDIR/uv.args")" == *"--prefetch" ]]
}

@test "setup は不正な値・不明なオプションをビルドの前に止め、設定ファイルを書き換えない" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    cp "$CONFIG_FILE" "$BATS_TEST_TMPDIR/before.json"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --asr-backend openai --no-daemon < /dev/null
    echo "$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"asr_backend は mlx / groq"* ]]
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --bogus < /dev/null
    [ "$status" -eq 1 ]
    [[ "$output" == *"不明なオプション: --bogus"* ]]
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup --notes-dir < /dev/null
    [ "$status" -eq 1 ]
    [ ! -e "$BATS_TEST_TMPDIR/swift.pkg" ]
    cmp "$CONFIG_FILE" "$BATS_TEST_TMPDIR/before.json"
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

@test "print-plist は固定パスのバイナリを --watch で起動し、ユーザー設定は焼き込まず設定ファイルの場所だけを渡す" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    write_config '"notes_dir": "/tmp/vault", "auto_notes": true, "calendar_tools": ["mcp__cal__list_events"], "asr_backend": "groq", "apps": ["us.zoom.=Zoom"]'
    # シェルに古い設定の環境変数が残っていても plist には入らない
    MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR=/tmp/vault MEETING_CALENDAR_TOOLS=mcp__cal__list_events MEETING_ASR_BACKEND=groq \
        MEETING_APPS=us.zoom.=Zoom MEETING_HOME="$MEETING_HOME" run bash "$SCRIPT" print-plist
    [ "$status" -eq 0 ]
    echo "$output" > "$BATS_TEST_TMPDIR/p.plist"
    [[ "$output" != *"MEETING_NOTES_DIR"* && "$output" != *"/tmp/vault"* && "$output" != *"$MEETING_HOME"* ]]
    [[ "$output" != *"groq"* && "$output" != *"mcp__cal"* && "$output" != *"us.zoom."* ]]
    run python3 - "$BATS_TEST_TMPDIR/p.plist" "$MEETING_PREFIX" "$HOME" "$CONFIG_FILE" <<'PY'
import plistlib, sys
p = plistlib.load(open(sys.argv[1], "rb"))
prefix, home, config = sys.argv[2:]
assert p["Label"] == "jp.co.playpark.meeting-watch", p["Label"]
assert p["ProgramArguments"] == [f"{prefix}/bin/meeting-rec", "--watch", "--on-stop", f"{prefix}/bin/meeting"], p["ProgramArguments"]
env = p["EnvironmentVariables"]
assert sorted(env) == ["HOME", "LANG", "MEETING_CONFIG", "MEETING_PREFIX", "PATH"], env
assert env["MEETING_CONFIG"] == config and env["HOME"] == home and env["MEETING_PREFIX"] == prefix, env
assert p["StandardOutPath"] == f"{home}/Library/Logs/meeting/watch.log", p["StandardOutPath"]
assert p["KeepAlive"] and p["RunAtLoad"]
PY
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "設定ファイルは MEETING_CONFIG、無ければ XDG_CONFIG_HOME の下から読む" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    mkdir -p "$BATS_TEST_TMPDIR/xdg/meeting" "$BATS_TEST_TMPDIR/xdg-home/2026-01-01_1000-x" "$BATS_TEST_TMPDIR/explicit/2026-01-02_1000-y"
    printf '{"home": "%s"}\n' "$BATS_TEST_TMPDIR/xdg-home" > "$BATS_TEST_TMPDIR/xdg/meeting/config.json"
    printf '{"home": "%s"}\n' "$BATS_TEST_TMPDIR/explicit" > "$BATS_TEST_TMPDIR/explicit.json"
    XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/xdg" run bash "$SCRIPT" ls
    [ "$status" -eq 0 ]
    [ "$output" = "  2026-01-01_1000-x" ]
    XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/xdg" MEETING_CONFIG="$BATS_TEST_TMPDIR/explicit.json" run bash "$SCRIPT" ls
    [ "$status" -eq 0 ]
    [ "$output" = "  2026-01-02_1000-y" ]
}

@test "設定ファイルが壊れている・知らないキーや値があれば、どのファイルの何が悪いかを出して失敗する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    for bad in '{' '{"notes_dir": 1}' '{"asr_backend": "openai"}' '{"notes_dri": "/x"}' '{"auto_notes": "yes"}' '[]'; do
        echo "$bad" > "$CONFIG_FILE"
        run bash "$SCRIPT" ls
        echo "$bad -> $output"
        [ "$status" -eq 1 ]
        [[ "$output" == *"$CONFIG_FILE"* ]]
    done
}

# uv / osascript / claude を stub に差し替える。claude は cwd と引数を記録し、$BATS_TEST_TMPDIR/note.md が
# あれば cwd の meetings/ に置く (議事録を書いたことにする)。osascript は通知の引数を記録する
stub_tools() {
    mkdir -p "$MEETING_PREFIX/bin" "$MEETING_PREFIX/transcribe" "$BATS_TEST_TMPDIR/stub" "$BATS_TEST_TMPDIR/notes"
    : > "$MEETING_PREFIX/bin/meeting-rec"
    chmod +x "$MEETING_PREFIX/bin/meeting-rec"
    : > "$MEETING_PREFIX/transcribe/transcribe.py"
    printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stub/uv"
    printf '#!/bin/sh\nprintf "%%s\\n" "$@" >> "%s/osascript.args"\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stub/osascript"
    cat > "$BATS_TEST_TMPDIR/stub/claude" <<EOF
#!/bin/sh
pwd -P > "$BATS_TEST_TMPDIR/claude.cwd"
for a in "\$@"; do printf "%s\\n" "\$a"; done > "$BATS_TEST_TMPDIR/claude.args"
if [ -f "$BATS_TEST_TMPDIR/note.md" ]; then mkdir -p meetings && cp "$BATS_TEST_TMPDIR/note.md" meetings/; fi
EOF
    chmod +x "$BATS_TEST_TMPDIR/stub/"*
}

# 設定ファイルの notes_dir を $BATS_TEST_TMPDIR/notes にする。$1 が auto なら auto_notes も true にし、
# $2 (JSON のメンバーの並び) を足す
notes_config() {
    local extra="\"notes_dir\": \"$BATS_TEST_TMPDIR/notes\""
    [ "${1:-}" != auto ] || extra+=", \"auto_notes\": true"
    write_config "$extra${2:+, $2}"
}

# launchctl を stub に差し替える。サブコマンドを launchctl.log に 1 行ずつ記録する。
# $BATS_TEST_TMPDIR/launchd/registered があれば登録あり。bootout は実機と同じく登録を残したまま rc=0 で戻り、
# そのあと print が $1 回成功してから登録が外れる。登録が残っている間の bootstrap は実機と同じく error 5
stub_launchctl() {
    local s="$BATS_TEST_TMPDIR/launchd"
    mkdir -p "$s" "$BATS_TEST_TMPDIR/stub"
    echo "$1" > "$s/linger"
    cat > "$BATS_TEST_TMPDIR/stub/launchctl" <<EOF
#!/bin/sh
s="$s"
echo "\$1" >> "$BATS_TEST_TMPDIR/launchctl.log"
case "\$1" in
  bootout)
    [ -e "\$s/registered" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }
    cp "\$s/linger" "\$s/lingering" ;;
  print)
    [ -e "\$s/registered" ] || exit 113
    if [ -e "\$s/lingering" ]; then
      n=\$(cat "\$s/lingering")
      if [ "\$n" -le 0 ]; then rm -f "\$s/registered" "\$s/lingering"; exit 113; fi
      echo \$((n - 1)) > "\$s/lingering"
    fi
    printf '\tstate = running\n\tpid = 4242\n' ;;
  bootstrap)
    if [ -e "\$s/registered" ] || [ -e "\$s/bootstrap_fails" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
    fi
    touch "\$s/registered" ;;
esac
EOF
    chmod +x "$BATS_TEST_TMPDIR/stub/launchctl"
}

@test "install は常駐中なら bootout 後に登録が外れるのを待ってから bootstrap し、常駐が running になる" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    stub_launchctl 3
    touch "$BATS_TEST_TMPDIR/launchd/registered"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" install
    echo "$output"
    [ "$status" -eq 0 ]
    [ -f "$HOME/Library/LaunchAgents/jp.co.playpark.meeting-watch.plist" ]
    # print が 3 回成功 (登録が残る) → 4 回目で失敗 (外れた) してから bootstrap
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/launchctl.log")" = "bootout print print print print bootstrap" ]

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" status
    [[ "$output" == *"state = running"* ]]
}

@test "install は未登録なら待たずに bootstrap し、常駐が running になる" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    stub_launchctl 3
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" install
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/launchctl.log")" = "bootout bootstrap" ]

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" status
    [[ "$output" == *"state = running"* ]]
}

@test "install は登録が外れるのを MEETING_INSTALL_WAIT 秒待っても外れなければ bootstrap せずに失敗する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    stub_launchctl 100000
    touch "$BATS_TEST_TMPDIR/launchd/registered"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_INSTALL_WAIT=1 run bash "$SCRIPT" install
    echo "$output"
    [ "$status" -ne 0 ]
    [[ "$output" == *"常駐は止まっておらず"* ]]
    [[ "$output" == *"meeting install を再実行"* ]]
    run grep -qx bootstrap "$BATS_TEST_TMPDIR/launchctl.log"
    [ "$status" -eq 1 ]
}

@test "install は bootstrap が失敗したら常駐が止まっていることと再実行を案内して失敗する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    stub_launchctl 0
    touch "$BATS_TEST_TMPDIR/launchd/bootstrap_fails"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" install
    echo "$output"
    [ "$status" -ne 0 ]
    [[ "$output" == *"常駐は止まっています"* ]]
    [[ "$output" == *"meeting install を再実行"* ]]
    [[ "$output" != *"✓ 常駐登録しました"* ]]
}

# 常駐の plist の EnvironmentVariables だけを環境にして、meeting-rec が録音後に起動するのと同じ
# `<--on-stop の値> post <DIR>` を実行する
launchd_post() {
    python3 - "$HOME/Library/LaunchAgents/jp.co.playpark.meeting-watch.plist" "$1" <<'PY'
import plistlib, subprocess, sys
p = plistlib.load(open(sys.argv[1], "rb"))
args = p["ProgramArguments"]
on_stop = args[args.index("--on-stop") + 1]
sys.exit(subprocess.run([on_stop, "post", sys.argv[2]], env=p["EnvironmentVariables"]).returncode)
PY
}

@test "設定ファイルを書き換えると、install し直さずに常駐から起動された post が新しい値を使う" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    stub_launchctl 0
    installed_copy
    notes_config auto
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" install
    [ "$status" -eq 0 ]

    mkdir -p "$BATS_TEST_TMPDIR/notes2"
    write_config "\"notes_dir\": \"$BATS_TEST_TMPDIR/notes2\", \"auto_notes\": true, \"calendar_tools\": [\"mcp__cal__list_events\"]"
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run launchd_post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/claude.cwd")" = "$(cd "$BATS_TEST_TMPDIR/notes2" && pwd -P)" ]
    grep -qxF -- 'Bash(git check-ignore:*),Bash(git rev-parse:*),mcp__cal__list_events' "$BATS_TEST_TMPDIR/claude.args"
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/launchctl.log")" = "bootout bootstrap" ]

    # auto_notes を外せば議事録は作らず、文字起こしの完了だけを通知する
    rm "$BATS_TEST_TMPDIR/claude.args"
    write_config "\"notes_dir\": \"$BATS_TEST_TMPDIR/notes2\""
    run launchd_post "$dir"
    [ "$status" -eq 0 ]
    [ ! -e "$BATS_TEST_TMPDIR/claude.args" ]
    grep -qF "文字起こし完了" "$BATS_TEST_TMPDIR/osascript.args"
}

@test "post の自動議事録は git の確認だけ許可し Web を閉じた claude -p にプロンプトを渡す" {
    # 文字起こし (第三者の発言) を読む非対話の claude なので、許可ツールとプロンプトの位置を固定する
    stub_tools
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    notes_config auto
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" post "$dir"
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
    # 名前が全員確定した議事録なら meeting name は案内しない
    grep -qF "議事録を作成しました: 2026-01-01_1000-Zoom" "$BATS_TEST_TMPDIR/osascript.args"
    run grep -qF "meeting name" "$BATS_TEST_TMPDIR/osascript.args"
    [ "$status" -eq 1 ]
}

@test "post は設定の calendar_tools のツールを --allowedTools に足す" {
    stub_tools
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    notes_config auto '"calendar_tools": ["mcp__cal__list_events", "mcp__cal__get_event"]'
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    grep -qxF -- 'Bash(git check-ignore:*),Bash(git rev-parse:*),mcp__cal__list_events,mcp__cal__get_event' \
        "$BATS_TEST_TMPDIR/claude.args"
}

@test "post は議事録に未確定の話者が残れば人数と meeting name を通知する" {
    stub_tools
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"
    printf -- '---\ntags: [meeting]\nrecording: %s\nunresolved_speakers: [話者A, 話者B]\n---\n\n# Zoom 会議\n' "$dir" \
        > "$BATS_TEST_TMPDIR/note.md"

    notes_config auto
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    cat "$BATS_TEST_TMPDIR/osascript.args"
    grep -qF "未確定の話者 2 人" "$BATS_TEST_TMPDIR/osascript.args"
    grep -qF "meeting name" "$BATS_TEST_TMPDIR/osascript.args"
}

# グローバル設定で output_dir を notes_dir の外 (Drive の同期フォルダ想定) に向ける
global_output_dir() {
    mkdir -p "$HOME/.config/skills"
    printf '{"meeting-notes": {"output_dir": "%s", "transcripts_dir": "meetings/transcripts"}}\n' "$1" \
        > "$HOME/.config/skills/config.json"
}

@test "post は output_dir が notes_dir の外なら作って --add-dir で渡し、そこの議事録から通知する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    global_output_dir "~/Google Drive/議事録"
    out="$HOME/Google Drive/議事録"
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    notes_config auto
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    [ -d "$out" ]
    grep -qxF -- "$out" "$BATS_TEST_TMPDIR/claude.args"

    printf -- '---\nrecording: %s\nunresolved_speakers: [話者A]\n---\n' "$dir" > "$out/2026-01-01-zoom.md"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" post "$dir"
    [ "$status" -eq 0 ]
    grep -qF "未確定の話者 1 人" "$BATS_TEST_TMPDIR/osascript.args"
}

@test "post は output_dir が notes_dir の中なら --add-dir を足さない" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    global_output_dir "~/Google Drive/議事録"
    # プロジェクトの skill-config.json がグローバルより優先される
    mkdir -p "$BATS_TEST_TMPDIR/notes/.git"
    printf '{"meeting-notes": {"output_dir": "minutes"}}\n' > "$BATS_TEST_TMPDIR/notes/skill-config.json"
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    notes_config auto
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(grep -cxF -- '--add-dir' "$BATS_TEST_TMPDIR/claude.args")" -eq 1 ]
    [ ! -e "$HOME/Google Drive" ]
}

# 話者A (system) と 自分 (mic) の発言を持つ録音を作る
make_recording() {
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"
    : > "$dir/system.wav"
    : > "$dir/mic.wav"
    cat > "$dir/transcript.json" <<'EOF'
{"utterances": [
  {"start": 1.0, "end": 3.0, "speaker": "話者A", "text": "はい", "source": "system"},
  {"start": 4.0, "end": 7.5, "speaker": "話者A", "text": "田中です", "source": "system"},
  {"start": 8.0, "end": 20.0, "speaker": "自分", "text": "よろしくお願いします", "source": "mic"}
]}
EOF
}

stub_player() {
    mkdir -p "$BATS_TEST_TMPDIR/stub"
    # ffmpeg は引数を 1 行に記録し、最後の引数 (出力先) を作る
    printf '#!/bin/sh\necho "$*" >> "%s/ffmpeg.args"\nfor a; do out="$a"; done\n: > "$out"\n' "$BATS_TEST_TMPDIR" \
        > "$BATS_TEST_TMPDIR/stub/ffmpeg"
    printf '#!/bin/sh\necho "$1" >> "%s/afplay.args"\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/stub/afplay"
    chmod +x "$BATS_TEST_TMPDIR/stub/"*
}

@test "play は話者の長い発言から合計約 5 秒を system.wav から切り出して再生する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    make_recording
    stub_player
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" play "$dir" 話者A
    echo "$output"
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "[00:00:04] 田中です" ]
    [ "${lines[1]}" = "[00:00:01] はい" ]
    mapfile -t cuts < "$BATS_TEST_TMPDIR/ffmpeg.args"
    [ "${#cuts[@]}" -eq 2 ]
    [[ "${cuts[0]}" == *"-ss 4.00 -t 3.50 -i $dir/system.wav "* ]]
    [[ "${cuts[1]}" == *"-ss 1.00 -t 1.50 -i $dir/system.wav "* ]]
    [ "$(wc -l < "$BATS_TEST_TMPDIR/afplay.args")" -eq 2 ]
}

@test "play は 自分 を mic.wav から切り出す" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    make_recording
    stub_player
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" play "$dir" 自分
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$(cat "$BATS_TEST_TMPDIR/ffmpeg.args")" == *"-ss 8.00 -t 5.00 -i $dir/mic.wav "* ]]
}

@test "play は引数が足りない・発言の無いラベルで失敗する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    make_recording
    stub_player
    run bash "$SCRIPT" play "$dir"
    [ "$status" -eq 1 ]
    [[ "$output" == *"meeting play <DIR> <話者ラベル>"* ]]
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" play "$dir" 話者Z
    [ "$status" -eq 1 ]
    [[ "$output" == *"話者Z の発言がありません"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/afplay.args" ]
}

# notes/meetings/<name>.md に議事録を置く。$3 は unresolved_speakers の値 (空なら行を書かない)
write_note() {
    local name="$1" rec="$2" unresolved="$3"
    mkdir -p "$BATS_TEST_TMPDIR/notes/meetings/transcripts"
    {
        printf -- '---\ntags: [meeting]\nattendees: [自分, 話者A, 話者B]\nrecording: %s\n' "$rec"
        [ -z "$unresolved" ] || printf 'unresolved_speakers: [%s]\n' "$unresolved"
        printf 'transcript: "[[meetings/transcripts/%s]]"\n---\n\n# 定例\n\n- 話者A が提案し、話者B と 話者AB が合意\n' "$name"
    } > "$BATS_TEST_TMPDIR/notes/meetings/$name.md"
    printf '# 定例\n\n**[00:00:01] 話者A**: はい\n\n**[00:00:05] 話者B**: どうも\n' \
        > "$BATS_TEST_TMPDIR/notes/meetings/transcripts/$name.md"
}

@test "name は未確定の話者が残る議事録が無ければ claude を起動せずに終わる" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    write_note 2026-01-01-a "$MEETING_HOME/2026-01-01_1000-a" ""
    notes_config
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者が残る議事録はありません"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/claude.args" ]

    # DIR 指定でも、その議事録に未確定の話者が無ければ何もしない
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" name "$MEETING_HOME/2026-01-01_1000-a/"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者はありません"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/claude.args" ]
}

@test "name は DIR 省略時に未確定の話者が残る最新の録音を選んで /meeting-notes --name-unresolved を起動する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    write_note 2026-01-01-a "$MEETING_HOME/2026-01-01_1000-a" "話者A"
    write_note 2026-01-02-b "$MEETING_HOME/2026-01-02_1000-b" "話者B"
    write_note 2026-01-03-c "$MEETING_HOME/2026-01-03_1000-c" ""
    notes_config
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/claude.cwd")" = "$(cd "$BATS_TEST_TMPDIR/notes" && pwd -P)" ]
    mapfile -t args < "$BATS_TEST_TMPDIR/claude.args"
    [ "${args[0]}" = "--add-dir" ]
    [ "${args[1]}" = "$MEETING_HOME/2026-01-02_1000-b" ]
    [ "${args[2]}" = "/meeting-notes $MEETING_HOME/2026-01-02_1000-b --name-unresolved $BATS_TEST_TMPDIR/notes/meetings/2026-01-02-b.md" ]
}

@test "name は議事録の無い DIR・不明なオプション・2 つ目の DIR で失敗する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    notes_config
    run bash "$SCRIPT" name "$MEETING_HOME/2026-01-09_1000-x"
    [ "$status" -eq 1 ]
    [[ "$output" == *"議事録が"*"ありません"* ]]
    run bash "$SCRIPT" name --bogus
    [ "$status" -eq 1 ]
    [[ "$output" == *"不明なオプション: --bogus"* ]]
    run bash "$SCRIPT" name a b
    [ "$status" -eq 1 ]
    [[ "$output" == *"DIR は 1 つだけ"* ]]
    run bash "$SCRIPT" name --set
    [ "$status" -eq 1 ]
    [[ "$output" == *"話者A=田中"* ]]
}

@test "name --set は議事録と全文のラベルを置き換え、答えた話者を unresolved_speakers から外す" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    rec="$MEETING_HOME/2026-01-01_1000-a"
    write_note 2026-01-01-a "$rec" "話者A, 話者B"
    note="$BATS_TEST_TMPDIR/notes/meetings/2026-01-01-a.md"
    notes_config
    run bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者: 話者B"* ]]
    grep -qxF 'unresolved_speakers: [話者B]' "$note"
    grep -qxF 'attendees: [自分, 田中, 話者B]' "$note"
    grep -qxF -- '- 田中 が提案し、話者B と 話者AB が合意' "$note"
    grep -qxF "recording: $rec" "$note"
    grep -qxF '**[00:00:01] 田中**: はい' "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"

    # 最後の 1 人に名前が入ると unresolved_speakers の行ごと消え、以後 name は何もしない
    run bash "$SCRIPT" name "$rec" --set "話者B=佐藤"
    [ "$status" -eq 0 ]
    run grep -q '^unresolved_speakers:' "$note"
    [ "$status" -eq 1 ]
    grep -qxF '**[00:00:05] 佐藤**: どうも' "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"
    run bash "$SCRIPT" name
    [[ "$output" == *"未確定の話者が残る議事録はありません"* ]]
}

@test "name は notes_dir の外の output_dir にある議事録を見つけ、全文は notes_dir 相対で書き換える" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    global_output_dir "~/Google Drive/議事録"
    out="$HOME/Google Drive/議事録"
    rec="$MEETING_HOME/2026-01-01_1000-a"
    write_note 2026-01-01-c "$MEETING_HOME/2026-01-01_1000-c" ""

    # 探すだけの name は output_dir が無くても作らない (共有先に空フォルダを作らない)
    notes_config
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者が残る議事録はありません"* ]]
    [ ! -e "$HOME/Google Drive" ]

    write_note 2026-01-01-a "$rec" "話者A"
    mkdir -p "$out"
    mv "$BATS_TEST_TMPDIR/notes/meetings/2026-01-01-a.md" "$out/"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    mapfile -t args < "$BATS_TEST_TMPDIR/claude.args"
    [ "${args[2]}" = "--add-dir" ]
    [ "${args[3]}" = "$out" ]
    [ "${args[4]}" = "/meeting-notes $rec --name-unresolved $out/2026-01-01-a.md" ]

    run bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    [ "$status" -eq 0 ]
    run grep -q '^unresolved_speakers:' "$out/2026-01-01-a.md"
    [ "$status" -eq 1 ]
    grep -qxF '**[00:00:01] 田中**: はい' "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"
}

@test "name --set は transcripts_dir が ~ 始まりの全文もホーム基準で書き換える" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    rec="$MEETING_HOME/2026-01-01_1000-a"
    write_note 2026-01-01-a "$rec" "話者A"
    note="$BATS_TEST_TMPDIR/notes/meetings/2026-01-01-a.md"
    mkdir -p "$HOME/tx"
    mv "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md" "$HOME/tx/"
    sed -i.bak 's|^transcript: .*|transcript: "[[~/tx/2026-01-01-a]]"|' "$note"
    notes_config
    run bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    [ "$status" -eq 0 ]
    grep -qxF '**[00:00:01] 田中**: はい' "$HOME/tx/2026-01-01-a.md"
}

# 議事録の transcript: の次の行に transcript_path: <$2> を足す
add_transcript_path() {
    awk -v p="$2" '{ print } /^transcript: /{ print "transcript_path: " p }' "$1" > "$1.tmp"
    mv "$1.tmp" "$1"
}

@test "/meeting-notes の議事録テンプレートは meeting name が読む transcript_path: を transcript: の隣に書く" {
    skill="$BATS_TEST_DIRNAME/../meeting-notes/SKILL.md"
    grep -A1 '^transcript: "\[\[<transcripts_dir>/' "$skill" | grep -qx 'transcript_path: <保存した全文の絶対パス>'
}

@test "name --set は notes_dir 未設定で作成時と違う cwd からでも transcript_path: の全文を書き換える" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    global_output_dir "~/Google Drive/議事録"
    out="$HOME/Google Drive/議事録"
    rec="$MEETING_HOME/2026-01-01_1000-a"
    tx="$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"
    write_note 2026-01-01-a "$rec" "話者A"
    mkdir -p "$out" "$BATS_TEST_TMPDIR/elsewhere"
    mv "$BATS_TEST_TMPDIR/notes/meetings/2026-01-01-a.md" "$out/"
    add_transcript_path "$out/2026-01-01-a.md" "$tx"

    cd "$BATS_TEST_TMPDIR/elsewhere"
    run bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" != *"全文が見つかりません"* ]]
    run grep -q '^unresolved_speakers:' "$out/2026-01-01-a.md"
    [ "$status" -eq 1 ]
    grep -qxF -- '- 田中 が提案し、話者B と 話者AB が合意' "$out/2026-01-01-a.md"
    grep -qxF "transcript_path: $tx" "$out/2026-01-01-a.md"
    grep -qxF '**[00:00:01] 田中**: はい' "$tx"
}

@test "name --set は全文が見つからなければ議事録を書き換えたうえで stderr に知らせて非 0 で終わる" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    rec="$MEETING_HOME/2026-01-01_1000-a"
    note="$BATS_TEST_TMPDIR/notes/meetings/2026-01-01-a.md"

    # transcript_path: の全文が無い
    write_note 2026-01-01-a "$rec" "話者A, 話者B"
    add_transcript_path "$note" "$BATS_TEST_TMPDIR/gone/2026-01-01-a.md"
    notes_config
    run --separate-stderr bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    echo "$stderr"
    [ "$status" -ne 0 ]
    [ "$stderr" = "! 全文が見つかりません: $BATS_TEST_TMPDIR/gone/2026-01-01-a.md" ]
    grep -qxF 'unresolved_speakers: [話者B]' "$note"
    grep -qxF -- '- 田中 が提案し、話者B と 話者AB が合意' "$note"

    # transcript_path: が無く、root 相対の transcript: の全文が無い
    rm "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"
    sed -i.bak '/^transcript_path:/d' "$note"
    run --separate-stderr bash "$SCRIPT" name "$rec" --set "話者B=佐藤"
    echo "$output"
    echo "$stderr"
    [ "$status" -ne 0 ]
    [ "$stderr" = "! 全文が見つかりません: $BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md" ]
    run grep -q '^unresolved_speakers:' "$note"
    [ "$status" -eq 1 ]
    grep -qxF -- '- 田中 が提案し、佐藤 と 話者AB が合意' "$note"
}

# doctor の全項目が ✅ になる環境を作る。PATH は stub (swift / ffmpeg / uv / launchctl / security) と、
# 実機の swift などを含まないよう必要なコマンドだけを並べた $BATS_TEST_TMPDIR/sys にする。
# plugin は $BATS_TEST_TMPDIR/plugin、インストール先はそこから setup したのと同じ中身にする
doctor_env() {
    local s="$BATS_TEST_TMPDIR/launchd" t
    mkdir -p "$BATS_TEST_TMPDIR/stub" "$BATS_TEST_TMPDIR/sys" "$s"
    for t in bash sh env python3 cat cmp diff dirname readlink id mkdir rm mktemp sleep grep sed head; do
        ln -sf "$(command -v "$t")" "$BATS_TEST_TMPDIR/sys/$t"
    done
    for t in swift ffmpeg uv; do printf '#!/bin/sh\nexit 0\n' > "$BATS_TEST_TMPDIR/stub/$t"; done
    stub_security
    touch "$BATS_TEST_TMPDIR/keychain"
    # launchctl: registered があれば print は state (既定 running)。bootstrap は launchd と同じく plist の
    # EnvironmentVariables だけで ProgramArguments を待たずに起動する (doctor の Keychain の確認用ジョブ)
    cat > "$BATS_TEST_TMPDIR/stub/launchctl" <<EOF
#!/usr/bin/env python3
import os, plistlib, subprocess, sys
s = "$s"
if sys.argv[1] == "print":
    if not os.path.exists(s + "/registered"):
        sys.exit(113)
    state = open(s + "/state").read().strip() if os.path.exists(s + "/state") else "running"
    print(f"\tstate = {state}\n\tpid = 4242")
elif sys.argv[1] == "bootstrap":
    if os.path.exists(s + "/bootstrap_fails"):
        sys.exit(5)
    p = plistlib.load(open(sys.argv[3], "rb"))
    subprocess.Popen(p["ProgramArguments"], env=dict(p["EnvironmentVariables"], MEETING_TEST_LAUNCHD="1"))
EOF
    chmod +x "$BATS_TEST_TMPDIR/stub/"*
    DOCTOR_PATH="$BATS_TEST_TMPDIR/stub:$BATS_TEST_TMPDIR/sys"

    plugin_copy "$BATS_TEST_TMPDIR/plugin"
    mkdir -p "$MEETING_PREFIX/bin" "$MEETING_PREFIX/transcribe" "$MEETING_PREFIX/src"
    cp "$BATS_TEST_TMPDIR/plugin/scripts/meeting.sh" "$MEETING_PREFIX/bin/meeting"
    printf '#!/bin/sh\n' > "$MEETING_PREFIX/bin/meeting-rec"
    chmod +x "$MEETING_PREFIX/bin/meeting-rec"
    cp "$BATS_TEST_TMPDIR/plugin/transcribe/"*.py "$MEETING_PREFIX/transcribe/"
    cp -R "$BATS_TEST_TMPDIR/plugin/recorder" "$MEETING_PREFIX/src/recorder"

    mkdir -p "$HOME/.cache/huggingface" "$BATS_TEST_TMPDIR/notes" "$HOME/Library/LaunchAgents"
    echo token > "$HOME/.cache/huggingface/token"
    notes_config auto '"asr_backend": "groq"'
    PATH="$DOCTOR_PATH" bash "$BATS_TEST_TMPDIR/plugin/scripts/meeting.sh" print-plist \
        > "$HOME/Library/LaunchAgents/jp.co.playpark.meeting-watch.plist"
    touch "$s/registered"
}

run_doctor() {
    PATH="$DOCTOR_PATH" run bash "$BATS_TEST_TMPDIR/plugin/scripts/meeting.sh" doctor
    echo "$output"
}

# doctor の出力の ❌ の行がちょうど 1 つで、それが $1 を含み、非 0 で終わる
only_ng() {
    [ "$status" -eq 1 ]
    [ "$(grep -c '^❌' <<< "$output")" -eq 1 ]
    [[ "$(grep '^❌' <<< "$output")" == *"$1"* ]]
}

@test "doctor は揃った環境では全項目を ✅ にして 0 で終わる" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    run_doctor
    [ "$status" -eq 0 ]
    [[ "$output" != *"❌"* ]]
    for item in "✅ swift" "✅ ffmpeg" "✅ uv" "✅ インストール済みの版は plugin と同じです" "✅ Hugging Face にログイン済み" \
        "✅ 設定ファイル $CONFIG_FILE" 'asr_backend = "groq"' "✅ 常駐: running (pid 4242)" \
        "✅ Keychain に meeting-groq があります" "✅ 常駐 (launchd) のプロセスから Keychain を読めます"; do
        [[ "$output" == *"$item"* ]] || { echo "missing: $item"; return 1; }
    done
}

@test "doctor は swift / ffmpeg / uv が PATH に無ければそれぞれ ❌ にする" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    for dep in swift ffmpeg uv; do
        mv "$BATS_TEST_TMPDIR/stub/$dep" "$BATS_TEST_TMPDIR/$dep.off"
        run_doctor
        only_ng "$dep がありません"
        mv "$BATS_TEST_TMPDIR/$dep.off" "$BATS_TEST_TMPDIR/stub/$dep"
    done
}

@test "doctor は未インストール・plugin と違う版のインストールを ❌ にする" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    echo "// changed" >> "$BATS_TEST_TMPDIR/plugin/recorder/Sources/meeting-rec/main.swift"
    run_doctor
    only_ng "インストール済みの版が plugin と違います"

    cp "$BATS_TEST_TMPDIR/plugin/recorder/Sources/meeting-rec/main.swift" "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/"
    echo "# changed" >> "$MEETING_PREFIX/transcribe/transcribe.py"
    run_doctor
    only_ng "インストール済みの版が plugin と違います"

    rm "$MEETING_PREFIX/bin/meeting-rec"
    run_doctor
    only_ng "インストールされていません"
}

@test "doctor は Hugging Face にログインしていなければ ❌ と規約のページを出す" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    rm "$HOME/.cache/huggingface/token"
    run_doctor
    only_ng "Hugging Face にログインしていません"
    [[ "$output" == *"https://huggingface.co/pyannote/speaker-diarization-community-1"* ]]
}

@test "doctor は設定ファイルが無い・壊れている・notes_dir が無いことを ❌ にする" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    rm -r "$BATS_TEST_TMPDIR/notes"
    run_doctor
    only_ng "notes_dir のディレクトリがありません"

    echo '{"asr_backend": "openai"}' > "$CONFIG_FILE"
    run_doctor
    only_ng "設定ファイルを読めません"

    rm "$CONFIG_FILE"
    run_doctor
    only_ng "設定ファイルがありません"
}

@test "doctor は常駐していない・止まっている・古い登録のままであることを ❌ にする" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    plist="$HOME/Library/LaunchAgents/jp.co.playpark.meeting-watch.plist"
    sed -i.bak 's|<key>MEETING_CONFIG</key>|<key>MEETING_NOTES_DIR</key>|' "$plist"
    run_doctor
    only_ng "常駐の登録が今の meeting と違います"

    echo "not running" > "$BATS_TEST_TMPDIR/launchd/state"
    run_doctor
    only_ng "常駐が動いていません (state = not running)"

    rm "$BATS_TEST_TMPDIR/launchd/registered"
    run_doctor
    only_ng "常駐していません"
}

@test "doctor は groq なのに Keychain に meeting-groq が無い・常駐から読めないことを ❌ にする" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    doctor_env
    touch "$BATS_TEST_TMPDIR/keychain_denied_for_launchd"
    run_doctor
    only_ng "常駐 (launchd) のプロセスから Keychain を読めません"
    [[ "$output" == *"✅ Keychain に meeting-groq があります"* ]]

    touch "$BATS_TEST_TMPDIR/launchd/bootstrap_fails"
    run_doctor
    only_ng "常駐 (launchd) から Keychain を読めるか確かめられません"

    rm "$BATS_TEST_TMPDIR/keychain"
    run_doctor
    only_ng "Keychain に meeting-groq がありません"
    [[ "$output" == *'security add-generic-password -a "$USER" -s meeting-groq -w'* ]]

    # mlx なら Keychain は見ない
    notes_config auto
    run_doctor
    [ "$status" -eq 0 ]
    [[ "$output" != *"Keychain"* ]]
}
