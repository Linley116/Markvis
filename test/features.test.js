// 功能模块测试：表格 / 查找替换 / 大纲 / 主题 / 专注模式 / 自动保存

const path = require('path');
const { launchTestBrowser, closeTestBrowser } = require('./browser');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'web', 'index.html');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + String(extra) : '')); }
}

const TABLE_MD = [
  '# 表格',
  '',
  '| Name | Qty | Price |',
  '|:---|---:|:---:|',
  '| apple | 3 | 1.5 |',
  '| banana | 12 | 0.8 |',
  '',
  '## 查找用',
  '',
  'apple pie, apple tart, apple juice.',
  '',
  '### 三级标题',
  '',
  'end'
].join('\n');

(async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(PAGE);
  await page.waitForTimeout(300);
  await page.evaluate(md => window.__loadContent('', md, 'test.md'), TABLE_MD);
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 表格
  console.log('\n[1] 表格');
  const t = await page.evaluate(() => {
    const tb = document.querySelector('table[mdtype="table"]');
    return {
      exists: !!tb,
      ths: tb ? [...tb.querySelectorAll('th')].map(e => e.textContent) : [],
      rows: tb ? tb.querySelectorAll('tr').length : 0,
      align: tb ? JSON.parse(tb.getAttribute('data-align')) : [],
      md: window.__getMarkdown()
    };
  });
  check('表格已渲染', t.exists);
  check('表头 3 列', t.ths.length === 3 && t.ths[0] === 'Name', JSON.stringify(t.ths));
  check('2 行数据 + 1 行表头', t.rows === 3, t.rows);
  check('解析出对齐方式', JSON.stringify(t.align) === '["left","right","center"]', JSON.stringify(t.align));
  check('序列化保留表格语法', /^\| Name\s+\| Qty \| Price \|$/m.test(t.md), t.md.split('\n')[2]);
  check('序列化保留右对齐分隔', /\|\s*-+:\s*\|/.test(t.md));
  check('序列化保留居中分隔', /\|\s*:-+:\s*\|/.test(t.md));

  console.log('\n[2] 表格 Tab 导航');
  await page.evaluate(() => {
    const cell = document.querySelector('table td');
    cell.focus();
    window.MF.setCaretBySourceOffset(cell, 0);
  });
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => {
    // contenteditable 里 activeElement 恒为容器，要看 selection 落在哪个单元格
    const sel = window.getSelection();
    let node = sel.anchorNode;
    while (node && node.nodeType !== 1) node = node.parentNode;
    while (node && node.tagName !== 'TD' && node.tagName !== 'TH') node = node.parentNode;
    return { tag: node && node.tagName, cell: node && node.getAttribute('data-cell'), text: node && node.textContent };
  });
  check('Tab 进入下一个单元格', afterTab.tag === 'TD' && afterTab.text === '3', JSON.stringify(afterTab));

  await page.evaluate(() => {
    const cells = [...document.querySelectorAll('table td')];
    window.MF.setCaretBySourceOffset(cells[cells.length - 1], 0);
  });
  await page.keyboard.press('Tab');
  const rowAdded = await page.evaluate(() => {
    const tb = document.querySelector('table');
    return { rows: tb.querySelectorAll('tbody tr').length, cells: tb.querySelectorAll('tbody td').length };
  });
  check('最后一格 Tab 新增一行', rowAdded.rows === 3, JSON.stringify(rowAdded));

  console.log('\n[2.1] 表格单元格换行');
  await page.evaluate(() => {
    const cell = document.querySelector('table td');
    cell.focus();
    window.MF.setCaretBySourceOffset(cell, 4);   // Name 末尾
  });
  await page.waitForTimeout(50);
  await page.keyboard.press('Enter');
  await page.keyboard.type('line2', { delay: 8 });
  await page.waitForTimeout(450);
  const cellBreak = await page.evaluate(() => {
    const tb = document.querySelector('table');
    const first = tb.querySelector('tbody td');
    return {
      md: window.__getMarkdown(),
      rows: tb.querySelectorAll('tbody tr').length,
      brs: first.querySelectorAll('br.md-hardbreak').length,
      text: first.textContent,
      lines: window.__getMarkdown().split('\n').slice(0, 8)
    };
  });
  check('单元格内换行写成 <br>', /<br>line2/.test(cellBreak.md),
        JSON.stringify(cellBreak.lines));
  check('单元格换行不新增表格行', cellBreak.rows === 3 && cellBreak.brs === 1, JSON.stringify(cellBreak));
  await page.evaluate(md => window.__loadContent('', md, 'test.md'), TABLE_MD);
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 查找
  console.log('\n[3] 查找替换');
  await page.keyboard.press('Meta+f');
  await page.waitForTimeout(120);
  await page.fill('#mf-find', 'apple');
  await page.waitForTimeout(150);
  const found = await page.evaluate(() => ({
    visible: document.getElementById('mf-search').classList.contains('mf-show'),
    count: document.getElementById('mf-count').textContent,
    hl: typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('mf-search') : null
  }));
  check('查找面板打开', found.visible);
  check('匹配计数正确', found.count === '1/4', found.count);
  check('Custom Highlight 已注册', found.hl === true, String(found.hl));

  await page.click('#mf-next');
  const nextCount = await page.evaluate(() => document.getElementById('mf-count').textContent);
  check('跳到下一个', nextCount === '2/4', nextCount);

  await page.fill('#mf-replace', 'pear');
  await page.click('#mf-repall');
  await page.waitForTimeout(150);
  const replaced = await page.evaluate(() => ({
    md: window.__getMarkdown(),
    count: document.getElementById('mf-count').textContent
  }));
  check('全部替换生效', (replaced.md.match(/pear/g) || []).length === 4, replaced.md.split('\n')[11]);
  check('替换后不再有 apple', !/apple/.test(replaced.md));
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- 大纲
  console.log('\n[4] 大纲侧栏');
  await page.waitForTimeout(350);
  const outline = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.mf-outline-item')];
    return {
      open: document.body.classList.contains('mf-sidebar-open'),
      count: items.length,
      levels: items.map(i => i.getAttribute('data-level')),
      texts: items.map(i => i.textContent)
    };
  });
  check('侧栏默认展开', outline.open);
  check('列出 3 个标题', outline.count === 3, outline.count);
  check('层级正确', JSON.stringify(outline.levels) === '["1","2","3"]', JSON.stringify(outline.levels));
  check('标题文本正确', outline.texts[0] === '表格', outline.texts.join('|'));

  const cursors = await page.evaluate(() => {
    const sidebar = document.getElementById('mf-sidebar');
    return {
      sidebar: getComputedStyle(sidebar).cursor,
      tab: getComputedStyle(document.querySelector('.mf-side-tab')).cursor,
      item: getComputedStyle(document.querySelector('.mf-outline-item')).cursor,
      resizer: getComputedStyle(document.querySelector('.mf-sidebar-resizer')).cursor
    };
  });
  check('侧栏内是普通箭头', cursors.sidebar === 'default' && cursors.tab === 'default' && cursors.item === 'default',
        JSON.stringify(cursors));
  check('拖宽手柄保留 col-resize', cursors.resizer === 'col-resize', cursors.resizer);

  const jumped = await page.evaluate(async () => {
    const before = document.getElementById('scroll').scrollTop;
    document.querySelectorAll('.mf-outline-item')[2].click();
    await new Promise(r => setTimeout(r, 80));
    return { before, after: document.getElementById('scroll').scrollTop };
  });
  check('点击大纲发生滚动', jumped.after !== jumped.before, JSON.stringify(jumped));

  await page.keyboard.press('Meta+Shift+O');
  const collapsed = await page.evaluate(() => document.body.classList.contains('mf-sidebar-open'));
  check('Cmd+Shift+O 收起侧栏', collapsed === false);

  console.log('\n[4.1] 左上角大纲开关与拖拽调宽');
  const fab = await page.evaluate(() => {
    const btn = document.getElementById('mf-outline-btn');
    const rect = () => {
      const r = btn.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width)];
    };
    const state = () => ({
      open: document.body.classList.contains('mf-sidebar-open'),
      pressed: btn.getAttribute('aria-pressed'),
      title: btn.title,
      rect: rect(),
      visible: rect()[2] > 0 && getComputedStyle(btn).display !== 'none'
    });

    const closedAtStart = state();   // 上一步 Cmd+Shift+O 已收起
    btn.click();                     // 左上角点一下：展开
    const opened = state();
    btn.click();                     // 再点：收起
    const closedAgain = state();
    btn.click();                     // 还在原位：重新展开
    const reopened = state();

    return {
      closedAtStart, opened, closedAgain, reopened,
      position: getComputedStyle(btn).position,
      hasHeaderClose: !!document.querySelector('#mf-outline-close')
    };
  });
  check('大纲开关固定在左上角',
        fab.position === 'fixed' && fab.closedAtStart.rect[0] < 40 && fab.closedAtStart.rect[1] < 40,
        JSON.stringify(fab.closedAtStart.rect));
  check('收起状态下按钮仍然可见', fab.closedAtStart.visible === true && fab.closedAtStart.open === false,
        JSON.stringify(fab.closedAtStart));
  check('点按钮展开侧栏', fab.opened.open === true && fab.opened.pressed === 'true', JSON.stringify(fab.opened));
  check('再点一次收起，按钮位置不变',
        fab.closedAgain.open === false && fab.closedAgain.pressed === 'false' &&
        fab.closedAgain.rect.join() === fab.closedAtStart.rect.join(),
        JSON.stringify(fab.closedAgain));
  check('收起后提示文案变为「显示侧栏」', /显示侧栏/.test(fab.closedAgain.title), fab.closedAgain.title);
  check('同一位置再点可以重新展开', fab.reopened.open === true && fab.reopened.pressed === 'true',
        JSON.stringify(fab.reopened));
  check('侧栏页眉不再有自己的收起按钮', fab.hasHeaderClose === false);

  const resized = await page.evaluate(async () => {
    if (!document.body.classList.contains('mf-sidebar-open')) {
      document.getElementById('mf-outline-btn').click();
    }
    await new Promise(r => setTimeout(r, 60));
    const r = document.querySelector('.mf-sidebar-resizer');
    const rect = r.getBoundingClientRect();
    const widthOf = () => Math.round(document.getElementById('mf-sidebar').getBoundingClientRect().width);

    r.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, clientX: rect.left + 2, clientY: rect.top + 40
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 320 }));
    await new Promise(res => setTimeout(res, 40));
    const during = widthOf();
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await new Promise(res => setTimeout(res, 40));

    const saved = localStorage.getItem('mf.sidebar.width');
    const margin = getComputedStyle(document.getElementById('scroll')).marginLeft;

    r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(res => setTimeout(res, 40));

    return { during, saved, margin, reset: widthOf() };
  });
  check('拖拽能改变侧栏宽度', resized.during === 320, JSON.stringify(resized));
  check('正文左边距跟着一起动', resized.margin === '320px', resized.margin);
  check('宽度写入 localStorage', resized.saved === '320', resized.saved);
  check('双击复位到 240', resized.reset === 240, resized.reset);

  console.log('\n[4.2] 正文栏宽（对齐 Typora 的 860 / 1024 / 1200 三档）');
  const col = await page.evaluate(() => {
    const el = document.getElementById('write');
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect().width;
    return {
      inner: Math.round(box - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      avail: document.getElementById('scroll').clientWidth,
      cap: parseFloat(cs.maxWidth)
    };
  });
  check('栏宽上限不小于 860px', col.cap >= 860, JSON.stringify(col));
  check('正文用满可用宽度（不再固定 720）',
        col.inner === Math.round(Math.min(col.cap, col.avail) - 80), JSON.stringify(col));

  // ---------------------------------------------------------------- 主题
  console.log('\n[5] 主题');
  const themes = await page.evaluate(() => {
    const out = [];
    ['dark', 'sepia', 'nord', 'auto'].forEach(id => {
      window.MFTheme.apply(id);
      out.push(document.documentElement.getAttribute('data-theme'));
    });
    return out;
  });
  check('切换到 dark', themes[0] === 'dark', themes.join(','));
  check('切换到 sepia', themes[1] === 'sepia');
  check('切换到 nord', themes[2] === 'nord');
  check('auto 移除属性', themes[3] === null, String(themes[3]));

  console.log('\n[5.1] 自定义主题（桩掉 themes.* 桥，走真实代码路径）');
  const custom = await page.evaluate(() => {
    const bridge = window.bridge;
    const orig = bridge.callHandler;
    const CSS = '/* @name: 纸墨 */\n/* @base: dark */\n' +
                ':root{--bg:#101010;--fg:#eeeeee;--mf-editor-width:700px}';

    bridge.callHandler = function (name, data, cb) {
      if (name === 'themes.list') { if (cb) cb([{ id: 'demo', name: '纸墨' }]); return; }
      if (name === 'themes.read') { if (cb) cb({ css: CSS, name: '纸墨' }); return; }
      return orig.call(bridge, name, data, cb);
    };

    window.MFTheme.reload();
    window.MFTheme.apply('file:demo');

    const el = document.getElementById('mf-custom-theme');
    const applied = {
      base: document.documentElement.getAttribute('data-theme'),
      injected: el ? el.textContent : '',
      btn: document.getElementById('mf-theme-btn').textContent,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      width: getComputedStyle(document.getElementById('write')).maxWidth,
      list: window.MFTheme.list().map(t => t.id)
    };

    window.MFTheme.apply('light');
    const cleared = {
      base: document.documentElement.getAttribute('data-theme'),
      style: !!document.getElementById('mf-custom-theme'),
      width: getComputedStyle(document.getElementById('write')).maxWidth,
      btn: document.getElementById('mf-theme-btn').textContent
    };

    bridge.callHandler = orig;
    return { applied, cleared };
  });
  check('自定义主题按 @base 打底', custom.applied.base === 'dark', String(custom.applied.base));
  check('自定义 CSS 被注入', custom.applied.injected.indexOf('#101010') >= 0, custom.applied.injected.slice(0, 40));
  check('主题变量真的生效', custom.applied.bg === '#101010', custom.applied.bg);
  check('主题能改正文栏宽', custom.applied.width === '700px', custom.applied.width);
  check('按钮显示 @name', custom.applied.btn === '纸墨', custom.applied.btn);
  check('列表里出现自定义主题', custom.applied.list.indexOf('file:demo') >= 0, custom.applied.list.join(','));
  check('切回内置主题会移除自定义样式',
        custom.cleared.style === false && custom.cleared.base === 'light', JSON.stringify(custom.cleared));
  check('栏宽回到默认三档', custom.cleared.width === '860px', custom.cleared.width);

  const metaCases = await page.evaluate(() => ({
    doc: window.MFTheme.parseMeta('/*\n *  @name : 这是文档里的说明文字\n */\n/* @name: 纸墨 */\n/* @base: dark */'),
    bare: window.MFTheme.parseMeta('@name: 简约\n@base: sepia'),
    none: window.MFTheme.parseMeta(':root{ --bg:#fff }')
  }));
  check('多行注释里的说明不会当成 @name',
        metaCases.doc.name === '纸墨' && metaCases.doc.base === 'dark', JSON.stringify(metaCases.doc));
  check('裸写指令也能解析',
        metaCases.bare.name === '简约' && metaCases.bare.base === 'sepia', JSON.stringify(metaCases.bare));
  check('没有指令时回落 light',
        metaCases.none.name === '' && metaCases.none.base === 'light', JSON.stringify(metaCases.none));

  console.log('\n[5.2] 主题菜单');
  const menu = await page.evaluate(() => {
    window.MFTheme.apply('auto');
    document.getElementById('mf-theme-btn').click();
    const el = document.getElementById('mf-theme-menu');
    const items = Array.from(el.querySelectorAll('[data-theme-id]')).map(i => i.getAttribute('data-theme-id'));
    const shown = el.classList.contains('mf-show');
    const acts = Array.from(el.querySelectorAll('[data-action]')).map(a => a.getAttribute('data-action'));

    // 点条目切换
    const darkItem = el.querySelector('[data-theme-id="dark"]');
    darkItem.click();
    const afterClick = {
      base: document.documentElement.getAttribute('data-theme'),
      closed: !el.classList.contains('mf-show')
    };

    // 再开一次，点外面应该收起
    document.getElementById('mf-theme-btn').click();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { items, shown, acts, afterClick, closedOutside: !el.classList.contains('mf-show') };
  });
  check('菜单列出全部内置主题',
        ['auto', 'light', 'dark', 'sepia', 'nord'].every(id => menu.items.indexOf(id) >= 0),
        menu.items.join(','));
  check('菜单有打开文件夹与重新加载', menu.acts.indexOf('open') >= 0 && menu.acts.indexOf('reload') >= 0,
        menu.acts.join(','));
  check('点条目切换主题并收起', menu.afterClick.base === 'dark' && menu.afterClick.closed, JSON.stringify(menu.afterClick));
  check('点菜单外面收起', menu.closedOutside === true);

  // ---------------------------------------------------------------- 专注
  console.log('\n[6] 专注模式');
  const focus = await page.evaluate(async () => {
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 0);
    window.MFFocus.toggleFocus();
    await new Promise(r => setTimeout(r, 60));
    return {
      on: document.body.classList.contains('mf-focus'),
      current: document.querySelectorAll('.mf-focus-current').length
    };
  });
  check('专注模式开启', focus.on);
  check('只有当前块高亮', focus.current === 1, focus.current);

  // ---------------------------------------------------------------- 自动保存
  console.log('\n[7] 自动保存');
  const autosave = await page.evaluate(async () => {
    window.__auto = [];
    const orig = window.bridge.callHandler;
    window.bridge.callHandler = function (n, d) {
      if (n === 'document.autoSave') window.__auto.push(d);
      return orig.apply(this, arguments);
    };
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 0);
    document.execCommand('insertText', false, 'X');
    await new Promise(r => setTimeout(r, 1500));
    return window.__auto.length;
  });
  check('输入后触发 autoSave', autosave >= 1, autosave);

  console.log('\n[8] 导出 HTML');
  const exp = await page.evaluate(() => {
    window.__prepareExport();
    const html = window.__buildExportHTML();
    const inExport = document.body.classList.contains('mf-export');
    window.__finishExport();
    return {
      len: html.length,
      doctype: html.indexOf('<!DOCTYPE html>') === 0,
      style: html.includes('<style>'),
      content: html.includes('<h1'),
      inExport,
      cleaned: !document.body.classList.contains('mf-export')
    };
  });
  check('HTML 有 doctype', exp.doctype);
  check('内联了样式表', exp.style);
  check('包含渲染后的正文', exp.content);
  check('导出期间加了标记类', exp.inExport);
  check('导出后清理标记类', exp.cleaned);

  console.log('\n[9] 图片粘贴');
  const imgMd = await page.evaluate(async () => {
    window.__loadContent('', '第一段\n\n第二段\n', 't.md');
    await new Promise(r => setTimeout(r, 100));

    // 拦截原生存盘，返回一个假路径
    const orig = window.bridge.callHandler;
    window.bridge.callHandler = function (n, d, cb) {
      if (n === 'images.savePNG') { if (cb) cb('assets/test.png'); return; }
      return orig.apply(this, arguments);
    };

    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, window.MF.inlineRaw(p).length);

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    p.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true
    }));

    await new Promise(r => setTimeout(r, 600));
    return window.__getMarkdown();
  });
  check('图片插入为 markdown', /!\[\]\(assets\/test\.png\)/.test(imgMd), JSON.stringify(imgMd).slice(0, 120));

  console.log('\n[10] front matter / 列表起始编号 / 表格列数');
  const rich = await page.evaluate(async () => {
    const md = '---\nname: x\nversion: 1\n---\n\n# T\n\n3. 第三\n4. 第四\n\n| A | B | C | D |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n';
    window.__loadContent('', md, 't.md');
    await new Promise(r => setTimeout(r, 120));
    const ol = document.querySelector('ol');
    const meta = document.querySelector('pre.md-meta-block');
    return {
      meta: !!meta,
      metaText: meta ? meta.textContent : '',
      metaVisible: meta ? getComputedStyle(meta).display !== 'none' &&
                          meta.getBoundingClientRect().height > 0 : false,
      olStart: ol ? ol.getAttribute('start') : null,
      cols: document.querySelectorAll('table th').length,
      md: window.__getMarkdown()
    };
  });
  check('front matter 渲染为元数据块', rich.meta && /name: x/.test(rich.metaText), rich.metaText.slice(0, 30));
  // 这条是 v0.9.1 的回归前提：块必须真的可见（曾经被 .md-meta 的 display:none 波及）
  check('front matter 块可见', rich.metaVisible === true, JSON.stringify(rich.metaVisible));
  check('有序列表保留起始编号', rich.olStart === '3', rich.olStart);
  check('表格 4 列', rich.cols === 4, rich.cols);
  check('序列化保留 front matter', rich.md.indexOf('---\nname: x') === 0, rich.md.slice(0, 20));
  check('序列化保留列表编号', /^3\. 第三$/m.test(rich.md));

  console.log('\n[12] 文件树（F9，左侧统一侧栏，桩掉 library.* 桥）');
  const lib = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const calls = [];
    const tree = [
      { name: 'notes', path: '/root/notes', dir: true, ext: '' },
      { name: 'a.md', path: '/root/a.md', dir: false, ext: 'md' },
      { name: 'b.txt', path: '/root/b.txt', dir: false, ext: 'txt' }
    ];
    const sub = [{ name: 'deep.md', path: '/root/notes/deep.md', dir: false, ext: 'md' }];

    const orig = window.bridge.callHandler;
    window.bridge.callHandler = function (name, data, cb) {
      calls.push({ name: name, data: data });
      if (name === 'library.root' && cb) return cb({ root: '/root' });
      if (name === 'library.setRoot' && cb) return cb({ root: data && data.path });
      if (name === 'library.list' && cb) {
        return cb(data && data.path === '/root/notes' ? sub : tree);
      }
      if (name === 'library.create' && cb) return cb({ ok: true, path: '/root/new.md' });
      if (name === 'library.delete' && cb) return cb({ ok: true });
      if (cb) cb(null);
    };

    window.MFLibrary.rootChanged();
    await wait(120);
    window.MFLibrary.open();   // 打开侧栏并切到「文件」tab
    await wait(120);

    const paneVisible = () => {
      const files = document.getElementById('mf-pane-files');
      const outline = document.getElementById('mf-pane-outline');
      return {
        sidebarOpen: document.body.classList.contains('mf-sidebar-open'),
        activeTab: window.MFSidebar.activeTab(),
        filesShown: !!files && !files.hidden,
        outlineHidden: !!outline && outline.hidden
      };
    };
    const tabState = paneVisible();

    const rows = Array.from(document.querySelectorAll('.mf-lib-row')).map(r => ({
      name: r.querySelector('.mf-lib-name').textContent,
      dir: r.getAttribute('data-dir') === '1'
    }));

    document.querySelector('.mf-lib-row[data-path="/root/notes"]').click();
    await wait(120);
    const afterExpand = Array.from(document.querySelectorAll('.mf-lib-row'))
      .map(r => r.querySelector('.mf-lib-name').textContent);

    // 鼠标悬停在已展开的文件夹上：不该有任何状态变化（曾经以为 hover 会收起）
    const dirRow = document.querySelector('.mf-lib-row[data-path="/root/notes"]');
    ['mouseover', 'mouseenter', 'mousemove'].forEach(t => {
      dirRow.dispatchEvent(new MouseEvent(t, { bubbles: t !== 'mouseenter' }));
    });
    await wait(150);
    const afterHover = Array.from(document.querySelectorAll('.mf-lib-row'))
      .map(r => r.querySelector('.mf-lib-name').textContent);

    // 原生监听通知（FSEvents 外部改动）触发刷新：已展开的层级不能塌回去
    window.MFLibrary.changed();
    await wait(700);
    const afterRefresh = {
      rows: Array.from(document.querySelectorAll('.mf-lib-row'))
        .map(r => r.querySelector('.mf-lib-name').textContent),
      // 刷新要连已展开的子目录一起重拉，只拉根目录就会丢内容
      recentLists: calls.filter(c => c.name === 'library.list')
        .slice(-2).map(c => c.data.path)
    };

    document.querySelector('.mf-lib-row[data-path="/root/a.md"]').click();
    await wait(60);
    const openCall = calls.filter(c => c.name === 'document.openPath').pop();

    // 面板在左侧：贴左边缘，正文让出左边距
    const panel = document.getElementById('mf-sidebar');
    const rect = panel.getBoundingClientRect();
    const margin = getComputedStyle(document.getElementById('scroll')).marginLeft;

    // 新建文件（行内输入 + Enter）
    document.querySelector('[data-act="newfile"]').click();
    const input = document.querySelector('.mf-lib-input');
    input.value = 'hello.md';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(100);
    const createCall = calls.filter(c => c.name === 'library.create').pop();

    // 删除（confirm 桩掉，走右键菜单）
    window.confirm = function () { return true; };
    document.querySelector('.mf-lib-row[data-path="/root/b.txt"]')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await wait(60);
    const delBtn = Array.from(document.querySelectorAll('.mf-lib-menu-item'))
      .find(b => b.textContent === '删除');
    delBtn.click();
    await wait(100);
    const deleteCall = calls.filter(c => c.name === 'library.delete').pop();

    // 打开「根内」的文档：根保持不动（不往里钻一层），只展开祖先 + 高亮
    window.MFLibrary.followDocument('/root/notes/deep.md');
    await wait(150);
    const followed = {
      setRootCall: calls.filter(c => c.name === 'library.setRoot').pop(),
      rows: Array.from(document.querySelectorAll('.mf-lib-row')).map(r => ({
        name: r.querySelector('.mf-lib-name').textContent,
        current: r.classList.contains('mf-lib-current')
      })),
      rootTitle: document.querySelector('.mf-lib-root-name').textContent
    };

    // 打开「根外」的文档：这时才跟到它的父文件夹
    window.MFLibrary.followDocument('/other/x.md');
    await wait(150);
    const outside = {
      setRootCall: calls.filter(c => c.name === 'library.setRoot').pop(),
      rootTitle: document.querySelector('.mf-lib-root-name').textContent
    };

    // 「上级目录」按钮：/other → /
    const upBtn = document.querySelector('.mf-lib-rootbar [data-act="up"]');
    const upEnabledAtOther = upBtn && !upBtn.disabled;
    upBtn.click();
    await wait(150);
    const up = {
      setRootCall: calls.filter(c => c.name === 'library.setRoot').pop(),
      rootTitle: document.querySelector('.mf-lib-root-name').textContent,
      disabled: upBtn.disabled
    };

    // 底部文件夹操作条（Typora 放在侧栏底部）
    const rootbar = {
      hasOpen: !!Array.from(document.querySelectorAll('.mf-lib-rootbar [data-act]'))
        .find(b => b.getAttribute('data-act') === 'root'),
      hasRefresh: !!Array.from(document.querySelectorAll('.mf-lib-rootbar [data-act]'))
        .find(b => b.getAttribute('data-act') === 'refresh'),
      hasUp: !!upBtn,
      upEnabledAtOther: upEnabledAtOther
    };

    window.MFSidebar.toggle();   // 收起整个侧栏
    await wait(60);

    window.bridge.callHandler = orig;
    return {
      tabState, rows, afterExpand, afterHover, afterRefresh, openCall,
      rectLeft: Math.round(rect.left),
      margin, createCall, deleteCall,
      followed, outside, up, rootbar,
      closed: !document.body.classList.contains('mf-sidebar-open')
    };
  });
  check('根目录列出条目', lib.rows.length === 3 && lib.rows[0].name === 'notes', JSON.stringify(lib.rows));
  check('目录排在文件前', lib.rows[0].dir === true && lib.rows[1].dir === false, JSON.stringify(lib.rows));
  check('点目录展开子级', lib.afterExpand.indexOf('deep.md') >= 0, JSON.stringify(lib.afterExpand));
  check('悬停在已展开的文件夹上不会收起', JSON.stringify(lib.afterHover) === JSON.stringify(lib.afterExpand),
        JSON.stringify(lib.afterHover));
  check('外部变化刷新后展开的层级不塌回去',
        JSON.stringify(lib.afterRefresh.rows) === JSON.stringify(lib.afterExpand),
        JSON.stringify(lib.afterRefresh));
  check('刷新连已展开的子目录一起重拉',
        lib.afterRefresh.recentLists.indexOf('/root/notes') >= 0,
        JSON.stringify(lib.afterRefresh.recentLists));
  check('点文件走 document.openPath', lib.openCall && lib.openCall.data.path === '/root/a.md', JSON.stringify(lib.openCall));
  check('打开即切到文件 tab 并隐藏大纲',
        lib.tabState.activeTab === 'files' && lib.tabState.filesShown === true &&
        lib.tabState.outlineHidden === true && lib.tabState.sidebarOpen === true,
        JSON.stringify(lib.tabState));
  check('面板贴在左侧且正文让位', lib.rectLeft === 0 && lib.margin === '240px', JSON.stringify([lib.rectLeft, lib.margin]));
  check('新建文件带上目录与类型',
        lib.createCall && lib.createCall.data.path === '/root' &&
        lib.createCall.data.name === 'hello.md' && lib.createCall.data.kind === 'file',
        JSON.stringify(lib.createCall));
  check('删除走 library.delete', lib.deleteCall && lib.deleteCall.data.path === '/root/b.txt', JSON.stringify(lib.deleteCall));
  check('打开根内的文件不把根往里带',
        !lib.followed.setRootCall, JSON.stringify(lib.followed.setRootCall));
  check('根内文件仍展开祖先并高亮',
        lib.followed.rows.some(r => r.name === 'deep.md' && r.current) &&
        lib.followed.rows.some(r => r.name === 'notes'),
        JSON.stringify(lib.followed.rows));
  check('底部条仍显示用户选的根目录', lib.followed.rootTitle === 'root', lib.followed.rootTitle);
  check('打开根外的文件才跟随父文件夹',
        lib.outside.setRootCall && lib.outside.setRootCall.data.path === '/other' &&
        lib.outside.rootTitle === 'other',
        JSON.stringify(lib.outside));
  check('上级目录按钮回到上一层',
        lib.up.setRootCall && lib.up.setRootCall.data.path === '/' && lib.up.rootTitle === '/',
        JSON.stringify(lib.up));
  check('到磁盘根后上级按钮禁用', lib.up.disabled === true, String(lib.up.disabled));
  check('底部有「打开文件夹…」「刷新」「上级目录」',
        lib.rootbar.hasOpen && lib.rootbar.hasRefresh && lib.rootbar.hasUp &&
        lib.rootbar.upEnabledAtOther === true, JSON.stringify(lib.rootbar));
  check('可以收起', lib.closed === true);

  console.log('\n[13] 粘贴 HTML → Markdown（F10）');
  const conv = html => page.evaluate(h => window.htmlToMarkdown(h), html);

  const c1 = await conv('<h1>大标题</h1><p>这是<strong>粗体</strong>和<em>斜体</em>，还有<code>代码</code>与<a href="https://example.com">链接</a>。</p>');
  check('标题与行内标记', c1 === '# 大标题\n\n这是**粗体**和*斜体*，还有`代码`与[链接](https://example.com)。', JSON.stringify(c1));

  const c2 = await conv('<ul><li>甲<ul><li>甲一</li></ul></li><li><input type="checkbox" checked>已完成</li><li><input type="checkbox">未完成</li></ul>');
  check('嵌套列表与任务清单',
        c2 === '- 甲\n  - 甲一\n- [x] 已完成\n- [ ] 未完成', JSON.stringify(c2));

  const c3 = await conv('<blockquote><p>引用一段</p><p>第二段</p></blockquote>');
  check('引用块', c3 === '> 引用一段\n>\n> 第二段', JSON.stringify(c3));

  const c4 = await conv('<pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>');
  check('代码块带语言', c4 === '```js\nconst a = 1;\nconst b = 2;\n```', JSON.stringify(c4));

  const c5 = await conv('<table><tr><th align="left">名称</th><th align="right">数量</th><th>价格</th></tr><tr><td>苹果</td><td>3</td><td>1.5</td></tr></table>');
  check('表格与对齐',
        c5 === '| 名称 | 数量 | 价格 |\n| :--- | ---: | --- |\n| 苹果 | 3 | 1.5 |', JSON.stringify(c5));

  const c6 = await conv('<p>第一行<br>第二行</p><hr><p>尾</p>');
  check('硬换行与分隔线', c6 === '第一行  \n第二行\n\n---\n\n尾', JSON.stringify(c6));

  const c7 = await conv('<p class="MsoNormal"><b>Word 标题</b></p><p>Word 正文</p>');
  check('Word 风格 HTML（Mso 类名不影响）', c7 === '**Word 标题**\n\nWord 正文', JSON.stringify(c7));

  const c8 = await conv('<img src="https://example.com/a.png" alt="示意图">');
  check('图片', c8 === '![示意图](https://example.com/a.png)', JSON.stringify(c8));

  const richFlags = await page.evaluate(() => ({
    browser: window.htmlToMarkdown.isRich('<p>段落</p>'),
    vscode: window.htmlToMarkdown.isRich('<span class="mtk1">const</span> <span class="mtk7">x</span> = 1'),
    empty: window.htmlToMarkdown.isRich('')
  }));
  check('能区分富文本与代码编辑器的高亮 HTML',
        richFlags.browser === true && richFlags.vscode === false && richFlags.empty === false, JSON.stringify(richFlags));

  // ---- 集成：走真实 paste 事件 ----
  const pasteRich = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '原文档', 't.md');
    await wait(120);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 0);

    const dt = new DataTransfer();
    dt.setData('text/html', '<h2>小节</h2><p>粘贴的<strong>正文</strong></p><ul><li>要点一</li><li>要点二</li></ul>');
    dt.setData('text/plain', '小节\n粘贴的正文\n要点一\n要点二');
    p.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(250);

    return {
      md: window.__getMarkdown(),
      h2: !!document.querySelector('#write h2'),
      ul: document.querySelectorAll('#write ul li').length,
      caret: (() => {
        const sel = window.getSelection();
        const leaf = window.MF.leafBlock ? window.MF.leafBlock() : null;
        return { inWrite: document.activeElement === document.getElementById('write'), hasSel: sel.rangeCount > 0, leaf: !!leaf };
      })()
    };
  });
  check('富文本粘贴成多个块',
        pasteRich.md === '## 小节\n\n粘贴的**正文**\n\n- 要点一\n- 要点二\n\n原文档',
        JSON.stringify(pasteRich.md));
  check('粘贴产出 h2 与列表', pasteRich.h2 && pasteRich.ul === 2, JSON.stringify([pasteRich.h2, pasteRich.ul]));

  const pasteMid = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '前半后半', 't.md');
    await wait(120);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 2);   // 光标在「前半」后

    const dt = new DataTransfer();
    dt.setData('text/html', '<p>插入内容</p>');
    dt.setData('text/plain', '插入内容');
    p.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(250);
    return window.__getMarkdown();
  });
  check('段中粘贴把当前块拆开', pasteMid === '前半\n\n插入内容\n\n后半', JSON.stringify(pasteMid));

  const pasteCell = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '| A | B |\n|---|---|\n| 1 | 2 |\n', 't.md');
    await wait(150);
    const cell = document.querySelector('#write td');
    cell.focus();
    window.MF.setCaretBySourceOffset(cell, 0);
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>多行</p><p>内容</p>');
    dt.setData('text/plain', '多行 内容');
    cell.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(250);
    const t = document.querySelector('#write table');
    return { rows: t.querySelectorAll('tr').length, md: window.__getMarkdown() };
  });
  check('表格单元格里粘贴不拆表', pasteCell.rows === 2 && /多行 内容/.test(pasteCell.md), JSON.stringify(pasteCell));

  const pastePlain = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '占位', 't.md');
    await wait(120);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 0);

    // 代码编辑器复制的 HTML：全是 span，没有块级结构 → 应该用 text/plain（markdown 源码）
    const dt = new DataTransfer();
    dt.setData('text/html', '<span class="mtk1">const</span> <span class="mtk7">x</span> <span class="mtk8">=</span> <span class="mtk4">1</span>');
    dt.setData('text/plain', '# 标题\n\n**粗体**');
    p.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(250);
    return window.__getMarkdown();
  });
  check('代码编辑器来源走纯文本（markdown 源码原样插入）',
        pastePlain === '# 标题\n\n**粗体**\n\n占位', JSON.stringify(pastePlain));

  const pasteSource = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '源码文档', 't.md');
    await wait(120);
    window.__cmd('toggleSource');
    await wait(150);
    const src = document.getElementById('source');
    src.focus();
    src.setSelectionRange(0, 0);
    const dt = new DataTransfer();
    dt.setData('text/html', '<h1>标题</h1><p>内容</p>');
    dt.setData('text/plain', '标题 内容');
    src.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(250);
    const val = src.value;
    window.__cmd('toggleSource');
    await wait(150);
    return { val, md: window.__getMarkdown() };
  });
  check('源码模式粘贴也转 markdown',
        pasteSource.val === '# 标题\n\n内容源码文档' && pasteSource.md === '# 标题\n\n内容源码文档',
        JSON.stringify(pasteSource));

  console.log('\n[14] 文件树 Typora 细节（F9b：排序 / 最近 / 复制 / 新窗口 / 拖拽）');
  const f9b = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const calls = [];
    const tree = [
      { name: 'notes', path: '/root/notes', dir: true, ext: '' },
      { name: 'a.md', path: '/root/a.md', dir: false, ext: 'md' }
    ];
    const sub = [{ name: 'deep.md', path: '/root/notes/deep.md', dir: false, ext: 'md' }];

    const orig = window.bridge.callHandler;
    window.bridge.callHandler = function (name, data, cb) {
      calls.push({ name: name, data: data });
      if (name === 'library.root' || name === 'library.setRoot') return cb({ root: '/root' });
      if (name === 'library.list' && cb) return cb(data && data.path === '/root/notes' ? sub : tree);
      if (name === 'library.recents' && cb) {
        return cb({ pinned: ['/root/notes'], recent: ['/other'] });
      }
      if (cb) cb({ ok: true });
    };

    window.MFLibrary.rootChanged();
    await wait(120);
    window.MFLibrary.open();
    await wait(120);

    // --- 排序菜单 ---
    document.querySelector('.mf-lib-rootbar [data-act="sort"]').click();
    await wait(80);
    const sortMenu = Array.from(document.querySelectorAll('.mf-lib-menu-item')).map(b => b.textContent);
    const byTime = Array.from(document.querySelectorAll('.mf-lib-menu-item'))
      .find(b => b.textContent.indexOf('按修改时间') === 0);
    byTime.click();
    await wait(120);
    const lastList = calls.filter(c => c.name === 'library.list').pop();

    // --- 最近文件夹菜单 ---
    document.querySelector('.mf-lib-rootbar [data-act="recents"]').click();
    await wait(80);
    const recentsMenu = {
      heads: Array.from(document.querySelectorAll('.mf-lib-menu-head')).map(h => h.textContent),
      rows: Array.from(document.querySelectorAll('.mf-lib-menu-row .mf-lib-menu-item')).map(b => b.textContent)
    };
    document.querySelector('.mf-lib-menu-row .mf-lib-menu-item').click();  // 点固定项切根
    await wait(120);
    const setRoot = calls.filter(c => c.name === 'library.setRoot').pop();

    // --- 右键复制 / 在新窗口打开 ---
    window.MFLibrary.refresh();
    await wait(120);
    document.querySelector('.mf-lib-row[data-path="/root/a.md"]')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await wait(60);
    const labels = Array.from(document.querySelectorAll('.mf-lib-menu-item')).map(b => b.textContent);
    Array.from(document.querySelectorAll('.mf-lib-menu-item'))
      .find(b => b.textContent === '复制').click();
    await wait(100);
    const dupCall = calls.filter(c => c.name === 'library.duplicate').pop();

    document.querySelector('.mf-lib-row[data-path="/root/a.md"]')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    await wait(60);
    Array.from(document.querySelectorAll('.mf-lib-menu-item'))
      .find(b => b.textContent === '在新窗口打开').click();
    await wait(100);
    const newWinCall = calls.filter(c => c.name === 'library.openInNewWindow').pop();

    // --- 树内拖拽移动到目录 ---
    const dt = new DataTransfer();
    const row = document.querySelector('.mf-lib-row[data-path="/root/a.md"]');
    const dirRow = document.querySelector('.mf-lib-row[data-path="/root/notes"]');
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    dirRow.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const dropping = dirRow.classList.contains('mf-lib-dropping');
    dirRow.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    row.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    await wait(120);
    const moveCall = calls.filter(c => c.name === 'library.move').pop();

    // --- 拖到正文插相对链接 ---
    window.__loadContent('/root/notes/当前.md', '# 当前文档\n\n正文。\n', '当前.md');
    await wait(150);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 3);
    const dt2 = new DataTransfer();
    document.querySelector('.mf-lib-row[data-path="/root/notes/deep.md"]')
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt2, bubbles: true }));
    p.dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    await wait(200);
    const linked = window.__getMarkdown();

    window.bridge.callHandler = orig;
    return { sortMenu, lastList, recentsMenu, setRoot, labels, dupCall, newWinCall, dropping, moveCall, linked };
  });
  check('排序菜单有两档 + 文件夹优先',
        f9b.sortMenu.length === 3 && /按名称/.test(f9b.sortMenu[0]) &&
        /按修改时间/.test(f9b.sortMenu[1]) && /文件夹优先/.test(f9b.sortMenu[2]),
        JSON.stringify(f9b.sortMenu));
  check('排序方式传给原生列表', f9b.lastList && f9b.lastList.data.sort === 'mtime' &&
        f9b.lastList.data.groupDirs === true && f9b.lastList.data.root === '/root',
        JSON.stringify(f9b.lastList && f9b.lastList.data));
  check('最近文件夹菜单渲染固定与最近两段',
        f9b.recentsMenu.heads.length === 2 && f9b.recentsMenu.rows.length === 2 &&
        f9b.recentsMenu.heads[0] === '固定的文件夹', JSON.stringify(f9b.recentsMenu));
  check('点最近条目切换根目录', f9b.setRoot && f9b.setRoot.data.path === '/root/notes',
        JSON.stringify(f9b.setRoot));
  check('右键菜单有复制', f9b.labels.indexOf('复制') >= 0, JSON.stringify(f9b.labels));
  check('复制走 library.duplicate', f9b.dupCall && f9b.dupCall.data.path === '/root/a.md',
        JSON.stringify(f9b.dupCall));
  check('在新窗口打开走 library.openInNewWindow',
        f9b.newWinCall && f9b.newWinCall.data.path === '/root/a.md', JSON.stringify(f9b.newWinCall));
  check('拖到目录高亮并走 library.move',
        f9b.dropping === true && f9b.moveCall && f9b.moveCall.data.path === '/root/a.md' &&
        f9b.moveCall.data.toDir === '/root/notes', JSON.stringify([f9b.dropping, f9b.moveCall]));
  check('拖到正文插入相对链接', /\[deep\.md\]\(deep\.md\)/.test(f9b.linked), JSON.stringify(f9b.linked.slice(0, 80)));

  console.log('\n[15] 快速打开（F11，桩掉 library.allFiles）');
  const qo = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const calls = [];
    const files = [
      { name: '欢迎.md', path: '/root/欢迎.md', rel: '欢迎.md', mtime: 3 },
      { name: '第一篇.md', path: '/root/笔记/第一篇.md', rel: '笔记/第一篇.md', mtime: 2 },
      { name: 'deep.md', path: '/root/笔记/sub/deep.md', rel: '笔记/sub/deep.md', mtime: 1 }
    ];
    const orig = window.bridge.callHandler;
    window.bridge.callHandler = function (name, data, cb) {
      calls.push({ name: name, data: data });
      if (name === 'library.allFiles' && cb) return cb(files);
      if (cb) cb(null);
    };

    window.MFQuickOpen.show();
    await wait(150);
    const shown = document.getElementById('mf-quickopen').classList.contains('mf-show');
    const initial = Array.from(document.querySelectorAll('.mf-qo-name')).map(n => n.textContent);

    // 搜「笔记」：命中路径
    const input = document.getElementById('mf-qo-input');
    input.value = '笔记';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    const byFolder = Array.from(document.querySelectorAll('.mf-qo-name')).map(n => n.textContent);

    // 搜「deep」：命中文件名
    input.value = 'deep';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(80);
    const byName = Array.from(document.querySelectorAll('.mf-qo-name')).map(n => n.textContent);

    // 方向键 + 回车打开
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const sel = document.querySelector('.mf-qo-item.mf-on');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(120);
    const openCall = calls.filter(c => c.name === 'document.openPath').pop();
    const hidden = !document.getElementById('mf-quickopen').classList.contains('mf-show');

    // Esc 关闭
    window.MFQuickOpen.show();
    await wait(100);
    document.getElementById('mf-qo-input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(80);
    const escClosed = !document.getElementById('mf-quickopen').classList.contains('mf-show');

    window.bridge.callHandler = orig;
    return { shown, initial, byFolder, byName, sel: sel ? sel.textContent : '', openCall, hidden, escClosed };
  });
  check('面板打开并列出全部文件', qo.shown && qo.initial.length === 3, JSON.stringify([qo.shown, qo.initial]));
  check('按文件夹名也能搜到（匹配路径）',
        qo.byFolder.length === 2 && qo.byFolder.indexOf('第一篇.md') >= 0, JSON.stringify(qo.byFolder));
  check('按文件名搜到单条', qo.byName.length === 1 && qo.byName[0] === 'deep.md', JSON.stringify(qo.byName));
  check('方向键移动选中项', /deep\.md/.test(qo.sel), JSON.stringify(qo.sel));
  check('回车打开选中文件并关闭面板',
        qo.openCall && qo.openCall.data.path === '/root/笔记/sub/deep.md' && qo.hidden === true,
        JSON.stringify([qo.openCall, qo.hidden]));
  check('Esc 关闭面板', qo.escClosed === true);

  console.log('\n[16] F14 emoji / 代码语言补全');
  await page.evaluate(() => {
    if (window.MF.isSourceMode()) window.__cmd('toggleSource');
    window.__loadContent('', '# T\n\nhello world', 't.md');
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 6);
  });
  await page.keyboard.type(':smile', { delay: 8 });
  await page.waitForTimeout(120);
  const acEmoji = await page.evaluate(() => ({
    open: !!document.getElementById('mf-autocomplete'),
    items: Array.from(document.querySelectorAll('#mf-autocomplete .mf-ac-item')).map(i => i.textContent),
    active: document.querySelector('#mf-autocomplete .mf-ac-item.mf-active')?.textContent || ''
  }));
  check('emoji 候选出现并默认选中 smile',
        acEmoji.open && /:smile:/.test(acEmoji.active), JSON.stringify(acEmoji));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const emojiMd = await page.evaluate(() => window.__getMarkdown());
  check('Enter 插入 emoji 并替换 shortcode',
        emojiMd.indexOf('😄') >= 0 && emojiMd.indexOf(':smile') < 0, JSON.stringify(emojiMd));
  const emojiClosed = await page.evaluate(() => !document.getElementById('mf-autocomplete'));
  check('选中后关闭候选层', emojiClosed);
  await page.evaluate(() => window.__cmd('undo'));
  await page.waitForTimeout(100);
  const emojiUndo = await page.evaluate(() => window.__getMarkdown());
  check('emoji 插入可撤销', emojiUndo.indexOf(':smile') >= 0, JSON.stringify(emojiUndo));

  const lang = await page.evaluate(async () => {
    if (!window.MF.isSourceMode()) window.__cmd('toggleSource');
    const s = document.getElementById('source');
    s.value = '```pyt\nprint(1)\n```';
    s.focus();
    s.selectionStart = s.selectionEnd = 6;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    return {
      open: !!document.getElementById('mf-autocomplete'),
      items: Array.from(document.querySelectorAll('#mf-autocomplete .mf-ac-item')).map(i => i.textContent),
      mode: window.MF.isSourceMode(),
      display: getComputedStyle(s).display,
      value: s.value,
      sel: [s.selectionStart, s.selectionEnd]
    };
  });
  check('围栏语言名补全出现 python', lang.open && lang.items.some(t => /python/.test(t)), JSON.stringify(lang));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const langValue = await page.evaluate(() => document.getElementById('source').value);
  check('选择语言后只替换语言名', langValue === '```python\nprint(1)\n```', JSON.stringify(langValue));

  console.log('\n[11] 运行时错误');
  check('无未捕获异常', errors.length === 0, errors.join(' | '));

  await closeTestBrowser();
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
