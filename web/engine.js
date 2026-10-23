/* MarkFrame 编辑器引擎
 *
 * 实现思路（复刻 Typora 的核心架构）：
 *   Markdown  ──parse──►  Node 树  ──render──►  contenteditable DOM
 *                                                  │
 *   Markdown  ◄──rawText───────────────────────────┘
 *
 * 权威表示是「无损 DOM」：每个行内元素把源码标记渲染成真实的 `.md-meta`
 * 文本节点（默认 display:none，光标进入时由 .md-expand 显形），块级元素
 * 用 mdtype / cid 记住类型与身份。用户直接编辑 DOM，由 200ms 画笔把脏块
 * 反解析回源码、必要时重渲染。
 */

(function () {
  'use strict';

  var write = document.getElementById('write');
  var source = document.getElementById('source');
  var modeEl = document.getElementById('mode');
  var wordCountEl = document.getElementById('wordcount');

  // =====================================================================
  // 1. 桥（与原生三通道对应：异步 / 回调 / 同步 prompt）
  // =====================================================================

  var bridge = (function () {
    var handlers = {};
    var callbacks = {};
    var uid = 1;

    function hasNative() {
      return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers._bridge);
    }

    function callHandler(name, data, cb) {
      var msg = { handlerName: name, data: data === undefined ? null : data };
      if (cb) {
        var id = 'cb_' + (uid++) + '_' + Date.now();
        callbacks[id] = cb;
        msg.callbackId = id;
      }
      if (hasNative()) {
        window.webkit.messageHandlers._bridge.postMessage(msg);
      } else if (window.MF_DEBUG) {
        console.log('[mock bridge]', name, data);
      }
    }

    function callSync(name, data) {
      if (!hasNative()) return null;
      var parts = name.split('.');
      var dict = {
        name: parts[0],
        method: parts.slice(1).join('.'),
        data: data === undefined ? null : data
      };
      var res = prompt('__bridge__', JSON.stringify(dict));
      if (!res) return null;
      try { return JSON.parse(res); } catch (e) { return null; }
    }

    function registerHandler(name, fn) { handlers[name] = fn; }

    function handleMessageFromObjC(json) {
      var msg;
      try { msg = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
      if (msg.responseId) {
        var cb = callbacks[msg.responseId];
        if (cb) { delete callbacks[msg.responseId]; cb(msg.responseData); }
        return;
      }
      var h = handlers[msg.handlerName];
      if (h) h(msg.data, null);
    }

    return {
      callHandler: callHandler,
      callSync: callSync,
      registerHandler: registerHandler,
      _handleMessageFromObjC: handleMessageFromObjC
    };
  })();

  window.bridge = bridge;

  // 原生 -> JS
  bridge.registerHandler('editor.setContent', function (data) {
    if (data && typeof data.content === 'string') {
      loadMarkdown(data.content);
      document.title = data.title || 'Untitled';
    }
  });

  // =====================================================================
  // 2. 工具
  // =====================================================================

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  // =====================================================================
  // 3. 行内解析：Markdown 片段 -> 行内节点数组
  // =====================================================================

  var ESCAPABLE = /[\\`*{}\[\]()#+\-.!_>~|]/;

  function parseInline(src) {
    var out = [];
    var buf = '';
    var i = 0;

    function flush() {
      if (buf) { out.push({ type: 'plain', text: buf }); buf = ''; }
    }

    while (i < src.length) {
      var c = src[i];

      // 行内公式 $...$（$ 后面不能是空白，收盘 $ 前也不能是空白）
      if (c === '$' && src[i + 1] && src[i + 1] !== '$' && /\S/.test(src[i + 1])) {
        var mathEnd = -1;
        for (var mj = i + 1; mj < src.length; mj++) {
          if (src[mj] === '$' && src[mj - 1] !== '\\' && src[mj - 1] !== ' ') { mathEnd = mj; break; }
          if (src[mj] === '\n') break;
        }
        if (mathEnd > i + 1) {
          flush();
          out.push({ type: 'math', tex: src.slice(i + 1, mathEnd) });
          i = mathEnd + 1;
          continue;
        }
      }

      // 反斜杠转义
      if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
        buf += src[i + 1];
        i += 2;
        continue;
      }

      // 换行：GFM 语义 —— 行尾两个以上空格或反斜杠是硬换行 <br>，
      // 其余是软换行（渲染成空格，序列化时还原成单个 \n）
      if (c === '\n') {
        var bs = 0;
        while (bs < buf.length && buf.charAt(buf.length - 1 - bs) === '\\') bs++;
        var sp = 0;
        while (sp < buf.length - bs && buf.charAt(buf.length - 1 - bs - sp) === ' ') sp++;

        if (sp >= 2) {
          buf = buf.slice(0, buf.length - sp);
          flush();
          out.push({ type: 'break', hard: true, mark: repeat(' ', sp) });
        } else if (bs % 2 === 1) {
          buf = buf.slice(0, buf.length - 1);
          flush();
          out.push({ type: 'break', hard: true, mark: '\\' });
        } else {
          flush();
          out.push({ type: 'break', hard: false });
        }
        i++;
        continue;
      }

      // 行内代码
      if (c === '`') {
        var mCode = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(src.slice(i));
        if (mCode) {
          flush();
          out.push({ type: 'code', text: mCode[2], mark: mCode[1] });
          i += mCode[0].length;
          continue;
        }
      }

      // 图片
      if (c === '!' && src[i + 1] === '[') {
        var mImg = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(src.slice(i));
        if (mImg) {
          flush();
          out.push({ type: 'image', alt: mImg[1], src: mImg[2], title: mImg[3] || '' });
          i += mImg[0].length;
          continue;
        }
      }

      // 脚注引用 [^label]（必须排在链接前面，否则会被当成 [text](url)）
      if (c === '[' && src[i + 1] === '^') {
        var mFn = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
        if (mFn) {
          flush();
          out.push({ type: 'fnref', label: mFn[1] });
          i += mFn[0].length;
          continue;
        }
      }

      // 引用式链接 [text][id]（id 省略时用 text 当 label）
      if (c === '[') {
        var mRef = /^\[([^\]]+)\]\[([^\]]*)\]/.exec(src.slice(i));
        if (mRef) {
          flush();
          out.push({
            type: 'link_ref',
            label: mRef[2] || mRef[1],
            children: parseInline(mRef[1])
          });
          i += mRef[0].length;
          continue;
        }
      }

      // 链接
      if (c === '[') {
        var mLink = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(src.slice(i));
        if (mLink) {
          flush();
          out.push({
            type: 'link',
            href: mLink[2],
            title: mLink[3] || '',
            children: parseInline(mLink[1])
          });
          i += mLink[0].length;
          continue;
        }
      }

      // 自动链接
      if (c === '<') {
        var mAuto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(src.slice(i));
        if (mAuto) {
          flush();
          out.push({ type: 'autolink', href: mAuto[1] });
          i += mAuto[0].length;
          continue;
        }
      }

      // 粗体 / 斜体
      if (c === '*' || c === '_') {
        var pair = src.substr(i, 2);
        if (pair === '**' || pair === '__') {
          var closeB = src.indexOf(pair, i + 2);
          if (closeB > i + 2) {
            flush();
            out.push({ type: 'strong', mark: pair, children: parseInline(src.slice(i + 2, closeB)) });
            i = closeB + 2;
            continue;
          }
        } else {
          var closeI = src.indexOf(c, i + 1);
          if (closeI > i + 1 && src[i + 1] !== ' ' && src[closeI - 1] !== ' ') {
            flush();
            out.push({ type: 'em', mark: c, children: parseInline(src.slice(i + 1, closeI)) });
            i = closeI + 1;
            continue;
          }
        }
      }

      // 删除线
      if (c === '~' && src.substr(i, 2) === '~~') {
        var closeD = src.indexOf('~~', i + 2);
        if (closeD > i + 2) {
          flush();
          out.push({ type: 'del', mark: '~~', children: parseInline(src.slice(i + 2, closeD)) });
          i = closeD + 2;
          continue;
        }
      }

      buf += c;
      i++;
    }

    flush();
    return out;
  }

  // =====================================================================
  // 4. 块解析：Markdown 全文 -> 块数组
  // =====================================================================

  var nid = 0;

  function isFenceLine(line) {
    return /^\s*(```+|~~~+)/.test(line);
  }

  function isHrLine(line) {
    return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  // ---- GFM 表格辅助 ----

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    var head = lines[i];
    var sep = lines[i + 1];
    if (head.indexOf('|') < 0) return false;
    if (sep.indexOf('-') < 0) return false;
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(sep);
  }

  /** 拆表格行，保留 \| 转义（交给 parseInline 处理） */
  function splitTableRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);

    var cells = [];
    var cur = '';
    var esc = false;

    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\') { cur += ch; esc = true; continue; }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function parseTableAlign(sep) {
    return splitTableRow(sep).map(function (c) {
      var left = c.charAt(0) === ':';
      var right = c.charAt(c.length - 1) === ':';
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }


  var LINK_DEF_RE = /^\[([^\[\]^][^\[\]]*)\]:[ \t]*(\S+)(?:[ \t]+"([^"]*)")?[ \t]*$/;

  function scanLinkDefs(lines) {
    var found = null;
    for (var k = 0; k < lines.length; k++) {
      var m = LINK_DEF_RE.exec(lines[k]);
      if (m) {
        if (!found) found = {};
        found[m[1]] = { href: m[2], title: m[3] || '' };
      }
    }
    return found;
  }

  function parseBlocks(src) {
    var lines = String(src).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var i = 0;

    // 引用式链接的定义可能出现在使用之后，先整篇扫一遍
    var defs = scanLinkDefs(lines);
    if (defs) linkDefs = defs;

    while (i < lines.length) {
      var line = lines[i];

      // 空行
      if (/^\s*$/.test(line)) { i++; continue; }

      // YAML front matter（仅文档开头）
      if (i === 0 && /^---\s*$/.test(line)) {
        var endMeta = -1;
        for (var mk = i + 1; mk < lines.length; mk++) {
          if (/^---\s*$/.test(lines[mk])) { endMeta = mk; break; }
        }
        if (endMeta > 0) {
          blocks.push({ type: 'meta', text: lines.slice(i + 1, endMeta).join('\n') });
          i = endMeta + 1;
          continue;
        }
      }

      // 围栏代码
      var mFence = /^(\s*)(```+|~~~+)\s*([\w+#-]*)\s*$/.exec(line);
      if (mFence) {
        var fenceChar = mFence[2][0];
        var fenceLen = mFence[2].length;
        var lang = mFence[3] || '';
        var body = [];
        i++;
        while (i < lines.length) {
          var closeRe = new RegExp('^\\s*' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
          if (closeRe.test(lines[i])) { i++; break; }
          body.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'fences', lang: lang, text: body.join('\n') });
        continue;
      }

      // 标题
      var mHead = /^(#{1,6})\s+(.*)$/.exec(line);
      if (mHead) {
        blocks.push({
          type: 'heading',
          depth: mHead[1].length,
          inline: parseInline(mHead[2].replace(/\s+#+\s*$/, '').trim())
        });
        i++;
        continue;
      }

      // 分隔线
      if (isHrLine(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      // 引用
      if (/^\s*>/.test(line)) {
        var quoteBody = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quoteBody.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        blocks.push({ type: 'blockquote', inline: parseInline(quoteBody.join('\n')) });
        continue;
      }

      // 列表
      var mList = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (mList) {
        var ordered = /\d/.test(mList[2]);
        var listStart = ordered ? (parseInt(mList[2], 10) || 1) : 1;
        var indent = mList[1].length;
        var items = [];

        while (i < lines.length) {
          var mItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!mItem) {
            // 缩进续行并入上一项
            if (items.length && /^\s+\S/.test(lines[i])) {
              items[items.length - 1].text += '\n' + lines[i].trim();
              i++;
              continue;
            }
            break;
          }
          if (mItem[1].length !== indent || /\d/.test(mItem[2]) !== ordered) break;
          items.push({ text: mItem[3] });
          i++;
        }

        blocks.push({
          type: 'list',
          ordered: ordered,
          start: listStart,
          items: items.map(function (it) { return { inline: parseInline(it.text) }; })
        });
        continue;
      }

      // 表格（GFM）
      if (isTableStart(lines, i)) {
        var rawRows = [splitTableRow(lines[i])];
        var aligns = parseTableAlign(lines[i + 1]);
        i += 2;

        while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
          rawRows.push(splitTableRow(lines[i]));
          i++;
        }

        var cols = 0;
        rawRows.forEach(function (r) { cols = Math.max(cols, r.length); });

        var rows = rawRows.map(function (r) {
          var cells = r.slice();
          while (cells.length < cols) cells.push('');
          return cells.slice(0, cols).map(function (t) { return parseInline(t); });
        });

        while (aligns.length < cols) aligns.push('left');
        blocks.push({ type: 'table', align: aligns.slice(0, cols), rows: rows });
        continue;
      }

      // 块级公式 $$ ... $$（可跨行）
      if (/^\s*\$\$/.test(line)) {
        var texLines = [];
        var firstChunk = line.replace(/^\s*\$\$/, '');
        if (/\$\$\s*$/.test(firstChunk) && firstChunk.trim()) {
          texLines.push(firstChunk.replace(/\$\$\s*$/, ''));
          i++;
        } else {
          if (firstChunk.trim()) texLines.push(firstChunk);
          i++;
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
            texLines.push(lines[i]);
            i++;
          }
          if (i < lines.length) {
            var tailChunk = lines[i].replace(/\$\$\s*$/, '');
            if (tailChunk.trim()) texLines.push(tailChunk);
            i++;
          }
        }
        blocks.push({ type: 'math_block', tex: texLines.join('\n').trim() });
        continue;
      }

      // 引用式链接的定义 [id]: url "title"
      var mLinkDef = LINK_DEF_RE.exec(line);
      if (mLinkDef) {
        blocks.push({
          type: 'def_link',
          label: mLinkDef[1],
          href: mLinkDef[2],
          title: mLinkDef[3] || ''
        });
        i++;
        continue;
      }

      // [TOC] 目录占位（内容在渲染后由 refreshTOC 生成）
      if (/^\s*\[TOC\]\s*$/i.test(line)) {
        blocks.push({ type: 'toc' });
        i++;
        continue;
      }

      // 脚注定义 [^label]: 正文（续行按 4 空格 / Tab 缩进）
      var mFnDef = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
      if (mFnDef) {
        var fnBody = [mFnDef[2]];
        i++;
        while (i < lines.length && /^(?: {4}|\t)/.test(lines[i])) {
          fnBody.push(lines[i].replace(/^(?: {4}|\t)/, ''));
          i++;
        }
        blocks.push({ type: 'def_footnote', label: mFnDef[1], inline: parseInline(fnBody.join('\n')) });
        continue;
      }

      // 段落
      var para = [];
      while (i < lines.length) {
        var l = lines[i];
        if (/^\s*$/.test(l)) break;
        if (/^(#{1,6})\s/.test(l)) break;
        if (/^\s*>/.test(l)) break;
        if (/^(\s*)([-*+]|\d+[.)])\s+/.test(l)) break;
        if (/^\[\^[^\]\s]+\]:/.test(l)) break;
        if (LINK_DEF_RE.test(l)) break;
        if (/^\s*\$\$/.test(l)) break;
        if (/^\s*\[TOC\]\s*$/i.test(l)) break;
        if (isFenceLine(l)) break;
        if (isHrLine(l)) break;
        para.push(l);
        i++;
      }
      if (para.length) {
        blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')) });
      } else {
        i++;
      }
    }

    return blocks;
  }

  // =====================================================================
  // 5. 渲染：Node 树 -> HTML
  // =====================================================================

  /**
   * 行内标记渲染成真实文本节点（对应 Typora 的 .md-meta）。
   * 默认 display:none；光标进入所属 .md-inline 时由 .md-expand 显形。
   * 这样标记既能被看见，也能被方向键穿过、被 Backspace 删掉。
   */
  function metaHTML(side, text) {
    return '<span class="md-meta" data-side="' + side + '">' + escapeHtml(text) + '</span>';
  }

  function renderInline(nodes) {
    return nodes.map(function (n) {
      switch (n.type) {
        case 'plain':
          return escapeHtml(n.text);

        case 'break':
          // 软换行：留在文本里，由 white-space 折叠成空格
          // 硬换行：<br>，data-mark 记住源码里的标记（空格或反斜杠）
          return n.hard
            ? '<br class="md-hardbreak" data-mark="' + escapeAttr(n.mark || '  ') + '">'
            : '\n';

        case 'strong':
          return '<span class="md-inline" mdtype="strong">' + metaHTML('open', n.mark || '**') +
            renderInline(n.children) + metaHTML('close', n.mark || '**') + '</span>';

        case 'em':
          return '<span class="md-inline" mdtype="em">' + metaHTML('open', n.mark || '*') +
            renderInline(n.children) + metaHTML('close', n.mark || '*') + '</span>';

        case 'code':
          return '<span class="md-inline" mdtype="code">' + metaHTML('open', n.mark || '`') +
            '<code>' + escapeHtml(n.text) + '</code>' + metaHTML('close', n.mark || '`') + '</span>';

        case 'del':
          return '<span class="md-inline" mdtype="del">' + metaHTML('open', '~~') +
            '<del>' + renderInline(n.children) + '</del>' + metaHTML('close', '~~') + '</span>';

        case 'link':
          return '<span class="md-inline" mdtype="link">' + metaHTML('open', '[') +
            '<a href="' + escapeAttr(n.href) + '">' + renderInline(n.children) + '</a>' +
            metaHTML('close', '](' + n.href + ')') + '</span>';

        case 'link_ref': {
          var ldef = linkDefs[n.label];
          var lhref = ldef ? ldef.href : '';
          var ltitle = ldef ? ldef.title : '';
          return '<span class="md-inline" mdtype="link_ref" data-label="' + escapeAttr(n.label) + '">' +
            metaHTML('open', '[') +
            '<a href="' + escapeAttr(lhref || '#') + '"' + (ltitle ? ' title="' + escapeAttr(ltitle) + '"' : '') +
            ' data-label="' + escapeAttr(n.label) + '">' + renderInline(n.children) + '</a>' +
            metaHTML('close', '][' + n.label + ']') + '</span>';
        }

        case 'autolink':
          return '<span class="md-inline" mdtype="autolink">' + metaHTML('open', '<') +
            '<a href="' + escapeAttr(n.href) + '">' + escapeHtml(n.href) + '</a>' +
            metaHTML('close', '>') + '</span>';

        case 'math': {
          var mtex = n.tex;
          return '<span class="md-inline md-math" mdtype="math_inline" contenteditable="false"' +
            ' data-tex="' + escapeAttr(mtex) + '" data-src="' + escapeAttr('$' + mtex + '$') + '">' +
            '<span class="md-math-ph">' + escapeHtml('$' + mtex + '$') + '</span></span>';
        }

        case 'fnref': {
          var flabel = String(n.label);
          return '<sup class="md-fn-ref" mdtype="footnote_ref" contenteditable="false" title="跳到脚注"' +
            ' data-label="' + escapeAttr(flabel) + '" data-src="' + escapeAttr('[^' + flabel + ']') +
            '">' + escapeHtml(flabel) + '</sup>';
        }

        case 'image':
          return '<img class="md-img" src="' + escapeAttr(resolveImgSrc(n.src)) + '" alt="' + escapeAttr(n.alt) +
            '" data-src="' + escapeAttr('![' + n.alt + '](' + n.src + ')') + '">';

        default:
          return escapeHtml(n.text || '');
      }
    }).join('');
  }

  function renderBlock(b) {
    var cid = ' cid="' + b.cid + '"';
    switch (b.type) {
      case 'heading':
        return '<h' + b.depth + ' class="md-block" mdtype="heading" data-depth="' + b.depth + '"' + cid + '>' +
          renderInline(b.inline) + '</h' + b.depth + '>';

      case 'paragraph':
        return '<p class="md-block" mdtype="paragraph"' + cid + '>' + renderInline(b.inline) + '</p>';

      case 'blockquote':
        return '<blockquote class="md-block" mdtype="blockquote" data-open="&gt; "' + cid + '>' +
          renderInline(b.inline) + '</blockquote>';

      case 'fences': {
        var lang = (b.lang || '').toLowerCase();

        // mermaid：渲染成图表块（源码编辑走源码模式）
        if (lang === 'mermaid') {
          var rawFence = '```mermaid\n' + b.text + '\n```';
          return '<div class="md-block md-mermaid" mdtype="mermaid" contenteditable="false"' +
            ' data-code="' + escapeAttr(b.text) + '" data-src="' + escapeAttr(rawFence) + '"' + cid + '>' +
            '<div class="md-mermaid-ph">' + escapeHtml(b.text) + '</div></div>';
        }

        var codeHTML = escapeHtml(b.text);

        // 有 highlight.js 且语言已注册时就地高亮（rawText 读 textContent，不受影响）
        if (window.hljs && lang && window.hljs.getLanguage(lang)) {
          try {
            codeHTML = window.hljs.highlight(b.text, {
              language: lang,
              ignoreIllegals: true
            }).value;
          } catch (e) {
            codeHTML = escapeHtml(b.text);
          }
        }

        return '<pre class="md-block md-fences" mdtype="fences" data-fences="' +
          escapeAttr(b.lang ? '```' + b.lang : '```') + '"' + cid + '>' +
          '<code class="language-' + escapeAttr(lang) + '">' + codeHTML + '</code></pre>';
      }

      case 'hr':
        return '<hr class="md-block" mdtype="hr"' + cid + '>';

      case 'toc':
        // 目录内容由 refreshTOC() 生成；整块不可编辑，当作原子处理
        return '<div class="md-block md-toc" mdtype="toc" contenteditable="false" data-src="[TOC]"' + cid + '></div>';

      case 'math_block':
        return '<div class="md-block md-math-block" mdtype="math_block" contenteditable="false"' +
          ' data-tex="' + escapeAttr(b.tex) + '" data-src="' +
          escapeAttr('$$\n' + b.tex + '\n$$') + '"' + cid + '>' +
          '<span class="md-math-ph">' + escapeHtml(b.tex) + '</span></div>';

      case 'def_link':
        return '<div class="md-block md-fn-def md-link-def" mdtype="def_link" data-label="' +
          escapeAttr(b.label) + '"' + cid + '>' +
          '<span class="md-fn-mark" contenteditable="false">[' + escapeHtml(b.label) + ']</span>' +
          '<span class="md-link-body">' + escapeHtml(b.href) +
          (b.title ? ' "' + escapeHtml(b.title) + '"' : '') + '</span></div>';

      case 'def_footnote':
        return '<div class="md-block md-fn-def" mdtype="def_footnote" data-label="' +
          escapeAttr(b.label) + '"' + cid + '>' +
          '<span class="md-fn-mark" contenteditable="false" data-label="' + escapeAttr(b.label) + '">[' +
          escapeHtml(b.label) + ']</span>' +
          '<span class="md-fn-body">' + renderInline(b.inline) + '</span>' +
          '<a class="md-fn-back" contenteditable="false" href="#" data-label="' + escapeAttr(b.label) +
          '" title="回到引用">↩</a></div>';

      case 'meta':
        // 块级用 .md-meta-block（行内标记叫 .md-meta，两者不能共用一个类名）
        return '<pre class="md-block md-meta-block" mdtype="meta"' + cid + '>' +
          escapeHtml(b.text) + '</pre>';

      case 'table':
        var aligns = b.align || [];
        var head = b.rows[0] || [];
        var body = b.rows.slice(1);

        function cellHTML(cellInline, r, c, tag) {
          var align = aligns[c] || 'left';
          var inner = renderInline(cellInline);
          if (!inner) inner = '<br class="md-pad">';   // 空单元格也要能定位光标
          return '<' + tag + ' mdtype="table_cell" data-cell="' + r + ',' + c +
            '" style="text-align:' + align + '">' + inner + '</' + tag + '>';
        }

        var thead = '<thead><tr>' + head.map(function (c, ci) {
          return cellHTML(c, 0, ci, 'th');
        }).join('') + '</tr></thead>';

        var tbody = '<tbody>' + body.map(function (row, ri) {
          return '<tr>' + row.map(function (c, ci) {
            return cellHTML(c, ri + 1, ci, 'td');
          }).join('') + '</tr>';
        }).join('') + '</tbody>';

        return '<table class="md-block md-table" mdtype="table" data-align="' +
          escapeAttr(JSON.stringify(aligns)) + '"' + cid + '>' + thead + tbody + '</table>';

      case 'list':
        var tag = b.ordered ? 'ol' : 'ul';
        var startAttr = (b.ordered && b.start && b.start !== 1) ? ' start="' + b.start + '"' : '';
        var lis = b.items.map(function (it, idx) {
          var marker = b.ordered ? (idx + 1) + '. ' : '- ';
          return '<li mdtype="list_item" data-open="' + escapeAttr(marker) + '" data-close="">' +
            renderInline(it.inline) + '</li>';
        }).join('');
        return '<' + tag + ' class="md-block" mdtype="list"' + startAttr + cid + '>' + lis + '</' + tag + '>';

      default:
        return '<p class="md-block" mdtype="paragraph"' + cid + '></p>';
    }
  }

  var doc = [];

  /** 引用式链接的定义表：label -> { href, title }。
      每次整篇解析时重建；逐块重解析（画笔）不会把它清空。 */
  var linkDefs = {};

  /** 当前文档所在目录（带尾斜杠）。渲染 <img> 时把相对路径解析成 file:// 绝对地址，
      否则相对地址会落到 bundle 的 web/ 里。序列化仍用 data-src 里的原始相对路径。 */
  var docBaseDir = '';

  function resolveImgSrc(src) {
    if (!src || !docBaseDir) return src;
    if (/^(https?:|data:|file:|\/\/)/.test(src)) return src;
    if (src.charAt(0) === '/') return src;
    return 'file://' + docBaseDir.replace(/\/+$/, '') + '/' + src;
  }

  function makeBlocks(raw) {
    return parseBlocks(raw).map(function (b) {
      b.cid = 'n' + (++nid);
      return b;
    });
  }

  /**
   * 空块必须有一个可定位的占位节点，否则 contenteditable 里没有可插入的
   * 文本位置，浏览器会把输入 forward 到下一个块。占位 br 在源码还原时被跳过。
   */
  function ensurePlaceholder(el) {
    if (!el || el.nodeType !== 1) return;
    var t = el.getAttribute('mdtype');

    if (t === 'list') {
      for (var i = 0; i < el.children.length; i++) ensurePlaceholder(el.children[i]);
      return;
    }
    if (t === 'hr' || t === 'fences') return;
    if (el.textContent.length) return;
    if (el.querySelector('img')) return;
    if (el.querySelector('br')) return;

    var br = document.createElement('br');
    br.className = 'md-pad';
    el.appendChild(br);
  }

  function padEmpties() {
    for (var i = 0; i < write.children.length; i++) ensurePlaceholder(write.children[i]);
  }

  function isPad(el) {
    return el.tagName === 'BR' && el.classList && el.classList.contains('md-pad');
  }

  /** 标题纯文本：剔除 .md-meta，否则目录里会出现 `**` */
  function plainTextOf(el) {
    var clone = el.cloneNode(true);
    var metas = clone.querySelectorAll('.md-meta');
    for (var i = 0; i < metas.length; i++) {
      if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
    }
    return clone.textContent;
  }

  /** 按当前标题重建所有 [TOC] 块（内容不可编辑，纯展示 + 点击跳转） */
  function refreshTOC() {
    var tocs = write.querySelectorAll('[mdtype="toc"]');
    if (!tocs.length) return;

    var heads = write.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var html = '<ol class="md-toc-list">';
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var lvl = parseInt(h.tagName.charAt(1), 10);
      var text = plainTextOf(h).trim() || '(空标题)';
      html += '<li class="md-toc-item" data-head="' + i + '" style="padding-left:' +
        ((lvl - 1) * 16) + 'px"><a href="#">' + escapeHtml(text) + '</a></li>';
    }
    html += '</ol>';

    for (var k = 0; k < tocs.length; k++) {
      if (tocs[k].innerHTML !== html) tocs[k].innerHTML = html;
    }
  }

  // =====================================================================
  // 5.5 公式 / 图表的懒加载
  //     两个库都只在文档里真的出现对应节点时才注入：KaTeX ~640KB（含字体），
  //     Mermaid ~2.5MB。没有公式的文档完全不受影响。
  // =====================================================================

  var libState = { katex: 0, mermaid: 0 };   // 0 未加载 / 1 加载中 / 2 就绪
  var mmdSeq = 0;

  function injectScript(src, onload) {
    var sc = document.createElement('script');
    sc.src = src;
    sc.onload = onload;
    document.head.appendChild(sc);
  }

  function ensureKatex() {
    if (window.katex || libState.katex) return;
    libState.katex = 1;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'vendor/katex/katex.min.css';
    document.head.appendChild(link);
    injectScript('vendor/katex/katex.min.js', function () {
      libState.katex = 2;
      hydrateMath();
    });
  }

  function hydrateMath() {
    var nodes = write.querySelectorAll('[mdtype="math_inline"],[mdtype="math_block"]');
    if (!nodes.length) return;
    if (!window.katex) { ensureKatex(); return; }

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute('data-rendered') === '1') continue;
      var tex = el.getAttribute('data-tex') || '';
      try {
        el.innerHTML = window.katex.renderToString(tex, {
          displayMode: el.getAttribute('mdtype') === 'math_block',
          throwOnError: false,
          output: 'html'
        });
        el.setAttribute('data-rendered', '1');
      } catch (e) {
        el.innerHTML = '<span class="md-math-ph">' + escapeHtml(tex) + '</span>';
      }
    }
  }

  function ensureMermaid() {
    if (window.mermaid || libState.mermaid) return;
    libState.mermaid = 1;
    injectScript('vendor/mermaid.min.js', function () {
      try {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      } catch (e) { console.warn('mermaid init failed', e); }
      libState.mermaid = 2;
      hydrateMermaid();
    });
  }

  function hydrateMermaid() {
    var nodes = write.querySelectorAll('[mdtype="mermaid"]');
    if (!nodes.length) return;
    if (!window.mermaid) { ensureMermaid(); return; }

    for (var i = 0; i < nodes.length; i++) {
      (function (el) {
        if (el.getAttribute('data-rendered') === '1') return;
        var code = el.getAttribute('data-code') || '';
        var id = 'mf-mmd-' + (++mmdSeq);
        try {
          window.mermaid.render(id, code).then(function (res) {
            el.innerHTML = res.svg;
            el.setAttribute('data-rendered', '1');
          }).catch(function () {
            el.innerHTML = '<pre class="md-mermaid-error">' + escapeHtml(code) + '</pre>';
            el.setAttribute('data-rendered', '1');
          });
        } catch (e) {
          el.innerHTML = '<pre class="md-mermaid-error">' + escapeHtml(code) + '</pre>';
          el.setAttribute('data-rendered', '1');
        }
      })(nodes[i]);
    }
  }

  // ---------------------------------------------------------------------
  // 公式 / 图表的源码编辑：点一下浮出一个小面板（对应 Typora 点公式弹源码框）
  // ---------------------------------------------------------------------

  var mathEditing = null;   // { node, kind }

  function closestTyped(node, types) {
    while (node && node !== write) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('mdtype')) {
        var t = node.getAttribute('mdtype');
        for (var i = 0; i < types.length; i++) if (types[i] === t) return node;
        return null;
      }
      node = node.parentNode;
    }
    return null;
  }

  function openMathEditor(node) {
    var panel = document.getElementById('mf-math-editor');
    var field = document.getElementById('mf-math-input');
    if (!panel || !field) return;

    var kind = node.getAttribute('mdtype');
    mathEditing = { node: node, kind: kind };
    field.value = kind === 'mermaid'
      ? (node.getAttribute('data-code') || '')
      : (node.getAttribute('data-tex') || '');

    panel.classList.add('mf-show');
    var r = node.getBoundingClientRect();
    var w = 340, h = 190;
    panel.style.left = Math.max(12, Math.min(window.innerWidth - w, r.left)) + 'px';
    panel.style.top = Math.max(12, Math.min(window.innerHeight - h, r.bottom + 8)) + 'px';
    field.focus();
    field.select();
  }

  function closeMathEditor() {
    var panel = document.getElementById('mf-math-editor');
    if (panel) panel.classList.remove('mf-show');
    mathEditing = null;
  }

  function applyMathEditor() {
    if (!mathEditing) return;
    var node = mathEditing.node;
    var kind = mathEditing.kind;
    var field = document.getElementById('mf-math-input');
    var val = field ? field.value : '';

    if (kind === 'math_inline') {
      node.setAttribute('data-tex', val);
      node.setAttribute('data-src', '$' + val + '$');
    } else if (kind === 'math_block') {
      node.setAttribute('data-tex', val);
      node.setAttribute('data-src', '$$\n' + val + '\n$$');
    } else {
      node.setAttribute('data-code', val);
      node.setAttribute('data-src', '```mermaid\n' + val + '\n```');
    }
    node.removeAttribute('data-rendered');

    closeMathEditor();
    hydrateMath();
    hydrateMermaid();

    var top = topBlockOf(node) || node;
    markDirty(top);
    setEdited(true);
  }

  (function wireMathEditor() {
    var panel = document.getElementById('mf-math-editor');
    var field = document.getElementById('mf-math-input');
    if (!panel || !field) return;

    document.getElementById('mf-me-apply').addEventListener('click', applyMathEditor);
    document.getElementById('mf-me-cancel').addEventListener('click', closeMathEditor);

    field.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeMathEditor(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); applyMathEditor(); }
    });

    // 点面板外面收起（点另一个公式时由 #write 的 click 重新打开）
    document.addEventListener('mousedown', function (e) {
      if (!panel.classList.contains('mf-show')) return;
      if (panel.contains(e.target)) return;
      closeMathEditor();
    });
  })();

  function renderDoc() {
    write.innerHTML = doc.map(renderBlock).join('');
    padEmpties();
    refreshTOC();
    hydrateMath();
    hydrateMermaid();
  }

  function loadMarkdown(text) {
    doc = makeBlocks(text);
    if (!doc.length) {
      doc = [{ type: 'paragraph', inline: [], cid: 'n' + (++nid) }];
    }
    renderDoc();
    updateWordCount();
    if (docLoadedHooks && docLoadedHooks.length) {
      docLoadedHooks.forEach(function (fn) { try { fn(); } catch (e) { console.warn(e); } });
    }
  }

  // =====================================================================
  // 6. 序列化：DOM -> Markdown（对应 Typora 的 rawText）
  // =====================================================================

  /** 硬换行 BR 还原成源码时要补的标记（两个空格或反斜杠）；Shift+Enter 插入的裸 BR 也按硬换行算 */
  function brMark(el) {
    return el.getAttribute('data-mark') || '  ';
  }

  /** BR 在源码里的长度：标记 + 换行符本身 */
  function brSourceLen(el) {
    return brMark(el).length + 1;
  }

  function inlineRaw(el) {
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];

      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/\u200b/g, '');
        continue;
      }
      if (n.nodeType !== 1) continue;

      if (n.tagName === 'BR') {
        if (!isPad(n)) out += brMark(n) + '\n';
        continue;
      }

      if (n.tagName === 'IMG') {
        out += n.getAttribute('data-src') || '';
        continue;
      }

      // 其它带 data-src 的原子（脚注引用等）
      if (n.hasAttribute('data-src')) {
        out += n.getAttribute('data-src');
        continue;
      }
      // 不可编辑的装饰节点（脚注的序号/回跳箭头）不进源码
      if (n.getAttribute && n.getAttribute('contenteditable') === 'false') continue;

      // .md-meta 里的标记是真实文本节点，递归即可读回；
      // 其余行内元素（code / a / del）同样递归。
      out += inlineRaw(n);
    }
    return out;
  }

  /** 等宽显示宽度：CJK 全角按 2 列算，用于生成对齐的表格 */
  function displayWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x1100 && (
        c <= 0x115f || c === 0x2329 || c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6)
      )) { w += 2; } else { w += 1; }
    }
    return w;
  }

  function padTo(s, w, align) {
    var d = w - displayWidth(s);
    if (d <= 0) return s;
    var sp = function (n) { return new Array(n + 1).join(' '); };
    if (align === 'right') return sp(d) + s;
    if (align === 'center') {
      var l = Math.floor(d / 2);
      return sp(l) + s + sp(d - l);
    }
    return s + sp(d);
  }

  function tableRaw(el) {
    var aligns = [];
    try { aligns = JSON.parse(el.getAttribute('data-align') || '[]'); } catch (e) { aligns = []; }

    var trs = el.querySelectorAll('tr');
    var rows = [];

    for (var r = 0; r < trs.length; r++) {
      var cells = [];
      for (var c = 0; c < trs[r].children.length; c++) {
        // 单元格内的 | 必须转义，否则会把列切断
        cells.push(inlineRaw(trs[r].children[c]).replace(/\|/g, '\\|'));
      }
      rows.push(cells);
    }
    if (!rows.length) return '';

    var cols = 0;
    rows.forEach(function (row) { cols = Math.max(cols, row.length); });
    rows.forEach(function (row) { while (row.length < cols) row.push(''); });

    var widths = [];
    for (var k = 0; k < cols; k++) {
      var w = 3;
      for (var j = 0; j < rows.length; j++) w = Math.max(w, displayWidth(rows[j][k]));
      widths.push(w);
    }

    function fmt(row) {
      var parts = [];
      for (var k2 = 0; k2 < cols; k2++) {
        parts.push(padTo(row[k2], widths[k2], aligns[k2] || 'left'));
      }
      return '| ' + parts.join(' | ') + ' |';
    }

    var sep = [];
    for (var k3 = 0; k3 < cols; k3++) {
      var w3 = widths[k3];
      var a = aligns[k3] || 'left';
      if (a === 'center') sep.push(':' + repeat('-', Math.max(1, w3 - 2)) + ':');
      else if (a === 'right') sep.push(repeat('-', Math.max(2, w3 - 1)) + ':');
      else sep.push(repeat('-', w3));
    }

    var out = [fmt(rows[0]), '| ' + sep.join(' | ') + ' |'];
    for (var r2 = 1; r2 < rows.length; r2++) out.push(fmt(rows[r2]));
    return out.join('\n');
  }

  function blockRaw(el) {
    var t = el.getAttribute('mdtype');

    switch (t) {
      case 'heading':
        return repeat('#', parseInt(el.dataset.depth || '1', 10)) + ' ' + inlineRaw(el);

      case 'paragraph':
        return inlineRaw(el);

      case 'blockquote':
        return inlineRaw(el).split('\n').map(function (l) { return '> ' + l; }).join('\n');

      case 'fences':
        return (el.dataset.fences || '```') + '\n' + el.textContent + '\n```';

      case 'hr':
        return '---';

      case 'meta':
        return '---\n' + (el.textContent || '') + '\n---';

      case 'table':
        return tableRaw(el);

      case 'toc':
      case 'math_block':
      case 'mermaid':
        return el.getAttribute('data-src') || '';

      case 'def_link': {
        var bodyEl = el.querySelector('.md-link-body');
        var rawBody = bodyEl ? inlineRaw(bodyEl).trim() : '';
        return '[' + (el.getAttribute('data-label') || '') + ']: ' + rawBody;
      }

      case 'def_footnote': {
        var fnBodyEl = el.querySelector('.md-fn-body');
        var fnText = fnBodyEl ? inlineRaw(fnBodyEl) : '';
        // 续行按 4 空格缩进写回，才能被重新解析成同一条脚注
        fnText = fnText.split('\n').map(function (line, i) {
          return i === 0 ? line : '    ' + line;
        }).join('\n');
        return '[^' + (el.getAttribute('data-label') || '') + ']: ' + fnText;
      }

      case 'list': {
        var ordered = el.tagName === 'OL';
        var start = parseInt(el.getAttribute('start') || '1', 10) || 1;
        var lines = [];
        for (var i = 0; i < el.children.length; i++) {
          var li = el.children[i];
          lines.push((ordered ? (start + i) + '. ' : '- ') + inlineRaw(li));
        }
        return lines.join('\n');
      }

      default:
        return inlineRaw(el);
    }
  }

  function repeat(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }

  function getMarkdown() {
    var parts = [];
    for (var i = 0; i < write.children.length; i++) {
      parts.push(blockRaw(write.children[i]));
    }
    return parts.join('\n\n');
  }

  // =====================================================================
  // 7. 光标 <-> 源码偏移
  // =====================================================================

  function leafBlock() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var node = sel.getRangeAt(0).startContainer;
    var best = null;

    while (node && node !== write) {
      if (node.nodeType === 1 && node.hasAttribute('mdtype')) best = node;
      if (node.nodeType === 1 && node.hasAttribute('cid')) break;
      node = node.parentNode;
    }
    return best;
  }

  function topBlockOf(node) {
    while (node && node !== write) {
      if (node.nodeType === 1 && node.hasAttribute('cid')) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** 光标在给定叶子元素内的「源码偏移」（含行内标记长度） */
  function caretSourceOffset(root) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    var range = sel.getRangeAt(0);
    var pos = 0;
    var done = false;

    function walk(node) {
      if (done) return;

      if (node.nodeType === 3) {
        if (node === range.startContainer) {
          var headLen = node.nodeValue.slice(0, range.startOffset).replace(/\u200b/g, '').length;
          pos += headLen;
          done = true;
          return;
        }
        pos += node.nodeValue.replace(/\u200b/g, '').length;
        return;
      }
      if (node.nodeType !== 1) return;

      if (node.tagName === 'BR') {
        if (!isPad(node)) pos += brSourceLen(node);
        return;
      }
      if (node.tagName === 'IMG') { pos += (node.getAttribute('data-src') || '').length; return; }

      // 其它原子（脚注引用）：按 data-src 的源码长度计
      if (node.hasAttribute && node.hasAttribute('data-src')) {
        pos += (node.getAttribute('data-src') || '').length;
        return;
      }
      // 不可编辑的装饰节点不占源码位置
      if (node.getAttribute && node.getAttribute('contenteditable') === 'false') return;

      // 标记是真实文本节点，偏移天然对齐：普通递归即可，
      // 不再需要按 data-open / data-close 补长度。
      if (node === range.startContainer) {
        // 光标停在元素本身（两个子节点之间）：只累加插入点之前的子节点
        for (var k = 0; k < range.startOffset && k < node.childNodes.length; k++) {
          walk(node.childNodes[k]);
          if (done) return;
        }
        done = true;
        return;
      }

      for (var j = 0; j < node.childNodes.length; j++) {
        walk(node.childNodes[j]);
        if (done) return;
      }
    }

    for (var i = 0; i < root.childNodes.length; i++) {
      walk(root.childNodes[i]);
      if (done) break;
    }
    return pos;
  }

  function placeCaret(node, offset) {
    var r = document.createRange();
    r.setStart(node, Math.max(0, Math.min(offset, node.nodeValue.length)));
    r.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function firstTextNode(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    return walker.nextNode();
  }

  /** 把光标放到 root 内的「源码偏移」target 处 */
  function setCaretBySourceOffset(root, target) {
    var pos = 0;
    var placed = false;

    // 清掉上一轮留下的零宽锚点，避免累积
    var stale = root.querySelectorAll ? root.querySelectorAll('.mf-anchor') : [];
    for (var si = 0; si < stale.length; si++) stale[si].parentNode.removeChild(stale[si]);

    function walk(node) {
      if (placed) return;

      if (node.nodeType === 3) {
        var raw = node.nodeValue;
        var clean = raw.replace(/\u200b/g, '');
        // 标记节点用「严格小于」：偏移正好落在标记末尾时，说明用户指的是
        // 内容开头，应该落到下一个文本节点里。否则光标会停在隐藏标记的末尾，
        // 按左方向键会直接跳出整个行内元素（Chrome 的标记内部最左位置不可达）。
        var inMeta = node.parentNode && node.parentNode.classList &&
          node.parentNode.classList.contains('md-meta');
        var hit = inMeta ? target < pos + clean.length : target <= pos + clean.length;
        if (hit && clean.length > 0) {
          // 把「去零宽后的偏移」映射回真实字符偏移
          var want = target - pos;
          var acc = 0;
          var real = 0;
          for (var ci = 0; ci < raw.length; ci++) {
            if (acc >= want) break;
            if (raw.charAt(ci) !== '\u200b') acc++;
            real = ci + 1;
          }
          placeCaret(node, real);
          placed = true;
          return;
        }
        pos += clean.length;
        return;
      }
      if (node.nodeType !== 1) return;

      if (node.tagName === 'BR') {
        if (!isPad(node)) pos += brSourceLen(node);
        return;
      }
      if (node.tagName === 'IMG') {
        var ilen = (node.getAttribute('data-src') || '').length;
        if (target <= pos + ilen) {
          // 光标落在图片占位区间内：贴到图片前/后，而不是继续走到块尾
          var ir = document.createRange();
          if (target <= pos) ir.setStartBefore(node);
          else ir.setStartAfter(node);
          ir.collapse(true);
          var isel = window.getSelection();
          isel.removeAllRanges();
          isel.addRange(ir);
          placed = true;
          return;
        }
        pos += ilen;
        return;
      }

      // 其它原子（脚注引用）：规则同图片，贴到前后
      if (node.hasAttribute && node.hasAttribute('data-src')) {
        var alen = (node.getAttribute('data-src') || '').length;
        if (target <= pos + alen) {
          var ar = document.createRange();
          if (target <= pos) ar.setStartBefore(node); else ar.setStartAfter(node);
          ar.collapse(true);
          var asel = window.getSelection();
          asel.removeAllRanges();
          asel.addRange(ar);
          placed = true;
          return;
        }
        pos += alen;
        return;
      }
      // 装饰节点（脚注序号/回跳箭头）不可编辑，跳过
      if (node.getAttribute && node.getAttribute('contenteditable') === 'false') return;

      for (var i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
        if (placed) return;
      }
    }

    for (var i = 0; i < root.childNodes.length; i++) {
      walk(root.childNodes[i]);
      if (placed) return;
    }

    // 兜底：块尾。若最后是一个行内元素，直接 selectNodeContents+collapse
    // 会被浏览器解释成「元素内部末尾」，后续输入被吸进该元素（甚至落进
    // 隐藏的 .md-meta 里）。这里显式补一个零宽锚点，把插入点钉在元素外面。
    var last = root.lastChild;
    if (last && last.nodeType === 1 && last.classList && last.classList.contains('md-inline')) {
      var anchor = document.createElement('span');
      anchor.className = 'mf-anchor';
      anchor.textContent = '\u200b';
      root.appendChild(anchor);

      var ar = document.createRange();
      ar.setStart(anchor.firstChild, 1);
      ar.collapse(true);
      var asel = window.getSelection();
      asel.removeAllRanges();
      asel.addRange(ar);
      updateExpand();
      return;
    }

    var r = document.createRange();
    r.selectNodeContents(root);
    r.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    // 标记可能是隐藏的：光标若落进 .md-meta，先让所属行内元素展开
    updateExpand();
  }

  // =====================================================================
  // 8. 画笔：脏块增量重绘
  // =====================================================================

  var dirty = new Set();
  var composing = false;

  function markDirty(el) {
    if (el) dirty.add(el);
  }

  function markDirtyFromCaret() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var node = sel.getRangeAt(0).startContainer;
    var top = topBlockOf(node);
    if (top) dirty.add(top);
  }

  /** 把 src 解析后写回 el，并尽量恢复光标 */
  function reparseInto(el, src, restore) {
    var blocks = parseBlocks(src);

    if (!blocks.length) {
      // 变成空块：保留一个空段落，避免无法继续输入
      var t = el.getAttribute('mdtype');
      if (t === 'paragraph' && !el.textContent.trim()) return;
      blocks = [{ type: 'paragraph', inline: [] }];
    }

    blocks.forEach(function (b) { if (!b.cid) b.cid = 'n' + (++nid); });

    var frag = document.createDocumentFragment();
    var created = [];

    blocks.forEach(function (b, idx) {
      var holder = document.createElement('div');
      holder.innerHTML = renderBlock(b).trim();
      var node = holder.firstElementChild;
      if (!node) return;
      if (idx === 0) node.setAttribute('cid', el.getAttribute('cid')); // 继承身份
      frag.appendChild(node);
      created.push(node);
    });

    el.replaceWith(frag);
    if (!created.length) return created;
    padEmpties();

    if (restore) {
      var target = created[Math.min(restore.index, created.length - 1)];
      if (target) setCaretBySourceOffset(target, restore.offset);
    }
    return created;
  }

  function closestCell(node) {
    while (node && node !== write) {
      if (node.nodeType === 1 && (node.tagName === 'TD' || node.tagName === 'TH')) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** 表格增量重绘：只替换内容确实变化的单元格，保住光标 */
  function brushTable(el) {
    var sel = window.getSelection();
    var activeCell = sel && sel.anchorNode ? closestCell(sel.anchorNode) : null;
    var cells = el.querySelectorAll('td,th');

    // 单元格里出现裸 | 会切断列，交给整表重建
    for (var i = 0; i < cells.length; i++) {
      if (inlineRaw(cells[i]).indexOf('|') >= 0) {
        var coord = activeCell ? activeCell.getAttribute('data-cell') : null;
        var off = activeCell ? caretSourceOffset(activeCell) : 0;
        var created = reparseInto(el, tableRaw(el), null);
        var table = created && created[0];
        if (table && coord) {
          var back = table.querySelector('[data-cell="' + coord + '"]');
          if (back) setCaretBySourceOffset(back, off);
        }
        return;
      }
    }

    for (var j = 0; j < cells.length; j++) {
      var cell = cells[j];
      var src = inlineRaw(cell);
      var html = src ? renderInline(parseInline(src)) : '<br class="md-pad">';
      if (cell.innerHTML === html) continue;

      var isActive = cell === activeCell;
      var caret = isActive ? caretSourceOffset(cell) : null;
      cell.innerHTML = html;
      if (isActive) setCaretBySourceOffset(cell, caret);
    }
  }

  function brush(el) {
    if (!el || !el.isConnected) return;
    if (el.getAttribute('mdtype') === 'hr') return;
    if (el.getAttribute('mdtype') === 'fences') return;

    // 表格：结构没变时只重绘改动过的单元格，避免整表重建丢光标
    if (el.getAttribute('mdtype') === 'table') {
      brushTable(el);
      return;
    }

    var sel = window.getSelection();
    var leaf = leafBlock();
    var restore = null;

    if (leaf && (leaf === el || el.contains(leaf))) {
      restore = {
        index: Array.prototype.indexOf.call(el.children, leaf) >= 0
          ? Array.prototype.indexOf.call(el.children, leaf) : 0,
        offset: caretSourceOffset(leaf)
      };
      if (leaf === el) restore.index = 0;
    }

    var src = blockRaw(el);
    var blocks = parseBlocks(src);

    // 形状完全相同且内容未变 -> 不动 DOM
    if (blocks.length === 1) {
      var nb = blocks[0];
      var t = el.getAttribute('mdtype');
      var sameType = nb.type === t &&
        (nb.type !== 'heading' || String(nb.depth) === String(el.dataset.depth)) &&
        (nb.type !== 'list' || (nb.ordered === (el.tagName === 'OL')));

      if (sameType) {
        var holder = document.createElement('div');
        holder.innerHTML = renderBlock(nb).trim();
        var next = holder.firstElementChild;
        if (next && next.innerHTML !== el.innerHTML) {
          el.innerHTML = next.innerHTML;
          if (restore) setCaretBySourceOffset(el, restore.offset);
        }
        return;
      }
    }

    reparseInto(el, src, restore);
  }

  setInterval(function () {
    if (composing || !dirty.size) return;
    var list = Array.from(dirty);
    dirty.clear();
    list.forEach(function (el) {
      try { brush(el); } catch (e) { console.warn('brush failed', e); }
    });
    updateExpand();
    updateWordCount();
    refreshTOC();
    hydrateMath();
    hydrateMermaid();
  }, 200);

  // =====================================================================
  // 9. expand：光标进入行内元素时显现其源码标记
  // =====================================================================

  function updateExpand() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    // 先算出该展开谁，再统一收拾别的元素 —— 不能「先全删再加回」。
    // 删了再加会让 .md-meta 在同一帧里 display:none → inline 闪一次，
    // Chrome 的插入符位置缓存会因此失效，方向键会整块跳过标记。
    var target = null;
    var node = sel.getRangeAt(0).startContainer;
    while (node && node !== write) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('md-inline')) {
        target = node;
        break;
      }
      node = node.parentNode;
    }

    var prev = write.querySelectorAll('.md-expand');
    for (var i = 0; i < prev.length; i++) {
      if (prev[i] !== target) prev[i].classList.remove('md-expand');
    }

    if (target && !target.classList.contains('md-expand')) {
      target.classList.add('md-expand');
    }
  }

  // =====================================================================
  // 10. 编辑行为
  // =====================================================================

  // 脚注跳转 / 目录跳转：这些节点是 contenteditable=false，点击不会移动光标，
  // 统一在这里做滚动导航。
  function jumpToLabel(mdtype, label) {
    var all = write.querySelectorAll('[mdtype="' + mdtype + '"]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-label') === label) {
        all[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
  }

  write.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t.nodeType !== 1 && t !== write) t = t.parentNode;
    if (!t || t === write) return;

    var typed = closestTyped(t, ['math_inline', 'math_block', 'mermaid']);
    if (typed) {
      e.preventDefault();
      openMathEditor(typed);
      return;
    }

    if (t.classList && t.classList.contains('md-fn-ref')) {
      e.preventDefault();
      jumpToLabel('def_footnote', t.getAttribute('data-label'));
      return;
    }
    if (t.classList && (t.classList.contains('md-fn-mark') || t.classList.contains('md-fn-back'))) {
      e.preventDefault();
      jumpToLabel('footnote_ref', t.getAttribute('data-label'));
      return;
    }
    if (t.tagName === 'A' && t.parentNode && t.parentNode.classList.contains('md-toc-item')) {
      e.preventDefault();
      var idx = parseInt(t.parentNode.getAttribute('data-head'), 10);
      var heads = write.querySelectorAll('h1,h2,h3,h4,h5,h6');
      if (heads[idx]) heads[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  write.addEventListener('input', function () {
    markDirtyFromCaret();
    setEdited(true);
  });

  write.addEventListener('compositionstart', function () { composing = true; });
  write.addEventListener('compositionend', function () {
    composing = false;
    markDirtyFromCaret();
  });

  write.addEventListener('keyup', updateExpand);
  write.addEventListener('mouseup', updateExpand);

  document.addEventListener('selectionchange', function () {
    if (document.activeElement === write) updateExpand();
  });

  // 粘贴：图片走原生存盘，其余只取纯文本（避免带入外部 HTML）
  write.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];

    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (file) insertImageFile(file);
        return;
      }
    }

    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  /** 把剪贴板里的图片交给原生落盘，再插入相对路径 */
  function insertImageFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(',')[1] || '';
      var ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');

      bridge.callHandler('images.savePNG', { base64: b64, ext: ext }, function (rel) {
        if (!rel) {
          bridge.callHandler('app.log', 'image save failed (document has no path?)');
          return;
        }
        document.execCommand('insertText', false, '![](' + rel + ')');
        markDirtyFromCaret();
        setEdited(true);
      });
    };
    reader.readAsDataURL(file);
  }

  // 回车：按当前块类型拆分
  function reindexCells(table) {
    var trs = table.querySelectorAll('tr');
    for (var r = 0; r < trs.length; r++) {
      for (var c = 0; c < trs[r].children.length; c++) {
        trs[r].children[c].setAttribute('data-cell', r + ',' + c);
      }
    }
  }

  function addTableRow(table) {
    var tbody = table.querySelector('tbody');
    if (!tbody) return;
    var cols = table.querySelectorAll('thead th').length || 1;

    var tr = document.createElement('tr');
    for (var i = 0; i < cols; i++) {
      var td = document.createElement('td');
      td.setAttribute('mdtype', 'table_cell');
      td.style.textAlign = 'left';
      td.innerHTML = '<br class="md-pad">';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    reindexCells(table);

    var first = tr.children[0];
    if (first) setCaretBySourceOffset(first, 0);
    markDirty(table);
  }

  function moveCell(cell, dir) {
    var table = cell.closest('table');
    if (!table) return;
    var cells = Array.prototype.slice.call(table.querySelectorAll('td,th'));
    var next = cells.indexOf(cell) + dir;

    if (next >= cells.length) { addTableRow(table); return; }
    if (next < 0) return;

    var target = cells[next];
    setCaretBySourceOffset(target, inlineRaw(target).length);
  }

  // ------------------------------------------------------------------
  // 自动配对：括号与引号（代码块内与 IME 组合态不启用）
  // ------------------------------------------------------------------

  var PAIR_OPEN = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  var PAIR_CLOSE = { ')': true, ']': true, '}': true, '"': true, "'": true };

  function pairableKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.isComposing || composing) return false;
    if (!PAIR_OPEN[e.key] && !PAIR_CLOSE[e.key]) return false;
    var leaf = leafBlock();
    if (leaf && leaf.getAttribute('mdtype') === 'fences') return false;
    return true;
  }

  /** 光标右侧第一个字符 */
  function charAfterCaret() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var off = range.startOffset;
    if (node.nodeType === 3) return node.nodeValue.charAt(off) || null;
    var sib = node.childNodes[off];
    if (sib && sib.nodeType === 3) return sib.nodeValue.charAt(0) || null;
    return null;
  }

  /** 光标左侧第一个字符（空串表示行首/原子元素） */
  function charBeforeCaret() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return '';
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var off = range.startOffset;
    if (node.nodeType === 3) return off > 0 ? node.nodeValue.charAt(off - 1) : '';
    var sib = node.childNodes[off - 1];
    if (!sib) return '';
    if (sib.nodeType === 3) return sib.nodeValue.slice(-1);
    if (sib.tagName === 'BR') return '\n';
    return '';
  }

  /** 输入闭合符且右边是同一个字符：光标跳过去，不重复插入 */
  function skipOverClose(ch) {
    if (charAfterCaret() !== ch) return false;
    var sel = window.getSelection();
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var off = range.startOffset;
    var target = null, targetOff = 0;

    if (node.nodeType === 3) {
      target = node; targetOff = off + 1;
    } else {
      var sib = node.childNodes[off];
      if (sib && sib.nodeType === 3) { target = sib; targetOff = 1; }
    }
    if (!target) return false;

    var r = document.createRange();
    r.setStart(target, targetOff);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }

  /** 插入配对；有选区时包裹选区并保持选中 */
  function insertPair(open, close) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var text = sel.toString();
    var range = sel.getRangeAt(0);

    var node;
    if (text) {
      range.deleteContents();
      node = document.createTextNode(open + text + close);
    } else {
      node = document.createTextNode(open + close);
    }
    range.insertNode(node);

    var r = document.createRange();
    if (text) {
      r.setStart(node, open.length);
      r.setEnd(node, open.length + text.length);
    } else {
      r.setStart(node, open.length);
      r.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(r);

    markDirtyFromCaret();
    setEdited(true);
  }

  write.addEventListener('keydown', function (e) {
    var sel = window.getSelection();
    var cell = sel && sel.anchorNode ? closestCell(sel.anchorNode) : null;

    // 表格内：Tab 走单元格，Enter 不拆块
    if (cell && e.key === 'Tab') {
      e.preventDefault();
      moveCell(cell, e.shiftKey ? -1 : 1);
      return;
    }
    if (cell && e.key === 'Enter') {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleEnter();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      return;
    }

    // 括号 / 引号自动配对
    if (pairableKey(e)) {
      var handled = false;
      if (PAIR_CLOSE[e.key] && skipOverClose(e.key)) {
        handled = true;
      } else if (PAIR_OPEN[e.key]) {
        // 引号只在行首/空白/开括号后配对，避免 don't 被补成 don't'
        var isQuote = (e.key === '"' || e.key === "'");
        var prev = charBeforeCaret();
        if (!isQuote || prev === '' || /\s/.test(prev) || PAIR_OPEN[prev]) {
          insertPair(e.key, PAIR_OPEN[e.key]);
          handled = true;
        }
      }
      if (handled) {
        e.preventDefault();
        updateExpand();
        return;
      }
      // 不满足配对条件：放行浏览器默认输入
    }

    // Backspace 在空块首：并入上一块
    if (e.key === 'Backspace') {
      handleBackspace(e);
    }
  });

  function handleEnter() {
    var leaf = leafBlock();
    if (!leaf) return;

    var top = topBlockOf(leaf);
    var mt = leaf.getAttribute('mdtype');
    var offset = caretSourceOffset(leaf);

    // 列表项
    if (mt === 'list_item') {
      var text = inlineRaw(leaf);
      if (!text.trim()) { exitList(leaf); return; }

      var before = text.slice(0, offset);
      var after = text.slice(offset);

      leaf.innerHTML = renderInline(parseInline(before));

      var newLi = document.createElement('li');
      newLi.setAttribute('mdtype', 'list_item');
      newLi.setAttribute('data-open', leaf.getAttribute('data-open') || '- ');
      newLi.innerHTML = renderInline(parseInline(after));
      leaf.after(newLi);

      setCaretBySourceOffset(newLi, 0);
      markDirty(top);
      return;
    }

    // 代码块 / 分隔线：不拆分
    if (mt === 'fences' || mt === 'hr') {
      document.execCommand('insertText', false, '\n');
      return;
    }

    var src = leaf === top ? blockRaw(top) : inlineRaw(leaf);
    var cut = offset;
    var head = src.slice(0, cut);
    var tail = src.slice(cut);

    // 标题回车后新行是普通段落
    var headType = mt;
    var tailType = (mt === 'heading' || mt === 'blockquote') ? 'paragraph' : mt;

    var headBlock = parseBlocks(head)[0] || { type: 'paragraph', inline: [] };
    if (headType === 'heading' && headBlock.type !== 'heading') {
      headBlock = { type: 'heading', depth: parseInt(top.dataset.depth || '1', 10), inline: [] };
    }
    if (mt === 'blockquote' && headBlock.type !== 'blockquote') {
      headBlock = { type: 'blockquote', inline: [] };
    }

    var tailBlock = parseBlocks(tail)[0] || { type: 'paragraph', inline: [] };
    if (tailType === 'paragraph' && tailBlock.type !== 'paragraph') {
      tailBlock = { type: 'paragraph', inline: parseInline(tail) };
    }

    headBlock.cid = top.getAttribute('cid');
    tailBlock.cid = 'n' + (++nid);

    var holder = document.createElement('div');
    holder.innerHTML = renderBlock(headBlock) + renderBlock(tailBlock);

    var headEl = holder.children[0];
    var tailEl = holder.children[1];

    top.replaceWith(headEl, tailEl);
    padEmpties();
    setCaretBySourceOffset(tailEl, 0);
    updateWordCount();
  }

  function exitList(li) {
    var list = li.parentElement;
    var p = document.createElement('p');
    p.className = 'md-block';
    p.setAttribute('mdtype', 'paragraph');
    p.setAttribute('cid', 'n' + (++nid));

    if (list.children.length === 1) {
      list.replaceWith(p);
    } else {
      list.after(p);
      li.remove();
    }
    setCaretBySourceOffset(p, 0);
    updateWordCount();
  }

  function handleBackspace(e) {
    var leaf = leafBlock();
    if (!leaf) return;
    var sel = window.getSelection();
    if (!sel.isCollapsed) return;

    // 空列表项：退回段落
    if (leaf.getAttribute('mdtype') === 'list_item' && !inlineRaw(leaf).trim()) {
      e.preventDefault();
      exitList(leaf);
      return;
    }

    // 空标题：退回段落
    if (leaf.getAttribute('mdtype') === 'heading' && !inlineRaw(leaf).trim()) {
      e.preventDefault();
      var p = document.createElement('p');
      p.className = 'md-block';
      p.setAttribute('mdtype', 'paragraph');
      p.setAttribute('cid', leaf.getAttribute('cid'));
      leaf.replaceWith(p);
      setCaretBySourceOffset(p, 0);
    }
  }

  // =====================================================================
  // 11. 行内样式命令（Cmd+B / I / K）
  // =====================================================================

  function wrapSelection(open, close) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var text = sel.toString();
    if (!text) return;

    var range = sel.getRangeAt(0);
    range.deleteContents();

    var node = document.createTextNode(open + text + close);
    range.insertNode(node);

    var r = document.createRange();
    r.setStart(node, node.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    markDirtyFromCaret();
  }

  // =====================================================================
  // 12. 源码模式
  // =====================================================================

  var sourceMode = false;

  function toggleSource() {
    if (!sourceMode) {
      source.value = getMarkdown();
      sourceMode = true;
      write.style.display = 'none';
      source.style.display = 'block';
      modeEl.textContent = 'Source';
      source.focus();
    } else {
      sourceMode = false;
      source.style.display = 'none';
      write.style.display = 'block';
      modeEl.textContent = 'Live';
      loadMarkdown(source.value);
      setEdited(true);
      write.focus();
    }
  }

  source.addEventListener('input', function () { setEdited(true); });
  // 注意：这里不能单独给 source 挂 Cmd+/ ——
  // textarea 是 document 的后代，事件会冒泡上去，document 上的监听会再切一次，
  // 一次按键切两下正反相消，表现为「焦点在源码框里时切不回实时模式」。
  // 统一由文档级监听处理（见文件末尾）。

  // =====================================================================
  // 13. 状态
  // =====================================================================

  var edited = false;

  function setEdited(v) {
    edited = v;
    bridge.callHandler('document.setEdited', v);
  }

  function updateWordCount() {
    var text = getMarkdown();
    var cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    var words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
    var total = cjk + words;
    var chars = text.replace(/\s/g, '').length;
    wordCountEl.textContent = total + ' 字 / ' + chars + ' 字符';
  }

  // =====================================================================
  // 14. 对外接口（原生调用）
  // =====================================================================

  window.__getMarkdown = function () {
    return sourceMode ? source.value : getMarkdown();
  };

  // 供 features/ 下的功能模块使用（表格、查找、大纲、专注模式等）
  window.MF = {
    write: write,
    source: source,
    bridge: bridge,
    getMarkdown: getMarkdown,
    loadMarkdown: loadMarkdown,
    parseInline: parseInline,
    renderInline: renderInline,
    blockRaw: blockRaw,
    inlineRaw: inlineRaw,
    markDirty: markDirty,
    markDirtyFromCaret: markDirtyFromCaret,
    caretSourceOffset: caretSourceOffset,
    setCaretBySourceOffset: setCaretBySourceOffset,
    leafBlock: leafBlock,
    topBlockOf: topBlockOf,
    setEdited: setEdited,
    updateWordCount: updateWordCount,
    isSourceMode: function () { return sourceMode; },
    notifyEdited: function () { setEdited(true); },
    onDocLoaded: function (fn) { docLoadedHooks.push(fn); }
  };

  var docLoadedHooks = [];

  window.__loadContent = function (path, text, title) {
    docBaseDir = path ? String(path).replace(/[^/]*$/, '') : '';
    loadMarkdown(text || '');
    document.title = title || 'Untitled';
    setEdited(false);
    if (sourceMode) {
      source.value = getMarkdown();
    }
    write.focus();
  };

  window.__onSaved = function (path) {
    setEdited(false);
  };

  /** 拼写检查开关：WebKit 用系统词典，中文不会被标红，英文错词会有波浪线 */
  function toggleSpell() {
    var on = write.getAttribute('spellcheck') !== 'true';
    write.setAttribute('spellcheck', on ? 'true' : 'false');
    try { localStorage.setItem('mf-spell', on ? '1' : '0'); } catch (e) {}
    return on;
  }

  function initSpell() {
    var pref = null;
    try { pref = localStorage.getItem('mf-spell'); } catch (e) {}
    if (pref === '0') write.setAttribute('spellcheck', 'false');
  }

  window.__cmd = function (name) {
    switch (name) {
      case 'bold': wrapSelection('**', '**'); break;
      case 'italic': wrapSelection('*', '*'); break;
      case 'code': wrapSelection('`', '`'); break;
      case 'toggleSource': toggleSource(); break;
      case 'toggleSpell': toggleSpell(); break;
      case 'zoomIn': setZoom(zoom + 0.1); break;
      case 'zoomOut': setZoom(zoom - 0.1); break;
      case 'zoomReset': setZoom(1); break;
    }
  };

  var zoom = 1;

  function setZoom(v) {
    zoom = Math.max(0.6, Math.min(2, v));
    write.style.fontSize = (16 * zoom) + 'px';
    source.style.fontSize = (14 * zoom) + 'px';
  }

  // =====================================================================
  // 13.5 导出
  // =====================================================================

  /** 导出前：收起 expand 标记、切回渲染视图、回到文档顶部、隐藏界面装饰 */
  window.__prepareExport = function () {
    if (sourceMode) toggleSource();

    document.body.classList.add('mf-export');

    // createPDF 会把插入符一并画进去，导出前先失焦
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

    // createPDF 的 rect 以视口为基准，必须先把滚动位置归零，
    // 否则捕获会从文档中间开始（表现为开头一段丢失 + 顶部空白）。
    var sc = document.getElementById('scroll');
    if (sc) sc.scrollTop = 0;

    var expanded = write.querySelectorAll('.md-expand');
    for (var i = 0; i < expanded.length; i++) expanded[i].classList.remove('md-expand');

    return true;
  };

  window.__finishExport = function () {
    document.body.classList.remove('mf-export');
  };

  // ---------------------------------------------------------------------
  // 分页引擎（PDF 导出）
  //
  // 为什么不用 WebKit 的打印：本机实测两种原生路径都不可用 ——
  //   printOperation(with:) 会产出十万级空白页（WebKit 分页失控），
  //   NSPrintOperation(view:) 因 WebKit 内容在独立进程而输出全空白。
  // 所以按 Typora 的思路自己做版面：先把文档装进 A4 页框里分页，
  // 再逐页 createPDF（每次只截一页，尺寸精确），最后由原生合并。
  //
  // 版面：A4 @96dpi = 794 × 1123 px，四周 60px（≈16mm）页边距，
  // 输出时统一缩放到 595 × 842 pt。
  // ---------------------------------------------------------------------

  var PRINT = { w: 794, h: 1123, pad: 50 };

  // 原生侧会用 web/style.css 的全文替换这个占位符
  var CSS_SLOT = '/*__MF_CSS__*/';
  var KATEX_CSS_SLOT = '/*__MF_KATEX_CSS__*/';

  function printContentSize() {
    return { w: PRINT.w - PRINT.pad * 2, h: PRINT.h - PRINT.pad * 2 };
  }

  function makePageBox() {
    var c = printContentSize();
    var d = document.createElement('div');
    d.className = 'mf-page';
    d.style.width = c.w + 'px';
    d.style.height = c.h + 'px';
    return d;
  }

  /** 元素独立排版时的高度（含上下 margin），用于判断能否拆得更细 */
  function blockHeight(el, width) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;' +
      'width:' + width + 'px;';
    var clone = el.cloneNode(true);
    probe.appendChild(clone);
    document.body.appendChild(probe);
    var cs = window.getComputedStyle(clone);
    var h = clone.getBoundingClientRect().height +
      (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    document.body.removeChild(probe);
    return h;
  }

  /** 当前页是否已经装不下最后一个块 */
  function pageOverflows(page) {
    var last = page.lastElementChild;
    if (!last) return false;
    return last.getBoundingClientRect().bottom >
      page.getBoundingClientRect().bottom + 0.5;
  }

  function emptyShell(el) {
    var sh = el.cloneNode(false);
    while (sh.firstChild) sh.removeChild(sh.firstChild);
    return sh;
  }

  /** 表格：按行拆分；续段不再重复表头（与 Typora 的 PDF 一致） */
  function splitTable(el, content) {
    var out = [];
    var thead = el.querySelector('thead');
    var tb = el.querySelector('tbody');
    var rows = tb
      ? Array.prototype.slice.call(tb.children)
      : Array.prototype.slice.call(el.children).filter(function (r) { return r.tagName === 'TR'; });

    var i = 0;
    while (i < rows.length) {
      var sh = emptyShell(el);
      if (thead && out.length === 0) sh.appendChild(thead.cloneNode(true));
      var body = document.createElement('tbody');
      sh.appendChild(body);

      var guard = 0;
      while (i < rows.length && guard++ < 20000) {
        body.appendChild(rows[i].cloneNode(true));
        if (blockHeight(sh, content.w) > content.h) {
          if (body.children.length === 1) { i++; break; }   // 单行就超高，只能保留
          body.removeChild(body.lastChild);
          break;
        }
        i++;
      }
      out.push(sh);
    }
    return out;
  }

  function preSlice(el, lines, a, b) {
    var sh = emptyShell(el);
    var code = document.createElement('code');
    code.textContent = lines.slice(a, b).join('\n');
    sh.appendChild(code);
    return sh;
  }

  /** 代码块：按行拆分（拆出来的片段丢失高亮，但内容完整） */
  function splitPre(el, content) {
    var codeEl = el.querySelector('code');
    var text = codeEl ? codeEl.textContent : el.textContent;
    var lines = text.split('\n');
    var out = [];
    var start = 0;
    var guard = 0;

    while (start < lines.length && guard++ < 5000) {
      var lo = start + 1, hi = lines.length, best = start + 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (blockHeight(preSlice(el, lines, start, mid), content.w) <= content.h) {
          best = mid; lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      out.push(preSlice(el, lines, start, best));
      start = best;
    }
    return out;
  }

  /** 列表：按 li 拆分，续页保持编号 */
  function splitList(el, content) {
    var out = [];
    var items = Array.prototype.slice.call(el.children);
    var base = parseInt(el.getAttribute('start') || '1', 10) || 1;
    var i = 0;

    while (i < items.length) {
      var sh = emptyShell(el);
      if (el.tagName === 'OL') sh.setAttribute('start', String(base + i));

      while (i < items.length) {
        sh.appendChild(items[i].cloneNode(true));
        if (blockHeight(sh, content.w) > content.h) {
          if (sh.children.length === 1) { i++; break; }
          sh.removeChild(sh.lastChild);
          break;
        }
        i++;
      }
      out.push(sh);
    }
    return out;
  }

  /** 通用容器（引用等）：按子节点拆分 */
  function splitByChildren(el, content) {
    var out = [];
    var kids = Array.prototype.slice.call(el.children);
    var i = 0;

    while (i < kids.length) {
      var sh = emptyShell(el);
      while (i < kids.length) {
        sh.appendChild(kids[i].cloneNode(true));
        if (blockHeight(sh, content.w) > content.h) {
          if (sh.children.length === 1) { i++; break; }
          sh.removeChild(sh.lastChild);
          break;
        }
        i++;
      }
      out.push(sh);
    }
    return out;
  }

  function textSlice(el, t) {
    var sh = emptyShell(el);
    sh.textContent = t;
    return sh;
  }

  /** 段落/标题：按字符二分截断（只作用于超高段落，会丢失行内格式） */
  function splitPlainText(el, content) {
    var text = el.textContent || '';
    if (!text) return [el];

    var out = [];
    var pos = 0;
    var guard = 0;

    while (pos < text.length && guard++ < 500) {
      var lo = pos + 1, hi = text.length, best = pos + 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (blockHeight(textSlice(el, text.slice(pos, mid)), content.w) <= content.h) {
          best = mid; lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      out.push(textSlice(el, text.slice(pos, best)));
      pos = best;
    }
    return out;
  }

  function splitBlock(el, content) {
    var tag = el.tagName;
    if (tag === 'TABLE') return splitTable(el, content);
    if (tag === 'PRE' || el.getAttribute('mdtype') === 'fences') return splitPre(el, content);
    if (tag === 'UL' || tag === 'OL') return splitList(el, content);
    if (tag === 'BLOCKQUOTE') return splitByChildren(el, content);
    return splitPlainText(el, content);
  }

  /**
   * 去掉 head 这一段后剩下的内容，合并成一个块。
   * 用于「用剩余空间拆出第一段」时，避免后续每一段都按剩余高度切得很碎。
   */
  function remainderOf(atom, head) {
    var tag = atom.tagName;

    if (tag === 'TABLE') {
      var rows = atom.querySelector('tbody')
        ? Array.prototype.slice.call(atom.querySelector('tbody').children) : [];
      var hb = head.querySelector('tbody');
      var used = hb ? hb.children.length : 0;
      if (used >= rows.length) return null;

      var sh = emptyShell(atom);
      var body = document.createElement('tbody');
      for (var i = used; i < rows.length; i++) body.appendChild(rows[i].cloneNode(true));
      sh.appendChild(body);
      return sh;
    }

    if (tag === 'PRE') {
      var code = atom.querySelector('code');
      var text = code ? code.textContent : atom.textContent;
      var lines = text.split('\n');
      var hcode = head.querySelector('code');
      var htext = hcode ? hcode.textContent : head.textContent;
      var usedLines = htext ? htext.split('\n').length : 0;
      if (usedLines >= lines.length) return null;
      return preSlice(atom, lines, usedLines, lines.length);
    }

    if (tag === 'UL' || tag === 'OL') {
      var items = Array.prototype.slice.call(atom.children);
      var usedItems = head.children.length;
      if (usedItems >= items.length) return null;
      var sl = emptyShell(atom);
      if (tag === 'OL') {
        var base = parseInt(atom.getAttribute('start') || '1', 10) || 1;
        sl.setAttribute('start', String(base + usedItems));
      }
      for (var j = usedItems; j < items.length; j++) sl.appendChild(items[j].cloneNode(true));
      return sl;
    }

    if (tag === 'BLOCKQUOTE') {
      var kids = Array.prototype.slice.call(atom.children);
      var usedKids = head.children.length;
      if (usedKids >= kids.length) return null;
      var sb = emptyShell(atom);
      for (var k = usedKids; k < kids.length; k++) sb.appendChild(kids[k].cloneNode(true));
      return sb;
    }

    return null;
  }

  /**
   * 把当前文档排成 A4 页，返回每页的 HTML。
   * 页面容器与正文同宽，所以排版规则、字体、间距与编辑器完全一致。
   */
  window.__paginateForPrint = function () {
    if (sourceMode) toggleSource();
    document.body.classList.add('mf-export');

    var expanded = write.querySelectorAll('.md-expand');
    for (var e = 0; e < expanded.length; e++) expanded[e].classList.remove('md-expand');

    var content = printContentSize();

    var old = document.getElementById('mf-stage');
    if (old) old.parentNode.removeChild(old);
    var stage = document.createElement('div');
    stage.id = 'mf-stage';
    stage.style.cssText = 'position:absolute;left:-100000px;top:0;' +
      'width:' + PRINT.w + 'px;height:' + PRINT.h + 'px;visibility:hidden;';
    document.body.appendChild(stage);

    function makePage() {
      var d = document.createElement('div');
      d.className = 'mf-page';
      d.style.width = content.w + 'px';
      d.style.height = content.h + 'px';
      stage.appendChild(d);
      return d;
    }

    function overflows(p) {
      var last = p.lastElementChild;
      return !!last && last.getBoundingClientRect().bottom >
        p.getBoundingClientRect().bottom + 0.5;
    }

    // ---- 第一遍：把高过一页的块拆成若干段 ----
    //
    // 每段留 80px 余量，这样「标题 + 第一段」仍能放进同一页，
    // 不会出现标题孤零零占一页。
    var atoms = [];
    var splits = 0;
    var seq = 0;
    var limit = content.h - 80;

    for (var i = 0; i < write.children.length; i++) {
      // front matter 是元数据，和 Typora 一样不进 PDF/HTML 正文
      if (write.children[i].getAttribute('mdtype') === 'meta') continue;
      var el = write.children[i].cloneNode(true);
      el.classList.remove('mf-focus-current');

      if (blockHeight(el, content.w) > limit) {
        var parts = splitBlock(el, { w: content.w, h: limit });
        var gid = 'g' + (++seq);
        splits++;
        for (var p = 0; p < parts.length; p++) {
          parts[p].setAttribute('data-split-group', gid);
          atoms.push(parts[p]);
        }
      } else {
        atoms.push(el);
      }
    }

    // ---- 第二遍：流式装页 ----
    var pages = [];
    var page = makePage();

    function flush() {
      if (page.children.length) pages.push(page.innerHTML);
    }

    function isHeading(el) {
      return /^H[1-6]$/.test(el.tagName);
    }

    function remainingIn(p) {
      var pr = p.getBoundingClientRect();
      var last = p.lastElementChild;
      return last ? pr.bottom - last.getBoundingClientRect().bottom : pr.height;
    }

    function splittable(el) {
      var t = el.tagName;
      return t === 'TABLE' || t === 'PRE' || t === 'UL' || t === 'OL' || t === 'BLOCKQUOTE';
    }

    for (var a = 0; a < atoms.length; a++) {
      var atom = atoms[a];

      // 规范：单个 atom 不得超过一页（填充分支产生的剩余块可能超）
      if (blockHeight(atom, content.w) > limit) {
        var norm = splitBlock(atom, { w: content.w, h: limit });
        if (norm.length > 1) {
          // 保留原有的分组号：续段必须和它的前一段互斥，
          // 否则会在一页里出现两个同源的代码块/表格
          var ng = atom.getAttribute('data-split-group') || ('g' + (++seq));
          for (var n = 0; n < norm.length; n++) norm[n].setAttribute('data-split-group', ng);
          atoms.splice.apply(atoms, [a, 1].concat(norm));
          atom = atoms[a];
          splits++;
        }
      }

      // 同一块的续段不与前一段同页：否则一个表会被切成两截、
      // 表头重复出现，中间还多出一道空隙
      var gid = atom.getAttribute && atom.getAttribute('data-split-group');
      if (gid && page.querySelector('[data-split-group="' + gid + '"]')) {
        var kept = [];
        while (page.lastElementChild && isHeading(page.lastElementChild)) {
          kept.unshift(page.removeChild(page.lastElementChild));
        }
        flush();
        page = makePage();
        for (var k = 0; k < kept.length; k++) page.appendChild(kept[k]);
      }

      page.appendChild(atom);
      if (!overflows(page)) continue;
      page.removeChild(atom);

      // 兜底：空页也放不下（极端情况），直接留下，避免死循环
      if (page.children.length === 0) {
        page.appendChild(atom);
        continue;
      }

      // 页尾若是标题，它占用下一块的空间，先扣掉
      var tail = page.lastElementChild;
      var headSpace = (tail && isHeading(tail)) ? tail.getBoundingClientRect().height : 0;
      var room = remainingIn(page) - headSpace - 4;

      // 可拆的块且剩余空间够，就地拆一段填满本页
      if (splittable(atom) && room >= 200) {
        var pieces = splitBlock(atom, { w: content.w, h: room });
        if (pieces.length > 1) {
          page.appendChild(pieces[0]);
          if (!overflows(page)) {
            splits++;
            var fg = 'g' + (++seq);
            pieces[0].setAttribute('data-split-group', fg);

            // 只把「剩余部分」作为一个整块插回队列，
            // 不能把按 room 切出来的碎片都插进去（每片都只有半页高）
            var rest = remainderOf(atom, pieces[0]);
            if (rest) {
              rest.setAttribute('data-split-group', fg);
              atoms.splice(a + 1, 0, rest);
            }
            continue;
          }
          page.removeChild(pieces[0]);
        }
      }

      // 页尾的标题跟着走，避免「标题孤行」
      var carried = [];
      while (page.lastElementChild && isHeading(page.lastElementChild)) {
        carried.unshift(page.removeChild(page.lastElementChild));
      }

      flush();
      page = makePage();

      for (var c = 0; c < carried.length; c++) page.appendChild(carried[c]);

      page.appendChild(atom);
      // 标题 + 该段仍超高：宁可让该段溢出一点，也不回退（回退会死循环）
      if (overflows(page) && page.children.length > 1) {
        page.removeChild(atom);
        if (carried.length) {
          // 把标题放回上一页，让这一页从整段开始
          page.appendChild(atom);
        } else {
          page.appendChild(atom);
        }
      }
    }
    flush();

    if (stage.parentNode) stage.parentNode.removeChild(stage);

    return {
      pageW: PRINT.w,
      pageH: PRINT.h,
      pad: PRINT.pad,
      contentW: content.w,
      contentH: content.h,
      count: pages.length,
      splits: splits,
      pages: pages
    };
  };

  /** 供原生导出视图使用的空壳页面（样式由原生注入，见 CSS_SLOT） */
  window.__printShellHTML = function () {
    var extra = [
      'html, body { height: auto !important; overflow: visible !important;',
      '  margin: 0 !important; padding: 0 !important; }',
      'html, html body { background: #fff !important; }',
      'body.mf-print { padding: ' + PRINT.pad + 'px !important; width: ' + PRINT.w + 'px;',
      '  --bg:#fff; --fg:#1a1a1a; --muted:#666; --accent:#1a5fb4;',
      '  --mark:#999; --code-bg:#f5f5f5; --border:#ddd; --quote:#ddd; }',
      '#mf-page-root { width: ' + printContentSize().w + 'px; }',
      '.mf-page { overflow: hidden; }',
      '.mf-page > :first-child { margin-top: 0 !important; }',
      '.md-meta { display: none !important; }',
      '.md-meta-block { display: none !important; }',
      '.md-inline.md-expand { background: none !important; }',
      '.md-fn-back { display: none !important; }',
      '.mf-anchor { display: none !important; }',
      // 打印时不允许横向滚动：代码块必须折行，否则右侧被裁掉
      'pre.md-fences, pre.md-fences code { white-space: pre-wrap !important;',
      '  overflow-wrap: anywhere; word-break: break-word; }',
      'pre.md-fences { overflow-x: hidden !important; }',
      'table { table-layout: auto; }',
      '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }'
    ].join('\n');

    return '<!DOCTYPE html>\n<html data-theme="light">\n<head>\n<meta charset="utf-8">\n' +
      '<style>\n' + CSS_SLOT + '\n</style>\n' +
      '<style>\n' + KATEX_CSS_SLOT + '\n</style>\n' +
      '<style>\n' + extra + '\n</style>\n</head>\n' +
      '<body class="mf-print mf-export">\n<div id="mf-page-root"></div>\n' +
      '<script>\n' +
      'window.__setPrintPage = function (html) {\n' +
      '  var root = document.getElementById("mf-page-root");\n' +
      '  if (root) root.innerHTML = html;\n' +
      '  return root ? root.scrollHeight : 0;\n' +
      '};\n' +
      '</script>\n' +
      '</body>\n</html>\n';
  };

  window.__setPrintPage = function (html) {
    var root = document.getElementById('mf-page-root');
    if (root) root.innerHTML = html;
    return root ? root.scrollHeight : 0;
  };

  /**
   * 生成自包含的 HTML。
   * CSS 由原生注入：WKWebView 里 file:// 的样式表被当作跨域，
   * document.styleSheets[].cssRules 会抛 SecurityError，读不到任何规则。
   */
  window.__buildExportHTML = function () {
    var title = document.title || 'Untitled';

    return '<!DOCTYPE html>\n<html lang="zh-CN" data-theme="light">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + escapeHtml(title) + '</title>\n' +
      '<style>\n' + CSS_SLOT + '\n</style>\n' +
      '<style>\n' + KATEX_CSS_SLOT + '\n</style>\n' +
      '<style>\n' +
      'html, body { height: auto !important; overflow: visible !important; background: #fff !important; }\n' +
      '#scroll { height: auto !important; overflow: visible !important; }\n' +
      '.mf-anchor { display: none !important; }\n' +
      '.md-meta { display: none !important; }\n' +
      '.md-meta-block { display: none !important; }\n' +
      '.md-fn-back { display: none !important; }\n' +
      '</style>\n' +
      '</head>\n' +
      '<body class="mf-export-standalone">\n' +
      '<main id="scroll"><article id="write">' + write.innerHTML + '</article></main>\n' +
      '</body>\n</html>\n';
  };

  // Cmd+/ 在 live 模式下也要生效
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      e.preventDefault();
      toggleSource();
    }
  });

  // =====================================================================
  // 15. 启动
  // =====================================================================

  var DEMO = [
    '# MarkFrame',
    '',
    '一个按 **Typora 架构** 复刻的最小可用 Markdown 编辑器。它跑在 `原生 Cocoa 外壳 + WKWebView` 里，不是 Electron。',
    '',
    '## 它复刻了什么',
    '',
    '- **无损 DOM**：每个行内元素都记得自己的源码标记，所以能从渲染结果反推出 Markdown',
    '- **200ms 画笔**：只重绘脏块，块内 HTML 相同就完全不碰 DOM',
    '- **expand 行为**：把光标移进 **粗体**、*斜体* 或 `行内代码`，标记会自动显现',
    '- 源码模式：按 `Cmd + /` 在这两种表示之间来回切换',
    '',
    '> 试试把光标点进上面任意一个加粗词，你会看到 `**` 浮出来。这就是同一份 DOM 承担两种呈现。',
    '',
    '```js',
    'const pipeline = markdown => parse(markdown).map(render).join("");',
    '```',
    '',
    '---',
    '',
    '## 现在可以做什么',
    '',
    '1. 直接打字，支持标题、列表、引用、代码块、分隔线',
    '2. `Cmd + B` / `Cmd + I` / `Cmd + K` 包裹选区',
    '3. `Cmd + S` 保存，`Cmd + O` 打开 `.md` 文件',
    '4. `Cmd + /` 切换源码模式',
    '',
    '也可以手打 Markdown 语法，输入完它会自己变成渲染结果。'
  ].join('\n');

  loadMarkdown(DEMO);
  initSpell();
  write.focus();

  // 把未捕获异常回传原生，避免 Web 层错误静默
  window.addEventListener('error', function (e) {
    bridge.callHandler('app.log', 'JS error: ' + (e.message || '') + ' @' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    bridge.callHandler('app.log', 'JS rejection: ' + String(e.reason));
  });

  // 通知原生：前端就绪
  bridge.callHandler('app.ready', { version: '0.9' });
})();
