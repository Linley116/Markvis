/* html2md：剪贴板 HTML → Markdown（粘贴富文本用）
 *
 * 为什么自写不引 turndown：只需要覆盖常见来源（浏览器 / Word / 备忘录 /
 * 本程序自己渲染出来的 HTML），子树不大；而且产物要直接喂给引擎的
 * parseBlocks 重新解析，行为必须可预测。
 *
 * 覆盖：标题 / 段落 / 加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 图片 /
 *       列表（嵌套 + 任务清单）/ 引用（嵌套）/ 代码块（带语言）/
 *       表格（对齐）/ 分隔线 / 硬换行。
 * 不覆盖：样式派生格式（Word 的 MsoNormal 之类）、sup/sub（按纯文本）、
 *         跨行内元素的复杂空白。已知取舍，够用为止。
 */
(function () {
  'use strict';

  // 整棵跳过：脚本 / 样式 / 表单控件 / 嵌入对象
  var SKIP = {
    SCRIPT: 1, STYLE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, NOSCRIPT: 1,
    IFRAME: 1, OBJECT: 1, EMBED: 1, SVG: 1, CANVAS: 1, AUDIO: 1, VIDEO: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1,
    LABEL: 1, FIELDSET: 1, TEMPLATE: 1, DIALOG: 1
  };

  // 块级标签：两侧要空行
  var BLOCK = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, MAIN: 1,
    ASIDE: 1, NAV: 1, FIGURE: 1, FIGCAPTION: 1, ADDRESS: 1, DETAILS: 1,
    SUMMARY: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1, DL: 1, DT: 1, DD: 1,
    BLOCKQUOTE: 1, PRE: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1,
    TR: 1, HR: 1
  };

  var HARD_BREAK = '\u0001'; // 硬换行哨兵，最后再还原成 "  \n"

  function isBlockNode(n) {
    return n.nodeType === 1 && BLOCK[n.tagName];
  }

  function repeat(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }

  function indentLines(text, pad) {
    return text.split('\n').map(function (l) { return l ? pad + l : l; }).join('\n');
  }

  function quoteLines(text) {
    return text.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
  }

  /** URL 里有空格或括号时用尖括号包起来，否则 markdown 链接会断 */
  function urlNeedsAngle(u) {
    return /[\s()]/.test(u);
  }

  function fmtURL(u) {
    return urlNeedsAngle(u) ? '<' + u + '>' : u;
  }

  // ---------------------------------------------------------------- 行内

  function emitInline(node, ctx) {
    if (node.nodeType === 3) {
      // 文本节点：空白折叠成单空格（硬换行只认 <br>）
      return node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    var tag = node.tagName;
    if (SKIP[tag]) return '';

    if (tag === 'BR') return HARD_BREAK;
    if (tag === 'IMG') return emitImage(node);

    var inner = emitChildrenInline(node, ctx);

    if (tag === 'STRONG' || tag === 'B') return inner.trim() ? '**' + inner + '**' : '';
    if (tag === 'EM' || tag === 'I') return inner.trim() ? '*' + inner + '*' : '';
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return inner.trim() ? '~~' + inner + '~~' : '';
    if (tag === 'CODE') return inner.trim() ? '`' + inner + '`' : '';
    if (tag === 'A') return emitLink(node, inner);
    if (tag === 'SUP' || tag === 'SUB' || tag === 'U' || tag === 'MARK' ||
        tag === 'SMALL' || tag === 'ABBR' || tag === 'CITE' || tag === 'Q' ||
        tag === 'TIME' || tag === 'VAR' || tag === 'KBD' || tag === 'SAMP') {
      return inner; // 没有对应语法，保留文字
    }
    return inner;
  }

  function emitChildrenInline(node, ctx) {
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      out += emitInline(node.childNodes[i], ctx);
    }
    return out;
  }

  function emitLink(node, inner) {
    var href = (node.getAttribute('href') || '').trim();
    var text = inner.trim();
    if (!href || /^(javascript|vbscript|data):/i.test(href)) return text;
    if (!text) return href;
    return '[' + text + '](' + fmtURL(href) + ')';
  }

  function emitImage(node) {
    var src = (node.getAttribute('src') || '').trim();
    var alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '');
    if (!src) return alt;
    return '![' + alt + '](' + fmtURL(src) + ')';
  }

  /** 行内片段收尾：压缩空白、还原硬换行哨兵、去首尾空格。
   *  顺序要紧：先做通用空白清理，最后才把哨兵还原成 "  \n"，
   *  否则硬换行前的两个空格会被空行清理规则一并吃掉。 */
  function finalizeInline(s) {
    return s
      .replace(/[\t ]+/g, ' ')
      .replace(/ ?\u0001 ?/g, '\u0001')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\u0001/g, '  \n')
      .trim();
  }

  // ---------------------------------------------------------------- 块级

  /** 容器（body / p / div / blockquote…）：块级子节点空行分隔，行内子节点累积成段 */
  function walkContainer(container, ctx) {
    var parts = [];
    var run = '';
    function flush() {
      var t = finalizeInline(run);
      if (t) parts.push(t);
      run = '';
    }
    for (var i = 0; i < container.childNodes.length; i++) {
      var n = container.childNodes[i];
      if (isBlockNode(n)) {
        flush();
        var b = emitBlock(n, ctx);
        if (b != null && b !== '') parts.push(b);
      } else {
        run += emitInline(n, ctx);
      }
    }
    flush();
    return parts.join('\n\n');
  }

  function emitBlock(node, ctx) {
    var tag = node.tagName;

    if (tag === 'HR') return '---';
    if (tag === 'PRE') return emitPre(node);
    if (tag === 'TABLE') return emitTable(node, ctx);
    if (tag === 'BLOCKQUOTE') {
      var inner = walkContainer(node, { quote: true });
      return inner ? quoteLines(inner) : '';
    }
    if (tag === 'UL' || tag === 'OL') return emitList(node, ctx);
    if (tag === 'LI') return emitList({ tagName: 'UL', childNodes: [node] }, ctx); // 兜底
    if (/^H[1-6]$/.test(tag)) {
      var depth = tag.charAt(1);
      var text = finalizeInline(emitChildrenInline(node, ctx));
      return text ? repeat('#', depth) + ' ' + text : '';
    }
    // P / DIV / SECTION / FIGURE / DD… 以及未知块级标签：继续往里走
    return walkContainer(node, ctx);
  }

  function emitPre(node) {
    var code = node.querySelector('code');
    var host = code || node;
    var lang = '';
    var m = (host.getAttribute('class') || '').match(/(?:^|\s)(?:language|lang)-([\w+#.\-]+)/);
    if (m) lang = m[1];
    var text = host.textContent
      .replace(/\r\n?/g, '\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
    return '```' + lang + '\n' + text + '\n```';
  }

  /** 列表：直接子 li 逐项生成；嵌套列表按 marker 宽度缩进挂在本项下面 */
  function emitList(node, ctx) {
    var ordered = node.tagName === 'OL';
    var start = 1;
    if (ordered) {
      var st = parseInt(node.getAttribute('start'), 10);
      if (!isNaN(st)) start = st;
    }

    var items = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var ch = node.childNodes[i];
      if (ch.nodeType === 1 && ch.tagName === 'LI') items.push(ch);
    }
    if (!items.length) return '';

    var lines = [];
    for (var j = 0; j < items.length; j++) {
      lines.push(emitListItem(items[j], ordered, start + j, ctx));
    }
    var text = lines.join('\n');
    if (ctx.quote) text = quoteLines(text);
    return text;
  }

  function emitListItem(li, ordered, index, ctx) {
    var marker = ordered ? (index + '. ') : '- ';

    // 任务清单：checkbox 的文字不进正文
    var cb = li.querySelector('input[type="checkbox"]');
    if (cb) marker += (cb.hasAttribute('checked') || cb.checked ? '[x] ' : '[ ] ');

    // 摘掉直接嵌套的列表，剩下的按行内处理（Word 会在 li 里放 <p>）
    var nested = [];
    for (var i = 0; i < li.childNodes.length; i++) {
      var ch = li.childNodes[i];
      if (ch.nodeType === 1 && (ch.tagName === 'UL' || ch.tagName === 'OL')) nested.push(ch);
    }
    var run = '';
    for (var k = 0; k < li.childNodes.length; k++) {
      var n = li.childNodes[k];
      if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) continue;
      run += emitInline(n, ctx);
    }
    var text = finalizeInline(run);

    var out = marker + text;
    for (var m = 0; m < nested.length; m++) {
      var sub = emitList(nested[m], ctx);
      if (sub) out += '\n' + indentLines(sub, repeat(' ', marker.length));
    }
    return out;
  }

  /** 表格：第一行当表头；对齐取单元格的 align 属性 / style.textAlign */
  function emitTable(node, ctx) {
    var rows = node.querySelectorAll('tr');
    if (!rows.length) return '';

    var matrix = [];
    var aligns = null;
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll('th,td');
      if (!cells.length) continue;
      var row = [];
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        row.push(finalizeInline(emitChildrenInline(cell, ctx))
          .replace(/\n/g, '<br>')
          .replace(/\|/g, '\\|'));
        if (aligns === null && cell.tagName === 'TH') aligns = [];
        if (aligns && cell.tagName === 'TH') {
          var a = (cell.getAttribute('align') ||
            (cell.style && cell.style.textAlign) || '').toLowerCase();
          aligns.push(a === 'left' || a === 'right' || a === 'center' ? a : null);
        }
      }
      matrix.push(row);
    }
    if (!matrix.length) return '';

    var cols = 0;
    matrix.forEach(function (row) { cols = Math.max(cols, row.length); });
    if (!aligns) aligns = [];
    while (aligns.length < cols) aligns.push(null);

    function line(cells) {
      var out = [];
      for (var i = 0; i < cols; i++) out.push(cells[i] || '');
      return '| ' + out.join(' | ') + ' |';
    }

    var out = [line(matrix[0])];
    var sep = [];
    for (var i = 0; i < cols; i++) {
      var a = aligns[i];
      sep.push(a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---');
    }
    out.push('| ' + sep.join(' | ') + ' |');
    for (var j = 1; j < matrix.length; j++) out.push(line(matrix[j]));
    return out.join('\n');
  }

  // ---------------------------------------------------------------- 入口

  function convert(html) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var md = walkContainer(doc.body, { quote: false });
    return md
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  /** 剪贴板 HTML 是不是「有块级结构的富内容」。
   *  代码编辑器（VS Code 等）复制出来的 HTML 全是 span，没有块级标签，
   *  那种应该用 text/plain（里面就是 markdown 源码），不该转换。 */
  function isRich(html) {
    if (!html) return false;
    return /<(p|div|h[1-6]|ul|ol|li|pre|table|blockquote|br|section|article|header|footer|main|figure|hr)\b/i
      .test(String(html));
  }

  window.htmlToMarkdown = convert;
  window.htmlToMarkdown.isRich = isRich;
})();
