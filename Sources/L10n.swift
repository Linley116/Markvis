// L10n：极简本地化
//
// 只有菜单和对话框需要翻译，字符串总量几十条，用「英文 + 中文并列」的
// 内联写法比 Localizable.strings 更好审阅：改文案时两种语言就在同一行，
// 不会出现 key 对不上、或者只改了一种语言的情况。
// 代价是加第三种语言时要改代码；真到那时候再迁到 .lproj 资源。

import Foundation

enum L10n {
    /// 跟随系统首选语言：zh-Hans / zh-Hant / zh-HK 都算中文
    static let isChinese: Bool = {
        let langs = UserDefaults.standard.stringArray(forKey: "AppleLanguages") ?? []
        return (langs.first ?? "").lowercased().hasPrefix("zh")
    }()

    static func t(_ en: String, _ zh: String) -> String {
        isChinese ? zh : en
    }
}
