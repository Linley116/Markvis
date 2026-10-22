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
        }
    }

    /// 双击 .md 文件、或 `open -a MarkFrame x.md` 走这里
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.isFileURL }) else { return }
        openFile(at: url.path)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - 窗口管理

    private func makeController() -> EditorWindowController {
        let wc = EditorWindowController()
        wc.onOpenFile = { [weak self] path in self?.noteRecent(path) }
        wc.requestOpenFile = { [weak self] path in self?.openFile(at: path) }
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
    }

    // MARK: - 打开文件

    /// 打开文件的统一入口：空白未编辑窗口就地复用，否则开新窗口
    /// （系统偏好设为「总是」时会自动并入标签组）
    func openFile(at path: String) {
        if windowControllers.isEmpty {
            pendingOpen = path
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
            let empty = NSMenuItem(title: "No Recent Files", action: nil, keyEquivalent: "")
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
        let clear = NSMenuItem(title: "Clear Menu", action: #selector(clearRecent(_:)), keyEquivalent: "")
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
        appMenu.addItem(withTitle: "About MarkFrame",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide MarkFrame",
                        action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit MarkFrame",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")

        // 文件
        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileItem.submenu = fileMenu
        fileMenu.addItem(withTitle: "New Window", action: #selector(newDocument(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "New Tab", action: #selector(newTab(_:)), keyEquivalent: "t")

        let openItem = fileMenu.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        openItem.keyEquivalentModifierMask = [.command]

        let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recent = NSMenu(title: "Open Recent")
        recentItem.submenu = recent
        recentMenu = recent
        fileMenu.addItem(recentItem)

        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Save", action: #selector(saveDocument(_:)), keyEquivalent: "s")
        let saveAs = fileMenu.addItem(withTitle: "Save As…", action: #selector(saveDocumentAs(_:)), keyEquivalent: "S")
        saveAs.keyEquivalentModifierMask = [.command, .shift]

        let exportItem = NSMenuItem(title: "Export", action: nil, keyEquivalent: "")
        let exportMenu = NSMenu(title: "Export")
        exportItem.submenu = exportMenu
        exportMenu.addItem(withTitle: "PDF…", action: #selector(exportPDF(_:)), keyEquivalent: "")
        exportMenu.addItem(withTitle: "HTML…", action: #selector(exportHTML(_:)), keyEquivalent: "")
        fileMenu.addItem(exportItem)

        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // 编辑（走 responder chain，作用于 contenteditable）
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Bold", action: #selector(toggleBold(_:)), keyEquivalent: "b")
        editMenu.addItem(withTitle: "Italic", action: #selector(toggleItalic(_:)), keyEquivalent: "i")
        editMenu.addItem(withTitle: "Inline Code", action: #selector(toggleCode(_:)), keyEquivalent: "k")

        // 视图
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "Toggle Source Mode",
                         action: #selector(toggleSourceMode(_:)),
                         keyEquivalent: "/")
        viewMenu.addItem(.separator())

        let find = viewMenu.addItem(withTitle: "Find and Replace…",
                                    action: #selector(showFind(_:)), keyEquivalent: "f")
        find.keyEquivalentModifierMask = [.command]
        let outline = viewMenu.addItem(withTitle: "Toggle Outline",
                                       action: #selector(toggleOutline(_:)), keyEquivalent: "O")
        outline.keyEquivalentModifierMask = [.command, .shift]
        let focus = viewMenu.addItem(withTitle: "Focus Mode",
                                     action: #selector(toggleFocusMode(_:)), keyEquivalent: "F")
        focus.keyEquivalentModifierMask = [.command, .shift]
        let typewriter = viewMenu.addItem(withTitle: "Typewriter Mode",
                                          action: #selector(toggleTypewriter(_:)), keyEquivalent: "T")
        typewriter.keyEquivalentModifierMask = [.command, .shift]
        let theme = viewMenu.addItem(withTitle: "Next Theme",
                                     action: #selector(nextTheme(_:)), keyEquivalent: "L")
        theme.keyEquivalentModifierMask = [.command, .shift]

        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(zoomReset(_:)), keyEquivalent: "0")

        // 窗口（NSApp.windowsMenu 会让系统自动维护打开的文档列表）
        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winItem.submenu = winMenu
        winMenu.addItem(withTitle: "Minimize",
                        action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom",
                        action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        winMenu.addItem(withTitle: "Bring All to Front",
                        action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        NSApp.windowsMenu = winMenu

        // 帮助（有个空位比缺菜单好）
        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        helpItem.submenu = NSMenu(title: "Help")

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
        guard let wc = activeController ?? windowControllers.last else { return }
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
    @objc private func showFind(_ sender: Any?) { js?("window.MFSearch && window.MFSearch.show()") }
    @objc private func toggleOutline(_ sender: Any?) { js?("window.MFOutline && window.MFOutline.toggle()") }
    @objc private func toggleFocusMode(_ sender: Any?) { js?("window.MFFocus && window.MFFocus.toggleFocus()") }
    @objc private func toggleTypewriter(_ sender: Any?) { js?("window.MFFocus && window.MFFocus.toggleTypewriter()") }
    @objc private func nextTheme(_ sender: Any?) { js?("window.MFTheme && window.MFTheme.cycle()") }
    @objc private func zoomIn(_ sender: Any?) { js?("window.__cmd('zoomIn')") }
    @objc private func zoomOut(_ sender: Any?) { js?("window.__cmd('zoomOut')") }
    @objc private func zoomReset(_ sender: Any?) { js?("window.__cmd('zoomReset')") }
}
