// 从 MarkFrame 改名为 Markvis 时的一次性数据迁移。
//
// Bundle ID 变了以后，UserDefaults 和 Application Support 都会落到新目录。
// 这里在新版本第一次启动时把旧域和应用支持目录里的内容补过来，避免用户
// 丢掉最近文件、上次会话、文件树根目录和自定义主题；旧数据不删除。

import Foundation

enum LegacyMigration {
    private static let legacyBundleID = "local.markframe.editor"
    private static let legacySupportName = "MarkFrame"
    private static let currentSupportName = "Markvis"
    private static let defaultsFlag = "mf.migrated.fromMarkFrame.v1"

    static func run() {
        migratePreferences()
        migrateSupportDirectory()
    }

    /// 把旧 Bundle ID 域里新域还没有的键补过来；已存在的值不覆盖。
    private static func migratePreferences() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: defaultsFlag) else { return }

        if let legacy = CFPreferencesCopyMultiple(
            nil,
            legacyBundleID as CFString,
            kCFPreferencesCurrentUser,
            kCFPreferencesAnyHost
        ) as? [String: Any] {
            for (key, value) in legacy where defaults.object(forKey: key) == nil {
                defaults.set(value, forKey: key)
            }
            defaults.synchronize()
        }
        defaults.set(true, forKey: defaultsFlag)
    }

    /// ~/Library/Application Support/MarkFrame → ~/Library/Application Support/Markvis
    /// 只补缺失的文件，旧目录原样保留，不做破坏性移动。
    private static func migrateSupportDirectory() {
        let fm = FileManager.default
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let old = base.appendingPathComponent(legacySupportName, isDirectory: true)
        let new = base.appendingPathComponent(currentSupportName, isDirectory: true)
        guard fm.fileExists(atPath: old.path) else { return }

        do {
            try mergeContents(from: old, to: new)
        } catch {
            NSLog("Markvis: legacy support migration failed: %@", "\(error)")
        }
    }

    private static func mergeContents(from src: URL, to dst: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dst, withIntermediateDirectories: true)

        let items = try fm.contentsOfDirectory(
            at: src,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        for item in items {
            let target = dst.appendingPathComponent(item.lastPathComponent)
            if fm.fileExists(atPath: target.path) {
                let values = try item.resourceValues(forKeys: [.isDirectoryKey])
                if values.isDirectory == true {
                    try mergeContents(from: item, to: target)
                }
                continue
            }
            try fm.copyItem(at: item, to: target)
        }
    }
}
