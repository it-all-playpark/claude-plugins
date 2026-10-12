// swift-tools-version:5.9
import Foundation
import PackageDescription

// launchd から直接起動されたとき (= ターミナル経由でない) にマイク/画面収録の権限ダイアログを
// 出せるよう、Info.plist をバイナリに埋め込む
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "meeting-rec",
    platforms: [.macOS("15.0")],
    targets: [
        .executableTarget(
            name: "meeting-rec",
            path: "Sources/meeting-rec",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist])
            ]
        )
    ]
)
