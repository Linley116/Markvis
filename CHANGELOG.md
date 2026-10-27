# Changelog

本文件由 `node scripts/gen-changelog.js` 生成，请勿手工编辑；
版本与提交的映射见 `scripts/versions.json`，改动说明取自 [ROADMAP.md](ROADMAP.md) 第四节的「已修复」表。

每个版本同时会作为 GitHub Release 发布，页面见 <https://github.com/Linley116/Markvis/releases>。

---

## v0.14.6 — 2026-10-27

**feat: render Markdown inside details/summary blocks**

- 提交：[12addce](https://github.com/Linley116/Markvis/commit/12addce8c0cb5617f47149ae3b1282936cff798c)
- `<details><summary>` 后面直接跟 Markdown 列表时，列表行被浏览器折成一段，粗体/行内代码也不生效
  - 修法：预览与导出时把 `summary` 后的直接 Markdown 文本解析成普通 HTML：块级支持段落/标题/列表/引用/代码，行内支持 strong/em/del/code/link/image；`data-html` 原样保留，编辑浮层仍写回源码。预览默认展开，导出/PDF 也展开内容。新增 3 项引擎断言（源码保留、Markdown 解析、导出展开）

## v0.14.5 — 2026-10-26

**feat: filter and dedupe the code-language picker**

- 提交：[3f72021](https://github.com/Linley116/Markvis/commit/3f7202199f48f096e41b250b6ce9fa230d3092a2)
- v0.14.4 的语言选择是原生 select，重复出现 `Plain text` / `plaintext`，且一次列出全部语言；没有输入筛选
  - 修法：改成右上角语言输入 + body 浮层：默认列常用语言，输入按 value / 显示名 / aliases 匹配，↑↓/Enter/Esc/点击操作；按 value 与显示名双重去重（跳过 plaintext/text/txt），未注册语言可手动写入。切换仍走 `programEdit`，`blockRaw` 只读 `code`，导出/打印/搜索排除控件。浮层挂 body，不受代码块 `overflow` 裁切；菜单自身滚动不关闭。新增 5 项引擎断言

## v0.14.4 — 2026-10-26

**feat: add a code-block language picker in live mode**

- 提交：[a9c7754](https://github.com/Linley116/Markvis/commit/a9c7754eac567446dadde5a8150c46be86cb9abe)
- 实时模式的代码块只能看高亮结果，不能像 Typora 一样点选语言；源码模式补全不算
  - 修法：在 `pre.md-fences` 右上角加语言下拉：`Plain text` + 常用语言 + highlight.js 全部注册语言，按当前语言选中，未注册语言保留为选项。切换时更新 `data-fences`、`code.language-*` 并重新高亮，代码正文不变；走 `programEdit` 可撤销。`blockRaw` 只读 `code.textContent`，下拉不进入 Markdown；导出/打印前移除控件，搜索跳过下拉。新增 3 项引擎断言（下拉存在、切换写回并高亮、导出无控件）

## v0.14.3 — 2026-10-25

**feat: make outline headings collapsible by level**

- 提交：[053d618](https://github.com/Linley116/Markvis/commit/053d618cbaf9ff31d9b861aa407e15b34c1dba42)
- 大纲是平铺列表，二级标题下的三级标题无法折叠，长文档不便导航
  - 修法：按标题层级建父子树：后代由「下一个同级或更高级标题」界定；有子项的标题显示折叠按钮，折叠后隐藏整段子孙；状态按 `cid` 保存在会话内，自动重建后仍保留。当前节被折叠时高亮最近的可见祖先。`a` 支持 Enter/Space 跳转。新增 3 项功能断言（折叠隐藏、状态保留、再次展开）

## v0.14.2 — 2026-10-25

**fix: preserve inline formatting when splitting tall paragraphs for PDF**

- 提交：[1708964](https://github.com/Linley116/Markvis/commit/1708964eabe19f5e595ec6c2f9a23693038f244b)
- 超高段落超过一页时按纯文本切，粗体、链接、行内代码和图片全丢
  - 修法：用 DOM Range 按可见字符二分切块：先清掉 `.md-meta`、回跳箭头和零宽锚点，`br` / `img` / 行内公式 / 脚注引用按原子节点整体移动；每段测量后 `cloneContents` 出前缀、`deleteContents` 留剩余，清掉空 wrapper。续页仍是同一 P/H 外壳，行内结构与属性保留。新增 3 项引擎断言（多页、strong 保留、首尾完整）

## v0.14.1 — 2026-10-25

**fix: support table-cell line breaks and split HTML blocks by section**

- 提交：[0cff446](https://github.com/Linley116/Markvis/commit/0cff4467677f5d6328ebac6c90782b78b8755181)
- 表格单元格里 Enter 被直接拦掉，无法换行；HTML 块超过一页只能整块塞进 PDF
  - 修法：①**表格换行**：解析 `
  ` 为 hard break，单元格内 Enter / Shift+Enter 插入 `data-mark="
  "`；序列化不产生真实换行，表格结构不变。
  ②**HTML 分页**：导出时若 HTML 只有一个顶层元素就沿用它（保留 class/样式），多个顶层节点包容器；`splitBlock` 对 `md-html-print` 容器按子块拆页，表格仍走按行拆。单个不可拆元素超过一页时仍可能裁切。新增 2 项功能断言

## v0.14.0 — 2026-10-25

**feat: render block-level HTML in a sandboxed iframe**

- 提交：[e4ed632](https://github.com/Linley116/Markvis/commit/e4ed632aa0d8827f3b85c4113236dbe949922f5f)
- 块级 HTML 只能当普通文本看，无法安全渲染，也没法在编辑器里改
  - 修法：**F13**：解析 CommonMark 块级标签与注释/script/style/pre；每块用 `sandbox="allow-same-origin"`（不含 `allow-scripts`）的 `srcdoc` iframe 渲染，按内容自动测高、主题字体同步、相对图片按文档目录补 `base`；右上角 `</>` 复用源码浮层编辑，保存后刷新预览；`data-html` 原样序列化，保证 Markdown 往返。导出/打印时把 iframe 展开为普通 DOM，并移除 script/iframe/object/embed/base/meta-refresh 与 `on*`、`javascript:`；独立 HTML 导出和 PDF 分页都走这条路径。新增 9 项断言覆盖解析、sandbox、编辑、序列化、导出与分页

## v0.13.0 — 2026-10-25

**feat: add file-operation recovery and input completion**

- 提交：[a3d1c88](https://github.com/Linley116/Markvis/commit/a3d1c888108020a2e8ef3bfce1a7ea5a809b2e28)
- ①删除文件后无法撤销；移动遇到同名目标直接拒绝；
  ②输入 emoji 只能手打、围栏语言名只能记拼写
  - 修法：①**F9d**：`libraryDelete` 记录 `delete{from,to}`，撤销时从废纸篓移回并重建父目录；重名移动走 `dedupeMoveName` 自动变成 `name 2.md`，目标文件不覆盖；移动/重命名撤销后若当前文档路径也变了，同步 `currentPath` 并通知 Web 层。
  ②**F14**：新增 `features/autocomplete.js`——实时模式识别冒号 shortcode（避开 `10:30` / `http://`，支持中文后触发），源码模式识别围栏首行语言，维护 90 个 emoji 与语言别名；候选层支持 ↑↓/Enter/Tab/Esc 与鼠标，插入走 `MF.programEdit` 保留撤销；样式统一普通箭头，打印/导出时隐藏。新增 6 项功能断言和原生文件操作断言

## v0.12.1 — 2026-10-24

**fix(sidebar): use the normal arrow cursor instead of a hand**

- 提交：[74336e7](https://github.com/Linley116/Markvis/commit/74336e7f27de552d03bf3a109bfaa147127ecbbc)
- 鼠标移到左侧导航栏时整片变成手形指针，与普通桌面编辑器不一致
  - 修法：侧栏统一 `cursor: default`，包括 tab、大纲项、文件行和底部按钮；只有文本输入保留 I-beam、右边缘拖宽保留 `col-resize`。样式限定在 `#mf-sidebar` 内，不影响正文链接、按钮和预览区。新增 2 项断言（侧栏与 tab/大纲均为 default、拖拽条仍为 col-resize）

## v0.12.0 — 2026-10-24

**refactor: rename product from MarkFrame to Markvis**

- 提交：[b070685](https://github.com/Linley116/Markvis/commit/b070685aed5d8afa77fd9dd2dd23e198123c03d7)
- 产品从 MarkFrame 改名为 Markvis，远程仓库同步改名
  - 修法：全量替换品牌：`Markvis.app` / 可执行文件 / `local.markvis.editor` / Application Support 目录 / 日志前缀 / 窗口与标签标识 / 测试模块 `MarkvisTests` / 环境变量 `MARKVIS_*` / README、路线图、CI 与仓库链接。新增 `LegacyMigration`：新 Bundle ID 首次启动时用 `CFPreferencesCopyMultiple` 从 `local.markframe.editor` 补齐最近文件、会话、文件树根目录等偏好（不覆盖新值），并把 `Application Support/MarkFrame` 的主题与恢复文件按缺失补齐到 `Markvis`；旧目录保留，不做破坏性移动。内部 `mf.*` 偏好键与 `mf-` CSS 前缀保持不变，避免无意义的全局重命名风险

## v0.11.1 — 2026-10-24

**fix(app): keep running after the last window closes**

- 提交：[3dc86ab](https://github.com/Linley116/Markvis/commit/3dc86ab0da9116ddf918c2f6b640b04430a164b6)
- 点左上角红色关闭按钮，最后一个窗口关掉后整个 app 直接退出；Typora 会留在后台，点 Dock 图标还能回来
  - 修法：根因是 `applicationShouldTerminateAfterLastWindowClosed` 直接返回 `true`，macOS 把「关最后一个窗口」当成退出。改为 `false`，并补全无窗口状态：①`applicationShouldHandleReopen` 点 Dock 时恢复最小化窗口或新建空白窗口；
  ②`openFile` / `openFileInNewWindow` 在启动完成后不再只写 `pendingOpen`（原来没窗口时双击文件会静默丢失），当场建窗口加载；
  ③无窗口时 `Cmd+O` 先建窗口再开面板。启动前的 `application(_:open:)` 仍走 pending 队列，不影响双击冷启动

## v0.11.0 — 2026-10-24

**feat(release): add CI, native tests, DMG packaging; fix table widths and orphan footnotes**

- 提交：[887856d](https://github.com/Linley116/Markvis/commit/887856d9844bc1c330f90ef04f427b43553968fe)
- 发布线没有 CI、原生层没有自动化测试、表格窄列折行、孤儿脚注无提示；另外快速打开返回的 `/private/var` 路径与文件树根不一致
  - 修法：①**CI**：GitHub Actions macOS runner 安装锁定的 `playwright-core` 与隔离 Chromium，依次跑原生测试、`build.sh --keep`、两套 JS 断言、PDF 回归；新增 `package-lock.json`，测试浏览器支持 `MARKVIS_TEST_CHROME`，不再硬编码本机 Chrome。
  ②**T8**：抽出不依赖窗口的 `MFPath`（软链比较、`/private` 归一化、根目录越界、会话恢复过滤），文件树与 AppDelegate 改为复用它；新增 7 组原生场景覆盖路径、会话、JS 字面量、文件增删改移/撤销/越界、列表排序与快速打开索引。完整 Xcode 下由 XCTest 运行；只有 Command Line Tools 时 `test/native.sh` 编译同一组场景运行，避免本机装不了 XCTest 就完全没测试。
  ③**T10**：按单元格实际显示宽度（CJK 记 2）生成 `<colgroup>`，`table-layout: fixed`，长内容列最高 32 权重、短列最低 6，打印样式同步；表格序列化不变。
  ④**F7c**：`refreshFootnotes()` 在渲染与画笔后比对引用，给无引用定义加 `.md-fn-orphan` 和「无引用」提示、隐藏返回箭头，不改 Markdown。
  ⑤**F16**：新增 `release.sh`（签名/打包/可选公证）与 DMG 内 Applications 快捷方式；`Info.plist` 版本从 0.3.1 补到 0.11.0。
  ⑥**顺带修路径 bug**：`libraryAllFiles` 统一 `/private` 前缀，快速打开不再算出错误相对路径。新增 8 项 JS 断言、7 组原生场景

## v0.10.11 — 2026-10-24

**feat: restore last session on launch; focus the open window instead of reopening**

- 提交：[15cff50](https://github.com/Linley116/Markvis/commit/15cff50a787f6ba01fcf40b5e2454e6109bd61a4)
- ①重启后永远是空白窗口，得重新找上次在写的文件；
  ②同一个文件在文件树里再点一次会再开一份（同一文件两个窗口）
  - 修法：①**会话恢复**：`load(path:)` 一进来就记 `intendedPath`（早于异步加载，恢复期间不会漏窗口），`persistSession()` 把「开着的文档」写进 `mf.openFiles`、活动文件写 `mf.activeFile`——加载文档、开窗、关窗、退出时更新；启动时没有命令行参数就按列表恢复：删掉的不恢复、上限 10 个、其余并进同一标签组（`addTabbedWindow`），上次活动的窗口置前。关窗时同步更新，但 `isTerminating` 期间跳过——否则退出时窗口回调会把刚存好的会话清空。
  ②**打开去重**：`openFile(at:)` 先在所有窗口里找 `currentPath` / `intendedPath` 相同的（`resolvingSymlinksInPath` 归一化，`/tmp` 与 `/private/tmp` 算同一个文件），命中就 `makeKeyAndOrderFront` 把那个窗口提到前面，不再新建；「在新窗口打开」保持原样（显式要求新窗口）。原生改动，无新增 JS 断言（Swift 侧仍无测试目标，见 `T8`），靠启动日志实测：重复打开打印 `already open, focusing …`，重启打印 `restore session: 2 file(s)`

## v0.10.10 — 2026-10-24

**feat(F9): keep the tree root when opening files inside it; add "up" button**

- 提交：[1ef6662](https://github.com/Linley116/Markvis/commit/1ef666230bfb82a3d6d1c499ec78781374f2fcce)
- 在文件树里点开子文件夹、再打开里面的文件，根目录会跟着跳进那一层（打开一个文件就往里钻一层），用户选中的文件夹位置被顶掉
  - 修法：「根跟随文档」补一条边界：**文件已经在当前根之内就保持根不动**，只展开祖先并高亮；只有打开根外的文件（或还没有根）时才跟到它的父文件夹。底部操作条新增「上级目录」按钮（`parentDir(root)` → `library.setRoot`），到磁盘根时禁用并把 tooltip 改成「已经是顶层目录」，样式 `.mf-lib-act:disabled`。新增 3 项断言（根内不换根 / 根外才跟随 / 上级按钮回退且到顶层禁用）

## v0.10.9 — 2026-10-24

**fix(F9): expanded folders no longer collapse on file-tree refresh**

- 提交：[814bb1c](https://github.com/Linley116/Markvis/commit/814bb1c32e66b6e661cf4096a2ec0b001299d1ec)
- 打开文件夹后，鼠标移到某个文件夹上，已展开的层级会自己收起来（箭头还开着，里面却是空的）
  - 修法：根因是刷新只重拉根目录：`refresh()` 把整棵缓存清空后只 `loadDir(root)`，已展开的子目录拿不到内容，`treeHTML` 就不渲染子项；而 `state.expanded` 还留着 `true`，于是箭头朝下、内容为空，再点一下反而变成「收起」。三处修：①`refresh()` 改成「根 + 所有已展开且已加载的目录」一起重拉（`loadDir(path, cb, force)`），期间继续用旧缓存渲染、全部回来再一次性重绘，不闪不塌；
  ②新增 `isOpen(path)` = 展开 **且** 有缓存，箭头、递归、点击三处统一用它，渲染状态和真实状态不再错位；
  ③重绘保留 `scrollTop`，并把对当前文件的强制 `scrollIntoView` 从 `render()` 挪到 `revealFile()`，刷新不会把用户正在看的位置拽走。原生侧：判断「这批事件是不是自己写盘」时先排除目录条目——替换文件会连带改父目录 mtime，而目录路径从来不会登记成自写，不排除的话每次自动保存都被判成外部改动白刷一次；整批只有目录（新建空文件夹）时仍然通知。新增 4 项断言；`MARKVIS_TEST_AUTOSAVE` 自检复测：连续两次自动保存，监听日志 0 条，外部改动仍 1 条

## v0.10.8 — 2026-10-24

**feat(F11): quick open; fix watcher firing on our own autosave**

- 提交：[02e1b87](https://github.com/Linley116/Markvis/commit/02e1b879a77c869f5b7358c8de4e9a9f6013054d)
- 边打字文件树每 1.2s 刷新一次（v0.10.4 的 FSEvents 监听被自动保存触发）；另外「快速打开」缺失
  - 修法：①**修监听自触发**：自动保存/Cmd+S 改用自实现的 `writeAtomic`（临时文件自己命名 `.mf-tmp-<uuid>`，系统 `write(atomically:)` 的随机临时名认不出来），写盘前把「目标 + 临时」两个路径登记进 `selfWritePaths`；FSEvents 加 `kFSEventStreamCreateFlagFileEvents` 拿到具体文件路径，一批事件全是自己刚写过的路径就整批丢弃。**坑**：FSEvents 报的是真实路径（`/tmp` → `/private/tmp` 软链），两侧要统一去掉 `/private` 前缀才对得上（`URL.resolvingSymlinksInPath()` 在这不起作用）。文件树自身的增删改名也照样登记。自检新增 `MARKVIS_TEST_AUTOSAVE`（打开文档后连写两次，监听日志应为 0 条；外部改动仍应为 1 条）。
  ②**F11 快速打开**：新增 `features/quickopen.js` + 原生 `library.allFiles`（遍历根目录、按类型过滤、最多 5000 条、按修改时间倒序）；子序列模糊匹配（开头/分词边界/文件名命中加分），↑↓ 选择、Enter 打开、Esc 关闭、点遮罩关闭，清单缓存 30s（文件树变了作废）。`Cmd+Shift+P` + 文件菜单「快速打开…」（`Cmd+P` 未绑定）。新增 6 项断言

## v0.10.7 — 2026-10-24

**feat(F9b): file tree Typora details — sort, duplicate, drag-move, recents**

- 提交：[d2113d7](https://github.com/Linley116/Markvis/commit/d2113d79d4bb4b33a44b4121aa07c96b108831d9)
- 文件树只做了 Typora 文件侧栏的主体，细节（排序、复制、新窗口、拖拽移动、最近文件夹）都还没有
  - 修法：**F9b**：①**排序切换**——底部「排序」菜单：按名称 / 按修改时间 + 文件夹优先开关，偏好写 localStorage，排序参数传给原生（`library.list` 新增 `sort` / `groupDirs`，原生带 `mtime` 一起返回）；
  ②**Duplicate**——右键「复制」走 `library.duplicate`，重名自动 `name copy.md` / `name copy 2.md`；
  ③**在新窗口打开**——`library.openInNewWindow` → AppDelegate 的 `openFileInNewWindow`（不复用空白窗口）；
  ④**树内拖拽移动**——行可拖，拖到目录行移动、拖到空白回根目录，拒绝移进自己的子孙（环）和覆盖同名；拖到正文按 `caretPositionFromPoint` 落光标插相对链接（走 `MF.programEdit` 可撤销）；
  ⑤**最近文件夹 / 固定**——底部「最近」菜单：固定段 + 最近段，每条可固定/移除/切根，可清除列表（原生记在 UserDefaults，`setRoot` / `chooseRoot` / 打开文档都会记）；
  ⑥**撤销上一次文件操作**——`library.undoFileOp`，新建/复制→删除、重命名/移动→移回，删除进废纸篓不记入（v0.13.0 起支持撤销删除）。原生 `create/rename/delete/duplicate/move/reveal` 都加了显式 `root` 参数，自检可以在测试目录里跑；自检新增 `MARKVIS_TEST_LIBRARY_OPS` 真实跑一遍 create→duplicate×2→rename→move→(拒绝自嵌套)→undo，断言命名去重、循环拒绝、撤销还原；三种排序模式用错开时间戳的 fixture 验证。新增 9 项 JS 断言

## v0.10.6 — 2026-10-24

**feat(F10): paste HTML as Markdown — self-written html2md converter**

- 提交：[1c5596a](https://github.com/Linley116/Markvis/commit/1c5596afec439b1351dd677d92437e1a2bb72092)
- 从浏览器/Word 复制内容粘进来，格式全丢（只吞纯文本）
  - 修法：自写 `web/html2md.js`（311 行，不引 turndown）：DOMParser 走 DOM 树转 Markdown，覆盖标题/段落/加粗斜体删除线/行内代码/链接/图片/嵌套列表/任务清单/嵌套引用/带语言代码块/表格（含对齐）/分隔线/硬换行；script/style/表单控件整棵跳过。引擎粘贴处理改为：图片仍走原生存盘 → 剪贴板有**块级结构**的富文本就转换后按块插入（多块内容走 `reparseInto` 拆块重解析，光标落到粘贴末尾，可撤销）→ 没有富文本或是代码编辑器的高亮 HTML（全是 span，`isRich` 识别）就按纯文本插。表格单元格里按单行文本插。源码模式粘贴同样转换。新增 15 项断言（含真实页面结构 fixture 的转换 + 往返）

## v0.10.5 — 2026-10-24

**fix: Cmd+/ no longer jumps to the end of the document**

- 提交：[80d84fb](https://github.com/Linley116/Markvis/commit/80d84fb4c62eb135f18c5985d4971157d059a949)
- `Cmd+/` 切源码模式直接跳到文档最后
  - 修法：两个方向都保持位置：**实时→源码**时光标在可视区就跟着光标走（Typora 行为，`caretSourceOffset` + 块偏移表算绝对偏移），光标被滚出可视区就跟着视图顶部所在的块；**源码→实时**时光标在 textarea 可视区就跟着光标，用滚轮读到别处就跟着 textarea 滚动比例——把对应块滚到视图顶部并落光标，顺带修掉 `write.focus()` 把视图拽回开头的次生问题。**根因**：`source.value = 整篇` 会把光标送到末尾，`focus()` 再把内部滚动的 textarea 滚到底

## v0.10.4 — 2026-10-24

**redesign(F9): file tree follows Typora — left sidebar, root follows doc, auto-refresh**

- 提交：[7ac6a9e](https://github.com/Linley116/Markvis/commit/7ac6a9eb0f4f526547daf943d8ea2be7d33514e7)
- 文件树放在右侧，和 Typora 的左侧边栏对不上；根目录被手动选择粘住，打开别的目录的文件不跟过去；当前打开的文件在树里没有标记；访达里改了文件树不刷新；不支持类型的文件也列出来
  - 修法：按 Typora 的 Files Sidebar 重做：①合并成**左侧统一侧栏**，顶部「大纲 / 文件」图标 tab 切换（新增 `features/sidebar.js` 管外壳/宽度/开关，右上角按钮删除），`Cmd+Shift+O` 开关侧栏、`Cmd+Shift+E` 直接开到文件 tab；
  ②**根目录跟随当前文档**——打开一个文件，它的父文件夹就是树的根（Typora 的 "parent folder will be automatically loaded"），手动「打开文件夹…」同理，以最近一次动作为准；
  ③**当前文件高亮**并自动展开祖先目录滚动到可见；
  ④**只显示 Typora 支持的类型**（md/markdown/mdown/mkdn/mkd/txt，目录永远显示）；
  ⑤原生 **FSEvents 监听根目录子树**，外部增删改名防抖后自动刷新（行内编辑中不冲掉输入框）；
  ⑥侧栏底部加当前文件夹操作条（打开文件夹… / 刷新），右键菜单加「复制路径」；
  ⑦「显示/隐藏大纲」菜单改「显示/隐藏侧栏」并新增「显示文件树」

## v0.10.3 — 2026-10-24

**fix(test): never leave headless Chrome behind after tests**

- 提交：[7c47d08](https://github.com/Linley116/Markvis/commit/7c47d088b20aad66d68c0142183961be409671fd)
- 跑测试会拉起用户的 Google Chrome；命令一旦被超时/中断强杀，headless Chrome 变成孤儿进程留在机器上，只能去活动监视器手动杀
  - 修法：新增 `test/browser.js` 统一托管浏览器生命周期：自己 spawn Chrome（独立进程组 + 一次性临时 profile，不碰用户数据）走 CDP 连接；四层收尸——`process.on('exit')` 同步强杀进程组、SIGINT/SIGTERM 处理器、看门狗进程（node 被 SIGKILL 时它补刀，macOS 没有 `PR_SET_PDEATHSIG` 只能这么干）、正常收尾 `closeTestBrowser()`；三个测试文件改走 helper，188 项断言不变

## v0.10.2 — 2026-10-24

**feat(F9): file tree sidebar — library.* bridge, lazy tree, inline create/rename**

- 提交：[4d9c1b3](https://github.com/Linley116/Markvis/commit/4d9c1b32a840e250d00227373b74cddde621ad03)
- 只能开单文件，没有目录视图
  - 修法：右侧文件树面板（`Cmd+Shift+E` / 右上角开关）：目录懒加载、行内新建/重命名、删除进废纸篓、右键菜单、拖拽调宽、宽度与展开状态记忆；原生 `library.*` 桥（list/create/rename/delete/reveal/chooseRoot），路径全部校验在根目录内；根目录可选（记忆），默认跟随当前文档目录，再否则 Home

## v0.10.1 — 2026-10-24

**feat(T4): nested blocks — recursive block parser, lists in lists, blocks in items**

- 提交：[1bf9cbc](https://github.com/Linley116/Markvis/commit/1bf9cbc24874c28bae8601ae0ddf59ee4b027f56)
- 解析器是扁平的：列表项里放不了引用/代码块/二级列表，引用内部按单段处理
  - 修法：`parseBlocks` 拆成可递归的 `parseLines`：列表按缩进收集条目（含惰性续行），条目内容按「内容列」去缩进后递归解析；引用同样递归。序列化新增 `liRaw`（子块按 marker 宽度缩进写回）；嵌套容器在光标模型里按「当场算出的源码长度」当原子。**顺带修掉一个 T4 之前就存在的 bug**：`leafBlock()` 会被容器类型覆盖，导致列表项里回车把整个列表拆散

## v0.10.0 — 2026-10-24

**feat(T3): unified undo stack — one history across live and source mode**

- 提交：[dd0abc7](https://github.com/Linley116/Markvis/commit/dd0abc70f8e2605c762905a3fabc6ab60b78f04c)
- 实时与源码模式的撤销互不相通：切一次模式，之前的编辑就再也撤不回来（实测连按两次 `Cmd+Z` 只撤掉源码里的改动）
  - 修法：换成自己的快照栈：实时存「整篇 markdown + 光标（块序号/块内路径/偏移）」，源码存「textarea + 选区」；撤销到另一条模式的快照时先切过去再写内容，所以能穿过模式边界；200 步 / 3MB 上限，同模式 800ms 内连续输入合并成一步；程序化改动（回车、自动配对、`Cmd+B`、表格、插图片、粘贴）走 `programEdit` 统一压栈；「编辑」菜单的撤销/重做改走 `__cmd`

## v0.9.1 — 2026-10-23

**fix: YAML front matter was invisible — class collision with inline markers**

- 提交：[a22099b](https://github.com/Linley116/Markvis/commit/a22099bf1663dd692ffc785da784c1304f083828)
- 打开带 YAML front matter 的文件（如 `SKILL.md`）时，开头整块元数据**看不见**
  - 修法：T1 把行内标记的类名定成 `.md-meta`，块级 front matter 也叫这个名字 → 行内那条 `display:none` 把整块元数据一起藏了。块级改名 `.md-meta-block`（Typora 的叫法）；导出改为在分页时直接跳过 `mdtype=meta`；顺带吃掉文件开头的 BOM

## v0.9.0 — 2026-10-23

**feat(F17): custom CSS themes in ~/Library/Application Support/MarkFrame/themes**

- 提交：[0b2c3cb](https://github.com/Linley116/Markvis/commit/0b2c3cb50f5cb111211c2a014684c8452ff4ff7d)
- 主题写死五套，改配色只能改源码
  - 修法：用户主题目录 `~/Library/Application Support/Markvis/themes/*.css`：`@name` / `@base` 单行指令、CSS 变量覆盖、`--mf-editor-width` 控制栏宽；首次启动自动放一份带注释的示例；状态栏菜单切换，改完点「重新加载」即可

## v0.8.5 — 2026-10-23

**style: widen the reading column to Typora's breakpoints**

- 提交：[71e29a3](https://github.com/Linley116/Markvis/commit/71e29a33d6456ccc04cdd46aded5863368e78cb6)
- 正文栏固定 720px，1440 的窗口里只用到一半，读起来像信纸
  - 修法：对齐 Typora 默认主题的三级断点：860px → ≥1400px 1024px → ≥1800px 1200px；左右内边距 48→40，窄窗口（≤720px）收到 28px

## v0.8.4 — 2026-10-23

**feat: pin the outline toggle to the window's top-left corner**

- 提交：[de66580](https://github.com/Linley116/Markvis/commit/de665803004e5c7bc0772df8f91a08dc7080252b)
- 大纲开关在右下角状态栏，收起后只能靠快捷键或跑到底部再点
  - 修法：移到窗口左上角常驻：收起后按钮停在原位（同一坐标），点一下即重新展开；侧栏页眉里重复的 « 按钮随之删掉

## v0.8.3 — 2026-10-23

**feat: outline sidebar gets a status-bar toggle and a drag-to-resize edge**

- 提交：[95ade7e](https://github.com/Linley116/Markvis/commit/95ade7ee424dddc3cbf0e3b20ae3826450d9b113)
- 侧栏收起后只能靠快捷键打开，宽度也固定死
  - 修法：状态栏加「大纲」按钮（状态跟随），右边缘拖拽调宽 180–480px、双击复位、宽度记忆

## v0.8.2 — 2026-10-23

**fix: Cmd+/ could not leave source mode while the textarea had focus**

- 提交：[049ee02](https://github.com/Linley116/Markvis/commit/049ee02b33c4257a15d29211760e18236a12b1e0)
- 焦点在源码框里按 `Cmd+/` 切不回实时模式
  - 修法：textarea 与 document 各挂了一个监听，事件冒泡导致一次按键切两次、正反相消；删掉 textarea 上那份，统一由 document 处理

## v0.8.1 — 2026-10-23

**feat(F5b): edit math and diagrams from a floating source box; fix PDFPage lifetime**

- 提交：[dc08da5](https://github.com/Linley116/Markvis/commit/dc08da5072e5c1e7f22745157e76c1f2b3bf8e7a)
- `Drawing a PDFPage when its PDFDocument is nil`，偶发空页
  - 修法：导出改存 `PDFDocument`，合并时再取页

## v0.7 — 2026-10-23

**feat(T11): crash recovery for untitled documents**

- 提交：[db4aae4](https://github.com/Linley116/Markvis/commit/db4aae414a35248579631158ac784959805d02de)
- 未命名文档断电/崩溃即丢
  - 修法：每 1.2s 写恢复目录，启动时提示「恢复 / 丢弃」

## v0.6 — 2026-10-23

**feat(F7b): reference-style links + fix link clicks navigating the editor away**

- 提交：[a81feef](https://github.com/Linley116/Markvis/commit/a81feef5da28747296499c3a9f2bc9569603e5b9)
- 点正文链接会把 WKWebView 导航走，编辑器变网页
  - 修法：`decidePolicyFor` 拦截 http/https/mailto，交给系统浏览器

## v0.5 — 2026-10-23

**feat(T1): editable inline markers — .md-meta text nodes instead of pseudo-elements**

- 提交：[a18f1b3](https://github.com/Linley116/Markvis/commit/a18f1b3d36a6b4112753c0958fa45a95a52a9c3b)
- `Shift+Enter` 的换行保存后变成空格
  - 修法：GFM 软/硬换行：硬换行产出 `br.md-hardbreak`，往返无损
- 方向键整块跳过行内标记
  - 修法：`updateExpand` 改成只动需要变的元素，避免 `display` 闪一下

## v0.4 — 2026-10-22

**feat: iteration 4 — multi-document tabs, auto-pairing, GFM line breaks, image pipeline**

- 提交：[515c783](https://github.com/Linley116/Markvis/commit/515c7835ca7fc3500fc5b590f71c7eadb95e8b41)
- 打开第二个文件会顶掉当前文档
  - 修法：一文档一窗口 + 原生标签页组
- PDF 里相对路径图片缺失
  - 修法：按文档目录解析相对路径 + 导出内联 data URL

## v0.3 — 2026-10-21

**feat: MarkFrame — native macOS Markdown editor with paginated PDF export**

- 提交：[b633415](https://github.com/Linley116/Markvis/commit/b63341533d3cf0016123a6278a3f0254d1a45c3d)
- `printOperation` 产出十万级空白页；`NSPrintOperation(view:)` 全白
  - 修法：自研分页：JS 装 A4 页 → 逐页 `createPDF` → PDFKit 合并
- 导出 HTML 没有样式（`cssRules` 抛 SecurityError）
  - 修法：由原生从 bundle 注入 `style.css`
