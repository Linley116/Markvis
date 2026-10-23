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
      listEl.innerHTML = '<div class="mf-outline-empty">还没有标题</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var level = parseInt(h.tagName.charAt(1), 10);
      var text = plainText(h).trim() || '(空标题)';
      html += '<a class="mf-outline-item" data-idx="' + i + '" data-level="' + level + '"' +
        ' style="padding-left:' + (10 + (level - 1) * 14) + 'px"' +
        ' title="' + esc(text) + '">' + esc(text) + '</a>';
    }
    listEl.innerHTML = html;
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

    var items = listEl ? listEl.querySelectorAll('.mf-outline-item') : [];
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('mf-active', j === idx);
    }
    if (idx >= 0 && items[idx] && typeof items[idx].scrollIntoView === 'function') {
      var box = listEl.getBoundingClientRect();
      var it = items[idx].getBoundingClientRect();
      if (it.top < box.top || it.bottom > box.bottom) {
        items[idx].scrollIntoView({ block: 'nearest' });
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
    var item = e.target.closest ? e.target.closest('.mf-outline-item') : null;
    if (!item) return;
    jump(parseInt(item.getAttribute('data-idx'), 10));
  });

  // DOM 结构或文本变化后重建（画笔重渲染也会触发，靠防抖合并）
  var mo = new MutationObserver(scheduleBuild);
  mo.observe(write, { childList: true, characterData: true, subtree: true });

  MF.onDocLoaded(function () { if (built) buildList(); });

  window.MFOutline = { toggle: function () { window.MFSidebar && window.MFSidebar.toggle(); }, refresh: buildList };
})();
