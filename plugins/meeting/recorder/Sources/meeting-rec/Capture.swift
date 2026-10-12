// ScreenCaptureKit でシステム音声とマイクを別トラックの WAV に録音する。

import AVFoundation
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
                let pcm = downmix(raw)
                let fmt = pcm.format
                if file == nil {
                    file = try AVAudioFile(
                        forWriting: url, settings: fmt.settings,
                        commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
                    format = fmt
                }
                try padSilence(until: sb.presentationTimeStamp, format: fmt)
                try file?.write(from: pcm)
                framesWritten += AVAudioFramePosition(pcm.frameLength)
            }
        } catch {
            log("write error (\(url.lastPathComponent)): \(error)")
        }
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
        case .microphone: mic?.append(sb)
        case .screen: break  // 映像は使わない (SCStream の仕様上ダミーで受けている)
        @unknown default: break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?(error)
    }
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
    case start(Error)

    var description: String {
        switch self {
        case .permission(let e):
            return "画面収録の権限がありません。システム設定 > プライバシーとセキュリティ > 画面収録とシステムオーディオ録音 で許可してください。(\(e))"
        case .noDisplay: return "ディスプレイが見つかりません"
        case .noMatchingApp(let f): return "--app に一致する起動中アプリがありません: \(f). --list-apps で確認してください"
        case .start(let e): return "録音を開始できません: \(e)"
        }
    }
}

final class CaptureSession {
    let outDir: URL
    let recorder: Recorder
    private let stream: SCStream

    private init(outDir: URL, recorder: Recorder, stream: SCStream) {
        self.outDir = outDir
        self.recorder = recorder
        self.stream = stream
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
        config.captureMicrophone = o.withMic
        if let id = o.micDeviceID { config.microphoneCaptureDeviceID = id }
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

        let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
        do {
            try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
            try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: recorder.queue)
            if o.withMic {
                try stream.addStreamOutput(recorder, type: .microphone, sampleHandlerQueue: recorder.queue)
            }
            try await stream.startCapture()
        } catch {
            throw CaptureError.start(error)
        }
        return CaptureSession(outDir: outDir, recorder: recorder, stream: stream)
    }

    /// 経過秒数 (system, mic)
    var elapsed: (system: Double, mic: Double) {
        recorder.queue.sync { (recorder.system.seconds, recorder.mic?.seconds ?? 0) }
    }

    @discardableResult
    func stop() async -> (system: Double, mic: Double) {
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
