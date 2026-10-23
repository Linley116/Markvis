// 功能模块测试：表格 / 查找替换 / 大纲 / 主题 / 专注模式 / 自动保存

const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'web', 'index.html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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
      open: document.body.classList.contains('mf-outline-open'),
      count: items.length,
      levels: items.map(i => i.getAttribute('data-level')),
      texts: items.map(i => i.textContent)
    };
  });
  check('侧栏默认展开', outline.open);
  check('列出 3 个标题', outline.count === 3, outline.count);
  check('层级正确', JSON.stringify(outline.levels) === '["1","2","3"]', JSON.stringify(outline.levels));
  check('标题文本正确', outline.texts[0] === '表格', outline.texts.join('|'));

  const jumped = await page.evaluate(async () => {
    const before = document.getElementById('scroll').scrollTop;
    document.querySelectorAll('.mf-outline-item')[2].click();
    await new Promise(r => setTimeout(r, 80));
    return { before, after: document.getElementById('scroll').scrollTop };
  });
  check('点击大纲发生滚动', jumped.after !== jumped.before, JSON.stringify(jumped));

  await page.keyboard.press('Meta+Shift+O');
  const collapsed = await page.evaluate(() => document.body.classList.contains('mf-outline-open'));
  check('Cmd+Shift+O 收起侧栏', collapsed === false);

  console.log('\n[4.1] 左上角大纲开关与拖拽调宽');
  const fab = await page.evaluate(() => {
    const btn = document.getElementById('mf-outline-btn');
    const rect = () => {
      const r = btn.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width)];
    };
    const state = () => ({
      open: document.body.classList.contains('mf-outline-open'),
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
  check('收起后提示文案变为「显示大纲」', /显示大纲/.test(fab.closedAgain.title), fab.closedAgain.title);
  check('同一位置再点可以重新展开', fab.reopened.open === true && fab.reopened.pressed === 'true',
        JSON.stringify(fab.reopened));
  check('侧栏页眉不再有自己的收起按钮', fab.hasHeaderClose === false);

  const resized = await page.evaluate(async () => {
    if (!document.body.classList.contains('mf-outline-open')) {
      document.getElementById('mf-outline-btn').click();
    }
    await new Promise(r => setTimeout(r, 60));
    const r = document.querySelector('.mf-outline-resizer');
    const rect = r.getBoundingClientRect();
    const widthOf = () => Math.round(document.getElementById('mf-outline').getBoundingClientRect().width);

    r.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, clientX: rect.left + 2, clientY: rect.top + 40
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 320 }));
    await new Promise(res => setTimeout(res, 40));
    const during = widthOf();
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    await new Promise(res => setTimeout(res, 40));

    const saved = localStorage.getItem('mf.outline.width');
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
    const meta = document.querySelector('pre.md-meta');
    return {
      meta: !!meta,
      metaText: meta ? meta.textContent : '',
      olStart: ol ? ol.getAttribute('start') : null,
      cols: document.querySelectorAll('table th').length,
      md: window.__getMarkdown()
    };
  });
  check('front matter 渲染为元数据块', rich.meta && /name: x/.test(rich.metaText), rich.metaText.slice(0, 30));
  check('有序列表保留起始编号', rich.olStart === '3', rich.olStart);
  check('表格 4 列', rich.cols === 4, rich.cols);
  check('序列化保留 front matter', rich.md.indexOf('---\nname: x') === 0, rich.md.slice(0, 20));
  check('序列化保留列表编号', /^3\. 第三$/m.test(rich.md));

  console.log('\n[11] 运行时错误');
  check('无未捕获异常', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
