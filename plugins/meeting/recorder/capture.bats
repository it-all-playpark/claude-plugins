#!/usr/bin/env bats
# Capture.swift の MicDevice (固定したマイクの引き直しと既定の入力への退避) のテスト。
# CoreAudio のデバイス検索を差し替えた小さな実行ファイルを swiftc で作って動かす。
# 実デバイスの抜き差しは実機でしか確かめられないので対象外。swiftc が無い環境 (Linux CI) では skip

setup_file() {
    [[ "$(uname)" == Darwin ]] && command -v swiftc >/dev/null || return 0
    cat > "$BATS_FILE_TMPDIR/harness.swift" <<'EOF'
import CoreAudio

@main
struct Harness {
    static func main() {
        let steps = CommandLine.arguments.dropFirst()
        var current: AudioDeviceID?
        var fallback: AudioDeviceID?
        var dev = MicDevice(uid: "BT-UID")
        dev.lookup = { uid in uid == "BT-UID" ? current : nil }
        dev.defaultInput = { fallback }
        // 引数は "<固定デバイスの ID|->:<既定の入力の ID|->" の並び。1 つごとに resolve して結果を出す
        for step in steps {
            let kv = step.split(separator: ":").map(String.init)
            current = AudioDeviceID(kv[0])
            fallback = AudioDeviceID(kv[1])
            let got = dev.resolve()
            print("resolve=\(got.map(String.init) ?? "-") missing=\(dev.missing)")
        }
    }
}
EOF
    swiftc -parse-as-library -target arm64-apple-macosx15.0 -module-cache-path "$BATS_FILE_TMPDIR/mc" \
        -o "$BATS_FILE_TMPDIR/harness" \
        "$BATS_TEST_DIRNAME/Sources/meeting-rec/Capture.swift" "$BATS_FILE_TMPDIR/harness.swift" 2>"$BATS_FILE_TMPDIR/build.log" \
        || { cat "$BATS_FILE_TMPDIR/build.log" >&2; return 1; }
}

setup() {
    [[ -x "$BATS_FILE_TMPDIR/harness" ]] || skip "swiftc (macOS) がない"
}

@test "固定したマイクが接続し直して別の AudioDeviceID になっても、新しい ID で繋ぐ" {
    run "$BATS_FILE_TMPDIR/harness" 10:7 -:7 42:7
    [ "$status" -eq 0 ]
    [[ "$output" == *"resolve=10 missing=false"* ]]
    [[ "$output" == *"resolve=42 missing=false"* ]]
    [[ "$output" == *"マイク BT-UID が戻ったため、このマイクで録音を続けます"* ]]
}

@test "固定したマイクが見つからない間はシステム既定の入力で録り、見失ったことを 1 回だけログに出す" {
    run "$BATS_FILE_TMPDIR/harness" 10:7 -:7 -:7
    [ "$status" -eq 0 ]
    [ "$(grep -c 'resolve=7 missing=true' <<<"$output")" -eq 2 ]
    [ "$(grep -c 'マイク BT-UID が見つからないため、戻るまでシステム既定の入力で録音します' <<<"$output")" -eq 1 ]
}

@test "固定したマイクもシステム既定の入力も無いときは、止まったことをログに出す" {
    run "$BATS_FILE_TMPDIR/harness" -:-
    [ "$status" -eq 0 ]
    [[ "$output" == *"resolve=- missing=true"* ]]
    [[ "$output" == *"システム既定の入力もないため、マイクの録音が止まっています"* ]]
}
