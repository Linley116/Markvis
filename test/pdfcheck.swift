// PDF 导出检查
//
// 用法: pdfcheck <out.pdf> [source.md]
//
// 检查项：
//   1. 必须分成多页
//   2. 不能有空白页
//   3. 页面尺寸统一为 A4（595×842）
//   4. 除最后一页外，页面填充率不能过低（避免整页留白）
//   5. 给出源文件时，检查正文末段是否出现在 PDF 里（防止页尾内容被裁）
//
// 这几条是为两个真实 bug 留的防线：
//   - 早期版本页数/体积都正常，但除第 1 页外全是空白
//   - 代码块在导出页里折行，分页时却按不折行高度测量，导致末尾两行被裁掉
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count > 1, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    print("无法打开 PDF")
    exit(2)
}

var empty = 0
var sizes = Set<String>()
var lowFill: [String] = []
var allText = ""

for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    allText += text
    if text.isEmpty { empty += 1 }

    let box = page.bounds(for: .mediaBox)
    sizes.insert("\(Int(box.width))x\(Int(box.height))")

    // 用最后一行文字的底部位置估算填充率
    var bottom = box.height
    if let lines = page.selection(for: box)?.selectionsByLine(), !lines.isEmpty {
        bottom = lines.map { $0.bounds(for: page).minY }.min() ?? bottom
    }
    let fill = (box.height - bottom) / box.height
    if fill < 0.55 && i < doc.pageCount - 1 {
        lowFill.append(String(format: "P%d(%.0f%%)", i + 1, fill * 100))
    }
}

print("pages=\(doc.pageCount) empty=\(empty) sizes=\(sizes.sorted().joined(separator: ","))")

var failed = false

if doc.pageCount < 2 {
    print("FAIL: 应该分成多页")
    failed = true
}
if empty > 0 {
    print("FAIL: 有 \(empty) 页是空白")
    failed = true
}
if sizes.count != 1 {
    print("FAIL: 页面尺寸不一致 \(sizes.sorted())")
    failed = true
}
if !lowFill.isEmpty {
    print("WARN: 填充率过低 \(lowFill.joined(separator: ","))")
}

// 内容完整性：源文件的有效文本（去空白）必须出现在 PDF 中
if args.count > 2, let source = try? String(contentsOfFile: args[2], encoding: .utf8) {
    // PingFang 的 PDF ToUnicode 会把部分汉字映射成康熙部首（文档 → ⽂档），
    // NFKC 归一化能把康熙部首还原成普通汉字，避免误判为「内容缺失」
    let normalized = allText.components(separatedBy: .whitespacesAndNewlines)
        .joined().precomposedStringWithCompatibilityMapping

    // 取源文件最后一行有实质内容的文本（跳过代码围栏）
    let tailLines = source.components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty && !$0.hasPrefix("```") }
    if let last = tailLines.last {
        let probe = last.components(separatedBy: .whitespaces)
            .joined().precomposedStringWithCompatibilityMapping
        let head = String(probe.prefix(30))
        if !normalized.contains(head) {
            print("FAIL: PDF 缺少文末内容「\(head)…」，导出被截断")
            failed = true
        }
    }
}

if failed { exit(1) }
print("OK")
