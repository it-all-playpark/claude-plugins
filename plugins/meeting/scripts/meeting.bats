#!/usr/bin/env bats
# meeting.sh の macOS 非依存部分（引数処理・未インストール時の案内・録音一覧・launchd plist 生成・
# install の常駐登録の手順・setup のビルド元の固定と署名・話者の声の切り出し・議事録の話者名の後入れ）のテスト。
# 録音 / 実際のビルド / 実際の署名 / 実際の launchd 登録 / 実際の再生は macOS 実機でしか動かないので対象外
# (launchctl / swift / security / openssl / codesign / ffmpeg / afplay は stub)。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/meeting.sh"
    export HOME="$BATS_TEST_TMPDIR/home"
    export MEETING_HOME="$BATS_TEST_TMPDIR/meetings"
    export MEETING_PREFIX="$BATS_TEST_TMPDIR/prefix"
    mkdir -p "$HOME" "$MEETING_HOME"
    unset MEETING_AUTO_NOTES MEETING_NOTES_DIR MEETING_APPS MEETING_CALENDAR_TOOLS
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
    stub_signing
    chmod +x "$BATS_TEST_TMPDIR/stub/"*
}

# setup の署名で呼ぶ security / openssl / codesign を stub に差し替える。keychain の identity は
# $BATS_TEST_TMPDIR/keychain/identity で表す (あれば find-identity に信頼設定なしの identity として出る)。
# security import は引数を security.import に記録し、p12 があれば identity を足す。openssl はサブコマンドを
# openssl.log に記録して -out / -keyout のファイルを作る。codesign は引数を codesign.args に 1 行で記録し、
# 対象ファイルの末尾に "signed <identity> <identifier>" を足す (署名でバイナリの中身が変わるのを模す)
stub_signing() {
    local s="$BATS_TEST_TMPDIR/stub" k="$BATS_TEST_TMPDIR/keychain"
    mkdir -p "$s" "$k"
    cat > "$s/security" <<EOF
#!/bin/sh
case "\$1" in
  find-identity)
    echo "Policy: Code Signing"
    echo "  Matching identities"
    if [ -e "$k/identity" ]; then
      echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "meeting-rec local signing" (CSSMERR_TP_NOT_TRUSTED)'
      echo "     1 identities found"
    else
      echo "     0 identities found"
    fi ;;
  import)
    printf "%s\\n" "\$@" > "$BATS_TEST_TMPDIR/security.import"
    [ -f "\$2" ] && touch "$k/identity" ;;
esac
EOF
    cat > "$s/openssl" <<EOF
#!/bin/sh
echo "\$1" >> "$BATS_TEST_TMPDIR/openssl.log"
while [ \$# -gt 0 ]; do
  case "\$1" in -out|-keyout) : > "\$2"; shift ;; esac
  shift
done
EOF
    cat > "$s/codesign" <<EOF
#!/bin/sh
echo "\$*" >> "$BATS_TEST_TMPDIR/codesign.args"
while [ \$# -gt 1 ]; do
  case "\$1" in -s) id="\$2"; shift ;; --identifier) ident="\$2"; shift ;; esac
  shift
done
echo "signed \$id \$ident" >> "\$1"
EOF
}

@test "setup は plugin root の場所によらず固定の \$MEETING_PREFIX/src/recorder からビルドし、ソースが同じなら meeting-rec を入れ替えない" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    plugin_copy "$BATS_TEST_TMPDIR/b"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ meeting-rec を更新しました"* ]]
    before="$(cksum < "$MEETING_PREFIX/bin/meeting-rec")"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/b/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"= meeting-rec は変更なし (権限はそのまま)"* ]]
    [ "$(cksum < "$MEETING_PREFIX/bin/meeting-rec")" = "$before" ]
    [ "$(wc -l < "$BATS_TEST_TMPDIR/codesign.args")" -eq 1 ]
    # 署名しないときは keychain のダイアログの案内も出さない
    [[ "$output" != *"「許可」を押して"* ]]
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/swift.pkg")" = "$MEETING_PREFIX/src/recorder $MEETING_PREFIX/src/recorder" ]
}

@test "setup は recorder のソースが変わったら meeting-rec を更新する" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    plugin_copy "$BATS_TEST_TMPDIR/b"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    [ "$status" -eq 0 ]
    before="$(cksum < "$MEETING_PREFIX/bin/meeting-rec")"

    echo "// changed" >> "$BATS_TEST_TMPDIR/b/recorder/Sources/meeting-rec/main.swift"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/b/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ meeting-rec を更新しました"* ]]
    [ "$(cksum < "$MEETING_PREFIX/bin/meeting-rec")" != "$before" ]
    [ "$(wc -l < "$BATS_TEST_TMPDIR/codesign.args")" -eq 2 ]
}

@test "setup は署名用の identity が keychain に無いときだけ作り、鍵と p12 を残さない" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"keychain へコード署名の証明書「meeting-rec local signing」を追加しました"* ]]
    [[ "$output" == *"一度だけ"*"再許可"* ]]
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/openssl.log")" = "req pkcs12" ]
    mapfile -t imp < "$BATS_TEST_TMPDIR/security.import"
    [ "${imp[0]}" = "import" ]
    [[ "${imp[1]}" == *.p12 ]]
    [ ! -e "$(dirname "${imp[1]}")" ]
    # -T を付けると任意のプログラムが確認なしで鍵を使えるので付けない
    [ -z "$(grep -xF -- '-T' "$BATS_TEST_TMPDIR/security.import")" ]
    [ -z "$(grep -F -- 'codesign' "$BATS_TEST_TMPDIR/security.import")" ]

    # identity があれば作らない
    rm "$BATS_TEST_TMPDIR/security.import"
    echo "// changed" >> "$BATS_TEST_TMPDIR/a/recorder/Sources/meeting-rec/main.swift"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" != *"keychain へ"* ]]
    [ "$(paste -sd ' ' "$BATS_TEST_TMPDIR/openssl.log")" = "req pkcs12" ]
    [ ! -e "$BATS_TEST_TMPDIR/security.import" ]
    [[ "$output" == *"✓ meeting-rec を更新しました (同じ証明書で署名したので権限はそのまま)"* ]]
}

@test "setup はインストールする meeting-rec を自己署名の identity と固定の識別子で署名する" {
    stub_build
    touch "$BATS_TEST_TMPDIR/keychain/identity"
    plugin_copy "$BATS_TEST_TMPDIR/a"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [ ! -e "$BATS_TEST_TMPDIR/openssl.log" ]
    [[ "$(cat "$BATS_TEST_TMPDIR/codesign.args")" == "-f -s meeting-rec local signing --identifier jp.co.playpark.meeting-rec "* ]]
    # 署名の前に keychain のダイアログで「許可」を押し「常に許可」は押さないよう案内する
    [[ "$output" == *"「許可」を押して"* ]]
    [[ "$output" == *"「常に許可」は押さない"* ]]
    [ -x "$MEETING_PREFIX/bin/meeting-rec" ]
    [ "$(tail -1 "$MEETING_PREFIX/bin/meeting-rec")" = "signed meeting-rec local signing jp.co.playpark.meeting-rec" ]
}

@test "setup は ad-hoc 署名のまま入れた meeting-rec をビルド成果物が同じでも署名して入れ替える" {
    stub_build
    touch "$BATS_TEST_TMPDIR/keychain/identity"
    plugin_copy "$BATS_TEST_TMPDIR/a"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    [ "$status" -eq 0 ]
    # この修正の前の setup と同じく、ビルド成果物をそのまま入れた状態にする
    cp "$MEETING_PREFIX/build/release/meeting-rec" "$MEETING_PREFIX/bin/meeting-rec"
    rm "$MEETING_PREFIX/bin/.meeting-rec.unsigned"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"✓ meeting-rec を更新しました (ad-hoc 署名からの切り替えなので、常駐の次の起動で一度だけ権限の再許可が必要です)"* ]]
    [ "$(tail -1 "$MEETING_PREFIX/bin/meeting-rec")" = "signed meeting-rec local signing jp.co.playpark.meeting-rec" ]
}

@test "setup は plugin 側で消した recorder のソースファイルを固定の場所にも残さない" {
    stub_build
    plugin_copy "$BATS_TEST_TMPDIR/a"
    extra="$BATS_TEST_TMPDIR/a/recorder/Sources/meeting-rec/Extra.swift"
    echo "// extra" > "$extra"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    [ "$status" -eq 0 ]
    [ -f "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/Extra.swift" ]

    rm "$extra"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" run bash "$BATS_TEST_TMPDIR/a/scripts/meeting.sh" setup
    echo "$output"
    [ "$status" -eq 0 ]
    [ ! -e "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/Extra.swift" ]
    [ -f "$MEETING_PREFIX/src/recorder/Sources/meeting-rec/main.swift" ]
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
    MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR=/tmp/vault MEETING_CALENDAR_TOOLS=mcp__cal__list_events \
        run bash "$SCRIPT" print-plist
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
assert env["MEETING_CALENDAR_TOOLS"] == "mcp__cal__list_events", env
assert "PATH" in env and p["KeepAlive"] and p["RunAtLoad"]
PY
    echo "$output"
    [ "$status" -eq 0 ]
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

@test "post の自動議事録は git の確認だけ許可し Web を閉じた claude -p にプロンプトを渡す" {
    # 文字起こし (第三者の発言) を読む非対話の claude なので、許可ツールとプロンプトの位置を固定する
    stub_tools
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
    # 名前が全員確定した議事録なら meeting name は案内しない
    grep -qF "議事録を作成しました: 2026-01-01_1000-Zoom" "$BATS_TEST_TMPDIR/osascript.args"
    run grep -qF "meeting name" "$BATS_TEST_TMPDIR/osascript.args"
    [ "$status" -eq 1 ]
}

@test "post は MEETING_CALENDAR_TOOLS のツールを --allowedTools に足す" {
    stub_tools
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        MEETING_CALENDAR_TOOLS="mcp__cal__list_events,mcp__cal__get_event" run bash "$SCRIPT" post "$dir"
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

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    cat "$BATS_TEST_TMPDIR/osascript.args"
    grep -qF "未確定の話者 2 人" "$BATS_TEST_TMPDIR/osascript.args"
    grep -qF "meeting name" "$BATS_TEST_TMPDIR/osascript.args"
}

# グローバル設定で output_dir を MEETING_NOTES_DIR の外 (Drive の同期フォルダ想定) に向ける
global_output_dir() {
    mkdir -p "$HOME/.config/skills"
    printf '{"meeting-notes": {"output_dir": "%s", "transcripts_dir": "meetings/transcripts"}}\n' "$1" \
        > "$HOME/.config/skills/config.json"
}

@test "post は output_dir が MEETING_NOTES_DIR の外なら作って --add-dir で渡し、そこの議事録から通知する" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    global_output_dir "~/Google Drive/議事録"
    out="$HOME/Google Drive/議事録"
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        run bash "$SCRIPT" post "$dir"
    echo "$output"
    [ "$status" -eq 0 ]
    [ -d "$out" ]
    grep -qxF -- "$out" "$BATS_TEST_TMPDIR/claude.args"

    printf -- '---\nrecording: %s\nunresolved_speakers: [話者A]\n---\n' "$dir" > "$out/2026-01-01-zoom.md"
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        run bash "$SCRIPT" post "$dir"
    [ "$status" -eq 0 ]
    grep -qF "未確定の話者 1 人" "$BATS_TEST_TMPDIR/osascript.args"
}

@test "post は output_dir が MEETING_NOTES_DIR の中なら --add-dir を足さない" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    global_output_dir "~/Google Drive/議事録"
    # プロジェクトの skill-config.json がグローバルより優先される
    mkdir -p "$BATS_TEST_TMPDIR/notes/.git"
    printf '{"meeting-notes": {"output_dir": "minutes"}}\n' > "$BATS_TEST_TMPDIR/notes/skill-config.json"
    dir="$MEETING_HOME/2026-01-01_1000-Zoom"
    mkdir -p "$dir"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_AUTO_NOTES=1 MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        run bash "$SCRIPT" post "$dir"
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
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者が残る議事録はありません"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/claude.args" ]

    # DIR 指定でも、その議事録に未確定の話者が無ければ何もしない
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" \
        run bash "$SCRIPT" name "$MEETING_HOME/2026-01-01_1000-a/"
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
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name
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
    MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name "$MEETING_HOME/2026-01-09_1000-x"
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
    MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者: 話者B"* ]]
    grep -qxF 'unresolved_speakers: [話者B]' "$note"
    grep -qxF 'attendees: [自分, 田中, 話者B]' "$note"
    grep -qxF -- '- 田中 が提案し、話者B と 話者AB が合意' "$note"
    grep -qxF "recording: $rec" "$note"
    grep -qxF '**[00:00:01] 田中**: はい' "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"

    # 最後の 1 人に名前が入ると unresolved_speakers の行ごと消え、以後 name は何もしない
    MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name "$rec" --set "話者B=佐藤"
    [ "$status" -eq 0 ]
    run grep -q '^unresolved_speakers:' "$note"
    [ "$status" -eq 1 ]
    grep -qxF '**[00:00:05] 佐藤**: どうも' "$BATS_TEST_TMPDIR/notes/meetings/transcripts/2026-01-01-a.md"
    MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name
    [[ "$output" == *"未確定の話者が残る議事録はありません"* ]]
}

@test "name は MEETING_NOTES_DIR の外の output_dir にある議事録を見つけ、全文は MEETING_NOTES_DIR 相対で書き換える" {
    command -v python3 >/dev/null 2>&1 || skip "python3 not available"
    stub_tools
    global_output_dir "~/Google Drive/議事録"
    out="$HOME/Google Drive/議事録"
    rec="$MEETING_HOME/2026-01-01_1000-a"
    write_note 2026-01-01-c "$MEETING_HOME/2026-01-01_1000-c" ""

    # 探すだけの name は output_dir が無くても作らない (共有先に空フォルダを作らない)
    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"未確定の話者が残る議事録はありません"* ]]
    [ ! -e "$HOME/Google Drive" ]

    write_note 2026-01-01-a "$rec" "話者A"
    mkdir -p "$out"
    mv "$BATS_TEST_TMPDIR/notes/meetings/2026-01-01-a.md" "$out/"

    PATH="$BATS_TEST_TMPDIR/stub:$PATH" MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name
    echo "$output"
    [ "$status" -eq 0 ]
    mapfile -t args < "$BATS_TEST_TMPDIR/claude.args"
    [ "${args[2]}" = "--add-dir" ]
    [ "${args[3]}" = "$out" ]
    [ "${args[4]}" = "/meeting-notes $rec --name-unresolved $out/2026-01-01-a.md" ]

    MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name "$rec" --set "話者A=田中"
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
    MEETING_NOTES_DIR="$BATS_TEST_TMPDIR/notes" run bash "$SCRIPT" name "$rec" --set "話者A=田中"
    echo "$output"
    [ "$status" -eq 0 ]
    grep -qxF '**[00:00:01] 田中**: はい' "$HOME/tx/2026-01-01-a.md"
}
