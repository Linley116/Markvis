/* 大纲面板：标题树 + 点击跳转 + 当前节高亮
 *
 * 面板外壳（侧栏、tab、宽度、开关）归 sidebar.js，这里只负责
 * 往 #mf-pane-outline 里渲染列表；切到本 tab 时重建一次。
 */

(function () {
  'use strict';

  var MF = window.MF;
  var write = MF.write;
  var scroll = document.getElementById('scroll');

  var listEl = null;
  var timer = null;
  var built = false;
  var collapsed = Object.create(null);   // cid -> true
  var rows = [];                         // { idx, level, key, parent, children, el, item, twist }

  function pane() { return document.getElementById('mf-pane-outline'); }

  function build() {
    if (!listEl) {
      var host = pane();
      if (!host) return;
      listEl = document.createElement('nav');
      listEl.id = 'mf-outline-list';
      host.appendChild(listEl);
    }
    built = true;
    buildList();
  }

  function buildList() {
    if (!listEl) return;

    var heads = write.querySelectorAll('h1,h2,h3,h4,h5,h6');
    if (!heads.length) {
      rows = [];
      listEl.innerHTML = '<div class="mf-outline-empty">还没有标题</div>';
      return;
    }

    // 先按标题层级建父子关系；后代由「下一个同级或更高级标题」界定
    rows = [];
    var stack = [];
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var level = parseInt(h.tagName.charAt(1), 10);
      var text = plainText(h).trim() || '(空标题)';
      var cid = h.getAttribute('cid') || '';
      var key = cid || ('h:' + level + ':' + text + ':' + i);

      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      var parent = stack.length ? stack[stack.length - 1] : null;
      var row = {
        idx: i,
        level: level,
        text: text,
        key: key,
        parent: parent,
        children: [],
        el: null,
        item: null,
        twist: null
      };
      if (parent) parent.children.push(row);
      rows.push(row);
      stack.push(row);
    }

    var liveKeys = Object.create(null);
    var html = '';
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      liveKeys[r.key] = true;
      var pad = 2 + (r.level - 1) * 14;
      html += '<div class="mf-outline-row" data-idx="' + r.idx + '" data-level="' + r.level + '"' +
        ' style="padding-left:' + pad + 'px">';
      if (r.children.length) {
        html += '<button class="mf-outline-twist" type="button" data-idx="' + r.idx + '"' +
          ' aria-expanded="' + (collapsed[r.key] ? 'false' : 'true') + '"' +
          ' aria-label="折叠或展开" title="折叠 / 展开">' + CHEVRON + '</button>';
      } else {
        html += '<span class="mf-outline-twist mf-outline-spacer" aria-hidden="true"></span>';
      }
      html += '<a class="mf-outline-item" data-idx="' + r.idx + '" data-level="' + r.level + '"' +
        ' tabindex="0" title="' + esc(r.text) + '">' + esc(r.text) + '</a></div>';
    }
    listEl.innerHTML = html;

    // 清理已经不存在标题的折叠状态
    Object.keys(collapsed).forEach(function (key) {
      if (!liveKeys[key]) delete collapsed[key];
    });

    var els = listEl.querySelectorAll('.mf-outline-row');
    for (var m = 0; m < rows.length; m++) {
      rows[m].el = els[m];
      rows[m].item = els[m].querySelector('.mf-outline-item');
      rows[m].twist = els[m].querySelector('.mf-outline-twist');
      rows[m].el.classList.toggle('mf-collapsed', !!collapsed[rows[m].key]);
    }
    applyVisibility();
    markActive();
  }

  var CHEVRON = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
    '<path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function isHidden(row) {
    var p = row.parent;
    while (p) {
      if (collapsed[p.key]) return true;
      p = p.parent;
    }
    return false;
  }

  function applyVisibility() {
    for (var i = 0; i < rows.length; i++) {
      rows[i].el.classList.toggle('mf-hidden', isHidden(rows[i]));
    }
  }

  function toggleRow(idx) {
    var row = rows[idx];
    if (!row || !row.children.length) return;
    if (collapsed[row.key]) delete collapsed[row.key];
    else collapsed[row.key] = true;
    row.el.classList.toggle('mf-collapsed', !!collapsed[row.key]);
    if (row.twist && row.twist.tagName === 'BUTTON') {
      row.twist.setAttribute('aria-expanded', collapsed[row.key] ? 'false' : 'true');
    }
    applyVisibility();
    markActive();
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 标题文本要剔除 .md-meta（标记是隐藏的真实节点，不该出现在大纲里） */
  function plainText(el) {
    var clone = el.cloneNode(true);
    var metas = clone.querySelectorAll('.md-meta');
    for (var i = 0; i < metas.length; i++) {
      if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
    }
    return clone.textContent;
  }

  function jump(idx) {
    var heads = write.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var h = heads[idx];
    if (!h) return;

    var base = scroll.getBoundingClientRect();
    var rect = h.getBoundingClientRect();
    scroll.scrollTop += rect.top - base.top - 24;

    // 光标放到标题末尾，方便接着编辑
    h.focus();
    MF.setCaretBySourceOffset(h, MF.inlineRaw(h).length);
  }

  function markActive() {
    var heads = write.querySelectorAll('h1,h2,h3,h4,h5,h6');
    var base = scroll.getBoundingClientRect().top + 32;
    var idx = -1;

    for (var i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= base) idx = i;
      else break;
    }
    if (idx < 0 && heads.length) idx = 0;

    // 当前节可能被折叠在祖先里：高亮最近的可见祖先
    var active = idx >= 0 ? rows[idx] : null;
    while (active && isHidden(active)) active = active.parent;

    for (var j = 0; j < rows.length; j++) {
      rows[j].item.classList.toggle('mf-active', rows[j] === active);
    }
    if (active && active.item && typeof active.item.scrollIntoView === 'function') {
      var box = listEl.getBoundingClientRect();
      var it = active.item.getBoundingClientRect();
      if (it.top < box.top || it.bottom > box.bottom) {
        active.item.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function scheduleBuild() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      // 只在侧栏开着且大纲 tab 激活时才重建，省掉无谓的 DOM 操作
      if (window.MFSidebar && window.MFSidebar.isOpen() &&
          window.MFSidebar.activeTab() === 'outline') {
        buildList();
      }
    }, 260);
  }

  // -------- 启动 --------

  build();

  // 切到大纲 tab 时重建（文档可能在我们看不见的时候换过了）
  if (window.MFSidebar) {
    window.MFSidebar.onTabChange(function (t) {
      if (t === 'outline') buildList();
    });
  }

  scroll.addEventListener('scroll', function () {
    if (window.MFSidebar && window.MFSidebar.isOpen() &&
        window.MFSidebar.activeTab() === 'outline') {
      markActive();
    }
  }, { passive: true });

  listEl.addEventListener('click', function (e) {
    var twist = e.target.closest ? e.target.closest('.mf-outline-twist') : null;
    if (twist && twist.tagName === 'BUTTON') {
      e.preventDefault();
      toggleRow(parseInt(twist.getAttribute('data-idx'), 10));
      return;
    }
    var item = e.target.closest ? e.target.closest('.mf-outline-item') : null;
    if (!item) return;
    jump(parseInt(item.getAttribute('data-idx'), 10));
  });

  listEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var item = e.target.closest ? e.target.closest('.mf-outline-item') : null;
    if (!item) return;
    e.preventDefault();
    jump(parseInt(item.getAttribute('data-idx'), 10));
  });

  // DOM 结构或文本变化后重建（画笔重渲染也会触发，靠防抖合并）
  var mo = new MutationObserver(scheduleBuild);
  mo.observe(write, { childList: true, characterData: true, subtree: true });

  MF.onDocLoaded(function () { if (built) buildList(); });

  window.MFOutline = { toggle: function () { window.MFSidebar && window.MFSidebar.toggle(); }, refresh: buildList };
})();
