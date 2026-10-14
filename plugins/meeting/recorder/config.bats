#!/usr/bin/env bats
# Config.swift の MeetingConfig (meeting-rec が読む設定ファイルの home / apps) のテスト。
# Config.swift と小さな実行ファイルを swiftc で作り、環境変数と設定ファイルを変えて動かす。
# swiftc が無い環境 (Linux CI) では skip

setup_file() {
    [[ "$(uname)" == Darwin ]] && command -v swiftc >/dev/null || return 0
    cat > "$BATS_FILE_TMPDIR/harness.swift" <<'EOF'
import Foundation

@main
struct Harness {
    static func main() {
        print("path=\(MeetingConfig.path().path)")
        do {
            let c = try MeetingConfig.load()
            print("home=\(c.home.path)")
            for a in c.apps { print("app=\(a.prefix)|\(a.name)|\(a.isBrowser)") }
        } catch {
            print("error=\(error)")
        }
    }
}
EOF
    swiftc -parse-as-library -target arm64-apple-macosx15.0 -module-cache-path "$BATS_FILE_TMPDIR/mc" \
        -o "$BATS_FILE_TMPDIR/harness" \
        "$BATS_TEST_DIRNAME/Sources/meeting-rec/Config.swift" "$BATS_FILE_TMPDIR/harness.swift" 2>"$BATS_FILE_TMPDIR/build.log" \
        || { cat "$BATS_FILE_TMPDIR/build.log" >&2; return 1; }
}

setup() {
    [[ -x "$BATS_FILE_TMPDIR/harness" ]] || skip "swiftc (macOS) がない"
    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME/.config/meeting"
    unset MEETING_CONFIG XDG_CONFIG_HOME
}

@test "設定ファイルが無ければ ~/Meetings と既定の会議アプリを使う" {
    run "$BATS_FILE_TMPDIR/harness"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "path=$HOME/.config/meeting/config.json" ]
    [ "${lines[1]}" = "home=$HOME/Meetings" ]
    [[ "$output" == *"app=us.zoom.|Zoom|false"* ]]
    [[ "$output" == *"app=com.google.Chrome|Chrome|true"* ]]
}

@test "home と apps を設定ファイルから読み、~ は HOME に、表示名の無い apps は bundle id にする" {
    printf '{"home": "~/rec", "apps": ["us.zoom.=Zoom", " com.example.app "], "notes_dir": "/x", "asr_backend": "groq"}\n' \
        > "$HOME/.config/meeting/config.json"
    run "$BATS_FILE_TMPDIR/harness"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "${lines[1]}" = "home=$HOME/rec" ]
    [ "${lines[2]}" = "app=us.zoom.|Zoom|false" ]
    [ "${lines[3]}" = "app=com.example.app|com.example.app|false" ]
    [ "${#lines[@]}" -eq 4 ]
}

@test "MEETING_CONFIG があればそのファイル、無ければ XDG_CONFIG_HOME の下を読む" {
    mkdir -p "$BATS_TEST_TMPDIR/xdg/meeting"
    printf '{"home": "/from-xdg"}\n' > "$BATS_TEST_TMPDIR/xdg/meeting/config.json"
    printf '{"home": "/from-env"}\n' > "$BATS_TEST_TMPDIR/explicit.json"
    XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/xdg" run "$BATS_FILE_TMPDIR/harness"
    [ "${lines[1]}" = "home=/from-xdg" ]
    XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/xdg" MEETING_CONFIG="$BATS_TEST_TMPDIR/explicit.json" run "$BATS_FILE_TMPDIR/harness"
    [ "${lines[0]}" = "path=$BATS_TEST_TMPDIR/explicit.json" ]
    [ "${lines[1]}" = "home=/from-env" ]
}

@test "読めない JSON・型の違う home / apps はファイルの場所付きのエラーにする" {
    for bad in '{' '[]' '{"home": 1}' '{"apps": "us.zoom.=Zoom"}' '{"apps": ["=Zoom"]}'; do
        echo "$bad" > "$HOME/.config/meeting/config.json"
        run "$BATS_FILE_TMPDIR/harness"
        echo "$bad -> $output"
        [[ "${lines[1]}" == "error=$HOME/.config/meeting/config.json"* ]]
    done
}
