// AppDelegate：菜单、生命周期、多窗口/标签页管理、文件菜单动作
//
// 多文档模型：每个文档一个 EditorWindowController（各自的 WKWebView 与桥）。
// 本数组持有强引用，窗口关闭时移除。标签页用系统原生 tab group：
//   window.tabbingMode = .preferred + keyWindow.addTabbedWindow(_:)

import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    var windowControllers: [EditorWindowController] = []
    private var recentMenu: NSMenu?
    private var pendingOpen: String?

    private let recentKey = "recentFiles"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = true
        buildMenu()

        let wc = makeController()
        NSApp.activate(ignoringOtherApps: true)

        // 直接运行二进制时把文件路径当参数传入
        if pendingOpen == nil {
            let args = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") }
            if let first = args.first, FileManager.default.fileExists(atPath: first) {
                pendingOpen = first
            }
        }
        if let path = pendingOpen {
            pendingOpen = nil
            wc.load(path: path)
            noteRecent(path)
        } else if !restoreSession(into: wc) {
            // 没有上次的会话：就是一个空白窗口
            wc.window?.makeKeyAndOrderFront(nil)
        }

        // 上次异常退出留下的未命名文档：提示恢复
        recoverPendingDocuments()
        hasFinishedLaunching = true
    }

    /// 启动完成前收到的打开请求要排队；运行中关掉所有窗口后，
    /// 再双击文件必须当场建窗口，否则会变成一个永远不打开的 pendingOpen。
    private var hasFinishedLaunching = false

    /// 双击 .md 文件、或 `open -a MarkFrame x.md` 走这里
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.isFileURL }) else { return }
        openFile(at: url.path)
    }

    /// macOS 默认行为是「最后一个窗口关闭就退出」。编辑器不该这样：
    /// 关掉窗口只是收起文档，点 Dock 图标或 Cmd+N 还能继续用。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// 无可见窗口时点 Dock 图标：有窗口就提到前面（最小化的先还原），
    /// 一个窗口都不剩就新建空白窗口。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !flag else { return true }
        if let wc = windowControllers.last, let w = wc.window {
            if w.isMiniaturized { w.deminiaturize(nil) }
            w.makeKeyAndOrderFront(nil)
        } else {
            _ = makeController()
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    // MARK: - 窗口管理

    private func makeController() -> EditorWindowController {
        let wc = EditorWindowController()
        wc.onOpenFile = { [weak self] path in
            self?.noteRecent(path)
            self?.persistSession()
        }
        wc.requestOpenFile = { [weak self] path in self?.openFile(at: path) }
        wc.requestOpenInNewWindow = { [weak self] path in self?.openFileInNewWindow(at: path) }
        windowControllers.append(wc)
        wc.showWindow(nil)
        return wc
    }

    /// 当前应该接收菜单动作的控制器（key window 优先）
    private var activeController: EditorWindowController? {
        if let key = NSApp.keyWindow {
            if let wc = windowControllers.first(where: { $0.window === key }) { return wc }
        }
        if let main = NSApp.mainWindow {
            if let wc = windowControllers.first(where: { $0.window === main }) { return wc }
        }
        return windowControllers.last
    }

    @objc private func windowWillClose(_ note: Notification) {
        guard let w = note.object as? NSWindow else { return }
        windowControllers.removeAll { $0.window === w }
        // 退出过程中窗口也会走这里，别把刚要保存的会话清空
        if !isTerminating { persistSession() }
    }

    /// 正在退出：此时 windowWillClose 不应再改写会话
    private var isTerminating = false

    // MARK: - 会话（下次启动恢复上次开着的文档）

    private let openFilesKey = "mf.openFiles"
    private let activeFileKey = "mf.activeFile"
    /// 恢复上限：和「最近打开」一样取 10，再多启动就慢了
    private let maxRestoredFiles = 10

    /// 记下当前开着的文档。用 intendedPath（load 一进来就设好）而不是
    /// currentPath —— 启动恢复时几个窗口在先后加载，用 currentPath 会把
    /// 还没加载完的窗口漏掉。
    private func persistSession() {
        let files = windowControllers
            .map { $0.currentPath.isEmpty ? $0.intendedPath : $0.currentPath }
            .filter { !$0.isEmpty }
        UserDefaults.standard.set(files, forKey: openFilesKey)

        if let wc = windowControllers.first(where: { $0.window === NSApp.keyWindow }),
           !(wc.currentPath.isEmpty && wc.intendedPath.isEmpty) {
            let p = wc.currentPath.isEmpty ? wc.intendedPath : wc.currentPath
            UserDefaults.standard.set(p, forKey: activeFileKey)
        }
    }

    /// 启动时把上次开着的文档原样打开。返回 false 表示没有可恢复的会话。
    /// 打不开的（已删除/改名）直接跳过，不弹窗打扰。
    @discardableResult
    private func restoreSession(into primary: EditorWindowController) -> Bool {
        let saved = UserDefaults.standard.stringArray(forKey: openFilesKey) ?? []
        let files = MFPath.restorableFiles(saved, limit: maxRestoredFiles)
        guard !files.isEmpty else { return false }
        mfLog("restore session: \(files.count) file(s) → \(files.prefix(3))")
        primary.load(path: files[0])

        // 其余文件并进同一个标签组（而不是散成 N 个窗口）
        if let primaryWindow = primary.window {
            for p in files.dropFirst() {
                let wc = makeController()
                wc.load(path: p)
                if let w = wc.window {
                    primaryWindow.addTabbedWindow(w, ordered: .above)
                }
            }
        }

        // 上次活动的那个窗口提到前面（不改标签顺序）
        let active = UserDefaults.standard.string(forKey: activeFileKey) ?? ""
        let target = windowControllers.first {
            samePath($0.intendedPath, active) || samePath($0.currentPath, active)
        } ?? primary
        target.window?.makeKeyAndOrderFront(nil)
        return true
    }

    private func samePath(_ a: String, _ b: String) -> Bool {
        MFPath.same(a, b)
    }

    // MARK: - 崩溃恢复

    /// 启动时检查恢复目录；有东西就问一句，用户决定恢复还是丢弃。
    /// 自动化测试（MARKFRAME_SELFTEST）下不走弹窗，直接恢复，避免阻塞启动。
    private func recoverPendingDocuments() {
        let files = EditorWindowController.pendingRecoveryFiles()
        guard !files.isEmpty else { return }

        var shouldRestore = true
        if ProcessInfo.processInfo.environment["MARKFRAME_SELFTEST"] == nil {
            let alert = NSAlert()
            alert.messageText = L10n.t("Recover unsaved documents?", "恢复上次未保存的文档？")
            alert.informativeText = L10n.t(
                "\(files.count) document(s) were not saved when the app last quit.",
                "有 \(files.count) 个文档在退出前没有保存。")
            alert.addButton(withTitle: L10n.t("Recover", "恢复"))
            alert.addButton(withTitle: L10n.t("Discard", "丢弃"))
            shouldRestore = alert.runModal() == .alertFirstButtonReturn
        }

        if shouldRestore {
            for url in files {
                let wc = makeController()
                wc.restore(from: url)
            }
        } else {
            EditorWindowController.discardRecoveryFiles(files)
        }
    }

    /// 正常退出时，把「没有未保存修改」的窗口的恢复文件清掉；
    /// 有未保存内容的窗口保留，下次启动还能恢复。
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isTerminating = true
        persistSession()   // 退出前把开着的文档记下来，下次启动恢复
        for wc in windowControllers where !(wc.window?.isDocumentEdited ?? false) {
            wc.discardRecovery()
        }
        return .terminateNow
    }

    // MARK: - 打开文件

    /// 打开文件的统一入口：已经开着就聚焦那个窗口；空白未编辑窗口就地复用；
    /// 否则开新窗口（系统偏好设为「总是」时会自动并入标签组）
    func openFile(at path: String) {
        if windowControllers.isEmpty {
            guard hasFinishedLaunching else {
                pendingOpen = path
                return
            }
            let wc = makeController()
            wc.load(path: path)
            noteRecent(path)
            return
        }
        // 同一个文件已经在某个窗口里（含正在加载的）→ 切过去，别开第二份
        if let existing = windowControllers.first(where: {
            samePath($0.currentPath, path) || samePath($0.intendedPath, path)
        }) {
            mfLog("openFile: already open, focusing \(path)")
            existing.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            noteRecent(path)
            return
        }
        if let wc = activeController ?? windowControllers.last, wc.isReusable {
            wc.load(path: path)
            noteRecent(path)
            return
        }
        let wc = makeController()
        wc.load(path: path)
        noteRecent(path)
    }

    /// 文件树右键「在新窗口打开」：不复用空白窗口，直接新建一个
    func openFileInNewWindow(at path: String) {
        if windowControllers.isEmpty {
            guard hasFinishedLaunching else {
                pendingOpen = path
                return
            }
            let wc = makeController()
            wc.load(path: path)
            noteRecent(path)
            return
        }
        let wc = makeController()
        wc.load(path: path)
        noteRecent(path)
    }

    private func noteRecent(_ path: String) {
        var files = UserDefaults.standard.stringArray(forKey: recentKey) ?? []
        files.removeAll { $0 == path }
        files.insert(path, at: 0)
        if files.count > 10 { files = Array(files.prefix(10)) }
        UserDefaults.standard.set(files, forKey: recentKey)
        rebuildRecentMenu()
    }

    private func rebuildRecentMenu() {
        guard let menu = recentMenu else { return }
        menu.removeAllItems()

        let files = UserDefaults.standard.stringArray(forKey: recentKey) ?? []
        if files.isEmpty {
            let empty = NSMenuItem(title: L10n.t("No Recent Files", "无最近文件"), action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }

        for path in files {
            let item = NSMenuItem(title: (path as NSString).lastPathComponent,
                                  action: #selector(openRecent(_:)),
                                  keyEquivalent: "")
            item.target = self
            item.representedObject = path
            item.toolTip = path
            menu.addItem(item)
        }

        menu.addItem(.separator())
        let clear = NSMenuItem(title: L10n.t("Clear Menu", "清除菜单"), action: #selector(clearRecent(_:)), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
    }

    @objc private func openRecent(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        openFile(at: path)
    }

    @objc private func clearRecent(_ sender: Any?) {
        UserDefaults.standard.removeObject(forKey: recentKey)
        rebuildRecentMenu()
    }

    // MARK: - 菜单

    private func buildMenu() {
        let main = NSMenu()

        // 应用菜单
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: L10n.t("About MarkFrame", "关于 MarkFrame"),
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L10n.t("Hide MarkFrame", "隐藏 MarkFrame"),
                        action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L10n.t("Quit MarkFrame", "退出 MarkFrame"),
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")

        // 文件
        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let fileMenu = NSMenu(title: L10n.t("File", "文件"))
        fileItem.submenu = fileMenu
        fileMenu.addItem(withTitle: L10n.t("New Window", "新建窗口"), action: #selector(newDocument(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: L10n.t("New Tab", "新建标签页"), action: #selector(newTab(_:)), keyEquivalent: "t")

        let openItem = fileMenu.addItem(withTitle: L10n.t("Open…", "打开…"), action: #selector(openDocument(_:)), keyEquivalent: "o")
        openItem.keyEquivalentModifierMask = [.command]

        // 快速打开：模糊搜当前文件夹里的文件（Typora 的 Open Quickly）
        // 用 Cmd+Shift+P；Cmd+P 目前未绑定，macOS 上 Typora 用 Cmd+Shift+O，
        // 而我们的 Cmd+Shift+O 已经是侧栏开关
        let quick = fileMenu.addItem(withTitle: L10n.t("Open Quickly…", "快速打开…"),
                                     action: #selector(quickOpen(_:)), keyEquivalent: "P")
        quick.keyEquivalentModifierMask = [.command, .shift]

        let recentItem = NSMenuItem(title: L10n.t("Open Recent", "最近打开"), action: nil, keyEquivalent: "")
        let recent = NSMenu(title: L10n.t("Open Recent", "最近打开"))
        recentItem.submenu = recent
        recentMenu = recent
        fileMenu.addItem(recentItem)

        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: L10n.t("Save", "保存"), action: #selector(saveDocument(_:)), keyEquivalent: "s")
        let saveAs = fileMenu.addItem(withTitle: L10n.t("Save As…", "另存为…"), action: #selector(saveDocumentAs(_:)), keyEquivalent: "S")
        saveAs.keyEquivalentModifierMask = [.command, .shift]

        let exportItem = NSMenuItem(title: L10n.t("Export", "导出"), action: nil, keyEquivalent: "")
        let exportMenu = NSMenu(title: L10n.t("Export", "导出"))
        exportItem.submenu = exportMenu
        exportMenu.addItem(withTitle: L10n.t("PDF…", "PDF…"), action: #selector(exportPDF(_:)), keyEquivalent: "")
        exportMenu.addItem(withTitle: L10n.t("HTML…", "HTML…"), action: #selector(exportHTML(_:)), keyEquivalent: "")
        fileMenu.addItem(exportItem)

        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: L10n.t("Close", "关闭"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // 编辑（走 responder chain，作用于 contenteditable）
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: L10n.t("Edit", "编辑"))
        editItem.submenu = editMenu
        // 撤销/重做交给 web 层的统一撤销栈（T3）：实时与源码模式共用一份历史。
        // 保留键等效，AppKit 会吃掉按键并派发到这里的 action，不会重复触发 webview 的监听。
        editMenu.addItem(withTitle: L10n.t("Undo", "撤销"), action: #selector(undoAction(_:)), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: L10n.t("Redo", "重做"), action: #selector(redoAction(_:)), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: L10n.t("Cut", "剪切"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: L10n.t("Copy", "复制"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: L10n.t("Paste", "粘贴"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: L10n.t("Select All", "全选"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: L10n.t("Bold", "粗体"), action: #selector(toggleBold(_:)), keyEquivalent: "b")
        editMenu.addItem(withTitle: L10n.t("Italic", "斜体"), action: #selector(toggleItalic(_:)), keyEquivalent: "i")
        editMenu.addItem(withTitle: L10n.t("Inline Code", "行内代码"), action: #selector(toggleCode(_:)), keyEquivalent: "k")

        // 视图
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: L10n.t("View", "显示"))
        viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: L10n.t("Toggle Source Mode", "切换源码模式"),
                         action: #selector(toggleSourceMode(_:)),
                         keyEquivalent: "/")
        viewMenu.addItem(.separator())

        let find = viewMenu.addItem(withTitle: L10n.t("Find and Replace…", "查找与替换…"),
                                    action: #selector(showFind(_:)), keyEquivalent: "f")
        find.keyEquivalentModifierMask = [.command]
        let spell = viewMenu.addItem(withTitle: L10n.t("Check Spelling While Typing", "输入时检查拼写"),
                                     action: #selector(toggleSpell(_:)), keyEquivalent: ";")
        spell.keyEquivalentModifierMask = [.command]
        let sidebar = viewMenu.addItem(withTitle: L10n.t("Toggle Sidebar", "显示/隐藏侧栏"),
                                       action: #selector(toggleOutline(_:)), keyEquivalent: "O")
        sidebar.keyEquivalentModifierMask = [.command, .shift]
        let files = viewMenu.addItem(withTitle: L10n.t("Show Files", "显示文件树"),
                                     action: #selector(showFiles(_:)), keyEquivalent: "E")
        files.keyEquivalentModifierMask = [.command, .shift]
        let focus = viewMenu.addItem(withTitle: L10n.t("Focus Mode", "专注模式"),
                                     action: #selector(toggleFocusMode(_:)), keyEquivalent: "F")
        focus.keyEquivalentModifierMask = [.command, .shift]
        let typewriter = viewMenu.addItem(withTitle: L10n.t("Typewriter Mode", "打字机模式"),
                                          action: #selector(toggleTypewriter(_:)), keyEquivalent: "T")
        typewriter.keyEquivalentModifierMask = [.command, .shift]
        let theme = viewMenu.addItem(withTitle: L10n.t("Next Theme", "下一个主题"),
                                     action: #selector(nextTheme(_:)), keyEquivalent: "L")
        theme.keyEquivalentModifierMask = [.command, .shift]

        // 自定义主题：文件夹入口 + 重新加载（改完 CSS 不用重启）
        viewMenu.addItem(withTitle: L10n.t("Open Theme Folder…", "打开主题文件夹…"),
                         action: #selector(openThemeFolder(_:)), keyEquivalent: "")
        viewMenu.addItem(withTitle: L10n.t("Reload Custom Themes", "重新加载自定义主题"),
                         action: #selector(reloadThemes(_:)), keyEquivalent: "")

        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: L10n.t("Zoom In", "放大"), action: #selector(zoomIn(_:)), keyEquivalent: "+")
        viewMenu.addItem(withTitle: L10n.t("Zoom Out", "缩小"), action: #selector(zoomOut(_:)), keyEquivalent: "-")
        viewMenu.addItem(withTitle: L10n.t("Actual Size", "实际大小"), action: #selector(zoomReset(_:)), keyEquivalent: "0")

        // 窗口（NSApp.windowsMenu 会让系统自动维护打开的文档列表）
        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: L10n.t("Window", "窗口"))
        winItem.submenu = winMenu
        winMenu.addItem(withTitle: L10n.t("Minimize", "最小化"),
                        action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: L10n.t("Zoom", "缩放"),
                        action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        winMenu.addItem(withTitle: L10n.t("Bring All to Front", "全部置于顶层"),
                        action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        NSApp.windowsMenu = winMenu

        // 帮助（有个空位比缺菜单好）
        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        helpItem.submenu = NSMenu(title: L10n.t("Help", "帮助"))

        NSApp.mainMenu = main
        rebuildRecentMenu()

        NotificationCenter.default.addObserver(self,
                                               selector: #selector(windowWillClose(_:)),
                                               name: NSWindow.willCloseNotification,
                                               object: nil)
    }

    // MARK: - 动作转发到 Web 层（作用于 key window）

    private var js: ((String) -> Void)? {
        activeController?.runJS
    }

    @objc private func newDocument(_ sender: Any?) {
        // 当前是空白未命名窗口就直接清空复用，避免窗口泛滥
        if let wc = activeController, wc.isReusable {
            wc.newDocument()
            return
        }
        _ = makeController()
    }

    @objc private func newTab(_ sender: Any?) {
        let wc = makeController()
        if let key = NSApp.keyWindow, key !== wc.window {
            key.addTabbedWindow(wc.window!, ordered: .above)
        }
        wc.window?.makeKeyAndOrderFront(nil)
    }

    @objc private func openDocument(_ sender: Any?) {
        let wc = activeController ?? windowControllers.last ?? makeController()
        wc.openDocumentPanel()
    }

    @objc private func saveDocument(_ sender: Any?) {
        activeController?.save(saveAs: false)
    }

    @objc private func saveDocumentAs(_ sender: Any?) {
        activeController?.save(saveAs: true)
    }

    @objc private func exportPDF(_ sender: Any?) {
        activeController?.exportPDF()
    }

    @objc private func exportHTML(_ sender: Any?) {
        activeController?.exportHTML()
    }

    @objc private func toggleBold(_ sender: Any?) { js?("window.__cmd('bold')") }
    @objc private func toggleItalic(_ sender: Any?) { js?("window.__cmd('italic')") }
    @objc private func toggleCode(_ sender: Any?) { js?("window.__cmd('code')") }
    @objc private func toggleSourceMode(_ sender: Any?) { js?("window.__cmd('toggleSource')") }
    @objc private func toggleSpell(_ sender: Any?) { js?("window.__cmd('toggleSpell')") }
    @objc private func undoAction(_ sender: Any?) { js?("window.__cmd('undo')") }
    @objc private func redoAction(_ sender: Any?) { js?("window.__cmd('redo')") }
    @objc private func openThemeFolder(_ sender: Any?) { js?("window.MFTheme && window.MFTheme.openFolder()") }
    @objc private func reloadThemes(_ sender: Any?) { js?("window.MFTheme && window.MFTheme.reload()") }
    @objc private func showFind(_ sender: Any?) { js?("window.MFSearch && window.MFSearch.show()") }
    @objc private func toggleOutline(_ sender: Any?) { js?("window.MFSidebar && window.MFSidebar.toggle()") }
    @objc private func showFiles(_ sender: Any?) { js?("window.MFSidebar && window.MFSidebar.show('files')") }
    @objc private func quickOpen(_ sender: Any?) { js?("window.MFQuickOpen && window.MFQuickOpen.show()") }
    @objc private func toggleFocusMode(_ sender: Any?) { js?("window.MFFocus && window.MFFocus.toggleFocus()") }
    @objc private func toggleTypewriter(_ sender: Any?) { js?("window.MFFocus && window.MFFocus.toggleTypewriter()") }
    @objc private func nextTheme(_ sender: Any?) { js?("window.MFTheme && window.MFTheme.cycle()") }
    @objc private func zoomIn(_ sender: Any?) { js?("window.__cmd('zoomIn')") }
    @objc private func zoomOut(_ sender: Any?) { js?("window.__cmd('zoomOut')") }
    @objc private func zoomReset(_ sender: Any?) { js?("window.__cmd('zoomReset')") }
}
