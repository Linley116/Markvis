/* 文件树面板（F9，对齐 Typora）：
 *
 * 位置：左侧统一侧栏的「文件」tab（外壳归 sidebar.js）。
 * 行为对齐 Typora 的 Files Sidebar：
 *   1. 打开文档时，根目录自动切换到该文档的父文件夹
 *      （Typora: "when you open a file its parent folder will be automatically loaded"）
 *   2. 当前打开的文件在树里高亮，并自动展开祖先目录滚动到可见
 *   3. 只显示 Typora 支持的类型（md / markdown / txt 等），目录永远显示
 *   4. 原生监听根目录变化，外部增删改自动刷新（Typora watches the folder）
 *   5. 侧栏底部是当前文件夹操作条：打开文件夹… / 刷新
 *
 * 所有文件操作都走 library.* 桥，路径由原生校验（必须落在根目录内），
 * 这里不再做第二套路径规则。
 */

(function () {
  'use strict';

  var bridge = window.bridge;

  var STORE_EXPANDED = 'mf.library.expanded';

  var state = {
    root: '',
    current: '',     // 当前打开的文档路径（高亮用）
    open: false,
    cache: {},       // 目录路径 -> [entry]
    loading: {},     // 目录路径 -> 是否正在加载
    expanded: {}     // 目录路径 -> 是否展开
  };

  var pane = null, listEl = null, titleEl = null, rootBarEl = null;
  var refreshTimer = null;
  var revealTimer = null;

  // 面板按钮用线条图标，别用 emoji（会变成彩色苹果表情，和整体不搭）
  var ICON = {
    file: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9 1.5H4v13h8V5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.5V5h4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 4.2h4l1.2 1.5h7.8v7.6h-13z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    home: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.8 1.8 7.2V14h12.4V7.2z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M11.4 1.6v3h-3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function readStore(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeStore(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  // ---------- 数据 ----------

  function baseName(p) {
    var parts = String(p || '').split('/');
    return parts[parts.length - 1] || p || '/';
  }

  function parentDir(p) {
    var s = String(p || '');
    var i = s.lastIndexOf('/');
    if (i <= 0) return i === 0 ? '/' : '';
    return s.slice(0, i);
  }

  function loadDir(path, cb) {
    if (state.cache[path]) { if (cb) cb(state.cache[path]); return; }
    if (state.loading[path]) { if (cb) cb([]); return; }
    state.loading[path] = true;

    bridge.callHandler('library.list', { path: path }, function (list) {
      state.loading[path] = false;
      var items = Array.isArray(list) ? list : [];
      // 根目录用绝对路径做 key，子目录同样
      state.cache[path] = items;
      if (cb) cb(items);
      render();
    });
  }

  function refresh(cb) {
    state.cache = {};
    loadDir(state.root, cb);
  }

  /** 原生监听通知：外部（访达/其他应用）改了文件，防抖后刷新 */
  function changed() {
    clearTimeout(refreshTimer);
    var attempt = function () {
      // 行内新建/重命名输入中不刷新，免得把输入框冲掉；稍后重试
      if (listEl && listEl.querySelector('.mf-lib-editing')) {
        refreshTimer = setTimeout(attempt, 400);
        return;
      }
      refresh();
    };
    refreshTimer = setTimeout(attempt, 350);
  }

  // ---------- 渲染 ----------

  function rowHTML(entry, depth) {
    var isDir = !!entry.dir;
    var expanded = !!state.expanded[entry.path];
    var pad = 8 + depth * 14;

    var icon = isDir
      ? '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 3.5h4l1.2 1.5h7.8v8h-13z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
      : '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

    var twisty = isDir
      ? '<span class="mf-lib-twisty' + (expanded ? ' mf-open' : '') + '">›</span>'
      : '<span class="mf-lib-twisty mf-leaf"></span>';

    var mark = (!isDir && entry.ext === 'md') ? ' class="mf-lib-name mf-md"' : ' class="mf-lib-name"';
    var cur = (!isDir && entry.path === state.current) ? ' mf-lib-current' : '';

    return '<div class="mf-lib-row' + (isDir ? ' mf-dir' : '') + cur + '" data-path="' + esc(entry.path) + '"' +
      ' data-dir="' + (isDir ? '1' : '0') + '" style="padding-left:' + pad + 'px">' +
      twisty + '<span class="mf-lib-icon">' + icon + '</span>' +
      '<span' + mark + '>' + esc(entry.name) + '</span></div>';
  }

  function treeHTML(dirPath, depth) {
    var items = state.cache[dirPath] || [];
    var out = '';
    for (var i = 0; i < items.length; i++) {
      out += rowHTML(items[i], depth);
      if (items[i].dir && state.expanded[items[i].path]) {
        out += treeHTML(items[i].path, depth + 1);
      }
    }
    return out;
  }

  function render() {
    if (!listEl) return;
    var items = state.cache[state.root];
    if (!items) {
      listEl.innerHTML = '<div class="mf-lib-empty">正在读取…</div>';
      return;
    }
    if (!items.length) {
      listEl.innerHTML = '<div class="mf-lib-empty">空目录</div>';
      return;
    }
    listEl.innerHTML = treeHTML(state.root, 0);
    markCurrent();
  }

  /** 当前文件高亮 + 滚动到可见 */
  function markCurrent() {
    if (!listEl || !state.current) return;
    var rows = listEl.querySelectorAll('.mf-lib-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-path') !== state.current) continue;
      rows[i].classList.add('mf-lib-current');
      if (typeof rows[i].scrollIntoView === 'function') {
        rows[i].scrollIntoView({ block: 'nearest' });
      }
      return;
    }
  }

  /** 展开当前文件的全部祖先目录，加载缺的目录，然后渲染并高亮 */
  function revealFile(path) {
    state.current = path || '';
    if (!state.current || !state.root) { render(); return; }
    if (state.current.indexOf(state.root + '/') !== 0) { render(); return; }

    var parts = state.current.split('/');
    var prefix = state.root + '/';
    var dirs = [];
    for (var i = 1; i < parts.length - 1; i++) {
      var d = parts.slice(0, i + 1).join('/');
      // 只要根目录内部的那几层；根目录上层（乃至磁盘根）不碰
      if (d === state.root || d.indexOf(prefix) !== 0) continue;
      dirs.push(d);
    }
    for (var j = 0; j < dirs.length; j++) state.expanded[dirs[j]] = true;
    writeStore(STORE_EXPANDED, state.expanded);

    var missing = dirs.filter(function (d) { return !state.cache[d]; });
    if (!missing.length) { render(); return; }
    var left = missing.length;
    missing.forEach(function (d) {
      loadDir(d, function () {
        left--;
        if (left === 0) render();
      });
    });
  }

  function renderTitle() {
    if (titleEl) {
      titleEl.textContent = baseName(state.root);
      titleEl.setAttribute('title', state.root);
    }
    if (rootBarEl) {
      var name = rootBarEl.querySelector('.mf-lib-root-name');
      if (name) {
        name.textContent = baseName(state.root);
        name.setAttribute('title', state.root);
      }
    }
  }

  // ---------- 交互 ----------

  function toggleDir(path) {
    if (state.expanded[path]) {
      delete state.expanded[path];
      writeStore(STORE_EXPANDED, state.expanded);
      render();
      return;
    }
    state.expanded[path] = true;
    writeStore(STORE_EXPANDED, state.expanded);
    if (!state.cache[path]) loadDir(path);
    else render();
  }

  function openFile(path) {
    bridge.callHandler('document.openPath', { path: path }, function () {});
  }

  /** 行内输入框：新建 / 重命名共用 */
  function beginInlineEdit(rowEl, entry, mode) {
    var old = listEl.querySelector('.mf-lib-editing');
    if (old) old.remove();

    var input = document.createElement('input');
    input.className = 'mf-lib-input';
    input.value = mode === 'rename' ? entry.name : (mode === 'dir' ? '' : '');
    input.placeholder = mode === 'dir' ? '文件夹名' : '文件名（.md）';

    var host = document.createElement('div');
    host.className = 'mf-lib-edit mf-lib-editing';
    host.style.paddingLeft = (rowEl ? rowEl.style.paddingLeft : '8px');
    host.appendChild(input);

    if (rowEl) rowEl.replaceWith(host);
    else listEl.insertBefore(host, listEl.firstChild);

    input.focus();
    if (mode === 'rename') {
      var dot = entry.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }

    var done = false;
    function commit() {
      if (done) return;
      done = true;
      var val = input.value.trim();
      if (!val) { host.remove(); render(); return; }
      if (mode === 'rename') {
        bridge.callHandler('library.rename', { path: entry.path, name: val }, function (res) {
          if (res && res.error) { window.alert(res.error); }
          refresh();
        });
      } else {
        // 目录：传给右键菜单的那个目录；根目录操作：根
        var dir = entry ? entry.path : state.root;
        bridge.callHandler('library.create', { path: dir, name: val, kind: mode }, function (res) {
          if (res && res.error) { window.alert(res.error); return; }
          if (mode === 'dir' && entry) { state.expanded[entry.path] = true; writeStore(STORE_EXPANDED, state.expanded); }
          if (res && res.path && mode !== 'dir') openFile(res.path);
          refresh();
        });
      }
    }
    function cancel() {
      if (done) return;
      done = true;
      host.remove();
      render();
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
  }

  function ensureExpanded(path) {
    state.expanded[path] = true;
    writeStore(STORE_EXPANDED, state.expanded);
  }

  // ---------- 右键菜单 ----------

  var menuEl = null;

  function closeMenu() { if (menuEl) menuEl.remove(); menuEl = null; }

  function openMenu(x, y, entry) {
    closeMenu();
    var isDir = entry && !!entry.dir;
    var items = [];

    if (!entry) {
      items.push({ label: '新建文件', act: function () { beginInlineEdit(null, null, 'file'); } });
      items.push({ label: '新建文件夹', act: function () { beginInlineEdit(null, null, 'dir'); } });
      items.push({ sep: true });
      items.push({ label: '打开文件夹…', act: function () { bridge.callHandler('library.chooseRoot', null, function () {}); } });
      items.push({ label: '刷新', act: function () { refresh(); } });
    } else {
      if (!isDir) {
        items.push({ label: '打开', act: function () { openFile(entry.path); } });
        items.push({ sep: true });
      }
      items.push({ label: '新建文件', act: function () { ensureExpanded(isDir ? entry.path : parentDir(entry.path)); beginInlineEdit(null, isDir ? entry : null, 'file'); } });
      items.push({ label: '新建文件夹', act: function () { ensureExpanded(isDir ? entry.path : parentDir(entry.path)); beginInlineEdit(null, isDir ? entry : null, 'dir'); } });
      items.push({ sep: true });
      items.push({ label: '复制路径', act: function () { bridge.callHandler('library.copyPath', { path: entry.path }, function () {}); } });
      items.push({ label: '重命名', act: function () {
        var row = listEl.querySelector('[data-path="' + cssEscape(entry.path) + '"]');
        beginInlineEdit(row, entry, 'rename');
      } });
      items.push({ label: '删除', act: function () { deleteEntry(entry); } });
      items.push({ sep: true });
      items.push({ label: '在访达中显示', act: function () { bridge.callHandler('library.reveal', { path: entry.path }, function () {}); } });
    }

    menuEl = document.createElement('div');
    menuEl.className = 'mf-lib-menu';
    var html = '';
    for (var i = 0; i < items.length; i++) {
      if (items[i].sep) { html += '<div class="mf-lib-menu-sep"></div>'; continue; }
      html += '<button class="mf-lib-menu-item" data-i="' + i + '">' + esc(items[i].label) + '</button>';
    }
    menuEl.innerHTML = html;
    document.body.appendChild(menuEl);

    var w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x)) + 'px';
    menuEl.style.top = Math.max(6, Math.min(window.innerHeight - h - 36, y)) + 'px';

    menuEl.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.mf-lib-menu-item') : null;
      if (!btn) return;
      var it = items[parseInt(btn.getAttribute('data-i'), 10)];
      closeMenu();
      if (it && it.act) it.act();
    });
  }

  function cssEscape(s) {
    return String(s).replace(/"/g, '\\"');
  }

  function deleteEntry(entry) {
    var msg = entry.dir
      ? '删除文件夹「' + entry.name + '」及其全部内容？'
      : '删除「' + entry.name + '」？';
    if (!window.confirm(msg + '\n（会放进废纸篓）')) return;
    bridge.callHandler('library.delete', { path: entry.path }, function (res) {
      if (res && res.error) { window.alert(res.error); return; }
      refresh();
    });
  }

  // ---------- 构建 ----------

  function build() {
    pane = document.getElementById('mf-pane-files');
    if (!pane) return;

    pane.innerHTML =
      '<div class="mf-lib-head">' +
        '<span class="mf-lib-title" title="">—</span>' +
        '<span class="mf-lib-acts">' +
          '<button class="mf-lib-act" data-act="newfile" title="新建文件">' + ICON.file + '</button>' +
          '<button class="mf-lib-act" data-act="newdir" title="新建文件夹">' + ICON.folder + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="mf-lib-list"></div>' +
      // Typora 把当前文件夹的操作放在侧栏底部
      '<div class="mf-lib-rootbar">' +
        '<span class="mf-lib-root-name" title="">—</span>' +
        '<button class="mf-lib-act" data-act="root" title="打开文件夹…">' + ICON.home + '</button>' +
        '<button class="mf-lib-act" data-act="refresh" title="刷新">' + ICON.refresh + '</button>' +
      '</div>';

    listEl = pane.querySelector('.mf-lib-list');
    titleEl = pane.querySelector('.mf-lib-title');
    rootBarEl = pane.querySelector('.mf-lib-rootbar');

    pane.querySelector('.mf-lib-acts').addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'newfile') beginInlineEdit(null, null, 'file');
      else if (a === 'newdir') beginInlineEdit(null, null, 'dir');
    });

    rootBarEl.addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'root') bridge.callHandler('library.chooseRoot', null, function () {});
      else if (a === 'refresh') refresh();
    });

    // 行点击：目录展开/收起，文件打开
    listEl.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.mf-lib-row') : null;
      if (!row) return;
      var path = row.getAttribute('data-path');
      var isDir = row.getAttribute('data-dir') === '1';
      if (isDir) toggleDir(path);
      else openFile(path);
    });

    // 右键菜单
    listEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var row = e.target.closest ? e.target.closest('.mf-lib-row') : null;
      var entry = null;
      if (row) {
        var path = row.getAttribute('data-path');
        var items = state.cache[state.root] || [];
        // 在缓存里找（含子目录）
        var find = function (arr) {
          for (var i = 0; i < arr.length; i++) {
            if (arr[i].path === path) return arr[i];
            if (arr[i].dir && state.cache[arr[i].path]) {
              var hit = find(state.cache[arr[i].path]);
              if (hit) return hit;
            }
          }
          return null;
        };
        entry = find(items) || { path: path, name: baseName(path), dir: row.getAttribute('data-dir') === '1', ext: '' };
      }
      openMenu(e.clientX, e.clientY, entry);
    });

    // 空白处右键：根目录操作
    pane.addEventListener('contextmenu', function (e) {
      if (e.target.closest('.mf-lib-row')) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, null);
    });

    document.addEventListener('mousedown', function (e) {
      if (!menuEl) return;
      if (menuEl.contains(e.target)) return;
      closeMenu();
    });
  }

  // ---------- 根目录 ----------

  function setRootFrom(res) {
    state.root = (res && res.root) || '';
    state.cache = {};
    renderTitle();
    refresh();
  }

  function rootChanged() {
    bridge.callHandler('library.root', null, function (res) { setRootFrom(res); });
  }

  /**
   * 根目录跟随当前文档（Typora 行为）：打开一个文件，它的父文件夹
   * 就是树的根。用户手动「打开文件夹…」也会改根，之后打开别的目录的
   * 文件时再跟过去 —— 和 Typora 一样，以最近一次动作为准。
   */
  function followDocument(path) {
    var p = path || window.__currentFilePath || '';
    if (!p) return;
    var dir = parentDir(p);
    if (!dir || dir === state.root) { revealFile(p); return; }
    bridge.callHandler('library.setRoot', { path: dir }, function (res) {
      state.root = (res && res.root) || dir;
      state.cache = {};
      renderTitle();
      refresh(function () { revealFile(p); });
    });
  }

  // ---------- 启动 ----------

  build();
  state.expanded = readStore(STORE_EXPANDED, {}) || {};

  bridge.callHandler('library.root', null, function (res) {
    setRootFrom(res);
  });

  // 文档加载完：根目录跟过去 + 高亮当前文件
  if (window.MF && window.MF.onDocLoaded) {
    window.MF.onDocLoaded(function (path) {
      followDocument(path);
    });
  }

  // 切到文件 tab 时按需刷新 + 揭示当前文件
  if (window.MFSidebar) {
    window.MFSidebar.onTabChange(function (t) {
      if (t !== 'files') return;
      if (!state.cache[state.root]) refresh(function () { revealFile(state.current); });
      else revealFile(state.current);
    });
  }

  window.MFLibrary = {
    toggle: function () { window.MFSidebar && window.MFSidebar.show('files'); },
    open: function () { window.MFSidebar && window.MFSidebar.show('files'); },
    refresh: refresh,
    changed: changed,
    rootChanged: rootChanged,
    followDocument: followDocument,
    revealFile: revealFile
  };
})();
