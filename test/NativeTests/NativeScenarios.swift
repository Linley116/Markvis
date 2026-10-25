import Foundation
#if !NATIVE_TEST_HARNESS
@testable import Markvis
#endif

struct NativeTestFailure: Error, CustomStringConvertible {
    let description: String
}

func nativeExpect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NativeTestFailure(description: message) }
}

private func withTempLibrary(_ body: (URL) throws -> Void) throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("MarkvisTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try body(root)
}

private func libraryController() -> EditorWindowController {
    // 文件操作不依赖 WebView；不调用 convenience init()，避免打开窗口。
    EditorWindowController(window: nil)
}

func nativeScenarioPaths() throws {
    try nativeExpect(MFPath.same("/tmp", "/private/tmp"), "软链路径应相同")
    try nativeExpect(MFPath.same("/tmp/note.md", "/tmp/note.md"), "相同路径应相同")
    try nativeExpect(!MFPath.same("", ""), "空路径不应视为已打开")
    try nativeExpect(!MFPath.same("/tmp/a.md", "/tmp/b.md"), "不同文件不应相同")
    try nativeExpect(MFPath.real("/private/tmp/a.md") == "/tmp/a.md", "FSEvents 路径归一化")
    try nativeExpect(MFPath.real("/Users/test/a.md") == "/Users/test/a.md", "普通路径保持不变")

    let root = "/tmp/markvis-root"
    try nativeExpect(MFPath.entry("/tmp/markvis-root/a.md", root: root)?.path == "/tmp/markvis-root/a.md", "允许根内文件")
    try nativeExpect(MFPath.entry("/tmp/markvis-root/../secret.md", root: root) == nil, "拒绝 ../ 穿越")
    try nativeExpect(MFPath.entry("/tmp/markvis-root-other/a.md", root: root) == nil, "拒绝同前缀兄弟目录")
    try nativeExpect(MFPath.entry(root, root: root) == nil, "文件操作不直接接受根本身")
    try nativeExpect(MFPath.entry("", root: root) == nil, "拒绝空路径")
}

func nativeScenarioSessionRestore() throws {
    let saved = ["", "missing.md", "one.md", "two.md", "three.md"]
    let files = MFPath.restorableFiles(saved, limit: 2) { $0.hasSuffix(".md") && $0 != "missing.md" }
    try nativeExpect(files == ["one.md", "two.md"], "恢复列表应过滤缺失文件、保序并限量")
    try nativeExpect(MFPath.restorableFiles(saved, limit: 0) { _ in true } == [], "恢复上限为 0 时为空")
}

func nativeScenarioJSBridge() throws {
    let literal = jsStringLiteral("a\"b\\c\n中文")
    let data = try nativeRequire(literal.data(using: .utf8), "JS 字面量应可转成 UTF-8")
    let decoded = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? String
    try nativeExpect(decoded == "a\"b\\c\n中文", "JS 字符串字面量应可逆")
    try nativeExpect(jsStringLiteral("plain") == "\"plain\"", "普通 JS 字面量")
}

private func nativeRequire<T>(_ value: T?, _ message: String) throws -> T {
    guard let value else { throw NativeTestFailure(description: message) }
    return value
}

func nativeScenarioLibraryLifecycle() throws {
    try withTempLibrary { root in
        let wc = libraryController()
        func path(_ name: String) -> String { root.appendingPathComponent(name).path }
        let created = wc.libraryCreate(in: "", name: "draft", kind: "file", root: root.path)
        try nativeExpect(created["ok"] as? Bool == true, "新建文件")
        try nativeExpect(created["path"] as? String == path("draft.md"), "新建文件自动补 .md")

        let copy1 = wc.libraryDuplicate(path: path("draft.md"), root: root.path)
        let copy2 = wc.libraryDuplicate(path: path("draft.md"), root: root.path)
        try nativeExpect(copy1["path"] as? String == path("draft copy.md"), "第一个副本命名")
        try nativeExpect(copy2["path"] as? String == path("draft copy 2.md"), "第二个副本命名")

        let renamed = wc.libraryRename(path: path("draft.md"), name: "renamed.md", root: root.path)
        try nativeExpect(renamed["ok"] as? Bool == true, "重命名")
        try nativeExpect(FileManager.default.fileExists(atPath: path("renamed.md")), "重命名落盘")

        try nativeExpect(wc.libraryCreate(in: "", name: "folder", kind: "dir", root: root.path)["ok"] as? Bool == true, "新建目录")
        let moved = wc.libraryMove(path: path("renamed.md"), toDir: path("folder"), root: root.path)
        try nativeExpect(moved["ok"] as? Bool == true, "移动文件")
        try nativeExpect(FileManager.default.fileExists(atPath: path("folder/renamed.md")), "移动落盘")

        try nativeExpect(wc.libraryUndoFileOp()["ok"] as? Bool == true, "撤销移动")
        try nativeExpect(FileManager.default.fileExists(atPath: path("renamed.md")), "撤销移动还原")
        // 设计上只保留「上一次文件操作」，所以撤销一次后没有更多历史。
        try nativeExpect(wc.libraryUndoFileOp()["error"] != nil, "撤销栈只保留一步")

        let undoRename = wc.libraryRename(path: path("renamed.md"), name: "again.md", root: root.path)
        try nativeExpect(undoRename["ok"] as? Bool == true, "准备撤销重命名")
        try nativeExpect(wc.libraryUndoFileOp()["ok"] as? Bool == true, "撤销重命名")
        try nativeExpect(FileManager.default.fileExists(atPath: path("renamed.md")), "撤销重命名还原")

        let undoCopy = wc.libraryDuplicate(path: path("renamed.md"), root: root.path)
        try nativeExpect(undoCopy["ok"] as? Bool == true, "准备撤销复制")
        try nativeExpect(wc.libraryUndoFileOp()["ok"] as? Bool == true, "撤销复制")
        try nativeExpect(!FileManager.default.fileExists(atPath: path("renamed copy.md")), "撤销复制还原")

        try nativeExpect(wc.libraryCreate(in: "", name: "tempdir", kind: "dir", root: root.path)["ok"] as? Bool == true, "准备撤销新建目录")
        try nativeExpect(wc.libraryUndoFileOp()["ok"] as? Bool == true, "撤销新建目录")
        try nativeExpect(!FileManager.default.fileExists(atPath: path("tempdir")), "撤销新建目录还原")

        // F9d：目标重名时自动改名，而不是拒绝
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("dest"), withIntermediateDirectories: true)
        try Data("source".utf8).write(to: root.appendingPathComponent("clash.md"))
        try Data("target".utf8).write(to: root.appendingPathComponent("dest/clash.md"))
        let conflict = wc.libraryMove(path: path("clash.md"), toDir: path("dest"), root: root.path)
        try nativeExpect(conflict["ok"] as? Bool == true, "重名移动不拒绝")
        try nativeExpect(conflict["path"] as? String == path("dest/clash 2.md"), "重名移动自动改名")
        let movedBody = try String(contentsOfFile: path("dest/clash 2.md"), encoding: .utf8)
        let targetBody = try String(contentsOfFile: path("dest/clash.md"), encoding: .utf8)
        try nativeExpect(movedBody == "source", "源文件内容随移动保留")
        try nativeExpect(targetBody == "target", "不覆盖目标文件")
        try nativeExpect(wc.libraryUndoFileOp()["ok"] as? Bool == true, "撤销重名移动")
        try nativeExpect(fm.fileExists(atPath: path("clash.md")), "重名移动撤销回原位")

        // F9d：删除进废纸篓后可以撤销恢复
        let trashName = "markvis-trash-\(UUID().uuidString.prefix(8)).md"
        try Data("recover me".utf8).write(to: root.appendingPathComponent(trashName))
        let deleted = wc.libraryDelete(path: path(trashName), root: root.path)
        try nativeExpect(deleted["ok"] as? Bool == true, "删除进废纸篓")
        try nativeExpect(!fm.fileExists(atPath: path(trashName)), "删除后原位置消失")
        try nativeExpect(wc.libraryUndoFileOp()["ok"] as? Bool == true, "撤销删除")
        let restoredBody = try String(contentsOfFile: path(trashName), encoding: .utf8)
        try nativeExpect(restoredBody == "recover me", "从废纸篓恢复原文件")
    }
}

func nativeScenarioLibrarySafety() throws {
    try withTempLibrary { root in
        let wc = libraryController()
        func path(_ name: String) -> String { root.appendingPathComponent(name).path }
        let escaped = wc.libraryCreate(in: path("../outside"), name: "bad", kind: "file", root: root.path)
        try nativeExpect(escaped["path"] as? String == path("bad.md"), "非法目录回退到根")
        try nativeExpect(!FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("outside/bad.md").path), "不能写出根目录")

        try nativeExpect(wc.libraryCreate(in: "", name: "folder", kind: "dir", root: root.path)["ok"] as? Bool == true, "准备目录")
        try nativeExpect(wc.libraryCreate(in: path("folder"), name: "child", kind: "dir", root: root.path)["ok"] as? Bool == true, "准备子目录")
        let cyclic = wc.libraryMove(path: path("folder"), toDir: path("folder/child"), root: root.path)
        try nativeExpect(cyclic["error"] != nil, "拒绝移入自己的子孙")
        try nativeExpect(wc.libraryRename(path: path("../outside.md"), name: "x.md", root: root.path)["error"] as? String == "bad path", "拒绝重命名根外文件")
    }
}

func nativeScenarioLibraryList() throws {
    try withTempLibrary { root in
        let fm = FileManager.default
        func path(_ name: String) -> String { root.appendingPathComponent(name).path }
        for name in ["b.md", "a.txt", "ignored.png", ".hidden.md"] {
            try Data().write(to: root.appendingPathComponent(name))
        }
        try fm.createDirectory(at: root.appendingPathComponent("folder"), withIntermediateDirectories: false)
        try Data().write(to: root.appendingPathComponent("folder/nested.markdown"))
        try fm.setAttributes([.modificationDate: Date(timeIntervalSince1970: 100)], ofItemAtPath: path("b.md"))
        try fm.setAttributes([.modificationDate: Date(timeIntervalSince1970: 200)], ofItemAtPath: path("a.txt"))

        let wc = libraryController()
        let byName = wc.libraryList(path: "", root: root.path, sort: "name", groupDirs: true)
        try nativeExpect(byName.compactMap { $0["name"] as? String } == ["folder", "a.txt", "b.md"], "名称排序和目录优先")
        let byTime = wc.libraryList(path: "", root: root.path, sort: "mtime", groupDirs: false)
        try nativeExpect(byTime.compactMap { $0["name"] as? String } == ["folder", "a.txt", "b.md"], "修改时间排序（最新在前）")

        let defaults = UserDefaults.standard
        let oldRoot = defaults.string(forKey: EditorWindowController.libraryRootKey)
        defer {
            if let oldRoot { defaults.set(oldRoot, forKey: EditorWindowController.libraryRootKey) }
            else { defaults.removeObject(forKey: EditorWindowController.libraryRootKey) }
        }
        EditorWindowController.libraryRoot = root.path
        let all = wc.libraryAllFiles().compactMap { $0["path"] as? String }
        try nativeExpect(all.contains(path("b.md")), "快速打开索引 Markdown: \(all)")
        try nativeExpect(all.contains(path("folder/nested.markdown")), "快速打开索引子目录")
        try nativeExpect(!all.contains(path("ignored.png")), "过滤不支持的类型")
        try nativeExpect(!all.contains(path(".hidden.md")), "过滤隐藏文件")
    }
}

func nativeScenarioEntrySorting() throws {
    let input: [[String: Any]] = [
        ["name": "z.md", "dir": false, "mtime": 1.0],
        ["name": "b", "dir": true, "mtime": 3.0],
        ["name": "a.md", "dir": false, "mtime": 2.0],
        ["name": "a", "dir": true, "mtime": 0.0]
    ]
    let sorted = EditorWindowController.sortEntries(input, sort: "name", groupDirs: true)
    try nativeExpect(sorted.compactMap { $0["name"] as? String } == ["a", "b", "a.md", "z.md"], "排序后稳定分区")
}
