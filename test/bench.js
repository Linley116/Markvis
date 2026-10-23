// 性能基准：长文档下的加载 / 序列化 / 端到端输入延迟
//
// 用法：node test/bench.js [块数...]
// 默认测 250 / 1000 / 2500 个块（约 1k / 4k / 10k 行）

const path = require('path');
const { launchTestBrowser, closeTestBrowser } = require('./browser');

const PAGE = 'file://' + path.join(__dirname, '..', 'web', 'index.html');

function makeDoc(blocks) {
  const out = [];
  for (let i = 0; i < blocks; i++) {
    switch (i % 5) {
      case 0:
        out.push(`## 章节 ${i}`, '');
        break;
      case 1:
        out.push(`这是第 ${i} 段，包含 **粗体**、\`行内代码\` 以及 [链接](https://example.com) 和 *斜体*。`, '');
        break;
      case 2:
        out.push('- 项目 A', '- 项目 B', '- 项目 C', '');
        break;
      case 3:
        out.push('```js', `const x${i} = ${i};`, '```', '');
        break;
      case 4:
        out.push('| 列 A | 列 B |', '|:---|---:|', `| ${i} | ${i * 2} |`, '');
        break;
    }
  }
  return out.join('\n');
}

async function measure(page, blocks) {
  const md = makeDoc(blocks);
  const lines = md.split('\n').length;
  const kb = (Buffer.byteLength(md, 'utf8') / 1024).toFixed(0);

  const r = await page.evaluate(async (doc) => {
    const t0 = performance.now();
    window.__loadContent('', doc, 'bench.md');
    const load = performance.now() - t0;

    // 序列化两次取较小值，排除首次 JIT 抖动
    const a = performance.now();
    window.__getMarkdown();
    const s1 = performance.now() - a;
    const b = performance.now();
    window.__getMarkdown();
    const s2 = performance.now() - b;
    const serialize = Math.min(s1, s2);

    // 端到端：按键 → Markdown 里出现该字符
    const p = document.querySelector('#write p[mdtype="paragraph"]');
    p.focus();
    window.MF.setCaretBySourceOffset(p, 0);
    const mark = 'ZQ' + Math.random().toString(36).slice(2, 6);
    const t1 = performance.now();
    document.execCommand('insertText', false, mark);

    let guard = 0;
    while (!window.__getMarkdown().includes(mark) && guard < 500) {
      await new Promise(res => setTimeout(res, 10));
      guard++;
    }
    const latency = performance.now() - t1;

    // 大纲重建耗时（loadMarkdown 的 docLoadedHooks 会触发它，单独量一下）
    const t3 = performance.now();
    window.MFOutline.refresh();
    const outline = performance.now() - t3;

    // 画笔成型：输入 **x** 到渲染成 <strong>。轮询是 200ms 周期，
    // 单次采样抖动大，取 5 次平均。
    const p2 = document.querySelector('#write p[mdtype="paragraph"]');
    let markupTotal = 0;
    for (let k = 0; k < 5; k++) {
      p2.focus();
      window.MF.setCaretBySourceOffset(p2, window.MF.inlineRaw(p2).length);
      const uniq = 'b' + Math.random().toString(36).slice(2, 8);
      const t2 = performance.now();
      document.execCommand('insertText', false, ' **' + uniq + '**');
      let g2 = 0;
      while (g2 < 500) {
        const hit = Array.from(p2.querySelectorAll('span[mdtype="strong"]'))
          .some(s => s.textContent === uniq);
        if (hit) break;
        await new Promise(res => setTimeout(res, 10));
        g2++;
      }
      markupTotal += performance.now() - t2;
    }
    const markup = markupTotal / 5;

    return { load, serialize, latency, outline, markup, timedOut: guard >= 500 };
  }, md);

  return { blocks, lines, kb, ...r };
}

(async () => {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  const targets = sizes.length ? sizes : [250, 1000, 2500];

  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(PAGE);
  await page.waitForTimeout(300);

  const rows = [];
  for (const n of targets) {
    process.stdout.write(`测量 ${n} 个块…\n`);
    rows.push(await measure(page, n));
  }

  console.log('\n| 块数 | 行数 | 大小 | loadMarkdown | getMarkdown | 输入→DOM | 大纲重建 | 输入→成型 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.blocks} | ${r.lines} | ${r.kb} KB | ${r.load.toFixed(1)} ms | ${r.serialize.toFixed(1)} ms | ${r.latency.toFixed(0)} ms | ${r.outline.toFixed(1)} ms | ${r.markup.toFixed(0)} ms |`);
  }

  if (errors.length) console.log('\n运行时错误：\n' + errors.join('\n'));
  await closeTestBrowser();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
