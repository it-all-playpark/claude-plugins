// 会議アプリがマイクを使い始めたら自動で録音し、離したら止めて後処理を起動する常駐モード。
//
// 検知方法: CoreAudio のプロセスオブジェクト (macOS 14+) から「いまマイク入力を使っている
// プロセス」の bundle id を取り、既知の会議アプリと照合する。主催者・URL・カレンダーに依存しない。

import AppKit
import CoreAudio
import Foundation

// MARK: - Mic users (CoreAudio)

struct AudioProcess {
    let pid: pid_t
    let bundleID: String
    let input: Bool  // マイク使用中
    let output: Bool  // 音声出力中
}

private func prop<T>(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
    return st == noErr ? value : nil
}

/// いま音声入出力を行っているプロセス一覧
func audioProcesses() -> [AudioProcess] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }

    let me = getpid()
    return ids.compactMap { id in
        let input = prop(id, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1
        let output = prop(id, kAudioProcessPropertyIsRunningOutput, UInt32(0)) == 1
        guard input || output, let pid = prop(id, kAudioProcessPropertyPID, pid_t(0)), pid != me
        else { return nil }
        var bid = ""
        if let cf = prop(id, kAudioProcessPropertyBundleID, Unmanaged<CFString>?.none), let s = cf {
            bid = s.takeRetainedValue() as String
        }
        if bid.isEmpty { bid = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "" }
        return AudioProcess(pid: pid, bundleID: bid, input: input, output: output)
    }
}

// MARK: - Meeting apps

struct MeetingApp {
    let prefix: String  // bundle id の前方一致 (ヘルパープロセスも拾うため)
    let name: String
    var isBrowser = false  // ブラウザは会議以外でも音を出すので「出力中」を会議継続とみなさない
}

/// 既定の会議アプリ。MEETING_APPS="us.zoom.=Zoom,com.microsoft.teams=Teams" で上書きできる
let defaultMeetingApps: [MeetingApp] = [
    .init(prefix: "us.zoom.", name: "Zoom"),
    .init(prefix: "com.microsoft.teams", name: "Teams"),
    .init(prefix: "Cisco-Systems.Spark", name: "Webex"),
    .init(prefix: "com.tinyspeck.slackmacgap", name: "Slack"),
    .init(prefix: "com.hnc.Discord", name: "Discord"),
    .init(prefix: "com.apple.FaceTime", name: "FaceTime"),
    // ブラウザ (Google Meet 等)。ブラウザでマイクを使う = Web 会議とみなす
    .init(prefix: "com.google.Chrome", name: "Chrome", isBrowser: true),
    .init(prefix: "company.thebrowser.", name: "Arc", isBrowser: true),
    .init(prefix: "com.brave.Browser", name: "Brave", isBrowser: true),
    .init(prefix: "com.microsoft.edgemac", name: "Edge", isBrowser: true),
    .init(prefix: "org.mozilla.firefox", name: "Firefox", isBrowser: true),
    .init(prefix: "com.apple.WebKit.GPU", name: "Safari", isBrowser: true),
]

func meetingAppsFromEnv() -> [MeetingApp] {
    guard let raw = ProcessInfo.processInfo.environment["MEETING_APPS"], !raw.isEmpty else {
        return defaultMeetingApps
    }
    return raw.split(separator: ",").map { item in
        let kv = item.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        return MeetingApp(prefix: kv[0], name: kv.count > 1 ? kv[1] : kv[0])
    }
}

/// マイクを使っている会議アプリ
func meetingAppUsingMic(_ apps: [MeetingApp], _ procs: [AudioProcess]) -> MeetingApp? {
    apps.first { app in procs.contains { $0.input && $0.bundleID.hasPrefix(app.prefix) } }
}

/// 会議がまだ続いているか: マイク使用中、または (専用アプリなら) 音声出力中。
/// 長時間ミュートでアプリがマイクを閉じても、相手の声が鳴っていれば録音を続ける
func meetingStillActive(_ app: MeetingApp, _ procs: [AudioProcess]) -> Bool {
    procs.contains { p in
        p.bundleID.hasPrefix(app.prefix) && (p.input || (!app.isBrowser && p.output))
    }
}

// MARK: - Notification

func notify(_ message: String, title: String = "meeting-rec") {
    func esc(_ s: String) -> String { s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(esc(message))\" with title \"\(esc(title))\""]
    try? p.run()
}

// MARK: - Watch loop

struct WatchOptions {
    var home: URL
    var onStop: String?  // 録音終了後に `<onStop> post <dir>` を起動
    var capture = CaptureOptions()
    var apps = meetingAppsFromEnv()
    var startDelay: TimeInterval = 8  // マイク使用がこの秒数続いたら開始 (音声入力などの誤検知よけ)
    var stopGrace: TimeInterval = 45  // マイクを離してからこの秒数で終了 (デバイス切替などの瞬断よけ)
    var minSeconds: Double = 30  // これより短い録音は破棄 (マイクテスト等)
    var poll: TimeInterval = 2
}

private final class Flags: @unchecked Sendable {
    private let lock = NSLock()
    private var skip = false, quit = false
    private var error: String?
    func set(skip: Bool = false, quit: Bool = false, error: String? = nil) {
        lock.lock(); defer { lock.unlock() }
        if skip { self.skip = true }
        if quit { self.quit = true }
        if let e = error { self.error = e }
    }
    func take() -> (skip: Bool, quit: Bool, error: String?) {
        lock.lock(); defer { lock.unlock() }
        defer { skip = false; error = nil }
        return (skip, quit, error)
    }
}

func runWatch(_ o: WatchOptions) async -> Never {
    let flags = Flags()
    // SIGUSR1 = この会議の録音を破棄 (meeting skip) / SIGINT,SIGTERM = 終了 (録音中なら保存して後処理)
    let sources = onSignals([SIGINT, SIGTERM, SIGUSR1]) { sig in
        if sig == SIGUSR1 { flags.set(skip: true) } else { flags.set(quit: true) }
    }
    _ = sources

    var session: CaptureSession?
    var app: MeetingApp?
    var firstSeen: Date?
    var lastSeen = Date()
    var skipping = false  // この会議は録らない (skip / 開始失敗)。会議アプリがマイクを離したら解除

    func postProcess(_ dir: URL) {
        guard let cmd = o.onStop else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = ["post", dir.path]
        let logURL = dir.appendingPathComponent("postprocess.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = fh
            p.standardError = fh
        }
        do { try p.run() } catch { log("後処理を起動できません: \(error)") }
    }

    func finish(_ s: CaptureSession, discard: Bool = false) async {
        let (sys, mic) = await s.stop()
        updateMeta(s.outDir, ["ended_at": nowISO()])
        if discard || max(sys, mic) < o.minSeconds {
            try? FileManager.default.removeItem(at: s.outDir)
            log("録音を破棄: \(s.outDir.lastPathComponent) (\(discard ? "skip" : String(format: "%.0fs", max(sys, mic))))")
            if discard { notify("この会議の録音を破棄しました") }
            return
        }
        log(String(format: "録音終了: %@ (system %.0fs / mic %.0fs)", s.outDir.path, sys, mic))
        notify(String(format: "録音終了 (%.0f 分)。文字起こしを開始します", max(sys, mic) / 60))
        postProcess(s.outDir)
    }

    log("会議の検知を開始 (対象: \(o.apps.map(\.name).joined(separator: ", ")))")
    while true {
        let f = flags.take()
        let procs = audioProcesses()
        let now = Date()

        if f.quit {
            if let s = session { await finish(s) }
            log("終了")
            exit(0)
        }

        if let s = session {
            if let a = app, meetingStillActive(a, procs) { lastSeen = now }
            if f.skip {
                await finish(s, discard: true)
                session = nil
                skipping = true
            } else if let err = f.error {
                log("ストリームが停止: \(err)")
                await finish(s)
                session = nil  // 会議が続いていれば次のループで録り直す
                firstSeen = nil
            } else if now.timeIntervalSince(lastSeen) > o.stopGrace {
                log("\(app?.name ?? "?") の会議が終わりました")
                await finish(s)
                session = nil
                firstSeen = nil
            }
        } else if let a = meetingAppUsingMic(o.apps, procs) {
            if f.skip { skipping = true; notify("この会議は録音しません") }
            if !skipping {
                firstSeen = firstSeen ?? now
                if now.timeIntervalSince(firstSeen!) >= o.startDelay {
                    let df = DateFormatter()
                    df.dateFormat = "yyyy-MM-dd_HHmm"
                    let base = "\(df.string(from: now))-\(a.name)"
                    var dir = o.home.appendingPathComponent(base)
                    var n = 2
                    while FileManager.default.fileExists(atPath: dir.path) {  // 同じ分に録り直した場合
                        dir = o.home.appendingPathComponent("\(base)-\(n)")
                        n += 1
                    }
                    do {
                        session = try await CaptureSession.start(outDir: dir, options: o.capture) { err in
                            flags.set(error: "\(err)")
                        }
                        app = a
                        lastSeen = now
                        updateMeta(dir, ["title": "\(a.name) 会議", "app": a.name, "auto": true, "started_at": nowISO()])
                        log("録音開始: \(a.name) → \(dir.path)")
                        notify("\(a.name) の会議を録音中 (破棄: meeting skip)")
                    } catch {
                        log("録音開始に失敗: \(error)")
                        notify("録音を開始できませんでした: \(error)")
                        try? FileManager.default.removeItem(at: dir)
                        skipping = true
                    }
                }
            }
        } else {
            firstSeen = nil
            skipping = false
        }

        try? await Task.sleep(nanoseconds: UInt64(o.poll * 1_000_000_000))
    }
}
