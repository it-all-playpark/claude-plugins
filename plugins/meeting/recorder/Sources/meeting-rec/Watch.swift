// 会議アプリがマイクを使い始めたら自動で録音し、離したら止めて後処理を起動する常駐モード。
//
// 検知方法: CoreAudio のプロセスオブジェクト (macOS 14+) から「いまマイク入力を使っている
// プロセス」の bundle id を取り、既知の会議アプリと照合する。主催者・URL・カレンダーに依存しない。

import AVFoundation
import AppKit
import CoreAudio
import Foundation
import ScreenCaptureKit

// MARK: - Mic users (CoreAudio)

struct AudioProcess {
    let pid: pid_t
    let bundleID: String
    let input: Bool  // マイク使用中
    let output: Bool  // 音声出力中
    let inputDevices: [AudioDeviceID]  // いま入力に使っているデバイス
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
        return AudioProcess(
            pid: pid, bundleID: bid, input: input, output: output,
            // global scope では空が返る。入力デバイスは input scope で聞く
            inputDevices: input ? objectIDs(id, kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeInput) : [])
    }
}

private func objectIDs(
    _ obj: AudioObjectID, _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func stringProp(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    guard let cf = prop(obj, selector, Unmanaged<CFString>?.none), let s = cf else { return nil }
    return s.takeRetainedValue() as String
}

/// 会議アプリがマイク入力に使っているデバイス (UID, 名前)。
/// 既定の入力は BlackHole 等の仮想デバイスに戻っていることがあり、それを録ると全サンプル 0 になる
/// (会議アプリは自分の設定で選んだマイクを直接開くので気付けない)。アプリが拾っているマイクを録る
func meetingMicDevice(_ app: MeetingApp, _ procs: [AudioProcess]) -> (uid: String, name: String)? {
    let inputs = procs.filter { $0.input && $0.bundleID.hasPrefix(app.prefix) }.flatMap(\.inputDevices)
    // 会議アプリが自前の仮想デバイスも開いている場合に備え、実デバイスを優先する
    let isVirtual = { (d: AudioDeviceID) in prop(d, kAudioDevicePropertyTransportType, UInt32(0)) == kAudioDeviceTransportTypeVirtual }
    guard let d = inputs.first(where: { !isVirtual($0) }) ?? inputs.first,
          let uid = stringProp(d, kAudioDevicePropertyDeviceUID)
    else { return nil }
    return (uid, stringProp(d, kAudioObjectPropertyName) ?? uid)
}

// MARK: - Meeting apps (MeetingApp と既定の一覧は Config.swift)

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

// MARK: - Permissions

/// 常駐の起動時 (meeting install 直後) に画面収録とマイクの許可を求める。
/// 最初の会議で初めて求めると、ダイアログに答える前に録音開始が TCC で拒否され、その会議を録り逃す
func requestPermissions() async {
    do {
        _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        log("画面収録の権限がありません。ダイアログかシステム設定で meeting-rec を許可すると録音できます: \(error)")
        notify("meeting-rec に「画面収録とシステムオーディオ録音」を許可してください")
    }
    if !(await AVCaptureDevice.requestAccess(for: .audio)) {
        log("マイクの権限がありません。自分の声 (mic.wav) は録音されません")
    }
}

// MARK: - Watch loop

struct WatchOptions {
    var home: URL?  // --home。無ければ設定ファイルの home
    var onStop: String?  // 録音終了後に `<onStop> post <dir>` を起動
    var capture = CaptureOptions()
    var config: MeetingConfig  // 起動時に読んだ設定。録音していない間は毎回読み直す
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
    var permissionNotified = false  // 権限待ちの通知をこの会議で出したか
    var config = o.config
    var configError: String?  // 同じ読み込みエラーをループのたびにログに出さない

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

    await requestPermissions()
    log("会議の検知を開始 (対象: \(config.apps.map(\.name).joined(separator: ", ")))")
    while true {
        let f = flags.take()
        let procs = audioProcesses()
        let now = Date()

        // 設定ファイルを書き換えたら常駐を登録し直さずに効かせる。録音中は保存先と対象を変えない。
        // 読めなくなったら直るまで前の設定で続ける
        if session == nil {
            do {
                let c = try MeetingConfig.load()
                if c != config {
                    config = c
                    log("設定を読み直しました (保存先: \(c.home.path), 対象: \(c.apps.map(\.name).joined(separator: ", ")))")
                }
                configError = nil
            } catch {
                if "\(error)" != configError { log("設定ファイルを読めないため前の設定で続けます: \(error)") }
                configError = "\(error)"
            }
        }

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
        } else if let a = meetingAppUsingMic(config.apps, procs) {
            if f.skip { skipping = true; notify("この会議は録音しません") }
            if !skipping {
                firstSeen = firstSeen ?? now
                if now.timeIntervalSince(firstSeen!) >= o.startDelay {
                    let df = DateFormatter()
                    df.dateFormat = "yyyy-MM-dd_HHmm"
                    let base = "\(df.string(from: now))-\(a.name)"
                    let home = o.home ?? config.home
                    var dir = home.appendingPathComponent(base)
                    var n = 2
                    while FileManager.default.fileExists(atPath: dir.path) {  // 同じ分に録り直した場合
                        dir = home.appendingPathComponent("\(base)-\(n)")
                        n += 1
                    }
                    var capture = o.capture
                    let mic = capture.withMic && capture.micDeviceID == nil ? meetingMicDevice(a, procs) : nil
                    if let m = mic { capture.micDeviceID = m.uid }
                    do {
                        session = try await CaptureSession.start(outDir: dir, options: capture) { err in
                            flags.set(error: "\(err)")
                        }
                        app = a
                        lastSeen = now
                        updateMeta(dir, ["title": "\(a.name) 会議", "app": a.name, "auto": true, "started_at": nowISO()])
                        log("録音開始: \(a.name) → \(dir.path) (マイク: \(mic?.name ?? "システム既定"))")
                        notify("\(a.name) の会議を録音中 (破棄: meeting skip)")
                    } catch CaptureError.permission(let e) {
                        // 許可ダイアログに答えている最中かもしれないので、この会議を諦めず startDelay ごとに再試行する
                        try? FileManager.default.removeItem(at: dir)
                        firstSeen = nil
                        if !permissionNotified {
                            log("画面収録の権限待ち (許可されたら録音を開始): \(e)")
                            notify("meeting-rec に「画面収録とシステムオーディオ録音」を許可すると録音を開始します")
                            permissionNotified = true
                        }
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
            permissionNotified = false
        }

        try? await Task.sleep(nanoseconds: UInt64(o.poll * 1_000_000_000))
    }
}
