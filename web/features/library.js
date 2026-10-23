/* 文件树侧栏（F9）：右侧面板，目录懒加载，行内新建 / 重命名 / 删除（进废纸篓）
 *
 * 所有文件操作都走 library.* 桥，路径由原生校验（必须落在根目录内），
 * 这里不再做第二套路径规则。
 */

(function () {
  'use strict';

  var bridge = window.bridge;
  var scroll = document.getElementById('scroll');

  var STORE_OPEN = 'mf.library.open';
  var STORE_EXPANDED = 'mf.library.expanded';

  var state = {
    root: '',
    open: false,
    cache: {},        // 目录路径 -> [entry]
    loading: {},      // 目录路径 -> 是否正在加载
    expanded: {}      // 目录路径 -> 是否展开
  };

  var panel = null, listEl = null, titleEl = null;

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

    return '<div class="mf-lib-row' + (isDir ? ' mf-dir' : '') + '" data-path="' + esc(entry.path) + '"' +
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
  }

  function renderTitle() {
    if (titleEl) titleEl.textContent = baseName(state.root);
    titleEl && titleEl.setAttribute('title', state.root);
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
    host.className = 'mf-lib-edit';
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
      items.push({ label: '选择根目录…', act: function () { bridge.callHandler('library.chooseRoot', null, function () {}); } });
    } else if (isDir) {
      items.push({ label: '新建文件', act: function () { ensureExpanded(entry.path); beginInlineEdit(null, entry, 'file'); } });
      items.push({ label: '新建文件夹', act: function () { ensureExpanded(entry.path); beginInlineEdit(null, entry, 'dir'); } });
      items.push({ sep: true });
      items.push({ label: '重命名', act: function () {
        var row = listEl.querySelector('[data-path="' + cssEscape(entry.path) + '"]');
        beginInlineEdit(row, entry, 'rename');
      } });
      items.push({ label: '删除', act: function () { deleteEntry(entry); } });
      items.push({ sep: true });
      items.push({ label: '在访达中显示', act: function () { bridge.callHandler('library.reveal', { path: entry.path }, function () {}); } });
    } else {
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

  // ---------- 开关 ----------

  function setOpen(open) {
    state.open = open;
    document.body.classList.toggle('mf-lib-open', open);
    writeStore(STORE_OPEN, open ? '1' : '0');

    var btn = document.getElementById('mf-library-btn');
    if (btn) {
      btn.classList.toggle('mf-on', open);
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    }
    if (open && !state.cache[state.root]) refresh();
  }

  function toggle() { setOpen(!state.open); }

  // ---------- 启动 ----------

  function build() {
    panel = document.createElement('aside');
    panel.id = 'mf-library';
    panel.innerHTML =
      '<div class="mf-lib-head">' +
        '<span class="mf-lib-title" title="">—</span>' +
        '<span class="mf-lib-acts">' +
          '<button class="mf-lib-act" data-act="newfile" title="新建文件">' + ICON.file + '</button>' +
          '<button class="mf-lib-act" data-act="newdir" title="新建文件夹">' + ICON.folder + '</button>' +
          '<button class="mf-lib-act" data-act="root" title="选择根目录">' + ICON.home + '</button>' +
          '<button class="mf-lib-act" data-act="refresh" title="刷新">' + ICON.refresh + '</button>' +
          '<button class="mf-lib-act" data-act="close" title="收起">«</button>' +
        '</span>' +
      '</div>' +
      '<div class="mf-lib-list"></div>' +
      '<div class="mf-lib-resizer" title="拖动调整宽度，双击复位"></div>';

    document.body.appendChild(panel);
    listEl = panel.querySelector('.mf-lib-list');
    titleEl = panel.querySelector('.mf-lib-title');

    panel.querySelector('.mf-lib-acts').addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'close') setOpen(false);
      else if (a === 'refresh') refresh();
      else if (a === 'newfile') beginInlineEdit(null, null, 'file');
      else if (a === 'newdir') beginInlineEdit(null, null, 'dir');
      else if (a === 'root') bridge.callHandler('library.chooseRoot', null, function () {});
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
    panel.addEventListener('contextmenu', function (e) {
      if (e.target.closest('.mf-lib-row')) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, null);
    });

    wireResizer();
  }

  function wireResizer() {
    var resizer = panel.querySelector('.mf-lib-resizer');
    var dragging = false;

    resizer.addEventListener('pointerdown', function (e) {
      dragging = true;
      resizer.classList.add('mf-dragging');
      document.body.classList.add('mf-lib-resizing');
      if (resizer.setPointerCapture) { try { resizer.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });

    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var w = Math.max(180, Math.min(460, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--mf-lib-w', Math.round(w) + 'px');
    });

    window.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('mf-dragging');
      document.body.classList.remove('mf-lib-resizing');
      var w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mf-lib-w'), 10);
      if (!isNaN(w)) writeStore('mf.library.width', w);
    });

    resizer.addEventListener('dblclick', function () {
      document.documentElement.style.setProperty('--mf-lib-w', '240px');
      writeStore('mf.library.width', 240);
    });
  }

  build();
  state.expanded = readStore(STORE_EXPANDED, {}) || {};

  // 宽度
  var savedW = readStore('mf.library.width', 0);
  document.documentElement.style.setProperty('--mf-lib-w', (savedW || 240) + 'px');

  // 根目录
  bridge.callHandler('library.root', null, function (res) {
    state.root = (res && res.root) || '';
    renderTitle();
    if (state.open) refresh();
  });

  setOpen(readStore(STORE_OPEN, '0') === '1');

  var btn = document.getElementById('mf-library-btn');
  if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });

  document.addEventListener('mousedown', function (e) {
    if (!menuEl) return;
    if (menuEl.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      toggle();
    }
  });

  window.MFLibrary = {
    toggle: toggle,
    refresh: refresh,
    rootChanged: function () {
      bridge.callHandler('library.root', null, function (res) {
        state.root = (res && res.root) || '';
        state.cache = {};
        renderTitle();
        refresh();
      });
    },
    open: function () { setOpen(true); }
  };
})();
