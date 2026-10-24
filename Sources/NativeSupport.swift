import Foundation

/// 不依赖窗口或 WebView 的原生核心逻辑，供 App 与 XCTest 共用。
enum MFPath {
    /// /tmp 与 /private/tmp 这类软链差异也认成同一个文件。
    static func same(_ a: String, _ b: String) -> Bool {
        if a.isEmpty || b.isEmpty { return false }
        if a == b { return true }
        let ua = URL(fileURLWithPath: a).resolvingSymlinksInPath().path
        let ub = URL(fileURLWithPath: b).resolvingSymlinksInPath().path
        return ua == ub
    }

    /// FSEvents 报真实路径；文件树和自写登记统一使用用户可见路径。
    static func real(_ path: String) -> String {
        path.hasPrefix("/private") ? String(path.dropFirst("/private".count)) : path
    }

    /// 根本身允许由 libraryList 单独处理；文件操作必须落在根的子级。
    static func entry(_ raw: String, root: String) -> URL? {
        guard !raw.isEmpty else { return nil }
        let url = URL(fileURLWithPath: raw).standardizedFileURL
        let rootURL = URL(fileURLWithPath: root).standardizedFileURL
        guard url.path.hasPrefix(rootURL.path + "/") else { return nil }
        return url
    }

    /// 启动恢复：保留原顺序，跳过已删除文件，并限制恢复数量。
    static func restorableFiles(
        _ saved: [String],
        limit: Int = 10,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> [String] {
        guard limit > 0 else { return [] }
        let existing = saved.filter { !$0.isEmpty && fileExists($0) }
        return Array(existing.prefix(limit))
    }
}
