// 引擎逻辑测试：在无头 Chrome 里加载 web/index.html，验证
//   1. 块解析/渲染产出正确的 DOM 结构
//   2. DOM -> Markdown 往返
//   3. 输入 **x** 后经画笔自动变成 strong
//   4. expand / 源码模式切换

const path = require('path');
const { launchTestBrowser, closeTestBrowser } = require('./browser');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'web', 'index.html');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(PAGE);
  await page.waitForTimeout(400);

  console.log('\n[1] 渲染结构');
  const shape = await page.evaluate(() => {
    const kids = Array.from(document.getElementById('write').children);
    return kids.map(k => ({
      tag: k.tagName,
      mdtype: k.getAttribute('mdtype'),
      depth: k.dataset.depth || null,
      cid: k.getAttribute('cid') || null
    }));
  });
  console.log('   ' + shape.map(s => s.tag + '/' + s.mdtype).join(', '));
  check('存在 h1', shape.some(s => s.tag === 'H1'));
  check('存在 h2', shape.some(s => s.tag === 'H2'));
  check('存在 ul', shape.some(s => s.tag === 'UL'));
  check('存在 ol', shape.some(s => s.tag === 'OL'));
  check('存在 blockquote', shape.some(s => s.tag === 'BLOCKQUOTE'));
  check('存在 pre/fences', shape.some(s => s.mdtype === 'fences'));
  check('存在 hr', shape.some(s => s.tag === 'HR'));
  check('每个块都有 cid', shape.every(s => !!s.cid));

  console.log('\n[2] 行内标记');
  const hl = await page.evaluate(() => {
    const code = document.querySelector('pre.md-fences code');
    return {
      hasToken: !!(code && code.querySelector('span.hljs-keyword, span.hljs-string, span.hljs-title, span.hljs-built_in')),
      cls: code && code.className,
      raw: code && code.textContent
    };
  });
  check('代码块已语法高亮', hl.hasToken, JSON.stringify(hl).slice(0, 120));
  check('代码块保留 language- 类', /language-js/.test(hl.cls || ''), hl.cls);
  check('高亮不改动源码文本', /const pipeline/.test(hl.raw || ''), hl.raw);

  const fenceLang = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const input = document.querySelector('pre.md-fences .md-fence-lang-input');
    const pre = input.closest('pre.md-fences');
    const code = pre.querySelector('code');
    const menu = () => document.getElementById('mf-fence-lang-menu') || document.querySelector('.md-fence-lang-menu');
    const labels = () => [...menu().querySelectorAll('button[data-lang] span')].map(s => s.textContent);

    input.focus();
    await wait(60);
    const quickCount = labels().length;

    input.value = 'plain';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
    const plainLabels = labels();

    input.value = 'pyth';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
    const matches = [...menu().querySelectorAll('button[data-lang]')].map(b => b.getAttribute('data-lang'));
    const py = menu().querySelector('button[data-lang="python"]');
    py.click();
    await wait(160);
    const python = {
      md: window.__getMarkdown(),
      cls: code.className,
      text: code.textContent,
      fence: pre.getAttribute('data-fences'),
      input: input.value
    };

    // 输入 js 后回车，恢复演示文档
    input.focus();
    input.value = 'js';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(160);

    return {
      quickCount,
      plainLabels,
      matches,
      python,
      restored: window.__getMarkdown(),
      inputCount: document.querySelectorAll('.md-fence-lang-input').length,
      exportHasPicker: /md-fence-lang/.test(window.__buildExportHTML())
    };
  });
  check('代码块有语言输入框，默认只展示常用项',
        fenceLang.inputCount === 1 && fenceLang.quickCount <= 14 && fenceLang.quickCount >= 8,
        JSON.stringify({ count: fenceLang.quickCount }));
  check('输入字符可匹配语言', fenceLang.matches.includes('python') &&
        fenceLang.matches.length < 24, JSON.stringify(fenceLang.matches));
  check('语言列表按显示名去重', new Set(fenceLang.plainLabels).size === fenceLang.plainLabels.length &&
        fenceLang.plainLabels.filter(l => l === 'Plain text').length === 1,
        JSON.stringify(fenceLang.plainLabels));
  check('选择语言写回 Markdown 并重新高亮',
        /^```python/m.test(fenceLang.python.md) && fenceLang.python.cls === 'language-python' &&
        fenceLang.python.fence === '```python' && fenceLang.python.input === 'python' &&
        /const pipeline/.test(fenceLang.python.text) &&
        /^```js/m.test(fenceLang.restored), JSON.stringify(fenceLang.python));
  check('导出不包含语言控件', fenceLang.exportHasPicker === false);

  const inline = await page.evaluate(() => {
    const plain = el => {
      const c = el.cloneNode(true);
      c.querySelectorAll('.md-meta').forEach(m => m.remove());
      return c.textContent;
    };
    const s = document.querySelector('#write span[mdtype="strong"]');
    const c = document.querySelector('#write span[mdtype="code"]');
    const metas = s ? [...s.querySelectorAll('.md-meta')] : [];
    return {
      strongMarks: metas.map(m => m.textContent),
      strongText: s && plain(s),
      strongMetaDisplay: metas[0] ? getComputedStyle(metas[0]).display : null,
      codeMarks: c ? [...c.querySelectorAll('.md-meta')].map(m => m.textContent) : [],
      codeInner: c && c.querySelector('code').textContent
    };
  });
  check('strong 的标记是两个真实 .md-meta 节点', inline.strongMarks.length === 2 && inline.strongMarks[0] === '**' && inline.strongMarks[1] === '**', JSON.stringify(inline.strongMarks));
  check('标记默认隐藏', inline.strongMetaDisplay === 'none', inline.strongMetaDisplay);
  check('strong 内容正确', /Typora 架构/.test(inline.strongText || ''), inline.strongText);
  check('code 的标记是 `', inline.codeMarks.length === 2 && inline.codeMarks[0] === '`', JSON.stringify(inline.codeMarks));

  console.log('\n[3] DOM -> Markdown 往返');
  const md = await page.evaluate(() => window.__getMarkdown());
  check('保留 ATX 标题', /^# Markvis$/m.test(md) && /^## 它复刻了什么$/m.test(md));
  check('保留粗体标记', md.includes('**Typora 架构**'));
  check('保留行内代码', md.includes('`原生 Cocoa 外壳 + WKWebView`'));
  check('保留围栏与语言', md.includes('```js'));
  check('保留引用', /^> /m.test(md));
  check('保留列表标记', /^- \*\*无损 DOM\*\*/m.test(md));
  check('保留分隔线', /^---$/m.test(md));
  console.log('   ---- 往返结果前 14 行 ----');
  console.log(md.split('\n').slice(0, 14).map(l => '   | ' + l).join('\n'));

  console.log('\n[4] 画笔闭环：输入 **world** 应自动变 strong');
  const typed = await page.evaluate(async () => {
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    // 光标放到段落末尾
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    document.execCommand('insertText', false, ' hello **world**');
    await new Promise(res => setTimeout(res, 420));  // 等 200ms 画笔两轮

    const spans = Array.from(p.querySelectorAll('span[mdtype="strong"]'));
    const last = spans[spans.length - 1];
    const plain = el => {
      const c = el.cloneNode(true);
      c.querySelectorAll('.md-meta').forEach(m => m.remove());
      return c.textContent;
    };
    return {
      count: spans.length,
      text: last && plain(last),
      markdown: window.__getMarkdown()
    };
  });
  check('新输入的 **world** 生成了 strong', typed.count >= 1, 'count=' + typed.count);
  check('strong 内容是 world', typed.text === 'world', typed.text);
  check('往返后保留 **world**', typed.markdown.includes('**world**'));

  console.log('\n[5] 块类型转换：回车后输入 "# " 应把段落变标题');
  await page.evaluate(() => {
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('# ');
  await page.keyboard.insertText('新标题');
  await page.waitForTimeout(450);
  const converted = await page.evaluate(() => ({
    shape: Array.from(document.getElementById('write').children)
      .map(k => k.tagName + '/' + k.getAttribute('mdtype')),
    lastMd: window.__getMarkdown().split('\n').filter(Boolean).slice(-3)
  }));
  console.log('   tail markdown: ' + JSON.stringify(converted.lastMd));
  check('出现新的 H1', converted.shape.filter(x => x === 'H1/heading').length >= 2, converted.shape.join(','));

  console.log('\n[6] 源码模式往返');
  const src = await page.evaluate(async () => {
    const before = window.__getMarkdown();
    window.__cmd('toggleSource');
    await new Promise(res => setTimeout(res, 60));
    const inSource = document.getElementById('source').style.display === 'block';
    const text = document.getElementById('source').value;
    window.__cmd('toggleSource');
    await new Promise(res => setTimeout(res, 60));
    return { inSource, text, after: window.__getMarkdown(), mode: document.getElementById('mode').textContent };
  });
  check('进入源码模式', src.inSource);
  check('源码内容与 Markdown 一致', src.text.trim() === src.text.trim() && src.text.length > 100);
  check('退出后恢复 Live', src.mode === 'Live');
  check('往返后内容仍在', src.after.includes('# Markvis'));

  console.log('\n[6.1] Cmd+/ 双向切换（回归：焦点在源码框里切不回来）');
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '切换测试', 't');
    await wait(80);
    document.getElementById('write').focus();
  });
  await page.keyboard.press('Meta+/');
  await page.waitForTimeout(150);
  const toSource = await page.evaluate(() => ({
    mode: document.getElementById('mode').textContent,
    focus: document.activeElement.id
  }));
  await page.keyboard.press('Meta+/');
  await page.waitForTimeout(200);
  const backToLive = await page.evaluate(() => ({
    mode: document.getElementById('mode').textContent,
    focus: document.activeElement.id
  }));
  check('正文里按 Cmd+/ 进入源码模式', toSource.mode === 'Source' && toSource.focus === 'source', JSON.stringify(toSource));
  check('源码框里按 Cmd+/ 能切回实时模式', backToLive.mode === 'Live', JSON.stringify(backToLive));
  check('切回后焦点回到正文', backToLive.focus === 'write', JSON.stringify(backToLive));

  console.log('\n[6.2] Cmd+/ 保持阅读位置（回归：切模式跳到文档末尾）');
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const md = Array.from({ length: 40 }, (_, i) => `## 第 ${i} 章\n\n第 ${i} 段正文。\n`).join('\n');
    window.__loadContent('', md, 'long.md');
    await wait(150);
    const sc = document.getElementById('scroll');
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * 0.5;
    await wait(100);
  });
  const jump = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sc = document.getElementById('scroll');
    const source = document.getElementById('source');
    const ratio = el => {
      const max = el.scrollHeight - el.clientHeight;
      return max > 0 ? el.scrollTop / max : 0;
    };
    const before = ratio(sc);
    window.__cmd('toggleSource');
    await wait(220);
    const inSource = { ratio: ratio(source), caretRatio: source.selectionStart / source.value.length };
    window.__cmd('toggleSource');
    await wait(220);
    return { before, inSource, after: ratio(sc) };
  });
  check('切到源码模式停在原位置（不再跳文档末尾）',
        Math.abs(jump.inSource.ratio - jump.before) < 0.2 && jump.inSource.caretRatio < 0.8,
        JSON.stringify(jump.inSource));
  check('切回实时模式回到原位置',
        Math.abs(jump.after - jump.before) < 0.05, JSON.stringify(jump));

  console.log('\n[7] 光标模型：图片是非文本原子，偏移不能漂');
  const imgCaret = await page.evaluate(async () => {
    window.__loadContent('', 'hello ![](a.png) world', 't');
    await new Promise(r => setTimeout(r, 60));
    const img = document.querySelector('.md-img');
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, 'X');
    await new Promise(r => setTimeout(r, 420));
    return window.__getMarkdown();
  });
  check('图片后输入落在正确位置', imgCaret === 'hello ![](a.png)X world', JSON.stringify(imgCaret));

  console.log('\n[7.5] 软换行 / 硬换行（GFM 语义）');
  const breaks = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // 软换行：单个 \n 不是 BR，往返仍是单个 \n
    window.__loadContent('', 'soft\nbreak', 't');
    await wait(80);
    const p1 = document.querySelector('#write p[mdtype="paragraph"]');
    const soft = { br: !!p1.querySelector('br.md-hardbreak'), md: window.__getMarkdown() };

    // 行尾双空格 = 硬换行，BR 记住空格标记
    window.__loadContent('', 'hard  \nbreak', 't');
    await wait(80);
    const p2 = document.querySelector('#write p[mdtype="paragraph"]');
    const br = p2 && p2.querySelector('br.md-hardbreak');
    const hard = { hasBR: !!br, mark: br && br.getAttribute('data-mark'), md: window.__getMarkdown() };

    // 反斜杠硬换行
    window.__loadContent('', 'back\\\nslash', 't');
    await wait(80);
    const p3 = document.querySelector('#write p[mdtype="paragraph"]');
    const br3 = p3 && p3.querySelector('br.md-hardbreak');
    const back = { hasBR: !!br3, mark: br3 && br3.getAttribute('data-mark'), md: window.__getMarkdown() };

    // 引用内的硬换行：序列化要还原 > 前缀（每行都得带 >）
    window.__loadContent('', '> quote  \n> more', 't');
    await wait(80);
    const quote = { md: window.__getMarkdown() };

    // 画笔稳定：再过一轮画笔不改变结果
    await wait(450);
    const stable = { hard: window.__getMarkdown() };

    return { soft, hard, back, quote, stable };
  });
  check('软换行不产生 BR', breaks.soft.br === false);
  check('软换行往返仍是单个 \\n', breaks.soft.md === 'soft\nbreak', JSON.stringify(breaks.soft.md));
  check('双空格产生硬换行 BR', breaks.hard.hasBR === true);
  check('BR 记住空格标记', breaks.hard.mark === '  ', JSON.stringify(breaks.hard.mark));
  check('硬换行往返保留双空格', breaks.hard.md === 'hard  \nbreak', JSON.stringify(breaks.hard.md));
  check('反斜杠硬换行', breaks.back.hasBR === true && breaks.back.mark === '\\');
  check('反斜杠硬换行往返', breaks.back.md === 'back\\\nslash', JSON.stringify(breaks.back.md));
    check('引用内硬换行还原 > 前缀', breaks.quote.md === '> quote  \n> more', JSON.stringify(breaks.quote.md));
    check('画笔多轮后稳定', breaks.stable.hard === '> quote  \n> more', JSON.stringify(breaks.stable.hard));

  console.log('\n[7.6] 硬换行处的光标偏移');
  const brCaret = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', 'aa  \nbb', 't');
    await wait(80);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    window.MF.setCaretBySourceOffset(p, 6);   // bb 的 b 之后
    document.execCommand('insertText', false, 'X');
    await wait(450);
    return window.__getMarkdown();
  });
  check('硬换行后输入不漂', brCaret === 'aa  \nbXb', JSON.stringify(brCaret));

  console.log('\n[7.7] 括号 / 引号自动配对');
  await page.evaluate(() => {
    window.__loadContent('', 'pairtest', 't');
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
  await page.keyboard.type('(');
  await page.keyboard.type('x');
  await page.keyboard.type(')');
  await page.waitForTimeout(450);
  const paired = await page.evaluate(() => window.__getMarkdown());
  check('输入 ( 自动补 )，输入 ) 跳过', paired === 'pairtest(x)', JSON.stringify(paired));

  const apoo = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', "don", 't');
    await wait(60);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  });
  await page.keyboard.type("'t");
  await page.waitForTimeout(450);
  const apos = await page.evaluate(() => window.__getMarkdown());
  check('字母后的撇号不配对', apos === "don't", JSON.stringify(apos));

  const wrapped = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', 'wrap me', 't');
    await wait(60);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    const r = document.createRange();
    r.setStart(p.firstChild, 0);
    r.setEnd(p.firstChild, 7);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  });
  await page.keyboard.type('[');
  await page.waitForTimeout(450);
  const wrapMd = await page.evaluate(() => window.__getMarkdown());
  check('选区被 [ ] 包裹', wrapMd === '[wrap me]', JSON.stringify(wrapMd));

  console.log('\n[7.8] 图片 src 按文档目录解析');
  const img = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('/tmp/doc/x.md', '![](assets/a.png)', 'x.md');
    await wait(80);
    const i = document.querySelector('.md-img');
    return {
      src: i && i.getAttribute('src'),
      data: i && i.getAttribute('data-src'),
      md: window.__getMarkdown()
    };
  });
  check('src 解析为 file:// 绝对地址', img.src === 'file:///tmp/doc/assets/a.png', img.src);
  check('data-src 保留相对路径', img.data === '![](assets/a.png)', img.data);
  check('序列化仍是相对路径', img.md === '![](assets/a.png)', img.md);

  console.log('\n[2.5] 行内标记可编辑（T1）');
  const expandState = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', 'a **bold** z', 't');
    await wait(80);
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    const s = p.querySelector('span[mdtype="strong"]');

    // 光标进内容（offset 2 = 开头 ** 之后）
    window.MF.setCaretBySourceOffset(s, 2);
    await wait(60);
    const metas = [...s.querySelectorAll('.md-meta')];
    return {
      expanded: s.classList.contains('md-expand'),
      displays: metas.map(m => getComputedStyle(m).display),
      marks: metas.map(m => m.textContent)
    };
  });
  check('光标进入后标记显现（.md-expand）', expandState.expanded === true, JSON.stringify(expandState));
  check('两个标记都变成 inline', expandState.displays.join(',') === 'inline,inline', JSON.stringify(expandState.displays));

  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', 'a **bold** z', 't');
    await wait(80);
    const write = document.getElementById('write');
    write.focus();
    const s = write.querySelector('span[mdtype="strong"]');
    window.MF.setCaretBySourceOffset(s, 1);   // 落在开标记的第一个 * 之后
    await wait(60);
  });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);
  const afterDelete = await page.evaluate(() => window.__getMarkdown());
  check('能删掉单个 *，源码随之变化', afterDelete === 'a *bold** z', JSON.stringify(afterDelete));

  const arrow = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', 'a **bold** z', 't');
    await wait(80);
    const write = document.getElementById('write');
    write.focus();
    const s = write.querySelector('span[mdtype="strong"]');
    window.MF.setCaretBySourceOffset(s, 2);   // 内容开头（不是标记末尾）
    await wait(60);
    return true;
  });
  await page.keyboard.press('ArrowLeft');
  const arrowState = await page.evaluate(() => {
    const sel = window.getSelection();
    const n = sel.anchorNode;
    const meta = n && n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('md-meta');
    return { inMeta: !!meta, offset: sel.anchorOffset };
  });
  check('方向键能穿进标记内部', arrowState.inMeta === true, JSON.stringify(arrowState));

  const tail = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', 'a **b**', 't');
    await wait(80);
    const write = document.getElementById('write');
    write.focus();
    const p = write.querySelector('p[mdtype="paragraph"]');
    window.MF.setCaretBySourceOffset(p, 7);   // 块尾，正好在 **b** 之后
    await wait(60);
    document.execCommand('insertText', false, 'X');
    await wait(500);
    return window.__getMarkdown();
  });
  check('块尾输入不会被吸进行内元素', tail === 'a **b**X', JSON.stringify(tail));

  console.log('\n[7.9] 脚注与目录（F7）');
  const fn = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = [
      '# 标题一',
      '',
      '正文引用[^1]，还有命名[^note]。',
      '',
      '[^1]: 第一条脚注',
      '[^note]: 命名脚注，可以',
      '    换行续写',
      '',
      '## 标题二',
      '',
      '[TOC]'
    ].join('\n');
    window.__loadContent('', src, 't');
    await wait(120);

    const refs = [...document.querySelectorAll('.md-fn-ref')].map(x => x.getAttribute('data-src'));
    const defs = [...document.querySelectorAll('[mdtype="def_footnote"]')].map(x => ({
      label: x.getAttribute('data-label'),
      body: x.querySelector('.md-fn-body').textContent
    }));
    const toc = document.querySelector('[mdtype="toc"]');
    return {
      refs,
      defs,
      tocItems: toc ? [...toc.querySelectorAll('.md-toc-item a')].map(a => a.textContent) : null,
      md: window.__getMarkdown()
    };
  });
  check('脚注引用是原子（data-src = [^1]）', JSON.stringify(fn.refs) === '["[^1]","[^note]"]', JSON.stringify(fn.refs));
  check('脚注定义解析出两个', fn.defs.length === 2 && fn.defs[0].label === '1' && fn.defs[1].label === 'note', JSON.stringify(fn.defs));
  check('脚注定义支持缩进续行', /命名脚注，可以\n换行续写/.test(fn.defs[1] && fn.defs[1].body), JSON.stringify(fn.defs[1]));
  check('TOC 列出两个标题', JSON.stringify(fn.tocItems) === '["标题一","标题二"]', JSON.stringify(fn.tocItems));
  check('往返保留引用语法', /正文引用\[\^1\]，还有命名\[\^note\]。/.test(fn.md), fn.md.split('\n')[2]);
  check('往返保留定义与续行', /\[\^note\]: 命名脚注，可以\n {4}换行续写/.test(fn.md), JSON.stringify(fn.md));
  check('往返保留 [TOC]', /^\[TOC\]$/m.test(fn.md));

  const fnCaret = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '引用[^1] 后续', 't');
    await wait(100);
    const write = document.getElementById('write');
    write.focus();
    const p = write.querySelector('p[mdtype="paragraph"]');
    window.MF.setCaretBySourceOffset(p, 6);   // 紧贴引用原子之后（「引用」2 + [^1] 4）
    await wait(60);
    document.execCommand('insertText', false, 'X');
    await wait(450);
    return window.__getMarkdown();
  });
  check('脚注原子后的光标偏移正确', fnCaret === '引用[^1]X 后续', JSON.stringify(fnCaret));

  const orphan = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = '正文引用[^used]。\n\n[^used]: 有引用\n[^lost]: 没人引用这条';
    window.__loadContent('', src, 't');
    await wait(120);
    const defs = [...document.querySelectorAll('[mdtype="def_footnote"]')].map(x => ({
      label: x.getAttribute('data-label'),
      orphan: x.classList.contains('md-fn-orphan'),
      title: x.getAttribute('title'),
      back: x.querySelector('.md-fn-back').getAttribute('title')
    }));
    const md = window.__getMarkdown();
    window.__loadContent('', '正文没有引用了。\n\n[^used]: 有引用\n[^lost]: 没人引用这条', 't');
    await wait(120);
    const after = [...document.querySelectorAll('[mdtype="def_footnote"]')]
      .map(x => x.classList.contains('md-fn-orphan'));
    return { defs, md, after };
  });
  check('被引用的脚注不标记孤儿', orphan.defs[0] && !orphan.defs[0].orphan, JSON.stringify(orphan.defs));
  check('没有引用的脚注标为孤儿并给出提示',
        orphan.defs[1] && orphan.defs[1].orphan && /没有正文引用/.test(orphan.defs[1].title) &&
        /没有引用可返回/.test(orphan.defs[1].back),
        JSON.stringify(orphan.defs[1]));
  check('删掉引用后两条定义都变成孤儿', JSON.stringify(orphan.after) === '[true,true]', JSON.stringify(orphan.after));
  check('孤儿标记不改写 Markdown',
        /\[\^lost\]: 没人引用这条/.test(orphan.md) && /\[\^used\]: 有引用/.test(orphan.md),
        JSON.stringify(orphan.md));

  console.log('\n[7.9b] 表格列宽（T10）');
  const tableWidth = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = [
      '| ID | 说明 | 状态 |',
      '|---|---|---|',
      '| 1 | 这是一段明显更长的说明文字，用来验证长内容列获得更多宽度而不是被挤成多行。 | 通过 |',
      '| 2 | 短 | 未通过 |'
    ].join('\n');
    window.__loadContent('', src, 't');
    await wait(120);
    const table = document.querySelector('table.md-table');
    const cols = [...table.querySelectorAll('col')].map(c => parseFloat(c.style.width));
    const layout = getComputedStyle(table).getPropertyValue('table-layout').trim();

    const cjk = '| 中文 | abcd |\n|---|---|\n| 中文 | abcd |';
    window.__loadContent('', cjk, 't');
    await wait(120);
    const balanced = [...document.querySelector('table.md-table').querySelectorAll('col')]
      .map(c => parseFloat(c.style.width));
    return { count: cols.length, cols, layout, balanced };
  });
  check('表格生成与列数一致的 colgroup', tableWidth.count === 3, JSON.stringify(tableWidth.cols));
  check('表格使用固定布局', tableWidth.layout === 'fixed', tableWidth.layout);
  check('长内容列分到更多宽度', tableWidth.cols[1] > 60 && tableWidth.cols[0] < 20, JSON.stringify(tableWidth.cols));
  check('CJK 宽度按两倍计算（「中文」≈ abcd）', Math.abs(tableWidth.balanced[0] - tableWidth.balanced[1]) < 1,
        JSON.stringify(tableWidth.balanced));

  const spell = await page.evaluate(() => {
    const write = document.getElementById('write');
    const before = write.getAttribute('spellcheck');
    window.__cmd('toggleSpell');
    const off = write.getAttribute('spellcheck');
    window.__cmd('toggleSpell');
    return { before, off, back: write.getAttribute('spellcheck') };
  });
  check('拼写检查默认开启', spell.before === 'true', spell.before);
  check('拼写检查可关闭/恢复', spell.off === 'false' && spell.back === 'true', JSON.stringify(spell));

  console.log('\n[7.10] 定义式链接（F7b）');
  const refLinks = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = [
      '[示例][ref] 与 [同名][] 两种写法。',
      '',
      '[ref]: https://example.com/a "标题A"',
      '[同名]: https://example.com/b'
    ].join('\n');
    window.__loadContent('', src, 't');
    await wait(120);
    const links = [...document.querySelectorAll('[mdtype="link_ref"] a')].map(a => ({
      href: a.getAttribute('href'),
      text: a.textContent,
      title: a.getAttribute('title')
    }));
    const defs = [...document.querySelectorAll('[mdtype="def_link"]')].map(d => ({
      label: d.getAttribute('data-label'),
      body: d.querySelector('.md-link-body').textContent
    }));
    return { links, defs, md: window.__getMarkdown() };
  });
  check('引用式链接解析出定义地址', refLinks.links[0] && refLinks.links[0].href === 'https://example.com/a', JSON.stringify(refLinks.links[0]));
  check('定义里的 title 传给了 a', refLinks.links[0] && refLinks.links[0].title === '标题A', JSON.stringify(refLinks.links[0]));
  check('[text][] 省略式按文本匹配定义', refLinks.links[1] && refLinks.links[1].href === 'https://example.com/b', JSON.stringify(refLinks.links[1]));
  check('定义块渲染出两条', refLinks.defs.length === 2 && refLinks.defs[0].label === 'ref', JSON.stringify(refLinks.defs));
  check('往返保留引用形式', /\[示例\]\[ref\]/.test(refLinks.md), refLinks.md.split('\n')[0]);
  check('往返保留定义行', /\[ref\]: https:\/\/example\.com\/a "标题A"/.test(refLinks.md), JSON.stringify(refLinks.md));

  console.log('\n[7.11] 公式与图表（F5 / F6）');
  const mathMmd = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = [
      '行内 $a^2+b^2=c^2$ 公式。',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '$$',
      '',
      '```mermaid',
      'graph TD',
      '  A[开始] --> B[结束]',
      '```'
    ].join('\n');
    window.__loadContent('', src, 't');

    // 两个库都是按需注入的，等它们加载完
    for (let i = 0; i < 60; i++) {
      await wait(200);
      const m = document.querySelector('[mdtype="math_inline"]');
      const b = document.querySelector('[mdtype="math_block"]');
      const d = document.querySelector('[mdtype="mermaid"]');
      if (m && m.querySelector('.katex') && b && b.querySelector('.katex') && d && d.querySelector('svg')) break;
    }

    const m = document.querySelector('[mdtype="math_inline"]');
    const b = document.querySelector('[mdtype="math_block"]');
    const d = document.querySelector('[mdtype="mermaid"]');
    return {
      inlineKatex: !!(m && m.querySelector('.katex')),
      blockDisplay: !!(b && b.querySelector('.katex-display')),
      mmdSvg: !!(d && d.querySelector('svg')),
      md: window.__getMarkdown()
    };
  });
  check('行内公式渲染成 KaTeX', mathMmd.inlineKatex === true);
  check('块级公式用 display 模式', mathMmd.blockDisplay === true);
  check('mermaid 渲染出 SVG', mathMmd.mmdSvg === true);
  check('往返保留行内公式', /\$a\^2\+b\^2=c\^2\$/.test(mathMmd.md), mathMmd.md.split('\n')[0]);
  check('往返保留块级公式', /\$\$\n\\int_0\^1 x\^2 \\, dx = \\frac\{1\}\{3\}\n\$\$/.test(mathMmd.md), JSON.stringify(mathMmd.md));
  check('往返保留 mermaid 围栏', /```mermaid\ngraph TD\n  A\[开始\] --> B\[结束\]\n```/.test(mathMmd.md), JSON.stringify(mathMmd.md));

  console.log('\n[7.12] 点公式编辑源码（F5b）');
  const mathEdit = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '值 $x^2$ 结束', 't');
    for (let i = 0; i < 40; i++) {
      await wait(150);
      const n = document.querySelector('[mdtype="math_inline"]');
      if (n && n.querySelector('.katex')) break;
    }
    const node = document.querySelector('[mdtype="math_inline"]');
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(80);

    const panel = document.getElementById('mf-math-editor');
    const field = document.getElementById('mf-math-input');
    const opened = panel.classList.contains('mf-show');
    const prefilled = field.value;

    field.value = 'x^3';
    document.getElementById('mf-me-apply').click();
    await wait(500);

    const after = document.querySelector('[mdtype="math_inline"]');
    return {
      opened,
      prefilled,
      hidden: !panel.classList.contains('mf-show'),
      tex: after && after.getAttribute('data-tex'),
      rendered: !!(after && after.querySelector('.katex')),
      md: window.__getMarkdown()
    };
  });
  check('点击公式弹出源码框', mathEdit.opened === true);
  check('源码框带出原 TeX', mathEdit.prefilled === 'x^2', mathEdit.prefilled);
  check('应用后面板收起', mathEdit.hidden === true);
  check('应用后 Markdown 更新', mathEdit.md === '值 $x^3$ 结束', JSON.stringify(mathEdit.md));
  check('应用后重新渲染', mathEdit.rendered === true && mathEdit.tex === 'x^3', JSON.stringify(mathEdit));

  console.log('\n[7.13] 前置元数据 front matter（回归：块不能被行内标记的规则藏掉）');
  const meta = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = ['---', 'name: fds-review', 'description: Self-contained skill', '---',
                 '', '# 标题', '', '正文 **粗体**'].join('\n');
    const read = () => {
      const el = document.querySelector('[mdtype="meta"]');
      const inline = document.querySelector('.md-inline .md-meta');
      return {
        found: !!el,
        display: el ? getComputedStyle(el).display : null,
        height: el ? Math.round(el.getBoundingClientRect().height) : 0,
        text: el ? (el.textContent || '').slice(0, 16) : '',
        inlineDisplay: inline ? getComputedStyle(inline).display : null,
        markdown: window.__getMarkdown()
      };
    };

    window.__loadContent('', src, 't');
    await wait(160);
    const plain = read();

    // BOM（有些编辑器会写 U+FEFF）
    window.__loadContent('', '\uFEFF' + src, 't');
    await wait(160);
    const bom = read();

    // 中间出现的 --- 仍然是分隔线，不是元数据
    window.__loadContent('', ['段落', '', '---', '', '结尾'].join('\n'), 't');
    await wait(160);
    const mid = { metaCount: document.querySelectorAll('[mdtype="meta"]').length };

    return { plain, bom, mid };
  });
  check('front matter 渲染成 meta 块', meta.plain.found === true, JSON.stringify(meta.plain));
  check('meta 块可见（不被行内标记的 display:none 波及）',
        meta.plain.display === 'block' && meta.plain.height > 20, JSON.stringify(meta.plain));
  check('meta 块内容正确', meta.plain.text.indexOf('name: fds-review') === 0, meta.plain.text);
  check('行内标记仍然隐藏', meta.plain.inlineDisplay === 'none', String(meta.plain.inlineDisplay));
  check('front matter 往返无损',
        meta.plain.markdown === ['---', 'name: fds-review', 'description: Self-contained skill', '---',
                                 '', '# 标题', '', '正文 **粗体**'].join('\n'),
        JSON.stringify(meta.plain.markdown.slice(0, 30)));
  check('带 BOM 的文件也能识别 front matter',
        meta.bom.found === true && meta.bom.text.indexOf('name: fds-review') === 0, JSON.stringify(meta.bom));
  check('正文中间的 --- 仍是分隔线', meta.mid.metaCount === 0, JSON.stringify(meta.mid));

  console.log('\n[7.14] 统一撤销栈（T3）');
  const ensureLive = async () => {
    const mode = await page.evaluate(() => document.getElementById('mode').textContent);
    if (mode === 'Source') { await page.keyboard.press('Meta+/'); await page.waitForTimeout(200); }
  };

  // a) 实时模式：输入 → 撤销 → 重做
  await ensureLive();
  await page.evaluate(() => { window.__loadContent('', 'start', 't'); document.getElementById('write').focus(); });
  await page.keyboard.type('hello');
  await page.waitForTimeout(350);
  const uTyped = await page.evaluate(() => window.__getMarkdown());
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(220);
  const uUndone = await page.evaluate(() => window.__getMarkdown());
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(220);
  const uRedone = await page.evaluate(() => window.__getMarkdown());
  check('实时输入后可撤销', uTyped === 'hellostart' && uUndone === 'start', JSON.stringify([uTyped, uUndone]));
  check('撤销后可重做', uRedone === 'hellostart', JSON.stringify(uRedone));

  // b) 跨模式：实时里改一次 → 切源码再改一次 → 撤销两次
  await ensureLive();
  await page.evaluate(() => { window.__loadContent('', 'base', 't'); document.getElementById('write').focus(); });
  await page.keyboard.type('A');
  await page.waitForTimeout(300);
  await page.keyboard.press('Meta+/');
  await page.waitForTimeout(200);
  await page.keyboard.type('B');
  await page.waitForTimeout(200);
  const crossBefore = await page.evaluate(() => window.__getMarkdown());
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(200);
  const cross1 = await page.evaluate(() => ({ md: window.__getMarkdown(), mode: document.getElementById('mode').textContent }));
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(250);
  const cross2 = await page.evaluate(() => ({ md: window.__getMarkdown(), mode: document.getElementById('mode').textContent }));
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(250);
  const crossRedo = await page.evaluate(() => ({ md: window.__getMarkdown(), mode: document.getElementById('mode').textContent }));
  // 注意：切到源码模式后光标跟着走（v0.10.5 修掉「跳到文档末尾」后），
  // 'B' 插在 'A' 后面而不是末尾
  check('跨模式前内容正确', crossBefore === 'ABbase', JSON.stringify(crossBefore));
  check('源码里的改动可以撤销', cross1.md === 'Abase' && cross1.mode === 'Source', JSON.stringify(cross1));
  check('撤销能穿过模式边界回到实时模式', cross2.md === 'base' && cross2.mode === 'Live', JSON.stringify(cross2));
  check('跨模式重做也生效', crossRedo.md === 'Abase' && crossRedo.mode === 'Source', JSON.stringify(crossRedo));

  // c) 连续输入合并成一步
  await ensureLive();
  await page.evaluate(() => { window.__loadContent('', '', 't'); document.getElementById('write').focus(); });
  await page.keyboard.type('abc');
  await page.waitForTimeout(400);
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(250);
  const merged = await page.evaluate(() => window.__getMarkdown());
  check('连续输入合并成一步撤销', merged === '', JSON.stringify(merged));

  // d) 结构变化（段落 → 标题）也能撤销
  await ensureLive();
  await page.evaluate(() => { window.__loadContent('', '标题测试', 't'); document.getElementById('write').focus(); });
  await page.keyboard.press('Home');
  await page.keyboard.type('# ');
  await page.waitForTimeout(400);
  const asHeading = await page.evaluate(() => document.querySelector('#write').firstElementChild.tagName);
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(300);
  const backToPara = await page.evaluate(() => ({
    tag: document.querySelector('#write').firstElementChild.tagName,
    md: window.__getMarkdown()
  }));
  check('段落转标题后可以撤销回段落',
        asHeading === 'H1' && backToPara.tag === 'P' && backToPara.md === '标题测试',
        JSON.stringify([asHeading, backToPara]));

  // e) 原生「编辑」菜单走的是 __cmd('undo') / __cmd('redo')
  await ensureLive();
  await page.evaluate(() => { window.__loadContent('', 'menu', 't'); document.getElementById('write').focus(); });
  await page.keyboard.type('!');
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__cmd('undo'));
  await page.waitForTimeout(220);
  const menuUndo = await page.evaluate(() => window.__getMarkdown());
  await page.evaluate(() => window.__cmd('redo'));
  await page.waitForTimeout(220);
  const menuRedo = await page.evaluate(() => window.__getMarkdown());
  check('菜单入口（__cmd undo）可撤销', menuUndo === 'menu', JSON.stringify(menuUndo));
  check('菜单入口（__cmd redo）可重做', menuRedo === '!menu', JSON.stringify(menuRedo));

  // f) 打开新文档会清空历史（不会撤回到上一个文档）
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__loadContent('', '另一个文档', 't2'); });
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(250);
  const afterSwitch = await page.evaluate(() => window.__getMarkdown());
  check('打开新文档后不会撤销到上一个文档', afterSwitch === '另一个文档', JSON.stringify(afterSwitch));

  console.log('\n[7.15] 嵌套块（T4）：子列表 / 项内代码块 / 多段引用');
  const nest = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const load = async (text) => {
      window.__loadContent('', text, 't');
      await wait(240);
      return {
        md: window.__getMarkdown(),
        nestedLists: document.querySelectorAll('li > ul, li > ol').length,
        liParas: document.querySelectorAll('li > p[mdtype="paragraph"]').length,
        liFences: document.querySelectorAll('li > pre[mdtype="fences"]').length,
        quoteParas: document.querySelectorAll('blockquote > p[mdtype="paragraph"]').length,
        quoteLists: document.querySelectorAll('blockquote > ul, blockquote > ol').length
      };
    };

    const nested = await load('- 第一项\n  - 子项 A\n  - 子项 B\n- 第二项');
    const deep = await load('- a\n  - b\n    - c');
    const fenced = await load('- 第一项\n\n  ```js\n  const a = 1;\n  ```\n\n- 第二项');
    const multiPara = await load('- 第一段\n\n  第二段\n- 第二项');
    const multiQuote = await load('> 第一段\n>\n> 第二段');
    const quoteList = await load('> - 甲\n> - 乙\n\n> 结尾');
    const ordered = await load('1. 一\n   1. 1.1\n   2. 1.2\n2. 二');
    return { nested, deep, fenced, multiPara, multiQuote, quoteList, ordered };
  });
  check('子列表挂在 li 里', nest.nested.nestedLists === 1 && /- 第一项/.test(nest.nested.md),
        JSON.stringify(nest.nested.md));
  check('三级嵌套也能解析', nest.deep.nestedLists === 2 && /- a[\s\S]*- b[\s\S]*- c/.test(nest.deep.md),
        JSON.stringify(nest.deep.md));
  check('列表项里能放代码块', nest.fenced.liFences === 1 && /```js[\s\S]*const a = 1;/.test(nest.fenced.md),
        JSON.stringify(nest.fenced.md));
  check('列表项里能放多段', nest.multiPara.liParas === 2 && /第一段[\s\S]*第二段/.test(nest.multiPara.md),
        JSON.stringify(nest.multiPara.md));
  check('引用里能放多段', nest.multiQuote.quoteParas === 2 && /第一段[\s\S]*第二段/.test(nest.multiQuote.md),
        JSON.stringify(nest.multiQuote.md));
  check('引用里能放列表', nest.quoteList.quoteLists === 1 && /> - 甲/.test(nest.quoteList.md),
        JSON.stringify(nest.quoteList.md));
  check('有序列表嵌套编号保留', /1\. 一[\s\S]*1\. 1\.1[\s\S]*2\. 1\.2[\s\S]*2\. 二/.test(nest.ordered.md),
        JSON.stringify(nest.ordered.md));

  // 序列化必须幂等：parse(serialize(x)) === serialize(x)
  const stable = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const cases = [
      '- 第一项\n  - 子项 A\n  - 子项 B\n- 第二项',
      '- a\n  - b\n    - c',
      '- 第一项\n\n  ```js\n  const a = 1;\n  ```\n\n- 第二项',
      '- 第一段\n\n  第二段\n- 第二项',
      '> 第一段\n>\n> 第二段',
      '> - 甲\n> - 乙\n\n> 结尾',
      '1. 一\n   1. 1.1\n   2. 1.2\n2. 二'
    ];
    const bad = [];
    for (const c of cases) {
      window.__loadContent('', c, 't');
      await wait(220);
      const md1 = window.__getMarkdown();
      window.__loadContent('', md1, 't');
      await wait(220);
      if (window.__getMarkdown() !== md1) bad.push(c);
    }
    return bad;
  });
  check('嵌套结构序列化幂等', stable.length === 0, JSON.stringify(stable));

  // 交互：嵌套项里回车应拆这一项，而不是拆散整个列表（leafBlock 的回归）
  const enterNested = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '- a\n  - bcd', 't');
    document.getElementById('write').focus();
    await wait(120);
    const li = document.querySelectorAll('li')[1];
    window.MF.setCaretBySourceOffset(li, 2);
    return true;
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
  const nestedSplit = await page.evaluate(() => ({
    items: Array.from(document.querySelectorAll('li')).map(l => l.textContent),
    md: window.__getMarkdown()
  }));
  check('嵌套项里回车只拆这一项',
        nestedSplit.items.length === 3 && nestedSplit.items[1] === 'bc' && nestedSplit.items[2] === 'd',
        JSON.stringify(nestedSplit));

  // 交互：多块条目段末回车生成空行，输入落在空行里
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__loadContent('', '- 第一段\n\n  第二段', 't');
    document.getElementById('write').focus();
    await wait(150);
    const para = document.querySelectorAll('li')[0].querySelector('p[mdtype="paragraph"]');
    window.MF.setCaretBySourceOffset(para, 3);
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.type('新段');
  await page.waitForTimeout(450);
  const typedInEmpty = await page.evaluate(() => window.__getMarkdown());
  check('条目内段末回车后输入落到新行',
        typedInEmpty === '- 第一段\n\n  新段\n\n  第二段', JSON.stringify(typedInEmpty));

  console.log('\n[7.5] F13 块级 HTML');
  const hb = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = '<div class="card" style="padding:6px"><strong>Hello</strong> HTML</div>\n\nafter paragraph';
    window.__loadContent('', src, 'html.md');
    await wait(450);
    const el = document.querySelector('[mdtype="html_block"]');
    const frame = el && el.querySelector('iframe.md-html-frame');
    return {
      exists: !!el,
      data: el ? el.getAttribute('data-html') : '',
      text: frame && frame.contentDocument && frame.contentDocument.body
        ? frame.contentDocument.body.textContent.trim() : '',
      sandbox: frame ? frame.getAttribute('sandbox') : '',
      md: window.__getMarkdown(),
      after: document.querySelector('#write p') ? document.querySelector('#write p').textContent : ''
    };
  });
  check('HTML 块解析并渲染 iframe', hb.exists && /Hello HTML/.test(hb.text), JSON.stringify(hb));
  check('iframe 是 sandbox 且禁用脚本', /allow-same-origin/.test(hb.sandbox) && !/allow-scripts/.test(hb.sandbox), hb.sandbox);
  check('HTML 块原样序列化且不吃后面的段落',
        hb.data.indexOf('<div class="card"') === 0 && /after paragraph/.test(hb.md) && hb.after === 'after paragraph',
        JSON.stringify(hb.md.slice(0, 120)));

  const detailsMd = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = '<details>\n<summary>历史说明</summary>\n' +
      '- 主播目录和观看流程由 **LiveHub** 提供\n' +
      '- 弹幕读取由 `server/danmaku/` 下的连接器实现\n' +
      '- 登录 Cookie 只存本机\n</details>\n\n普通段落';
    window.__loadContent('', src, 'details.md');
    await wait(450);
    const el = document.querySelector('[mdtype="html_block"]');
    const frame = el && el.querySelector('iframe.md-html-frame');
    return {
      raw: el ? el.getAttribute('data-html') : '',
      preview: frame ? frame.srcdoc : '',
      md: window.__getMarkdown(),
      exported: window.__buildExportHTML()
    };
  });
  check('details 源码保持原样',
        detailsMd.raw.includes('<summary>历史说明</summary>') &&
        detailsMd.raw.includes('- 主播目录') && detailsMd.raw.includes('</details>') &&
        detailsMd.md.includes('- 主播目录') && /普通段落/.test(detailsMd.md),
        JSON.stringify(detailsMd.md.slice(0, 180)));
  check('details 里的 Markdown 被解析',
        /<details/.test(detailsMd.preview) && /<ul/.test(detailsMd.preview) &&
        /<strong>LiveHub<\/strong>/.test(detailsMd.preview) &&
        /<code>server\/danmaku\//.test(detailsMd.preview),
        JSON.stringify(detailsMd.preview.slice(0, 240)));
  check('导出/PDF 展开解析后的 details 内容',
        /<details/.test(detailsMd.exported) && /<ul/.test(detailsMd.exported) &&
        /<strong>LiveHub<\/strong>/.test(detailsMd.exported),
        JSON.stringify(detailsMd.exported.slice(0, 240)));

  // 真实文件里条目之间常有空行：CommonMark 的「空行结束 HTML 块」会把列表
  // 切到 details 外面（列表变成编辑器块、iframe 只剩 summary 且高度虚高）。
  // details 必须吞到 </details> 为止。
  const detailsBlank = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = '<details>\n<summary>历史说明</summary>\n\n' +
      '- 主播目录和观看流程由 LiveHub 提供\n\n' +
      '- 弹幕读取由 `server/danmaku/` 下的连接器实现\n' +
      '</details>\n\n主播库保存在本地。';
    window.__loadContent('', src, 'details-blank.md');
    await wait(450);
    const el = document.querySelector('[mdtype="html_block"]');
    const frame = el && el.querySelector('iframe.md-html-frame');
    const doc = frame && frame.contentDocument;
    const det = doc && doc.querySelector('details');
    return {
      blocks: Array.from(document.getElementById('write').children)
        .map(k => k.getAttribute('mdtype')),
      raw: el ? el.getAttribute('data-html') : '',
      preview: frame ? frame.srcdoc : '',
      detKids: det ? Array.from(det.childNodes).map(n => n.nodeType === 3 ? '#text' : n.tagName) : [],
      gap: (det && det.querySelector('summary') && det.querySelector('ul'))
        ? Math.round(det.querySelector('ul').getBoundingClientRect().top -
                     det.querySelector('summary').getBoundingClientRect().bottom) : -1,
      frameH: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
      md: window.__getMarkdown(),
      exported: window.__buildExportHTML()
    };
  });
  check('空行分隔的 details 整块解析（列表不落到块外）',
        detailsBlank.blocks.filter(t => t === 'html_block').length === 1 &&
        !detailsBlank.blocks.includes('list'),
        JSON.stringify(detailsBlank.blocks));
  check('空行 details 源码原样保留',
        detailsBlank.raw.includes('<summary>历史说明</summary>') &&
        detailsBlank.raw.includes('- 主播目录') && detailsBlank.raw.includes('</details>'),
        JSON.stringify(detailsBlank.raw.slice(0, 120)));
  check('空行 details 列表在 iframe 内且间距正常',
        detailsBlank.detKids.includes('UL') && detailsBlank.gap >= 0 && detailsBlank.gap < 40 &&
        detailsBlank.frameH > 60,
        JSON.stringify({ kids: detailsBlank.detKids, gap: detailsBlank.gap, frameH: detailsBlank.frameH }));
  check('空行 details 往返与导出无损',
        detailsBlank.md.includes('- 主播目录') && detailsBlank.md.includes('</details>') &&
        /主播库保存在本地/.test(detailsBlank.md) &&
        /<details[\s>]/.test(detailsBlank.exported) && /<ul/.test(detailsBlank.exported),
        JSON.stringify(detailsBlank.md.slice(0, 160)));

  const hbEdit = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    // details 用例换了当前文档；编辑浮层测试重新加载普通 HTML 块
    window.__loadContent('', '<div class="card" style="padding:6px"><strong>Hello</strong> HTML</div>', 'html-edit.md');
    await wait(420);
    document.querySelector('.md-html-edit').click();
    await wait(80);
    const panel = document.getElementById('mf-math-editor');
    const field = document.getElementById('mf-math-input');
    const opened = panel.classList.contains('mf-show') && /class="card"/.test(field.value);
    field.value = '<section><em>Changed</em></section><script>window.__htmlPwned=1</script>';
    document.getElementById('mf-me-apply').click();
    await wait(450);
    const el = document.querySelector('[mdtype="html_block"]');
    const frame = el && el.querySelector('iframe.md-html-frame');
    const exportHTML = window.__buildExportHTML();
    const printed = window.__paginateForPrint();
    return {
      opened,
      closed: !panel.classList.contains('mf-show'),
      text: frame && frame.contentDocument && frame.contentDocument.body
        ? frame.contentDocument.body.textContent.trim() : '',
      pwned: !!window.__htmlPwned,
      md: window.__getMarkdown(),
      exportHasRaw: /<section[^>]*><em>Changed<\/em><\/section>/.test(exportHTML),
      exportHasIframe: /<iframe/i.test(exportHTML),
      exportHasScript: /<script/i.test(exportHTML),
      printHasRaw: /<section[^>]*><em>Changed<\/em><\/section>/.test(printed.pages.join('')),
      printHasIframe: /<iframe/i.test(printed.pages.join(''))
    };
  });
  check('点编辑按钮打开 HTML 源码浮层', hbEdit.opened && hbEdit.closed, JSON.stringify(hbEdit));
  check('编辑后 iframe 内容刷新', /^Changed/.test(hbEdit.text), hbEdit.text);
  check('HTML 里的脚本被 sandbox 阻止', hbEdit.pwned === false);
  check('编辑结果进入 Markdown', /<section><em>Changed<\/em><\/section>/.test(hbEdit.md), JSON.stringify(hbEdit.md));
  check('导出展开原始 HTML，不残留 iframe/script',
        hbEdit.exportHasRaw && !hbEdit.exportHasIframe && !hbEdit.exportHasScript,
        JSON.stringify([hbEdit.exportHasRaw, hbEdit.exportHasIframe, hbEdit.exportHasScript]));
  check('PDF 分页展开 HTML 块', hbEdit.printHasRaw && !hbEdit.printHasIframe,
        JSON.stringify([hbEdit.printHasRaw, hbEdit.printHasIframe]));

  console.log('\n[7.6] 超高段落分页保留行内格式');
  const tall = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const parts = [];
    for (let i = 0; i < 1200; i++) parts.push(`**B${i}** T${i}`);
    window.__loadContent('', '# 长段落\n\n' + parts.join(' '), 'tall.md');
    await wait(400);
    const pages = window.__paginateForPrint();
    const html = pages.pages.join('');
    return {
      pageCount: pages.pages.length,
      strong: (html.match(/mdtype="strong"/g) || []).length,
      first: html.indexOf('B0') >= 0,
      last: html.indexOf('B1199') >= 0,
      rawMarks: html.indexOf('**') >= 0,
      continuationStrong: pages.pages.slice(1).every(p => p.indexOf('mdtype="strong"') >= 0)
    };
  });
  check('超高段落拆成多页', tall.pageCount >= 2, String(tall.pageCount));
  check('拆分后保留 strong 结构', tall.strong >= 1000 && !tall.rawMarks, JSON.stringify(tall));
  check('拆分后内容完整且续页仍有格式',
        tall.first && tall.last && tall.continuationStrong, JSON.stringify(tall));

  console.log('\n[8] 运行时错误');

  check('无未捕获异常', errors.length === 0, errors.join(' | '));

  await closeTestBrowser();
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
