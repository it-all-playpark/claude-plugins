// ユーザー設定 (meeting setup が書く config.json) の読み込み。meeting.sh / transcribe.py と同じファイルを読む。
// 場所は $MEETING_CONFIG (常駐の plist が渡す)、無ければ ${XDG_CONFIG_HOME:-~/.config}/meeting/config.json。
// ユーザー設定を環境変数からは読まない (シェルごとに値が変わり、常駐と手動で別の値を見るため)

import Foundation

// MARK: - Meeting apps

struct MeetingApp: Equatable {
    let prefix: String  // bundle id の前方一致 (ヘルパープロセスも拾うため)
    let name: String
    var isBrowser = false  // ブラウザは会議以外でも音を出すので「出力中」を会議継続とみなさない
}

/// 既定の会議アプリ。設定ファイルの apps (["us.zoom.=Zoom", "com.microsoft.teams=Teams"]) で上書きできる
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

// MARK: - Config

struct ConfigError: Error, CustomStringConvertible {
    let description: String
}

struct MeetingConfig: Equatable {
    var home: URL  // 録音の保存先
    var apps: [MeetingApp]

    static func path(_ env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let p = env["MEETING_CONFIG"], !p.isEmpty { return URL(fileURLWithPath: p) }
        let base = env["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? homeDir(env) + "/.config"
        return URL(fileURLWithPath: base).appendingPathComponent("meeting/config.json")
    }

    /// 設定ファイルを読む。ファイルが無ければ既定値。読めない・形が違うときは ConfigError
    static func load(_ env: [String: String] = ProcessInfo.processInfo.environment) throws -> MeetingConfig {
        let url = path(env)
        guard FileManager.default.fileExists(atPath: url.path) else { return defaults(env) }
        let obj: Any
        do {
            obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        } catch {
            throw ConfigError(description: "\(url.path) を読めません: \(error.localizedDescription)")
        }
        guard let dict = obj as? [String: Any] else {
            throw ConfigError(description: "\(url.path) が JSON オブジェクトではありません")
        }
        do { return try parseChecked(dict, env) } catch let e as ConfigError {
            throw ConfigError(description: "\(url.path): \(e.description)")
        }
    }

    static func defaults(_ env: [String: String]) -> MeetingConfig {
        MeetingConfig(home: URL(fileURLWithPath: homeDir(env) + "/Meetings"), apps: defaultMeetingApps)
    }

    /// home / apps だけを読む (ほかのキーは meeting.sh / transcribe.py が読む)
    static func parseChecked(_ dict: [String: Any], _ env: [String: String]) throws -> MeetingConfig {
        var c = defaults(env)
        if let v = dict["home"] {
            guard let s = v as? String, !s.isEmpty else { throw ConfigError(description: "home は文字列で指定してください") }
            c.home = URL(fileURLWithPath: s.hasPrefix("~/") ? homeDir(env) + s.dropFirst() : s)
        }
        if let v = dict["apps"] {
            let usage = "apps は [\"us.zoom.=Zoom\", ...] (bundle id の前方一致=表示名) の文字列の配列で指定してください"
            guard let items = v as? [String] else { throw ConfigError(description: usage) }
            let apps = try items.map { item -> MeetingApp in
                let kv = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                guard !kv[0].isEmpty else { throw ConfigError(description: usage) }
                return MeetingApp(prefix: kv[0], name: kv.count > 1 && !kv[1].isEmpty ? kv[1] : kv[0])
            }
            if !apps.isEmpty { c.apps = apps }
        }
        return c
    }

    private static func homeDir(_ env: [String: String]) -> String {
        env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
    }
}
