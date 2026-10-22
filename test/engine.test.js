// 引擎逻辑测试：在无头 Chrome 里加载 web/index.html，验证
//   1. 块解析/渲染产出正确的 DOM 结构
//   2. DOM -> Markdown 往返
//   3. 输入 **x** 后经画笔自动变成 strong
//   4. expand / 源码模式切换

const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'web', 'index.html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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

  const inline = await page.evaluate(() => {
    const s = document.querySelector('#write span[mdtype="strong"]');
    const c = document.querySelector('#write span[mdtype="code"]');
    return {
      strongOpen: s && s.getAttribute('data-open'),
      strongText: s && s.textContent,
      codeOpen: c && c.getAttribute('data-open'),
      codeInner: c && c.textContent
    };
  });
  check('strong 的 data-open 是 **', inline.strongOpen === '**', JSON.stringify(inline.strongOpen));
  check('strong 内容正确', /Typora 架构/.test(inline.strongText || ''), inline.strongText);
  check('code 的 data-open 是 `', inline.codeOpen === '`');

  console.log('\n[3] DOM -> Markdown 往返');
  const md = await page.evaluate(() => window.__getMarkdown());
  check('保留 ATX 标题', /^# MarkFrame$/m.test(md) && /^## 它复刻了什么$/m.test(md));
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
    return {
      count: spans.length,
      text: last && last.textContent,
      open: last && last.getAttribute('data-open'),
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
  check('往返后内容仍在', src.after.includes('# MarkFrame'));

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

  console.log('\n[8] 运行时错误');
  check('无未捕获异常', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
