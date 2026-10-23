/* 大纲侧栏：标题树 + 点击跳转 + 当前节高亮 */

(function () {
  'use strict';

  var MF = window.MF;
  var write = MF.write;
  var scroll = document.getElementById('scroll');

  var aside, listEl, toggleBtn;
  var timer = null;
  var activeId = null;

  function build() {
    aside = document.createElement('aside');
    aside.id = 'mf-outline';
    aside.innerHTML =
      '<div class="mf-outline-head">' +
        '<span class="mf-outline-title">大纲</span>' +
        '<button id="mf-outline-close" title="隐藏大纲 (Cmd+Shift+O)">«</button>' +
      '</div>' +
      '<nav id="mf-outline-list"></nav>';

    document.body.appendChild(aside);
    listEl = aside.querySelector('#mf-outline-list');

    aside.querySelector('#mf-outline-close').addEventListener('click', function () {
      setOpen(false);
    });
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
    timer = setTimeout(buildList, 260);
  }

  function setOpen(open) {
    document.body.classList.toggle('mf-outline-open', open);
    try { localStorage.setItem('mf.outline', open ? '1' : '0'); } catch (e) {}
    if (open) buildList();
  }

  function toggle() {
    setOpen(!document.body.classList.contains('mf-outline-open'));
  }

  // -------- 启动 --------

  build();

  var saved = null;
  try { saved = localStorage.getItem('mf.outline'); } catch (e) {}
  setOpen(saved === null ? true : saved === '1');

  scroll.addEventListener('scroll', function () {
    if (document.body.classList.contains('mf-outline-open')) markActive();
  }, { passive: true });

  listEl.addEventListener('click', function (e) {
    var item = e.target.closest('.mf-outline-item');
    if (!item) return;
    jump(parseInt(item.getAttribute('data-idx'), 10));
  });

  // DOM 结构或文本变化后重建（画笔重渲染也会触发，靠防抖合并）
  var mo = new MutationObserver(scheduleBuild);
  mo.observe(write, { childList: true, characterData: true, subtree: true });

  MF.onDocLoaded(function () { buildList(); });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      toggle();
    }
  });

  window.MFOutline = { toggle: toggle, refresh: buildList };
})();
