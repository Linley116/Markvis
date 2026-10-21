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

    private var pendingLoadPath: String?

    private var pendingZoom: Double = 1.0

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Untitled"
        window.minSize = NSSize(width: 560, height: 420)
        window.center()
        window.setFrameAutosaveName("MarkFrameMainWindow")
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
        runJS("window.__loadContent('', '', 'Untitled')")
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
    }

    /// 自动保存：仅对已有路径的文档静默写盘，不弹面板也不报错
    func writeSilently(content: String) {
        guard !currentPath.isEmpty else { return }
        do {
            try content.write(toFile: currentPath, atomically: true, encoding: .utf8)
            window?.isDocumentEdited = false
        } catch {
            mfLog("autosave failed: \(error)")
        }
    }

    private func suggestedName() -> String {
        if !currentPath.isEmpty { return (currentPath as NSString).lastPathComponent }
        return "Untitled.md"
    }

    func openDocumentPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window!) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.load(path: url.path)
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
        currentPath = path
        window?.title = url.lastPathComponent
        window?.isDocumentEdited = false
        runJS("window.__loadContent(\(jsStringLiteral(path)), \(jsStringLiteral(content)), \(jsStringLiteral(url.lastPathComponent)))")
        onOpenFile?(path)
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
            let html = self.injectCSS(into: raw)
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
    private func injectCSS(into html: String) -> String {
        let marker = "/*__MF_CSS__*/"
        guard html.contains(marker) else { return html }
        return html.replacingOccurrences(of: marker, with: bundledCSS())
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
        if currentPath.isEmpty { return "Untitled.\(ext)" }
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
    private var exportRendered: [PDFPage] = []
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
                self.showSimpleAlert("分页失败：文档为空")
                return
            }

            self.exportPages = pages
            self.exportGeometry = CGSize(width: pw, height: ph)
            mfLog("paginate: \(pages.count) pages \(Int(pw))x\(Int(ph)) splits=\(obj["splits"] ?? "-")")

            self.runJSReturning("window.__printShellHTML ? window.__printShellHTML() : ''") { shell in
                guard let html = shell as? String, !html.isEmpty else {
                    self.runJS("window.__finishExport && window.__finishExport()")
                    self.showSimpleAlert("导出失败：无法生成打印样式")
                    return
                }
                self.startRenderPipeline(shellHTML: html)
            }
        }
    }

    private func startRenderPipeline(shellHTML: String) {
        let html = injectCSS(into: shellHTML)
        let shell = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("markframe-print-\(UUID().uuidString).html")
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

        web.loadFileURL(shell, allowingReadAccessTo: shell.deletingLastPathComponent())
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
                    var captured: PDFPage?
                    if case .success(let data) = result,
                       let doc = PDFDocument(data: data),
                       let page = doc.page(at: 0) {
                        captured = page
                    }

                    // 空页重试：刚建立的导出视图偶尔会抓到未绘制的首帧
                    let empty = (captured?.string ?? "").isEmpty
                    if empty && expectText && attempt < 2 {
                        mfLog("page \(index) empty, retry \(attempt + 1)")
                        DispatchQueue.main.async {
                            self.renderPage(index, shell: shell, attempt: attempt + 1)
                        }
                        return
                    }

                    if let page = captured { self.exportRendered.append(page) }
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
            showSimpleAlert("导出失败：没有捕获到页面")
            return
        }

        let a4 = CGSize(width: 595, height: 842)
        guard let consumer = CGDataConsumer(url: url as CFURL) else { return }
        var box = CGRect(origin: .zero, size: a4)
        guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return }

        for page in exportRendered {
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

        try? FileManager.default.removeItem(at: shell)
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
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window!)
    }

    // MARK: 未保存确认

    func confirmDiscardIfNeeded(_ proceed: @escaping () -> Void) {
        guard window?.isDocumentEdited == true else { proceed(); return }
        let alert = NSAlert()
        alert.messageText = "当前文档有未保存的修改"
        alert.informativeText = "继续将丢弃这些修改。"
        alert.addButton(withTitle: "丢弃并继续")
        alert.addButton(withTitle: "取消")
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
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 页面就绪后再补上启动时排队的文件
        if let path = pendingLoadPath {
            pendingLoadPath = nil
            performLoad(path: path)
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
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender.isDocumentEdited else { return true }

        let alert = NSAlert()
        alert.messageText = "当前文档有未保存的修改"
        alert.informativeText = "关闭后这些修改会丢失。要保存吗？"
        alert.addButton(withTitle: "保存并关闭")
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "放弃修改")

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
