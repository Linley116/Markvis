// EditorWindowController：NSWindow + WKWebView + JS 桥
//
// 桥协议复刻 Typora 的三通道语义：
//   1. 异步 JS→原生  webkit.messageHandlers["_bridge"].postMessage({handlerName, data, callbackId})
//   2. 异步 原生→JS  evaluateJavaScript("bridge._handleMessageFromObjC(<json string>)")
//   3. 同步 JS→原生  prompt("__bridge__", JSON) 由 WKUIDelegate 拦截并同步返回

import Cocoa
import WebKit
import PDFKit

// MARK: - 桥

final class Bridge: NSObject, WKScriptMessageHandler, WKUIDelegate {
    weak var webView: WKWebView?
    weak var window: NSWindow?
    weak var controller: EditorWindowController?

    // JS -> 原生（异步）
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let handler = body["handlerName"] as? String else { return }

        let data = body["data"]
        let callbackId = body["callbackId"] as? String

        let respond: (Any?) -> Void = { [weak self] result in
            guard let cb = callbackId else { return }
            self?.dispatchToJS(responseId: cb, payload: result)
        }

        switch handler {
        case "document.save":
            let dict = data as? [String: Any] ?? [:]
            let content = dict["content"] as? String ?? ""
            let saveAs = dict["saveAs"] as? Bool ?? false
            controller?.write(content: content, saveAs: saveAs) { path in
                respond(path)
            }

        case "document.open":
            controller?.openDocumentPanel()
            respond(nil)

        case "document.autoSave":
            let dict = data as? [String: Any] ?? [:]
            let content = dict["content"] as? String ?? ""
            controller?.writeSilently(content: content)
            respond(nil)

        case "images.savePNG":
            let dict = data as? [String: Any] ?? [:]
            let b64 = dict["base64"] as? String ?? ""
            let ext = dict["ext"] as? String ?? "png"
            respond(controller?.saveImage(base64: b64, ext: ext))

        case "document.setEdited":
            window?.isDocumentEdited = (data as? Bool) ?? false
            respond(nil)

        case "document.setTitle":
            if let title = data as? String, !title.isEmpty {
                window?.title = title
            }
            respond(nil)

        case "app.log":
            if let s = data as? String { NSLog("[web] %@", s) }
            respond(nil)

        case "app.ready":
            NSLog("MarkFrame: web layer ready")
            // 构建自检：仅当显式设置 MARKFRAME_SELFTEST 时落一份就绪标记
            if let marker = ProcessInfo.processInfo.environment["MARKFRAME_SELFTEST"] {
                let info = (data as? [String: Any])?["version"] as? String ?? "?"
                try? "ready \(info)".write(toFile: marker, atomically: true, encoding: .utf8)
            }
            // 文件树自检：MARKFRAME_TEST_LIBRARY=<marker> 时把某个目录的清单写成 JSON
            if let marker = ProcessInfo.processInfo.environment["MARKFRAME_TEST_LIBRARY"] {
                let dir = ProcessInfo.processInfo.environment["MARKFRAME_TEST_LIBRARY_DIR"] ?? ""
                // 自检时把测试目录当根目录用，不污染用户的根目录偏好
                let list = controller?.libraryList(path: dir, root: dir.isEmpty ? nil : dir) ?? []
                let summary: [String: Any] = [
                    "count": list.count,
                    "names": list.compactMap { $0["name"] as? String },
                    "dirs": list.compactMap { $0["dir"] as? Bool },
                    "paths": list.compactMap { $0["path"] as? String }
                ]
                if let json = jsonEncode(summary) {
                    try? json.write(toFile: marker, atomically: true, encoding: .utf8)
                }
            }
            // 文件树自检：MARKFRAME_TEST_LIBRARY=<marker> 时把某个目录的清单写成 JSON
            if let marker = ProcessInfo.processInfo.environment["MARKFRAME_TEST_LIBRARY"] {
                let dir = ProcessInfo.processInfo.environment["MARKFRAME_TEST_LIBRARY_DIR"] ?? ""
                // 自检时把测试目录当根目录，不污染用户的根目录偏好
                let list = controller?.libraryList(path: dir, root: dir.isEmpty ? nil : dir) ?? []
                let summary: [String: Any] = [
                    "count": list.count,
                    "names": list.compactMap { $0["name"] as? String },
                    "dirs": list.compactMap { $0["dir"] as? Bool },
                    "paths": list.compactMap { $0["path"] as? String }
                ]
                if let json = jsonEncode(summary) {
                    try? json.write(toFile: marker, atomically: true, encoding: .utf8)
                }
            }
            // 自定义主题自检：MARKFRAME_TEST_THEMES=<marker> 时把主题清单写成 JSON
            if let marker = ProcessInfo.processInfo.environment["MARKFRAME_TEST_THEMES"] {
                let list = controller?.themeList() ?? []
                let ids = list.compactMap { $0["id"] as? String }
                let firstCSS = ids.first.flatMap { controller?.themeCSS(id: $0)?["css"] as? String } ?? ""
                let summary: [String: Any] = [
                    "count": list.count,
                    "ids": ids,
                    "names": list.compactMap { $0["name"] as? String },
                    "cssBytes": firstCSS.count
                ]
                if let json = jsonEncode(summary) {
                    try? json.write(toFile: marker, atomically: true, encoding: .utf8)
                }
            }
            respond(nil)

        case "library.list":
            let dict = data as? [String: Any] ?? [:]
            respond(controller?.libraryList(path: dict["path"] as? String ?? ""))

        case "library.root":
            respond(["root": controller?.effectiveLibraryRoot() ?? ""])

        case "library.setRoot":
            let p = (data as? [String: Any])?["path"] as? String ?? ""
            var isDir: ObjCBool = false
            if !p.isEmpty, FileManager.default.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue {
                EditorWindowController.libraryRoot = p
            }
            respond(["root": controller?.effectiveLibraryRoot() ?? ""])

        case "library.chooseRoot":
            controller?.chooseLibraryRoot()
            respond(nil)

        case "library.create":
            let dict = data as? [String: Any] ?? [:]
            respond(controller?.libraryCreate(
                in: dict["path"] as? String ?? "",
                name: dict["name"] as? String ?? "",
                kind: dict["kind"] as? String ?? "file"))

        case "library.rename":
            let dict = data as? [String: Any] ?? [:]
            respond(controller?.libraryRename(
                path: dict["path"] as? String ?? "",
                name: dict["name"] as? String ?? ""))

        case "library.delete":
            let p = (data as? [String: Any])?["path"] as? String ?? ""
            respond(controller?.libraryDelete(path: p))

        case "library.reveal":
            let p = (data as? [String: Any])?["path"] as? String ?? ""
            controller?.libraryReveal(path: p)
            respond(nil)

        case "document.openPath":
            let p = (data as? [String: Any])?["path"] as? String ?? ""
            if !p.isEmpty { controller?.requestOpenFile?(p) }
            respond(nil)

        case "themes.list":
            respond(controller?.themeList() ?? [])

        case "themes.read":
            let dict = data as? [String: Any] ?? [:]
            let id = dict["id"] as? String ?? ""
            respond(controller?.themeCSS(id: id))

        case "themes.openFolder":
            controller?.openThemesFolder()
            respond(nil)

        default:
            respond(nil)
        }
    }

    // JS -> 原生（同步，经 prompt 拦截）
    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard prompt == "__bridge__",
              let json = defaultText,
              let data = json.data(using: .utf8),
              let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let name = dict["name"] as? String else {
            completionHandler(nil)
            return
        }
        let method = dict["method"] as? String ?? ""

        switch "\(name).\(method)" {
        case "document.getPath":
            completionHandler(jsonEncode(["path": controller?.currentPath ?? ""]))
        case "document.isEdited":
            completionHandler(jsonEncode(["edited": window?.isDocumentEdited ?? false]))
        case "document.getTitle":
            completionHandler(jsonEncode(["title": window?.title ?? ""]))
        default:
            completionHandler(jsonEncode([:]))
        }
    }

    private func dispatchToJS(responseId: String, payload: Any?) {
        let message: [String: Any] = [
            "responseId": responseId,
            "responseData": payload ?? NSNull()
        ]
        guard let inner = jsonEncode(message) else { return }
        // _handleMessageFromObjC 接收的是"JSON 字符串"，故需再包一层字符串字面量
        let literal = jsStringLiteral(inner)
        webView?.evaluateJavaScript("window.bridge && window.bridge._handleMessageFromObjC(\(literal));")
    }
}

// MARK: - 诊断日志（NSLog 在重定向场景下不进 stderr）

func mfLog(_ s: String) {
    FileHandle.standardError.write(("[MarkFrame] " + s + "\n").data(using: .utf8)!)
}

// MARK: - JSON 辅助

func jsonEncode(_ obj: Any) -> String? {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let s = String(data: data, encoding: .utf8) else { return nil }
    return s
}

/// 把任意字符串变成合法的 JS 字符串字面量（含引号）
func jsStringLiteral(_ s: String) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
       let wrapped = String(data: data, encoding: .utf8) {
        // wrapped 形如 ["..."]，去掉外层方括号即得带引号的字面量
        return String(wrapped.dropFirst().dropLast())
    }
    return "\"\""
}

// MARK: - 窗口

final class EditorWindowController: NSWindowController {
    private(set) var webView: WKWebView!
    private(set) var bridge: Bridge!
    private(set) var currentPath: String = ""

    /// 成功打开文件后回调（AppDelegate 用来记「最近打开」）
    var onOpenFile: ((String) -> Void)?

    /// 当前窗口不适合接这个文件时（已脏/已有文档），交给 AppDelegate 开新窗口
    var requestOpenFile: ((String) -> Void)?

    /// 空白未命名且无修改：可以就地加载新文档，不必开新窗口
    var isReusable: Bool {
        currentPath.isEmpty && (window?.isDocumentEdited != true)
    }

    private var pendingLoadPath: String?
    private var pendingContent: (path: String, content: String, title: String)?

    private var pendingZoom: Double = 1.0

    /// bundle 里的 web/ 目录，以及当前 WebView 被授予的可读根目录
    private var webRoot: URL?
    private var readRoot: URL?

    /// 未命名文档的崩溃恢复文件（有路径的文档直接自动保存到原文件，不需要它）
    private var recoveryFile: URL?

    // MARK: 崩溃恢复

    /// ~/Library/Application Support/MarkFrame/Recovery
    static let recoveryDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("MarkFrame/Recovery", isDirectory: true)
    }()

    /// 上次会话遗留的恢复文件（按修改时间倒序，超过 30 天的顺手删掉）
    static func pendingRecoveryFiles() -> [URL] {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(
            at: recoveryDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]) else { return [] }

        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        var fresh: [(URL, Date)] = []
        for url in items where url.pathExtension == "md" {
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            if date < cutoff {
                try? fm.removeItem(at: url)
            } else {
                fresh.append((url, date))
            }
        }
        return fresh.sorted { $0.1 > $1.1 }.map { $0.0 }
    }

    static func discardRecoveryFiles(_ urls: [URL]) {
        for url in urls { try? FileManager.default.removeItem(at: url) }
    }

    /// 内容落进恢复目录（只对未命名文档调用）
    private func writeRecovery(content: String) {
        let dir = Self.recoveryDir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if recoveryFile == nil {
            let stamp = Int(Date().timeIntervalSince1970)
            let rand = UUID().uuidString.prefix(6).lowercased()
            recoveryFile = dir.appendingPathComponent("untitled-\(stamp)-\(rand).md")
        }
        guard let url = recoveryFile else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            mfLog("recovery write failed: \(error)")
        }
    }

    /// 保存到真实文件、或用户主动关窗后，恢复文件就没用了
    func discardRecovery() {
        guard let url = recoveryFile else { return }
        try? FileManager.default.removeItem(at: url)
        recoveryFile = nil
    }

    /// 从恢复文件恢复成一个「未命名但已编辑」的窗口
    func restore(from url: URL) {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        recoveryFile = url
        applyContent(path: "", content: text, title: L10n.t("Recovered", "已恢复"))
        window?.isDocumentEdited = true
        mfLog("restored \(url.lastPathComponent) (\(text.count) chars)")
    }

    // MARK: 自定义主题

    /// ~/Library/Application Support/MarkFrame/themes
    static let themesDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("MarkFrame/themes", isDirectory: true)
    }()

    /// 目录不存在就建；里面一个 .css 都没有时，拷一份带注释的示例进去当文档
    private func prepareThemesFolder() {
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.themesDir, withIntermediateDirectories: true)

        let existing = (try? fm.contentsOfDirectory(at: Self.themesDir, includingPropertiesForKeys: nil)) ?? []
        guard !existing.contains(where: { $0.pathExtension.lowercased() == "css" }) else { return }

        guard let sample = Bundle.main.resourceURL?
            .appendingPathComponent("web/themes/example.css"),
              fm.fileExists(atPath: sample.path) else { return }
        try? fm.copyItem(at: sample, to: Self.themesDir.appendingPathComponent("example.css"))
    }

    /// 主题文件夹里的 .css 列表（名字优先取文件里的 @name 注释）
    func themeList() -> [[String: Any]] {
        prepareThemesFolder()
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(
            at: Self.themesDir,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]) else { return [] }

        var out: [[String: Any]] = []
        for url in items where url.pathExtension.lowercased() == "css" {
            let id = url.deletingPathExtension().lastPathComponent
            out.append([
                "id": id,
                "name": themeDisplayName(at: url) ?? id,
                "path": url.path
            ])
        }
        return out.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    /// 读一个主题的 CSS。id 只接受主题目录下的单层文件名，避免路径穿越。
    func themeCSS(id rawId: String) -> [String: Any]? {
        var id = rawId
        if id.lowercased().hasSuffix(".css") { id = String(id.dropLast(4)) }
        guard !id.isEmpty, !id.contains("/"), !id.contains("..") else { return nil }

        let url = Self.themesDir.appendingPathComponent(id + ".css").standardizedFileURL
        guard url.path.hasPrefix(Self.themesDir.standardizedFileURL.path + "/") else { return nil }

        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? Int, size < 1_000_000 else { return nil }
        guard let css = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return ["css": css, "name": themeDisplayName(at: url) ?? id]
    }

    // MARK: 文件树（F9）

    static let libraryRootKey = "mf.library.root"

    static var libraryRoot: String {
        get { UserDefaults.standard.string(forKey: libraryRootKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: libraryRootKey) }
    }

    /// 根目录：用户选过就用选过的；否则跟着当前文档；再否则 Home
    func effectiveLibraryRoot() -> String {
        let saved = Self.libraryRoot
        if !saved.isEmpty {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: saved, isDirectory: &isDir), isDir.boolValue {
                return saved
            }
        }
        if !currentPath.isEmpty { return (currentPath as NSString).deletingLastPathComponent }
        return NSHomeDirectory()
    }

    /// 路径必须落在根目录内，否则拒绝（防 ../ 穿越）
    private func safeEntryURL(_ raw: String, root: String) -> URL? {
        guard !raw.isEmpty else { return nil }
        let url = URL(fileURLWithPath: raw).standardizedFileURL
        let rootURL = URL(fileURLWithPath: root).standardizedFileURL
        guard url.path.hasPrefix(rootURL.path + "/") else { return nil }
        return url
    }

    func libraryList(path raw: String, root: String? = nil) -> [[String: Any]] {
        let root = root ?? effectiveLibraryRoot()
        let dir: URL
        if raw.isEmpty {
            dir = URL(fileURLWithPath: root)
        } else if let safe = safeEntryURL(raw, root: root) {
            dir = safe
        } else {
            dir = URL(fileURLWithPath: root)
        }

        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }

        var out: [[String: Any]] = []
        for url in items where !url.lastPathComponent.hasPrefix(".") {
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            out.append([
                "name": url.lastPathComponent,
                "path": url.path,
                "dir": isDir,
                "ext": url.pathExtension.lowercased()
            ])
        }
        return out.sorted { a, b in
            let ad = a["dir"] as? Bool ?? false
            let bd = b["dir"] as? Bool ?? false
            if ad != bd { return ad }
            let an = a["name"] as? String ?? ""
            let bn = b["name"] as? String ?? ""
            return an.localizedStandardCompare(bn) == .orderedAscending
        }
    }

    func libraryCreate(in rawDir: String, name: String, kind: String) -> [String: Any] {
        let root = effectiveLibraryRoot()
        let dir = rawDir.isEmpty
            ? URL(fileURLWithPath: root)
            : (safeEntryURL(rawDir, root: root) ?? URL(fileURLWithPath: root))

        var clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !clean.contains("/") else { return ["error": "bad name"] }
        if kind != "dir" && !clean.lowercased().hasSuffix(".md") { clean += ".md" }

        let target = dir.appendingPathComponent(clean).standardizedFileURL
        guard target.path.hasPrefix(dir.standardizedFileURL.path + "/") else { return ["error": "bad name"] }

        let fm = FileManager.default
        do {
            if kind == "dir" {
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
            } else {
                try Data().write(to: target)
            }
            return ["ok": true, "path": target.path]
        } catch {
            return ["error": "\(error)"]
        }
    }

    func libraryRename(path raw: String, name: String) -> [String: Any] {
        let root = effectiveLibraryRoot()
        guard let url = safeEntryURL(raw, root: root) else { return ["error": "bad path"] }
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !clean.contains("/") else { return ["error": "bad name"] }

        let target = url.deletingLastPathComponent().appendingPathComponent(clean).standardizedFileURL
        do {
            try FileManager.default.moveItem(at: url, to: target)
            return ["ok": true, "path": target.path]
        } catch {
            return ["error": "\(error)"]
        }
    }

    /// 删除进废纸篓（不直接抹掉）
    func libraryDelete(path raw: String) -> [String: Any] {
        let root = effectiveLibraryRoot()
        guard let url = safeEntryURL(raw, root: root) else { return ["error": "bad path"] }

        let fm = FileManager.default
        let trash = fm.urls(for: .trashDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".Trash")
        var target = trash.appendingPathComponent(url.lastPathComponent)
        var n = 1
        while fm.fileExists(atPath: target.path) {
            let base = url.deletingPathExtension().lastPathComponent
            target = trash.appendingPathComponent("\(base).\(n).\(url.pathExtension)")
            n += 1
        }
        do {
            try fm.moveItem(at: url, to: target)
            return ["ok": true]
        } catch {
            return ["error": "\(error)"]
        }
    }

    func libraryReveal(path raw: String) {
        let root = effectiveLibraryRoot()
        guard let url = safeEntryURL(raw, root: root) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func chooseLibraryRoot() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window!) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            Self.libraryRoot = url.path
            self?.runJS("window.MFLibrary && window.MFLibrary.rootChanged()")
        }
    }

    func openThemesFolder() {
        prepareThemesFolder()
        NSWorkspace.shared.open(Self.themesDir)
    }

    /// 只认单行指令：`/* @name: 纸墨 */` 或裸写 `@name: 纸墨`。
    /// 多行注释里的说明文字（示例文件开头那些）不会被当成指令。
    private func themeDisplayName(at url: URL) -> String? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let head = String(text.prefix(2000))
        let patterns = [
            "(?m)^\\s*/\\*\\s*@name\\s*:\\s*([^*]+?)\\s*\\*/\\s*$",
            "(?m)^\\s*@name\\s*:\\s*(.+?)\\s*$"
        ]
        for pattern in patterns {
            guard let re = try? NSRegularExpression(pattern: pattern),
                  let m = re.firstMatch(in: head, range: NSRange(head.startIndex..., in: head)),
                  let range = Range(m.range(at: 1), in: head) else { continue }
            let name = String(head[range]).trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { return name }
        }
        return nil
    }

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = L10n.t("Untitled", "未命名")
        window.minSize = NSSize(width: 560, height: 420)
        window.center()
        window.setFrameAutosaveName("MarkFrameMainWindow")
        window.tabbingMode = .preferred
        window.tabbingIdentifier = "MarkFrame"
        self.init(window: window)

        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        bridge = Bridge()
        bridge.window = window
        bridge.controller = self
        ucc.add(bridge, name: "_bridge")
        config.userContentController = ucc
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = bridge
        webView.setValue(false, forKey: "drawsBackground")
        webView.unregisterDraggedTypes()
        bridge.webView = webView

        // 容器负责接收拖进来的 .md 文件（WKWebView 自己会把文件 drop 当成导航）
        let container = DropContainerView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        container.onFiles = { [weak self] urls in
            guard let first = urls.first else { return }
            self?.load(path: first.path)
        }
        container.addSubview(webView)
        window.contentView = container

        window.delegate = self

        guard let webDir = Bundle.main.url(forResource: "web", withExtension: nil) else {
            NSLog("web resources missing")
            return
        }
        webRoot = webDir
        readRoot = webDir
        let index = webDir.appendingPathComponent("index.html")
        webView.navigationDelegate = self
        webView.loadFileURL(index, allowingReadAccessTo: webDir)

        // 自动化验证入口：设置 MARKFRAME_EXPORT_PDF=/tmp/x.pdf 时，
        // 启动后自动导出一次 PDF（跳过保存面板）
        if let pdfPath = ProcessInfo.processInfo.environment["MARKFRAME_EXPORT_PDF"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
                self?.runJS("window.__prepareExport && window.__prepareExport()")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self?.writePDF(to: URL(fileURLWithPath: pdfPath))
                }
            }
        }

        // 自动化验证入口：设置 MARKFRAME_TEST_RECOVERY=<文本> 时模拟一次自动保存，
        // 用来验证「未命名文档 → 恢复目录」这条链路（正常由 web 层每 1.2s 触发）
        if let text = ProcessInfo.processInfo.environment["MARKFRAME_TEST_RECOVERY"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.writeSilently(content: text)
                mfLog("test recovery written")
            }
        }

        // 自动化验证入口：设置 MARKFRAME_TEST_IMAGE=<marker> 时写入一张 1x1 PNG 并回报路径
        if let marker = ProcessInfo.processInfo.environment["MARKFRAME_TEST_IMAGE"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
                let rel = self?.saveImage(base64: b64, ext: "png") ?? "FAILED"
                try? rel.write(toFile: marker, atomically: true, encoding: .utf8)
            }
        }
    }

    // MARK: JS 调用

    func runJS(_ code: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(code)
        }
    }

    private func runJSReturning(_ code: String, _ completion: @escaping (Any?) -> Void) {
        webView.evaluateJavaScript(code) { result, error in
            if let error = error { NSLog("evaluateJavaScript error: %@", "\(error)") }
            completion(result)
        }
    }

    // MARK: 文档动作

    func newDocument() {
        currentPath = ""
        runJS("window.__loadContent('', '', \(jsStringLiteral(L10n.t("Untitled", "未命名"))))")
    }

    func save(saveAs: Bool, then completion: (() -> Void)? = nil) {
        runJSReturning("window.__getMarkdown()") { [weak self] result in
            let content = result as? String ?? ""
            self?.write(content: content, saveAs: saveAs) { path in
                if path != nil { completion?() }
            }
        }
    }

    /// 写盘；无路径或 saveAs 时弹保存面板
    func write(content: String, saveAs: Bool, completion: @escaping (String?) -> Void) {
        if !saveAs && !currentPath.isEmpty {
            do {
                try content.write(toFile: currentPath, atomically: true, encoding: .utf8)
                markSaved()
                completion(currentPath)
            } catch {
                showErrorAlert(error)
                completion(nil)
            }
            return
        }

        let panel = NSSavePanel()
        panel.allowedContentTypes = []
        panel.nameFieldStringValue = suggestedName()
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window!) { [weak self] response in
            guard response == .OK, let url = panel.url else {
                completion(nil)
                return
            }
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                self?.currentPath = url.path
                self?.window?.title = url.lastPathComponent
                self?.markSaved()
                self?.runJS("window.__onSaved(\(jsStringLiteral(url.path)))")
                completion(url.path)
            } catch {
                self?.showErrorAlert(error)
                completion(nil)
            }
        }
    }

    /// 把粘贴进来的图片写到文档同级 assets/，返回相对路径
    func saveImage(base64: String, ext: String) -> String? {
        guard !currentPath.isEmpty else { return nil }
        guard let data = Data(base64Encoded: base64) else { return nil }

        let dir = URL(fileURLWithPath: currentPath).deletingLastPathComponent()
        let assets = dir.appendingPathComponent("assets")
        try? FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)

        let stamp = Int(Date().timeIntervalSince1970)
        let rand = UUID().uuidString.prefix(6).lowercased()
        let name = "image-\(stamp)-\(rand).\(ext)"
        let url = assets.appendingPathComponent(name)

        do {
            try data.write(to: url)
            mfLog("saved image: \(name) (\(data.count) bytes)")
            return "assets/\(name)"
        } catch {
            mfLog("save image failed: \(error)")
            return nil
        }
    }

    private func markSaved() {
        window?.isDocumentEdited = false
        // 已经落到真实文件上，恢复文件不再需要
        discardRecovery()
    }

    /// 自动保存：已保存的文档静默写回原文件；未命名文档写进恢复目录，
    /// 这样断电/崩溃也能在下次启动时找回来。
    func writeSilently(content: String) {
        if currentPath.isEmpty {
            writeRecovery(content: content)
            return
        }
        do {
            try content.write(toFile: currentPath, atomically: true, encoding: .utf8)
            window?.isDocumentEdited = false
        } catch {
            mfLog("autosave failed: \(error)")
        }
    }

    private func suggestedName() -> String {
        if !currentPath.isEmpty { return (currentPath as NSString).lastPathComponent }
        return L10n.t("Untitled", "未命名") + ".md"
    }

    func openDocumentPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window!) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            guard let self = self else { return }
            // 空白窗口就地打开；已有内容的窗口交给 AppDelegate 决定复用还是新窗口
            if self.isReusable {
                self.load(path: url.path)
            } else {
                self.requestOpenFile?(url.path)
            }
        }
    }

    func load(path: String) {
        // 页面还没加载完时先排队，等 didFinish 再执行（否则 evaluate 会丢失）
        if webView.isLoading || webView.url == nil {
            pendingLoadPath = path
            return
        }
        performLoad(path: path)
    }

    private func performLoad(path: String) {
        let url = URL(fileURLWithPath: path)
        var text: String?
        for enc in [String.Encoding.utf8, .utf16, .isoLatin1] {
            if let s = try? String(contentsOf: url, encoding: enc) { text = s; break }
        }
        guard let content = text else { return }

        // 文档目录若不在当前可读范围外，把读取权限放宽到 web/ 与文档目录的
        // 公共祖先并重载页面 —— 否则相对路径的图片（file:// 解析后）会被
        // WebKit 拦掉，编辑器里显示不出来，分页测量也会出错。
        let docDir = url.deletingLastPathComponent()
        if !isReadable(docDir) {
            reloadWithWiderAccess(covering: docDir)
            pendingContent = (path, content, url.lastPathComponent)
            return
        }

        applyContent(path: path, content: content, title: url.lastPathComponent)
    }

    private func applyContent(path: String, content: String, title: String) {
        currentPath = path
        // 窗口里换了文档：上一个未命名文档的恢复文件作废
        if !path.isEmpty { discardRecovery() }
        window?.title = title
        window?.isDocumentEdited = false
        runJS("window.__loadContent(\(jsStringLiteral(path)), \(jsStringLiteral(content)), \(jsStringLiteral(title)))")
        onOpenFile?(path)
    }

    private func isReadable(_ dir: URL) -> Bool {
        guard let root = readRoot else { return false }
        // 把两者都标准化后再比较前缀
        let rootPath = root.standardizedFileURL.path
        let dirPath = dir.standardizedFileURL.path
        return dirPath == rootPath || dirPath.hasPrefix(rootPath + "/")
    }

    /// 两个目录的最近公共祖先
    private func commonAncestor(_ a: URL, _ b: URL) -> URL {
        let ap = a.standardizedFileURL.pathComponents
        let bp = b.standardizedFileURL.pathComponents
        var shared: [String] = []
        for i in 0..<min(ap.count, bp.count) {
            if ap[i] == bp[i] { shared.append(ap[i]) } else { break }
        }
        if shared.isEmpty { return URL(fileURLWithPath: "/") }
        return URL(fileURLWithPath: "/" + shared.dropFirst().joined(separator: "/"))
    }

    private func reloadWithWiderAccess(covering dir: URL) {
        guard let webDir = webRoot else { return }
        let index = webDir.appendingPathComponent("index.html")
        let root = commonAncestor(webDir, dir)
        readRoot = root
        mfLog("widen read access to: \(root.path)")
        webView.loadFileURL(index, allowingReadAccessTo: root)
    }

    // MARK: 导出时把本地图片内联成 data URL
    //
    // 导出视图（临时目录里的打印壳）与独立 HTML 都读不到文档目录里的图片，
    // 唯一可靠的办法是原生把文件读出来转 base64。按路径做了缓存，
    // 同一张图出现在多页时只读一次。

    private var imageDataCache: [String: String] = [:]

    private func mimeForExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }

    private func dataURLForFile(_ fileURL: URL) -> String? {
        let key = fileURL.path
        if let hit = imageDataCache[key] { return hit }
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        let mime = mimeForExtension(fileURL.pathExtension)
        let encoded = "data:\(mime);base64,\(data.base64EncodedString())"
        imageDataCache[key] = encoded
        return encoded
    }

    /// 把 HTML 里 src="file://…" 的本地图片替换为 data URL（读不到的保持原样）
    private func inlineImages(in html: String) -> String {
        guard html.contains("src=\"file://") else { return html }
        guard let re = try? NSRegularExpression(pattern: "src=\"(file://[^\"]+)\"") else { return html }

        var out = ""
        var cursor = html.startIndex
        let full = NSRange(html.startIndex..., in: html)

        for m in re.matches(in: html, range: full) {
            guard let whole = Range(m.range, in: html),
                  let srcRange = Range(m.range(at: 1), in: html) else { continue }
            let rawPath = String(html[srcRange]).replacingOccurrences(of: "file://", with: "")
            let path = rawPath.removingPercentEncoding ?? rawPath
            guard let dataURL = dataURLForFile(URL(fileURLWithPath: path)) else { continue }

            out += html[cursor..<whole.lowerBound]
            out += "src=\"\(dataURL)\""
            cursor = whole.upperBound
        }
        out += html[cursor...]
        return out
    }

    // MARK: 导出

    func exportPDF() {
        runJSReturning("window.__prepareExport && window.__prepareExport()") { [weak self] _ in
            guard let self = self else { return }
            // 给页面一点时间完成样式切换再进入打印管线
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.presentExportPanel(ext: "pdf") { url in
                    self.writePDF(to: url)
                }
            }
        }
    }

    func exportHTML() {
        let js = "window.__prepareExport && window.__prepareExport(); " +
                 "window.__buildExportHTML ? window.__buildExportHTML() : null"
        runJSReturning(js) { [weak self] result in
            guard let self = self, let raw = result as? String, !raw.isEmpty else { return }
            // 图片转 data URL，导出的单文件才是真正自包含的
            let html = self.inlineImages(in: self.injectCSS(into: raw, forPrint: false))
            self.presentExportPanel(ext: "html") { url in
                do {
                    try html.write(to: url, atomically: true, encoding: .utf8)
                    self.runJS("window.__finishExport && window.__finishExport()")
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } catch {
                    self.runJS("window.__finishExport && window.__finishExport()")
                    self.showErrorAlert(error)
                }
            }
        }
    }

    /// 把包内的 style.css 注入导出 HTML。
    ///
    /// 不能在 JS 里读 document.styleSheets：WKWebView 把 file:// 样式表当跨域，
    /// cssRules 会抛 SecurityError，导致导出文件完全没有样式。
    private func injectCSS(into html: String, forPrint: Bool = true) -> String {
        var out = html
        if out.contains("/*__MF_CSS__*/") {
            out = out.replacingOccurrences(of: "/*__MF_CSS__*/", with: bundledCSS())
        }
        if out.contains("/*__MF_KATEX_CSS__*/") {
            out = out.replacingOccurrences(of: "/*__MF_KATEX_CSS__*/",
                                           with: katexCSS(embedFonts: !forPrint))
        }
        return out
    }

    /// KaTeX 的样式表。PDF 走「字体随壳目录一起拷」；HTML 导出走 base64 内联，
    /// 这样导出的单文件换台机器也能正确显示公式。
    private func katexCSS(embedFonts: Bool) -> String {
        guard let cssURL = Bundle.main.resourceURL?
            .appendingPathComponent("web/vendor/katex/katex.min.css"),
              let css = try? String(contentsOf: cssURL, encoding: .utf8) else { return "" }
        guard embedFonts else { return css }

        guard let re = try? NSRegularExpression(pattern: "url\\(fonts/([^)]+\\.woff2)\\)") else {
            return css
        }
        let fontsDir = cssURL.deletingLastPathComponent().appendingPathComponent("fonts")
        var out = ""
        var cursor = css.startIndex
        for m in re.matches(in: css, range: NSRange(css.startIndex..., in: css)) {
            guard let whole = Range(m.range, in: css),
                  let nameRange = Range(m.range(at: 1), in: css) else { continue }
            let name = String(css[nameRange])
            let fontURL = fontsDir.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: fontURL) else { continue }
            out += css[cursor..<whole.lowerBound]
            out += "url(data:font/woff2;base64,\(data.base64EncodedString()))"
            cursor = whole.upperBound
        }
        out += css[cursor...]
        return out
    }

    /// 打印壳目录里放一份字体，katex.min.css 里的相对 url(fonts/…) 就能解析
    private func copyKatexFonts(to dir: URL) {
        guard let src = Bundle.main.resourceURL?
            .appendingPathComponent("web/vendor/katex/fonts") else { return }
        let dst = dir.appendingPathComponent("fonts", isDirectory: true)
        try? FileManager.default.removeItem(at: dst)
        try? FileManager.default.copyItem(at: src, to: dst)
    }

    private func bundledCSS() -> String {
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("web/style.css"),
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/web/style.css")
        ]
        for url in candidates {
            if let url = url, let css = try? String(contentsOf: url, encoding: .utf8), !css.isEmpty {
                return css
            }
        }
        mfLog("bundledCSS: style.css not found")
        return ""
    }

    private func presentExportPanel(ext: String, completion: @escaping (URL) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = defaultExportName(ext: ext)
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window!) { response in
            guard response == .OK, let url = panel.url else {
                self.runJS("window.__finishExport && window.__finishExport()")
                return
            }
            completion(url)
        }
    }

    private func defaultExportName(ext: String) -> String {
        if currentPath.isEmpty { return L10n.t("Untitled", "未命名") + ".\(ext)" }
        let base = ((currentPath as NSString).lastPathComponent as NSString).deletingPathExtension
        return "\(base).\(ext)"
    }

    // MARK: PDF 导出
    //
    // 不用 WebKit 的打印管线：本机实测 printOperation 会产出十万级空白页
    // （分页失控），NSPrintOperation(view:) 又因 WebKit 内容在独立进程而全空白。
    // 因此按 Typora 的思路自己做版面：JS 侧把文档排进 A4 页框（794×1123 px），
    // 原生在独立 WebView 里逐页 createPDF，最后合并缩放到 595×842 pt。

    private var exportWindow: NSWindow?
    private var exportWebView: WKWebView?
    private var exportPages: [String] = []
    private var exportRendered: [PDFDocument] = []
    private var exportDocs: [PDFDocument] = []
    private var exportDest: URL?
    private var exportGeometry = CGSize(width: 794, height: 1123)

    private func writePDF(to url: URL) {
        exportDest = url
        exportPages = []
        exportRendered = []
        exportDocs = []

        let js = "JSON.stringify(window.__paginateForPrint ? window.__paginateForPrint() : null)"
        runJSReturning(js) { [weak self] result in
            guard let self = self else { return }
            guard let json = result as? String,
                  let data = json.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let pages = obj["pages"] as? [String], !pages.isEmpty,
                  let pw = obj["pageW"] as? Double,
                  let ph = obj["pageH"] as? Double else {
                self.runJS("window.__finishExport && window.__finishExport()")
                self.showSimpleAlert(L10n.t("Pagination failed: empty document", "分页失败：文档为空"))
                return
            }

            self.exportPages = pages
            self.exportGeometry = CGSize(width: pw, height: ph)
            mfLog("paginate: \(pages.count) pages \(Int(pw))x\(Int(ph)) splits=\(obj["splits"] ?? "-")")

            self.runJSReturning("window.__printShellHTML ? window.__printShellHTML() : ''") { shell in
                guard let html = shell as? String, !html.isEmpty else {
                    self.runJS("window.__finishExport && window.__finishExport()")
                    self.showSimpleAlert(L10n.t("Export failed: could not build print stylesheet", "导出失败：无法生成打印样式"))
                    return
                }
                self.startRenderPipeline(shellHTML: html)
            }
        }
    }

    private func startRenderPipeline(shellHTML: String) {
        // 打印壳在临时目录里，读不到文档目录的图片：先内联成 data URL
        let html = inlineImages(in: injectCSS(into: shellHTML))
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("markframe-print-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            showErrorAlert(error)
            runJS("window.__finishExport && window.__finishExport()")
            return
        }
        copyKatexFonts(to: dir)
        let shell = dir.appendingPathComponent("page.html")
        do {
            try html.write(to: shell, atomically: true, encoding: .utf8)
        } catch {
            showErrorAlert(error)
            runJS("window.__finishExport && window.__finishExport()")
            return
        }

        let size = exportGeometry
        let web = WKWebView(frame: NSRect(origin: .zero, size: size))
        let win = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: size.width, height: size.height),
                           styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = web
        win.orderFrontRegardless()
        exportWindow = win
        exportWebView = web

        web.loadFileURL(shell, allowingReadAccessTo: dir)
        waitForShell(tries: 0, shell: shell)
    }

    private func waitForShell(tries: Int, shell: URL) {
        guard let web = exportWebView else { return }
        web.evaluateJavaScript("document.readyState") { [weak self] state, _ in
            guard let self = self else { return }
            if (state as? String) == "complete" || tries > 80 {
                // 首帧：等 WebKit 完成首次绘制，否则第一页会抓成空白
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.renderPage(0, shell: shell)
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    self.waitForShell(tries: tries + 1, shell: shell)
                }
            }
        }
    }

    private func renderPage(_ index: Int, shell: URL, attempt: Int = 0) {
        guard let web = exportWebView, let dest = exportDest else { return }
        if index >= exportPages.count {
            finishExport(to: dest, shell: shell)
            return
        }

        let html = jsStringLiteral(exportPages[index])
        let expectText = pageHasText(exportPages[index])

        web.evaluateJavaScript("window.__setPrintPage(\(html))") { [weak self] _, _ in
            guard let self = self else { return }
            // 留一点时间完成重排与字体栅格化
            let settle = attempt == 0 ? 0.04 : 0.15
            DispatchQueue.main.asyncAfter(deadline: .now() + settle) {
                let cfg = WKPDFConfiguration()
                cfg.rect = CGRect(origin: .zero, size: self.exportGeometry)
                web.createPDF(configuration: cfg) { result in
                    var capturedDoc: PDFDocument?
                    if case .success(let data) = result, let doc = PDFDocument(data: data),
                       doc.page(at: 0) != nil {
                        capturedDoc = doc
                    }

                    // 空页重试：刚建立的导出视图偶尔会抓到未绘制的首帧
                    let empty = (capturedDoc?.page(at: 0)?.string ?? "").isEmpty
                    if empty && expectText && attempt < 2 {
                        mfLog("page \(index) empty, retry \(attempt + 1)")
                        DispatchQueue.main.async {
                            self.renderPage(index, shell: shell, attempt: attempt + 1)
                        }
                        return
                    }

                    if let doc = capturedDoc { self.exportRendered.append(doc) }
                    else { mfLog("page \(index) capture failed") }

                    DispatchQueue.main.async { self.renderPage(index + 1, shell: shell) }
                }
            }
        }
    }

    /// 这一页是否应该含有可提取文本（用于判断空页重试）
    private func pageHasText(_ html: String) -> Bool {
        let stripped = html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        return !stripped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func finishExport(to url: URL, shell: URL) {
        defer { teardownExport() }
        runJS("window.__finishExport && window.__finishExport()")

        guard !exportRendered.isEmpty else {
            showSimpleAlert(L10n.t("Export failed: no pages captured", "导出失败：没有捕获到页面"))
            return
        }

        let a4 = CGSize(width: 595, height: 842)
        guard let consumer = CGDataConsumer(url: url as CFURL) else { return }
        var box = CGRect(origin: .zero, size: a4)
        guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return }

        for doc in exportRendered {
            guard let page = doc.page(at: 0) else { continue }
            ctx.beginPDFPage(nil)
            let r = page.bounds(for: .mediaBox)
            ctx.saveGState()
            if r.width > 0 && r.height > 0 {
                ctx.scaleBy(x: a4.width / r.width, y: a4.height / r.height)
            }
            page.draw(with: .mediaBox, to: ctx)
            ctx.restoreGState()
            ctx.endPDFPage()
        }
        ctx.closePDF()

        try? FileManager.default.removeItem(at: shell.deletingLastPathComponent())
        NSWorkspace.shared.activateFileViewerSelecting([url])
        mfLog("export done: \(exportRendered.count) pages -> \(url.lastPathComponent)")
    }

    private func teardownExport() {
        exportWindow?.orderOut(nil)
        exportWindow = nil
        exportWebView = nil
        exportPages = []
        exportRendered = []
        exportDocs = []
    }

    private func showSimpleAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: L10n.t("OK", "好"))
        alert.beginSheetModal(for: window!)
    }

    // MARK: 未保存确认

    func confirmDiscardIfNeeded(_ proceed: @escaping () -> Void) {
        guard window?.isDocumentEdited == true else { proceed(); return }
        let alert = NSAlert()
        alert.messageText = L10n.t("This document has unsaved changes", "当前文档有未保存的修改")
        alert.informativeText = L10n.t("Continuing will discard them.", "继续将丢弃这些修改。")
        alert.addButton(withTitle: L10n.t("Discard and Continue", "丢弃并继续"))
        alert.addButton(withTitle: L10n.t("Cancel", "取消"))
        alert.beginSheetModal(for: window!) { response in
            if response == .alertFirstButtonReturn { proceed() }
        }
    }

    private func showErrorAlert(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.beginSheetModal(for: window!)
    }
}

// MARK: - 页面加载完成

extension EditorWindowController: WKNavigationDelegate {
    /// 正文里点链接不能把编辑器本身导航走（WKWebView 默认会直接加载目标页面），
    /// 一律取消并用系统默认浏览器打开。页面自身的 file:// 加载照常放行。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" || scheme == "mailto" {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 页面就绪后再补上启动时排队的文件（新的打开请求优先，丢弃旧的排队内容）
        if let path = pendingLoadPath {
            pendingLoadPath = nil
            pendingContent = nil
            performLoad(path: path)
            return
        }
        // 扩大读取权限后重载的页面：就绪后灌入排队的文档
        if let queued = pendingContent {
            pendingContent = nil
            applyContent(path: queued.path, content: queued.content, title: queued.title)
        }
    }
}

// MARK: - 拖拽打开

final class DropContainerView: NSView {
    var onFiles: (([URL]) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    private func markdownURLs(_ info: NSDraggingInfo) -> [URL] {
        guard let urls = info.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: nil) as? [URL] else { return [] }
        let exts: Set<String> = ["md", "markdown", "mdown", "txt"]
        return urls.filter { exts.contains($0.pathExtension.lowercased()) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        markdownURLs(sender).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        markdownURLs(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = markdownURLs(sender)
        guard !urls.isEmpty else { return false }
        onFiles?(urls)
        return true
    }
}

// MARK: - 关闭前确认
//
// 普通 NSWindow 关闭时不会像 NSDocument 那样自动询问，未保存内容会被静默丢弃。

extension EditorWindowController: NSWindowDelegate {
    /// 关窗意味着内容已经保存或用户主动放弃，恢复文件可以删了
    func windowWillClose(_ notification: Notification) {
        discardRecovery()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender.isDocumentEdited else { return true }

        let alert = NSAlert()
        alert.messageText = L10n.t("This document has unsaved changes", "当前文档有未保存的修改")
        alert.informativeText = L10n.t("These changes will be lost if you close it. Save first?", "关闭后这些修改会丢失。要保存吗？")
        alert.addButton(withTitle: L10n.t("Save and Close", "保存并关闭"))
        alert.addButton(withTitle: L10n.t("Cancel", "取消"))
        alert.addButton(withTitle: L10n.t("Discard Changes", "放弃修改"))

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            save(saveAs: false) { [weak self] in
                self?.window?.isDocumentEdited = false
                self?.window?.close()
            }
            return false          // 等异步保存完成后再关
        case .alertThirdButtonReturn:
            return true
        default:
            return false
        }
    }
}
