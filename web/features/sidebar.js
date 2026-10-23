/* 左侧统一侧栏（对齐 Typora）：
 *
 * Typora 只有一个侧栏，顶部用图标 tab 在「大纲 / 文件」之间切换，
 * 开关在左上角常驻。MarkFrame 原来把文件树放在右侧，和 Typora 不一致，
 * 现在合并成一个左侧边栏：
 *
 *   ┌──────────────┐
 *   │ [大纲] [文件] │  ← tab 栏（图标，激活的高亮）
 *   │              │
 *   │   当前面板    │  ← #mf-pane-outline / #mf-pane-files
 *   │              │
 *   └──────────────┘
 *
 * 宽度统一走 --mf-sidebar-w（180–480，记忆），正文左边距跟着让位。
 * 快捷键：Cmd+Shift+O 开关侧栏，Cmd+Shift+E 直接开到文件 tab。
 */

(function () {
  'use strict';

  var MIN_W = 180, MAX_W = 480, DEFAULT_W = 240;
  var STORE_OPEN = 'mf.sidebar.open';
  var STORE_TAB = 'mf.sidebar.tab';
  var STORE_WIDTH = 'mf.sidebar.width';

  var aside = null, fab = null;
  var open = false;
  var tab = 'outline';
  var tabListeners = [];

  var ICON_OUTLINE =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<line x1="5" y1="3.5" x2="14" y2="3.5" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="5" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="5" y1="12.5" x2="14" y2="12.5" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="2.2" cy="3.5" r="1.1" fill="currentColor"/>' +
    '<circle cx="2.2" cy="8" r="1.1" fill="currentColor"/>' +
    '<circle cx="2.2" cy="12.5" r="1.1" fill="currentColor"/></svg>';
  var ICON_FILES =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M1.5 4.2h4l1.2 1.5h7.8v7.6h-13z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch (e) { return fallback; }
  }

  function writeStore(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  // ---------- 宽度 ----------

  function applyWidth(w) {
    var width = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
    document.documentElement.style.setProperty('--mf-sidebar-w', width + 'px');
    return width;
  }

  function loadWidth() {
    var w = parseInt(readStore(STORE_WIDTH, ''), 10);
    applyWidth(isNaN(w) ? DEFAULT_W : w);
  }

  function wireResizer() {
    var resizer = aside.querySelector('.mf-sidebar-resizer');
    var dragging = false;

    resizer.addEventListener('pointerdown', function (e) {
      dragging = true;
      resizer.classList.add('mf-dragging');
      document.body.classList.add('mf-sidebar-resizing');
      if (resizer.setPointerCapture) { try { resizer.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });

    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      applyWidth(e.clientX);
    });

    window.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('mf-dragging');
      document.body.classList.remove('mf-sidebar-resizing');
      var w = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--mf-sidebar-w'), 10);
      if (!isNaN(w)) writeStore(STORE_WIDTH, String(w));
    });

    resizer.addEventListener('dblclick', function () {
      writeStore(STORE_WIDTH, String(applyWidth(DEFAULT_W)));
    });
  }

  // ---------- tab ----------

  function renderTabs() {
    var tabs = aside.querySelectorAll('.mf-side-tab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var on = t.getAttribute('data-tab') === tab;
      t.classList.toggle('mf-on', on);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var panes = aside.querySelectorAll('.mf-side-pane');
    for (var j = 0; j < panes.length; j++) {
      panes[j].hidden = panes[j].getAttribute('data-pane') !== tab;
    }
  }

  function setTab(next, quiet) {
    if (next === tab) { if (open) return; }
    tab = next === 'files' ? 'files' : 'outline';
    writeStore(STORE_TAB, tab);
    renderTabs();
    if (!quiet) {
      for (var i = 0; i < tabListeners.length; i++) {
        try { tabListeners[i](tab); } catch (e) {}
      }
    }
  }

  // ---------- 开合 ----------

  function syncButton() {
    if (!fab) return;
    fab.setAttribute('aria-pressed', open ? 'true' : 'false');
    fab.setAttribute('aria-label', open ? '隐藏侧栏' : '显示侧栏');
    fab.title = open ? '隐藏侧栏 (Cmd+Shift+O)' : '显示侧栏 (Cmd+Shift+O)';
  }

  function setOpen(next) {
    open = !!next;
    document.body.classList.toggle('mf-sidebar-open', open);
    writeStore(STORE_OPEN, open ? '1' : '0');
    syncButton();
  }

  function toggle() { setOpen(!open); }

  /** 打开侧栏并切到某个 tab；已打开时只切 tab */
  function show(nextTab) {
    if (nextTab) setTab(nextTab);
    setOpen(true);
  }

  // ---------- 启动 ----------

  function build() {
    aside = document.createElement('aside');
    aside.id = 'mf-sidebar';
    aside.innerHTML =
      '<div class="mf-side-tabs">' +
        '<button class="mf-side-tab" type="button" data-tab="outline"' +
        ' title="大纲 (Cmd+Shift+O)" aria-label="大纲">' + ICON_OUTLINE + '</button>' +
        '<button class="mf-side-tab" type="button" data-tab="files"' +
        ' title="文件 (Cmd+Shift+E)" aria-label="文件">' + ICON_FILES + '</button>' +
      '</div>' +
      '<div class="mf-side-body">' +
        '<div class="mf-side-pane" id="mf-pane-outline" data-pane="outline"></div>' +
        '<div class="mf-side-pane" id="mf-pane-files" data-pane="files" hidden></div>' +
      '</div>' +
      '<div class="mf-sidebar-resizer" title="拖动调整宽度，双击复位"></div>';

    document.body.appendChild(aside);

    aside.querySelector('.mf-side-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.mf-side-tab') : null;
      if (!btn) return;
      setTab(btn.getAttribute('data-tab'));
      setOpen(true);
    });

    wireResizer();
  }

  build();
  loadWidth();

  fab = document.getElementById('mf-outline-btn');
  if (fab) fab.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

  tab = readStore(STORE_TAB, 'outline') === 'files' ? 'files' : 'outline';
  renderTabs();

  var savedOpen = readStore(STORE_OPEN, '1');
  setOpen(savedOpen !== '0');

  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      toggle();
    } else if (e.shiftKey && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      show('files');
    }
  });

  window.MFSidebar = {
    toggle: toggle,
    show: show,
    isOpen: function () { return open; },
    activeTab: function () { return tab; },
    onTabChange: function (fn) { tabListeners.push(fn); }
  };
})();
