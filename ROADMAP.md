# MarkFrame 后续工作清单

> 基线：v0.2，3338 行（engine 1500 / features 800 / Swift 500 / tests 350 / css 450），56 项断言全绿。
> 规模标记：**S** < 200 行，**M** 200–600 行，**L** 需要改架构。

## 进度

| 轮次 | 项目 | 状态 |
|---|---|---|
| 1 | **F1 文件入口** | ✅ 双击 / 拖拽 / 最近打开 / 命令行参数 |
| 1 | **T2 光标偏移** | ✅ 图片占位定位 + 块尾零宽锚点（顺带修掉一个真 bug） |
| 1 | **T6 性能基准** | ✅ `test/bench.js`，基线见 README |
| 2 | **F2 图片管理** | ✅ 剪贴板粘贴 → `assets/` 落盘（拖拽/缩放/图床仍在 P1） |
| 2 | **F3 导出 PDF/HTML** | ✅ 按块边界分页的 A4 PDF + 内联主题 CSS 的 HTML |
| 2 | **F4 代码高亮** | ✅ highlight.js，token 配色跟随主题 |
| — | 下一步 | F5 数学 / F6 Mermaid / F8 多标签页 |

> 第 1 轮修复的 bug：块尾紧跟行内元素时，光标会被浏览器"吸进"元素内部，导致
> `<p><strong>a</strong></p>` 末尾输入 ` **b**` 变成 `<strong>a </strong>b****`。
> 解法是块尾插入零宽锚点 `span.mf-anchor`，并在两处偏移计算里忽略 `\u200b`。
>
> 第 2 轮踩的坑：`WKWebView.printOperation` 会产生 **126,865 页**的 PDF（分页失控），
> 换成 `createPDF` 捕获整页 + PDFKit 按块边界重绘分页后才正常（131 块 → 11 页 / 55KB）。
> 另外直接运行二进制带文件参数时，`__loadContent` 会在页面加载完成前被丢弃，
> 需要 `WKNavigationDelegate.didFinish` 排队补执行。

---

## 一、必须先还的技术债

这些不是"缺功能"，是当前实现的妥协。不还，后面每加一个功能都会更贵。

### T1 行内标记不可编辑 —— 最大的架构债（L）

**现状**：`**粗体**` 的星号用 CSS `::before/::after` 伪元素显示，看得见、删不掉、方向键穿不过。

**为什么是债**：Typora 的做法是把标记渲染成**真实的 `.md-meta` 文本节点**，所以用户能删掉一个 `*`、能用方向键进出、能在中间插字。我用伪元素换来了"实现简单 + 永不破坏无损性"，代价是**行内语法只能靠快捷键修改**。这是体验上离 Typora 最远的一处。

**做法**：行内元素改成
```html
<span class="md-inline" data-type="strong">
  <span class="md-meta">**</span>内容<span class="md-meta">**</span>
</span>
```
牵动四处：`renderInline`、`inlineRaw`（改为读真实节点）、`caretSourceOffset`（偏移天然对齐，可简化）、`expand`（从"切 class"变成"显示/隐藏 meta 节点"）。

**收益**：T2 的一半工作量顺带解决。

### T2 光标偏移模型过于粗糙（M）✅ 第 1 轮完成

**现状**：光标位置按"源码字符数"换算。图片 `![](a.png)` 占 8 个字符但没有文本节点，光标落在图片后面就会偏；表格、脚注同理。

**做法**：三种选择——给原子节点插入等长零宽文本占位；或改用 `(节点路径, 节点内偏移)` 两级模型；或随 T1 一起换成真实 meta 节点后自然对齐。

**先做**：加一个"图片后输入"的断言，把问题钉死再改。

### T3 没有统一撤销栈（L）

**现状**：实时模式的撤销交给浏览器 `execCommand`，源码模式用 textarea 原生撤销，两边不互通；退出源码模式后历史断裂。

**为什么重要**：Typora 的撤销对象同时是**跨窗口同步协议**（`{type:'sync', html|allHtml|cmChanges}`），这一层没有，后面做多标签页、增量落盘都缺基础设施。

**做法**：实现快照式 undo——每次 brush 前记录 `{cid, htmlBefore, caretBefore}`，栈上限 200；源码模式的 textarea 变更也压同一栈，切换时用 `getMarkdown()` 对齐。

### T4 解析器是扁平的，没有嵌套块（L）

**现状**：列表项里不能放引用/代码块/第二层列表；引用内部按单段处理。

**做法**：块解析改成递归——`parseBlocks` 对容器类型（`list_item` / `blockquote`）递归调用自身，产出真正的树；渲染和序列化相应递归。

**注意**：这会同时改 `blockRaw` 的缩进规则（子块要按父级前缀缩进），是 T4 里最麻烦的部分。

### T5 软换行 / 硬换行没有区分（S）

**现状**：段落里的 `\n` 直接渲染成换行。

**应该**：GFM 语义里单个 `\n` 是 softbreak（渲染成空格），行尾两个空格或 `\` 才是 `<br>`。现在两者混为一谈，导出的 HTML 也和标准不一致。

### T6 没有性能基准（S）✅ 第 1 轮完成

**现状**：只在几十行的 demo 上测过。1 万行文档下画笔、大纲重建、表格序列化的表现**完全未知**。

**做法**：加 `test/bench.js`——生成 5k/20k 行文档，测 `loadMarkdown` 耗时、单次 brush 耗时、输入到渲染延迟。有了数字再决定优化哪里（我怀疑大纲的 MutationObserver 全量监听会先成为瓶颈）。

---

## 二、P0 —— 决定它能不能当主力

### F1 文件入口：双击打开、拖拽打开、最近打开（M）✅ 第 1 轮完成

**现状**：`Info.plist` 声明了 Markdown 文档类型，但**没有实现 `application(_:open:)`**，双击 `.md` 文件不会进 MarkFrame；拖文件到窗口也没接。

**为什么是 P0**：这比数学公式更影响日常。缺了它，每次都得先开 app 再 Cmd+O。

**做法**：`AppDelegate.application(_:open urls:)` → 取第一个 `.md` → 交给 `EditorWindowController.load(path:)`；窗口注册 `NSDraggingDestination` 接收文件；菜单加"最近打开"（`NSDocumentController.shared.recentDocumentURLs` 或自建 list）。

### F2 图片管理（M）✅ 第 2 轮完成（基础版）

**现状**：粘贴图片只取纯文本，图片直接丢失；插入只能手打 `![](path)`。

**做法**：
1. 监听 `paste` 的 `clipboardData.items`，取出 `image/png` 的 Blob
2. 转 base64 → 通过桥交给原生 → 原生写到文档同级 `assets/` 目录 → 返回相对路径
3. 页面插入 `![](assets/xxx.png)` 并重绘
4. 拖拽图片文件同理（`drop` 事件拿 `DataTransfer.files`，原生负责拷贝）

**配套**：图片点击选中 + 拖角缩放（写回 `{width=300}` 语法）、右键"在访达中显示"。

### F3 导出 PDF / HTML（M）✅ 第 2 轮完成

**现状**：完全没有导出。

**做法**：
- **PDF**：原生 `WKWebView.createPDF(configuration:)` 一步到位；难点在分页样式（`@page`、标题不落在页底、代码块不跨页断裂），需要一份专门的 print stylesheet
- **HTML**：把 `#write` 的 outerHTML + 当前主题 CSS 内联，图片转 base64（自包含单文件）
- 导出前把 `.md-expand` 标记全部收起，否则会导出成带星号的源码

### F4 代码块语法高亮 + 自动配对（M）✅ 高亮已完成，自动配对待做

**现状**：围栏代码块是纯文本，没有高亮；输入 `(` 不会自动补 `)`。

**做法**：
- 高亮：内嵌 highlight.js（~120KB，只带常用语言）或自写一个正则着色器（够用但粗糙）。围栏块渲染成 `<pre><code class="language-x">`，渲染后调用 `hljs.highlightElement`
- 注意：高亮会往 DOM 插 `<span>`，**必须保证 `rawText` 读的是 `textContent` 而不是还原 innerHTML**（现在 `fences` 分支读 `el.textContent`，天然安全）
- 自动配对：`beforeinput` 里判断插入字符，成对时插两个并把光标放中间

---

## 三、P1 —— 对标差距最大的部分

### F5 数学公式（M）
行内 `$x$` + 块级 `$$...$$`。内嵌 KaTeX（约 280KB，比 MathJax 小一个数量级）或随 Typora 用 MathJax SVG。新增 `inline_math` / `math_block` 节点类型，渲染后 `katex.render`；序列化时保留原始 TeX（存在 `data-tex` 里，不要序列化渲染结果）。点公式弹出源码编辑框。

### F6 Mermaid 图表（M）
内嵌 `mermaid.min.js`（约 1.5MB，包体会从 264KB 涨到 ~2MB，和 Typora 同量级）。围栏 ```` ```mermaid ```` 渲染成 `<div class="mermaid">`，异步 `mermaid.render` 出 SVG。错误时显示源码 + 报错，不阻塞编辑。

### F7 脚注 / TOC / 定义链接（M）
三种 Node 类型：`def_footnote`、`def_link`、`toc`。难点不在渲染，在**双向链接**——脚注引用要能跳到定义、定义要能跳回引用，删除引用后定义要能标记孤儿。Typora 有专门的 `refreshFootnoteReverseLink`。

### F8 多标签页 / 多窗口（L）
Typora 是每文档一个 `NSWindow` + 标签页组。需要把"文档状态"从 `EditorWindowController` 单例里抽出来（`Document` 对象：path / content / dirty / undo stack / scroll），窗口和标签只是视图。

### F9 文件树侧栏（M）
现在只有大纲。需要 `library.*` 那批桥命令：列目录、新建/重命名/删除/移动、拖拽。原生 `FileManager` 做，JS 只管展示。

### F10 粘贴 HTML → Markdown（M）
现在粘贴只取纯文本，从网页复制的格式全丢。需要 `turndown` 之类的转换器（约 30KB），或自己写一个够用的子集（标题/列表/链接/粗斜体/代码）。

---

## 四、P2 —— 锦上添花

| 项 | 说明 | 规模 |
|---|---|---|
| F11 快速打开 | `Cmd+P` 模糊搜文件名，需要文件索引（Typora 用 Web Worker + 自带 ripgrep） | L |
| F12 拼写检查 | `WKWebView` 自带 `spellcheck`，接系统词典 + 右键建议 | S |
| F13 HTML 块 | 内联编辑 + `iframe` 沙箱（Typora 用 `srcdoc` + 独立 partition） | M |
| F14 表情/语言补全 | 输入 `:` 补 emoji、围栏语言名补全 | S |
| F15 增量落盘 | 复刻 `document.syncChangeIfNeeded` 命令流协议，取代全量保存 | M |
| F16 发布分发 | dmg + 公证（现在 ad-hoc 签名，别人机器上会被 Gatekeeper 拦） | M |
| F17 主题包 | 支持用户自定义 CSS 主题目录（Typora 的 `themes/` + `*.user.css`） | S |
| F18 打印 | `NSPrintOperation` + 同一份 print stylesheet（和 F3 共用） | S |

---

## 五、建议的推进顺序

**迭代 1｜先变成"能日常打开来写"的工具**
`F1 文件入口` → `T2 光标偏移` → `T6 性能基准`

理由：F1 是使用门槛，T2/T6 决定后面优化的方向。这一轮结束时，它应该能接住"双击 md 文件"这个最基本的动作。

**迭代 2｜生产力闭环**
`F2 图片管理` → `F3 导出 PDF/HTML` → `F4 代码高亮`

理由：能插图、能导出，才算写完一篇文章。

**迭代 3｜补对标差距**
`F5 数学` → `F6 Mermaid` → `T1 行内标记可编辑`

理由：T1 放这里是因为它要重写行内渲染，最好等前面功能稳定后再动，避免每次加行内语法都要改两遍。

**迭代 4｜基础设施**
`T3 撤销栈` → `T4 嵌套块` → `F8 多标签页` → `F15 增量落盘`

理由：这四项互相咬合，撤销栈的"命令对象"正好是增量落盘的传输单元，一起做省一次返工。

**随时可做（不占主线）**：`T5 软换行`、`F12 拼写检查`、`F17 主题包`、`F18 打印`

---

## 六、风险提示

1. **T1 和 T4 会动基础数据结构**，每次都要重跑全部 56 项断言，建议先补测试再改。
2. **F5/F6 会让包体涨 10 倍**（264KB → ~2MB）。如果在意体积，可以把 KaTeX/mermaid 做成"首次用到才加载"的懒加载资源。
3. **F16 之前，不要把这个 app 发给别人**——ad-hoc 签名在未公证的情况下，别人的 macOS 会直接拒绝运行。
4. 目前**没有任何一行原生层自动化测试**，只有启动自检（`MARKFRAME_SELFTEST`）。原生代码越写越多时，这个缺口会反噬。
