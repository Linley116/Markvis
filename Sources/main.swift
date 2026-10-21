// MarkFrame 入口
// 原生 Cocoa 外壳：NSApplication + 菜单 + WKWebView 承载编辑器

import Cocoa

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
