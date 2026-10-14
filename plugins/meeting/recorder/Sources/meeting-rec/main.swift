// meeting-rec: 会議アプリの音声(システム出力)とマイクを別トラックで録音する。
//
// ScreenCaptureKit を使うので、主催者が誰であっても「自分の Mac で鳴っている音」は録れる。
// 出力:
//   <out>/system.wav  … 相手側の声 (Zoom/Meet/Teams などの再生音)
//   <out>/mic.wav     … 自分の声
// 両トラックは録音開始時刻を 0 とした同じ時間軸に揃えてある (無音区間はゼロ埋め)。
//
// モード:
//   meeting-rec --out DIR      手動録音 (Ctrl-C で停止)
//   meeting-rec --watch ...    常駐。会議アプリがマイクを使い始めたら自動録音 (Watch.swift)
//
// 必要な権限: 「画面収録とシステムオーディオ録音」「マイク」。

import AVFoundation
import Foundation
import ScreenCaptureKit

func usage() -> Never {
    print("""
    usage: meeting-rec --out DIR [capture opts] [--max-minutes N]
           meeting-rec --watch [--home DIR] [--on-stop CMD] [capture opts]
           meeting-rec --list-apps

    capture opts:
      --no-mic          マイクを録らない
      --app NAME        指定アプリの音だけ録る (bundle id かアプリ名の部分一致, 複数可)
      --mic-device ID   マイクの AVCaptureDevice uniqueID (省略時はシステム既定)

    手動録音:
      --out DIR         出力ディレクトリ (system.wav / mic.wav を作成)
      --max-minutes N   N 分で自動停止。Ctrl-C でも停止

    常駐 (自動録音):
      --watch           会議アプリ (Zoom/Teams/Meet 等) のマイク使用を検知して自動で録音
      --home DIR        録音の保存先 (DIR/<日時>-<アプリ>/)。省略時は設定ファイルの home
      --on-stop CMD     録音終了後に `CMD post <録音DIR>` を起動 (文字起こし等)
      SIGUSR1 で録音中/検知中の会議をスキップ (録音は破棄)

    --list-apps         アプリ一覧・マイク一覧・いま音声を使っているプロセスを表示
    """)
    exit(2)
}

struct Options {
    var outDir: URL?
    var capture = CaptureOptions()
    var maxSeconds: Double?
    var listApps = false
    var watch = false
    var home: URL?
    var onStop: String?
}

func parseOptions() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    func next() -> String { guard let v = it.next() else { usage() }; return v }
    while let a = it.next() {
        switch a {
        case "--out": o.outDir = URL(fileURLWithPath: next())
        case "--no-mic": o.capture.withMic = false
        case "--app": o.capture.appFilters.append(next().lowercased())
        case "--mic-device": o.capture.micDeviceID = next()
        case "--max-minutes": guard let m = Double(next()) else { usage() }; o.maxSeconds = m * 60
        case "--list-apps": o.listApps = true
        case "--watch": o.watch = true
        case "--home": o.home = URL(fileURLWithPath: next())
        case "--on-stop": o.onStop = next()
        case "-h", "--help": usage()
        default: fputs("unknown option: \(a)\n", stderr); usage()
        }
    }
    if o.listApps { return o }
    if !o.watch && o.outDir == nil { usage() }
    return o
}

func listApps() async {
    print("# apps (--app に指定可)")
    if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) {
        for app in content.applications.sorted(by: { $0.applicationName < $1.applicationName })
        where !app.applicationName.isEmpty {
            print("\(app.applicationName)\t\(app.bundleIdentifier)")
        }
    } else {
        print("(画面収録の権限がないため取得できません)")
    }
    print("\n# microphones (--mic-device に指定可)")
    let mics = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified
    ).devices
    for d in mics { print("\(d.localizedName)\t\(d.uniqueID)") }

    print("\n# いま音声を使っているプロセス (設定ファイルの apps に使う)")
    let apps = (try? MeetingConfig.load())?.apps ?? defaultMeetingApps
    for p in audioProcesses() {
        let io = [p.input ? "mic" : nil, p.output ? "out" : nil].compactMap { $0 }.joined(separator: "+")
        let match = apps.first { p.bundleID.hasPrefix($0.prefix) }.map { " ← \($0.name)" } ?? ""
        print("\(p.pid)\t\(io)\t\(p.bundleID)\(match)")
    }
}

func runManual(_ o: Options, outDir: URL) async -> Never {
    let stop = StopSignal()
    let session: CaptureSession
    do {
        session = try await CaptureSession.start(outDir: outDir, options: o.capture) { stop.fire("stream error: \($0)") }
    } catch {
        log("\(error)")
        exit(1)
    }
    log("録音中… Ctrl-C で停止 (出力: \(outDir.path))")

    let sources = onSignals([SIGINT, SIGTERM]) { stop.fire($0 == SIGINT ? "Ctrl-C" : "SIGTERM") }
    _ = sources
    if let max = o.maxSeconds {
        DispatchQueue.global().asyncAfter(deadline: .now() + max) { stop.fire("max-minutes") }
    }
    let ticker = DispatchSource.makeTimerSource(queue: .global())
    ticker.schedule(deadline: .now() + 10, repeating: 10)
    ticker.setEventHandler {
        let e = session.elapsed
        log(String(format: "経過 system %.0fs / mic %.0fs", e.system, e.mic))
    }
    ticker.resume()

    let reason = await stop.wait()
    ticker.cancel()
    log("停止: \(reason)")
    let (sysSec, micSec) = await session.stop()
    log(String(format: "保存しました system.wav %.1fs, mic.wav %.1fs", sysSec, micSec))
    if sysSec == 0 { log("警告: システム音声が 0 秒です。会議アプリの音が鳴っていたか、--app 指定を確認してください") }
    if o.capture.withMic && micSec == 0 { log("警告: マイク音声が 0 秒です。マイク権限を確認してください") }
    exit(0)
}

let opts = parseOptions()
if opts.listApps {
    await listApps()
    exit(0)
}
if opts.watch {
    let config: MeetingConfig
    do { config = try MeetingConfig.load() } catch {
        log("設定ファイルを読めません (meeting doctor で確認できます): \(error)")
        exit(1)
    }
    await runWatch(WatchOptions(home: opts.home, onStop: opts.onStop, capture: opts.capture, config: config))
}
if let out = opts.outDir {
    await runManual(opts, outDir: out)
}
usage()
