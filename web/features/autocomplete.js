/*
 * F14：emoji 与围栏语言名补全
 *
 * - 实时模式输入 `:smi` → emoji 候选，Enter/Tab 选中，↑↓ 切换
 * - 源码模式在围栏首行输入 ```pyt → 语言名候选
 * - 候选层独立于引擎，插入走 MF.programEdit，保留撤销
 */
(function () {
  'use strict';

  var EMOJI = [
    ['smile', '😄', 'happy 开心 笑'], ['grin', '😁', '开心'], ['joy', '😂', '笑哭'],
    ['rofl', '🤣', '大笑'], ['slightly_smiling_face', '🙂', '微笑'], ['wink', '😉', '眨眼'],
    ['heart_eyes', '😍', '喜欢 爱'], ['kissing_heart', '😘', '亲'], ['thinking', '🤔', '思考'],
    ['neutral_face', '😐', '无语'], ['expressionless', '😑', '无语'], ['unamused', '😒', '不爽'],
    ['sweat_smile', '😅', '汗'], ['sweat', '😓', '汗'], ['cry', '😢', '哭'],
    ['sob', '😭', '大哭'], ['angry', '😠', '生气'], ['rage', '😡', '愤怒'],
    ['scream', '😱', '惊'], ['flushed', '😳', '脸红'], ['sleeping', '😴', '睡'],
    ['yum', '😋', '好吃'], ['sunglasses', '😎', '酷'], ['nerd_face', '🤓', '书呆子'],
    ['party_popper', '🎉', '庆祝 派对'], ['tada', '🎉', '庆祝'], ['clap', '👏', '鼓掌'],
    ['thumbsup', '👍', '+1 赞 好'], ['thumbsdown', '👎', '-1 差'], ['ok_hand', '👌', 'ok'],
    ['pray', '🙏', '感谢 祈祷'], ['muscle', '💪', '加油 强'], ['wave', '👋', '挥手 你好'],
    ['point_right', '👉', '右'], ['point_left', '👈', '左'], ['point_up', '☝️', '上'],
    ['eyes', '👀', '看'], ['brain', '🧠', '大脑 思考'], ['fire', '🔥', '火 热'],
    ['sparkles', '✨', '闪 新'], ['star', '⭐', '星'], ['star2', '🌟', '星'],
    ['boom', '💥', '爆炸'], ['zap', '⚡', '闪电'], ['rocket', '🚀', '火箭 发布'],
    ['tada_party', '🥳', '庆祝'], ['gift', '🎁', '礼物'], ['trophy', '🏆', '奖杯'],
    ['warning', '⚠️', '警告'], ['x', '❌', '错 叉'], ['white_check_mark', '✅', '对 完成'],
    ['heavy_check_mark', '✔️', '对'], ['question', '❓', '问'], ['exclamation', '❗', '感叹'],
    ['bulb', '💡', '灯泡 点子'], ['memo', '📝', '笔记'], ['book', '📖', '书'],
    ['books', '📚', '书'], ['computer', '💻', '电脑'], ['keyboard', '⌨️', '键盘'],
    ['bug', '🐛', 'bug'], ['wrench', '🔧', '修'], ['hammer', '🔨', '锤'],
    ['gear', '⚙️', '设置'], ['link', '🔗', '链接'], ['lock', '🔒', '锁'],
    ['unlock', '🔓', '解锁'], ['key', '🔑', '钥匙'], ['calendar', '📅', '日历'],
    ['clock', '🕒', '时间'], ['hourglass', '⌛', '等待'], ['package', '📦', '包'],
    ['chart_increasing', '📈', '上升 增长'], ['chart_decreasing', '📉', '下降'],
    ['money', '💰', '钱'], ['coffee', '☕', '咖啡'], ['beer', '🍺', '啤酒'],
    ['pizza', '🍕', '披萨'], ['apple', '🍎', '苹果'], ['cat', '🐱', '猫'],
    ['dog', '🐶', '狗'], ['seedling', '🌱', '新芽'], ['sunny', '☀️', '晴'],
    ['cloud', '☁️', '云'], ['umbrella', '☔', '雨'], ['snowflake', '❄️', '雪'],
    ['heart', '❤️', '心 爱'], ['broken_heart', '💔', '心碎'], ['100', '💯', '满分']
  ];

  var LANGS = [
    'plaintext', 'bash', 'shell', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile',
    'dart', 'elixir', 'erlang', 'go', 'graphql', 'groovy', 'haskell', 'ini', 'java',
    'javascript', 'json', 'kotlin', 'less', 'lua', 'makefile', 'markdown', 'matlab',
    'nginx', 'objectivec', 'perl', 'php', 'powershell', 'protobuf', 'python', 'r',
    'ruby', 'rust', 'scala', 'scss', 'sql', 'swift', 'toml', 'typescript', 'xml',
    'yaml', 'wasm'
  ];

  var LANG_ALIASES = {
    py: 'python', js: 'javascript', ts: 'typescript', sh: 'bash', zsh: 'bash',
    yml: 'yaml', md: 'markdown', objc: 'objectivec', 'c++': 'cpp', cs: 'csharp',
    rb: 'ruby', rs: 'rust', kt: 'kotlin', ps1: 'powershell', docker: 'dockerfile'
  };

  var write = document.getElementById('write');
  var source = document.getElementById('source');
  var pop = null;
  var entries = [];
  var active = 0;
  var current = null;
  var suppressNext = false;

  function isOpen() { return !!pop; }

  function close() {
    if (pop) pop.remove();
    pop = null;
    entries = [];
    current = null;
    active = 0;
  }

  function freshPop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'mf-autocomplete';
    pop.setAttribute('role', 'listbox');
    document.body.appendChild(pop);
    pop.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var item = e.target.closest ? e.target.closest('.mf-ac-item') : null;
      if (!item) return;
      var idx = parseInt(item.getAttribute('data-i'), 10);
      if (entries[idx]) pick(entries[idx]);
    });
    return pop;
  }

  function render() {
    if (!current || !entries.length) { close(); return; }
    var el = freshPop();
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      html += '<div class="mf-ac-item' + (i === active ? ' mf-active' : '') +
        '" data-i="' + i + '" role="option">' +
        (e.emoji ? '<span class="mf-ac-emoji">' + e.emoji + '</span>' : '') +
        '<span class="mf-ac-label">' + e.label + '</span>' +
        (e.detail ? '<span class="mf-ac-detail">' + e.detail + '</span>' : '') +
        '</div>';
    }
    el.innerHTML = html;
    position(el);
  }

  function position(el) {
    var rect = current && current.kind === 'language'
      ? sourceCaretRect()
      : liveCaretRect();
    if (!rect) { close(); return; }
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left));
    var top = rect.bottom + 5;
    if (top + h > window.innerHeight - 34) top = Math.max(8, rect.top - h - 5);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function liveCaretRect() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      var node = range.startContainer;
      if (node && node.parentElement) return node.parentElement.getBoundingClientRect();
    }
    return rect;
  }

  /** textarea 里没有 Range，用一个同步样式的镜像 div 找光标位置 */
  function sourceCaretRect() {
    var s = source;
    var mirror = document.getElementById('mf-ac-mirror');
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'mf-ac-mirror';
      document.body.appendChild(mirror);
    }
    var cs = getComputedStyle(s);
    var r = s.getBoundingClientRect();
    mirror.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;' +
      'word-wrap:break-word;box-sizing:border-box;overflow:hidden;' +
      'font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize + ';font-weight:' + cs.fontWeight +
      ';line-height:' + cs.lineHeight + ';letter-spacing:' + cs.letterSpacing +
      ';padding:' + cs.padding + ';border:' + cs.borderWidth + ' solid transparent;' +
      'width:' + s.clientWidth + 'px;left:' + r.left + 'px;top:' + (r.top - s.scrollTop) + 'px;';
    mirror.textContent = s.value.slice(0, s.selectionStart || 0);
    var marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    var box = marker.getBoundingClientRect();
    var lineH = parseFloat(cs.lineHeight) || 21;
    if (!box.width && !box.height) box = { left: r.left, top: r.top, bottom: r.top + lineH };
    return box;
  }

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9_+#.-]/g, '');
  }

  function liveContext() {
    if (window.MF && window.MF.isSourceMode && window.MF.isSourceMode()) return null;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    if (node.parentElement && node.parentElement.closest('pre, code, .md-math, .md-mermaid')) return null;

    var before = node.nodeValue.slice(0, range.startOffset);
    // 冒号前不能是 ASCII 单词/数字（避开 10:30、http://），但允许中文后直接输入
    var m = /(^|[^A-Za-z0-9_:\/\\]):([a-zA-Z0-9_+\-]{1,30})$/.exec(before);
    if (!m) return null;
    var query = m[2].toLowerCase();
    var start = range.startOffset - query.length - 1;
    return { kind: 'emoji', query: query, start: start, end: range.startOffset, node: node };
  }

  function sourceContext() {
    if (!window.MF || !window.MF.isSourceMode || !window.MF.isSourceMode()) return null;
    var pos = source.selectionStart || 0;
    if (pos !== (source.selectionEnd || 0)) return null;
    var before = source.value.slice(0, pos);
    var m = /(?:^|\n)[ \t]*(`{3,}|~{3,})([A-Za-z0-9_+#.-]{1,30})$/.exec(before);
    if (!m) return null;
    var query = m[2].toLowerCase();
    return { kind: 'language', query: query, start: pos - query.length, end: pos };
  }

  function matchEmoji(q) {
    var out = [];
    for (var i = 0; i < EMOJI.length && out.length < 8; i++) {
      var row = EMOJI[i];
      var hay = (row[0] + ' ' + row[2]).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
      out.push({
        kind: 'emoji',
        value: row[1],
        label: ':' + row[0] + ':',
        emoji: row[1],
        detail: row[2].split(' ')[0] || ''
      });
    }
    return out;
  }

  function matchLanguage(q) {
    var out = [], seen = {};
    var alias = Object.keys(LANG_ALIASES);
    for (var i = 0; i < alias.length && out.length < 8; i++) {
      if (alias[i].indexOf(q) !== 0 || seen[LANG_ALIASES[alias[i]]]) continue;
      seen[LANG_ALIASES[alias[i]]] = true;
      out.push({ kind: 'language', value: LANG_ALIASES[alias[i]], label: LANG_ALIASES[alias[i]] });
    }
    for (var j = 0; j < LANGS.length && out.length < 8; j++) {
      if (LANGS[j].indexOf(q) === 0 && !seen[LANGS[j]]) {
        seen[LANGS[j]] = true;
        out.push({ kind: 'language', value: LANGS[j], label: LANGS[j] });
      }
    }
    return out;
  }

  function update() {
    if (suppressNext) { suppressNext = false; return; }
    var ctx = sourceContext() || liveContext();
    if (!ctx) { close(); return; }
    var list = ctx.kind === 'language' ? matchLanguage(ctx.query) : matchEmoji(ctx.query);
    if (!list.length) { close(); return; }
    current = ctx;
    entries = list;
    active = 0;
    render();
  }

  function pick(entry) {
    var ctx = current;
    close();
    if (!ctx || !entry) return;
    // 插入本身会触发一次 input；跳过那一次，别立刻用补完后的文字重开候选
    suppressNext = true;
    setTimeout(function () { suppressNext = false; }, 80);

    if (ctx.kind === 'language') {
      window.MF.programEdit(function () {
        source.setRangeText(entry.value, ctx.start, ctx.end, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        window.MF.updateWordCount();
      });
      source.focus();
      return;
    }

    window.MF.programEdit(function () {
      var sel = window.getSelection();
      var range = document.createRange();
      range.setStart(ctx.node, ctx.start);
      range.setEnd(ctx.node, ctx.end);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, entry.value);
      window.MF.markDirtyFromCaret();
      window.MF.setEdited(true);
    });
    write.focus();
  }

  function schedule() {
    setTimeout(update, 0);
  }

  function onKeydown(e) {
    if (!isOpen() || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      active = (active + (e.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length;
      render();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      pick(entries[active]);
    }
  }

  write.addEventListener('keydown', onKeydown, true);
  source.addEventListener('keydown', onKeydown, true);
  write.addEventListener('input', schedule);
  source.addEventListener('input', schedule);
  write.addEventListener('mouseup', schedule);
  source.addEventListener('click', schedule);
  source.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') schedule();
  });

  document.addEventListener('pointerdown', function (e) {
    if (!isOpen()) return;
    if (pop && pop.contains(e.target)) return;
    close();
  }, true);

  document.getElementById('scroll').addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  window.MF_Autocomplete = { close: close };
})();
