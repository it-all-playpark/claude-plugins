// システム音声 (ScreenCaptureKit) とマイク (AVAudioEngine) を別トラックの WAV に録音する。

import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

func log(_ s: String) {
    let ts = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withInternetDateTime])
    fputs("[meeting-rec \(ts)] \(s)\n", stderr)
}

// MARK: - Track writer

/// CMSampleBuffer を時間軸を保ったまま WAV に書き出す。
/// 先頭や途中に音が来なかった区間は PTS を見てゼロ埋めする。
final class TrackWriter {
    let url: URL
    let origin: CMTime
    private var file: AVAudioFile?
    private var format: AVAudioFormat?
    private(set) var framesWritten: AVAudioFramePosition = 0

    init(url: URL, origin: CMTime) {
        self.url = url
        self.origin = origin
    }

    var seconds: Double {
        guard let f = format else { return 0 }
        return Double(framesWritten) / f.sampleRate
    }

    func append(_ sb: CMSampleBuffer) {
        guard sb.isValid, sb.numSamples > 0, let fd = sb.formatDescription else { return }
        do {
            try sb.withAudioBufferList { abl, _ in
                guard let raw = AVAudioPCMBuffer(
                    pcmFormat: AVAudioFormat(cmAudioFormatDescription: fd), bufferListNoCopy: abl.unsafePointer)
                else { return }
                try write(raw, at: sb.presentationTimeStamp)
            }
        } catch {
            log("write error (\(url.lastPathComponent)): \(error)")
        }
    }

    /// pts は host clock 上の時刻 (origin と同じ時計)
    func append(_ pcm: AVAudioPCMBuffer, at pts: CMTime) {
        do {
            try write(pcm, at: pts)
        } catch {
            log("write error (\(url.lastPathComponent)): \(error)")
        }
    }

    private func write(_ raw: AVAudioPCMBuffer, at pts: CMTime) throws {
        let pcm = downmix(raw)
        let fmt = pcm.format
        if file == nil {
            file = try AVAudioFile(
                forWriting: url, settings: fmt.settings,
                commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
            format = fmt
        }
        try padSilence(until: pts, format: fmt)
        try file?.write(from: pcm)
        framesWritten += AVAudioFramePosition(pcm.frameLength)
    }

    /// マイクは config.channelCount が効かず入力デバイスのチャンネル数で届く (仮想デバイスで 8ch など)。
    /// 文字起こしは mono しか使わないので、平均して mono にしてから書く
    private func downmix(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        let fmt = pcm.format
        guard fmt.channelCount > 1, fmt.commonFormat == .pcmFormatFloat32, let src = pcm.floatChannelData,
              let mono = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: 1, interleaved: false),
              let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: pcm.frameLength),
              let dst = out.floatChannelData?[0]
        else { return pcm }
        out.frameLength = pcm.frameLength
        let n = Int(fmt.channelCount)
        for f in 0..<Int(pcm.frameLength) {
            var sum: Float = 0
            for c in 0..<n {
                // interleaved は先頭チャンネルのポインタに stride 間隔で全チャンネルが並ぶ
                sum += fmt.isInterleaved ? src[0][f * pcm.stride + c] : src[c][f]
            }
            dst[f] = sum / Float(n)
        }
        return out
    }

    private func padSilence(until pts: CMTime, format fmt: AVAudioFormat) throws {
        let offset = CMTimeGetSeconds(CMTimeSubtract(pts, origin))
        guard offset.isFinite, offset > 0 else { return }
        var gap = AVAudioFramePosition(offset * fmt.sampleRate) - framesWritten
        // 50ms 未満のずれはジッタとして無視
        guard gap > AVAudioFramePosition(fmt.sampleRate * 0.05) else { return }
        let chunk = AVAudioFrameCount(fmt.sampleRate)  // 1 秒ずつ
        while gap > 0 {
            let n = AVAudioFrameCount(min(AVAudioFramePosition(chunk), gap))
            guard let silence = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: n) else { return }
            silence.frameLength = n
            for buf in UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList) {
                if let p = buf.mData { memset(p, 0, Int(buf.mDataByteSize)) }
            }
            try file?.write(from: silence)
            framesWritten += AVAudioFramePosition(n)
            gap -= AVAudioFramePosition(n)
        }
    }

    func close() { file = nil }
}

// MARK: - Stream output

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let system: TrackWriter
    let mic: TrackWriter?
    let queue = DispatchQueue(label: "meeting-rec.audio")
    var onError: ((Error) -> Void)?

    init(system: TrackWriter, mic: TrackWriter?) {
        self.system = system
        self.mic = mic
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .audio: system.append(sb)
        case .screen: break  // 映像は使わない (SCStream の仕様上ダミーで受けている)
        case .microphone: break  // マイクは MicCapture で録る
        @unknown default: break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?(error)
    }
}

// MARK: - Microphone

/// マイクは ScreenCaptureKit (captureMicrophone) ではなく AVAudioEngine で入力デバイスを直接開く。
/// 録音中に入力デバイスやフォーマットが変わっても (Bluetooth の接続し直し等)、
/// AVAudioEngineConfigurationChange を受けて繋ぎ直し、同じ mic.wav に録り続けるため
final class MicCapture {
    private let engine = AVAudioEngine()
    private let lock = NSLock()  // 繋ぎ直し (通知スレッド) と stop の競合よけ
    private var stopped = false
    private let writer: TrackWriter
    private let queue: DispatchQueue
    private let deviceID: AudioDeviceID?
    private var observer: NSObjectProtocol?
    /// Bluetooth のモード切替やデバイス変更で入力のサンプルレート・チャンネル数が途中で変わっても
    /// 1 つの WAV に書き続けられるよう、常にこの形式に変換してから書く
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!

    init(writer: TrackWriter, queue: DispatchQueue, deviceUID: String?) throws {
        self.writer = writer
        self.queue = queue
        if let uid = deviceUID {
            guard let id = audioDeviceID(uid: uid) else { throw CaptureError.noMicDevice(uid) }
            deviceID = id
        } else {
            deviceID = nil
        }
    }

    func start() throws {
        lock.lock(); defer { lock.unlock() }
        try attach()
        try engine.start()
        // 入力デバイスやそのフォーマットが変わるとエンジンが止まるので、繋ぎ直して録り続ける。
        // エンジンは作り直さない: 新しいエンジンにデバイスを設定すると、それ自体がまた構成変更の通知になり
        // 繋ぎ直しが無限に続く
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in self?.restart() }
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        stopped = true
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        observer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func restart() {
        lock.lock(); defer { lock.unlock() }
        guard !stopped else { return }
        log("マイクの入力構成が変わったため繋ぎ直します")
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        do {
            try attach()
            try engine.start()
        } catch {
            log("マイクの再開に失敗: \(error)")
        }
    }

    private func attach() throws {
        let input = engine.inputNode
        // 設定すると構成変更の通知が来るので、既にそのデバイスなら触らない (繋ぎ直しのループよけ)
        if var id = deviceID, let unit = input.audioUnit, currentDevice(unit) != id {
            let st = AudioUnitSetProperty(
                unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                &id, UInt32(MemoryLayout<AudioDeviceID>.size))
            if st != noErr { throw CaptureError.start(NSError(domain: NSOSStatusErrorDomain, code: Int(st))) }
        }
        // tap のサンプルレートはハードウェアの入力と一致していないと NSException になる。
        // outputFormat はデバイス切替直後に古い値のことがあるので、ハードウェア側の inputFormat を使う
        let fmt = input.inputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0, let conv = AVAudioConverter(from: fmt, to: target) else {
            throw CaptureError.start(NSError(
                domain: "meeting-rec", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "マイクの入力フォーマットを扱えません: \(fmt)"]))
        }
        conv.downmix = true
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, when in
            self?.write(buf, when: when, converter: conv)
        }
    }

    private func write(_ buf: AVAudioPCMBuffer, when: AVAudioTime, converter: AVAudioConverter) {
        let cap = AVAudioFrameCount(Double(buf.frameLength) * target.sampleRate / buf.format.sampleRate) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buf
        }
        if let err { log("マイクの変換に失敗: \(err)"); return }
        guard out.frameLength > 0 else { return }
        // system.wav (ScreenCaptureKit の PTS) と同じ host clock に載せて時間軸を揃える
        let pts = when.isHostTimeValid
            ? CMClockMakeHostTimeFromSystemUnits(when.hostTime)
            : CMClockGetTime(CMClockGetHostTimeClock())
        queue.sync { writer.append(out, at: pts) }
    }
}

private func currentDevice(_ unit: AudioUnit) -> AudioDeviceID? {
    var id = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let st = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, &size)
    return st == noErr ? id : nil
}

/// CoreAudio のデバイス UID (= AVCaptureDevice.uniqueID) から AudioDeviceID を引く
private func audioDeviceID(uid: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cfUID = uid as CFString
    var id = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let st = withUnsafePointer(to: &cfUID) {
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<CFString>.size), $0, &size, &id)
    }
    return st == noErr && id != kAudioObjectUnknown ? id : nil
}

// MARK: - Session

struct CaptureOptions {
    var withMic = true
    var appFilters: [String] = []
    var micDeviceID: String?
}

enum CaptureError: Error, CustomStringConvertible {
    case permission(Error)
    case noDisplay
    case noMatchingApp([String])
    case noMicDevice(String)
    case start(Error)

    var description: String {
        switch self {
        case .permission(let e):
            return "画面収録の権限がありません。システム設定 > プライバシーとセキュリティ > 画面収録とシステムオーディオ録音 で許可してください。(\(e))"
        case .noDisplay: return "ディスプレイが見つかりません"
        case .noMatchingApp(let f): return "--app に一致する起動中アプリがありません: \(f). --list-apps で確認してください"
        case .noMicDevice(let id): return "--mic-device に一致するマイクがありません: \(id). --list-apps で確認してください"
        case .start(let e): return "録音を開始できません: \(e)"
        }
    }
}

final class CaptureSession {
    let outDir: URL
    let recorder: Recorder
    private let stream: SCStream
    private let mic: MicCapture?

    private init(outDir: URL, recorder: Recorder, stream: SCStream, mic: MicCapture?) {
        self.outDir = outDir
        self.recorder = recorder
        self.stream = stream
        self.mic = mic
    }

    static func start(outDir: URL, options o: CaptureOptions, onError: @escaping (Error) -> Void) async throws -> CaptureSession {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw CaptureError.permission(error)
        }
        guard let display = content.displays.first else { throw CaptureError.noDisplay }

        let filter: SCContentFilter
        if o.appFilters.isEmpty {
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        } else {
            let apps = content.applications.filter { app in
                let name = app.applicationName.lowercased()
                let bid = app.bundleIdentifier.lowercased()
                return o.appFilters.contains { name.contains($0) || bid.contains($0) }
            }
            if apps.isEmpty { throw CaptureError.noMatchingApp(o.appFilters) }
            log("録音対象アプリ: \(apps.map(\.applicationName).joined(separator: ", "))")
            filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 1
        // 映像は不要なので最小に
        config.width = 128
        config.height = 72
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false

        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let origin = CMClockGetTime(CMClockGetHostTimeClock())
        let recorder = Recorder(
            system: TrackWriter(url: outDir.appendingPathComponent("system.wav"), origin: origin),
            mic: o.withMic ? TrackWriter(url: outDir.appendingPathComponent("mic.wav"), origin: origin) : nil
        )
        recorder.onError = onError
        let mic = try recorder.mic.map { try MicCapture(writer: $0, queue: recorder.queue, deviceUID: o.micDeviceID) }

        let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
        do {
            try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
            try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: recorder.queue)
            try await stream.startCapture()
        } catch {
            throw CaptureError.start(error)
        }
        do {
            try mic?.start()
        } catch {
            mic?.stop()
            try? await stream.stopCapture()
            throw error as? CaptureError ?? CaptureError.start(error)
        }
        return CaptureSession(outDir: outDir, recorder: recorder, stream: stream, mic: mic)
    }

    /// 経過秒数 (system, mic)
    var elapsed: (system: Double, mic: Double) {
        recorder.queue.sync { (recorder.system.seconds, recorder.mic?.seconds ?? 0) }
    }

    @discardableResult
    func stop() async -> (system: Double, mic: Double) {
        mic?.stop()
        try? await stream.stopCapture()
        recorder.queue.sync {
            recorder.system.close()
            recorder.mic?.close()
        }
        return elapsed
    }
}

// MARK: - Signals

/// 複数の停止要因のうち最初の 1 つを待つ
final class StopSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<String, Never>?
    private var fired: String?

    func fire(_ reason: String) {
        lock.lock(); defer { lock.unlock() }
        guard fired == nil else { return }
        fired = reason
        cont?.resume(returning: reason)
        cont = nil
    }

    func wait() async -> String {
        await withCheckedContinuation { c in
            lock.lock(); defer { lock.unlock() }
            if let r = fired { c.resume(returning: r) } else { cont = c }
        }
    }
}

/// signal(2) を DispatchSource で受ける。返り値は保持しておくこと
func onSignals(_ sigs: [Int32], _ handler: @escaping (Int32) -> Void) -> [DispatchSourceSignal] {
    sigs.map { sig in
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { handler(sig) }
        src.resume()
        return src
    }
}

// MARK: - meta.json

func updateMeta(_ dir: URL, _ fields: [String: Any]) {
    let url = dir.appendingPathComponent("meta.json")
    var meta = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
    meta.merge(fields) { _, new in new }
    if let data = try? JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted, .sortedKeys]) {
        try? data.write(to: url)
    }
}

func nowISO() -> String {
    ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withInternetDateTime])
}
