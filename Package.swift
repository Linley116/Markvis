// swift-tools-version: 6.0
import PackageDescription

// SwiftPM 在这里只承担原生 XCTest；正式 .app 仍由 build.sh 直接调用 swiftc。
let package = Package(
    name: "Markvis",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "Markvis",
            path: "Sources",
            exclude: ["main.swift"],
            linkerSettings: [
                .linkedFramework("Cocoa"),
                .linkedFramework("WebKit"),
                .linkedFramework("PDFKit"),
                .linkedFramework("CoreServices")
            ]
        ),
        .testTarget(
            name: "MarkvisTests",
            dependencies: ["Markvis"],
            path: "test/NativeTests",
            exclude: ["main.swift"]
        )
    ],
    swiftLanguageModes: [.v5]
)
