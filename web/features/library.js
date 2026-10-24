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
    cache: {},       // 目录路径 -> [entry]
    loading: {},     // 目录路径 -> 是否正在加载
    expanded: {},    // 目录路径 -> 是否展开
    batch: 0,        // 批量刷新中：>0 时先不渲染，等这一批全回来再一次性渲染
    sort: 'name',    // name | mtime（Typora 的排序方式）
    groupDirs: true, // 文件夹优先
    drag: ''         // 正在拖动的文件路径
  };

  var STORE_SORT = 'mf.library.sort';

  var pane = null, listEl = null, titleEl = null, rootBarEl = null, upBtn = null;
  var refreshTimer = null;
  var revealTimer = null;

  // 面板按钮用线条图标，别用 emoji（会变成彩色苹果表情，和整体不搭）
  var ICON = {
    file: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9 1.5H4v13h8V5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.5V5h4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 4.2h4l1.2 1.5h7.8v7.6h-13z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    home: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.8 1.8 7.2V14h12.4V7.2z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    sort: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.2h10M3 8h7M3 11.8h4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 5.2V8l2.3 1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    up: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 13V3.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.2 7.2 8 3.4l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
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

  /** force=true 时忽略已有缓存重新向原生要一份（刷新用） */
  function loadDir(path, cb, force) {
    if (!force && state.cache[path]) { if (cb) cb(state.cache[path]); return; }
    if (state.loading[path]) { if (cb) cb([]); return; }
    state.loading[path] = true;

    // 排序 / 文件夹优先交给原生做，Web 层只负责记住选择
    bridge.callHandler('library.list', {
      path: path,
      root: state.root,
      sort: state.sort,
      groupDirs: state.groupDirs
    }, function (list) {
      state.loading[path] = false;
      var items = Array.isArray(list) ? list : [];
      // 根目录用绝对路径做 key，子目录同样
      state.cache[path] = items;
      if (cb) cb(items);
      if (!state.batch) render();
    });
  }

  /**
   * 刷新整棵树。
   *
   * 关键：不能只清空 cache 再拉根目录 —— 那样已展开的层级会因为拿不到
   * 子目录内容而「塌回去」（箭头还开着，里面的文件全没了）。所以这里
   * 把「根 + 所有已加载且展开的目录」一起重拉：刷新期间继续用旧缓存渲
   * 染（不闪、不塌），全部回来后再一次性重绘。
   */
  function refresh(cb) {
    if (!state.root) { render(); if (cb) cb(); return; }
    var paths = [state.root];
    for (var p in state.cache) {
      if (p !== state.root && state.expanded[p]) paths.push(p);
    }

    var left = paths.length;
    var finished = false;
    state.batch++;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      state.batch--;
      render();
      if (cb) cb();
    }
    function done() {
      if (--left > 0) return;
      finish();
    }
    // 兜底：原生万一不回调，别让 batch 一直挂着把后面的渲染全吞掉
    var guard = setTimeout(finish, 4000);

    for (var i = 0; i < paths.length; i++) loadDir(paths[i], done, true);
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

  /**
   * 目录是否「真的」展开：既记着展开，又拿到了内容。
   * 只认 expanded 会让箭头开着、里面却是空的（缓存缺失时），
   * 用户再点一下反而变成收起 —— 状态要和实际渲染一致。
   */
  function isOpen(path) {
    return !!state.expanded[path] && !!state.cache[path];
  }

  function rowHTML(entry, depth) {
    var isDir = !!entry.dir;
    var expanded = isDir && isOpen(entry.path);
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
      ' data-dir="' + (isDir ? '1' : '0') + '" draggable="true"' +
      ' style="padding-left:' + pad + 'px">' +
      twisty + '<span class="mf-lib-icon">' + icon + '</span>' +
      '<span' + mark + '>' + esc(entry.name) + '</span></div>';
  }

  function treeHTML(dirPath, depth) {
    var items = state.cache[dirPath] || [];
    var out = '';
    for (var i = 0; i < items.length; i++) {
      out += rowHTML(items[i], depth);
      if (items[i].dir && isOpen(items[i].path)) {
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
    var keepScroll = listEl.scrollTop;
    listEl.innerHTML = treeHTML(state.root, 0);
    listEl.scrollTop = keepScroll;   // 重绘不把用户看的位置顶掉
    markCurrent();
  }

  /** 当前文件高亮（不动滚动位置） */
  function markCurrent() {
    if (!listEl || !state.current) return;
    var rows = listEl.querySelectorAll('.mf-lib-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-path') !== state.current) continue;
      rows[i].classList.add('mf-lib-current');
      return;
    }
  }

  /**
   * 把当前文件滚到可见。只在「打开/揭示某个文件」时调用 —— 外部变化
   * 刷新树时不能滚，否则用户正在看的位置会被拽走，看起来像树自己动了。
   */
  function scrollCurrentIntoView() {
    if (!listEl || !state.current) return;
    var rows = listEl.querySelectorAll('.mf-lib-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-path') !== state.current) continue;
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
    if (!missing.length) { render(); scrollCurrentIntoView(); return; }
    var left = missing.length;
    missing.forEach(function (d) {
      loadDir(d, function () {
        left--;
        if (left === 0) { render(); scrollCurrentIntoView(); }
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
    if (upBtn) {
      // 已经是磁盘根（或被清空）时不能继续往上
      var up = parentDir(state.root);
      var atTop = !state.root || !up || up === state.root;
      upBtn.disabled = atTop;
      upBtn.title = atTop ? '已经是顶层目录' : '上级目录：' + up;
    }
  }

  // ---------- 交互 ----------

  function toggleDir(path) {
    // 只有「真的展开了」才收起。记着展开但内容没拿到时这一下应当展开，
    // 否则用户会看到点了没反应（其实是先把它从 expanded 里删掉了）
    if (isOpen(path)) {
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

  /** items 直接给定时按它渲染（排序菜单用），否则按 entry 生成常规菜单 */
  function openMenu(x, y, entry, override) {
    closeMenu();
    var isDir = entry && !!entry.dir;
    var items = [];

    if (override) {
      items = override;
    } else     if (!entry) {
      items.push({ label: '新建文件', act: function () { beginInlineEdit(null, null, 'file'); } });
      items.push({ label: '新建文件夹', act: function () { beginInlineEdit(null, null, 'dir'); } });
      items.push({ sep: true });
      items.push({ label: '打开文件夹…', act: function () { bridge.callHandler('library.chooseRoot', null, function () {}); } });
      items.push({ label: '刷新', act: function () { refresh(); } });
      items.push({ sep: true });
      items.push({ label: '撤销上一次文件操作', act: function () { window.MFLibrary.undoFileOp(); } });
    } else {
      if (!isDir) {
        items.push({ label: '打开', act: function () { openFile(entry.path); } });
        items.push({ label: '在新窗口打开', act: function () {
          bridge.callHandler('library.openInNewWindow', { path: entry.path }, function () {});
        } });
        items.push({ sep: true });
      } else {
        items.push({ label: '打开文件夹', act: function () {
          bridge.callHandler('library.setRoot', { path: entry.path }, function (r) { setRootFrom(r); });
        } });
      }
      items.push({ label: '新建文件', act: function () { ensureExpanded(isDir ? entry.path : parentDir(entry.path)); beginInlineEdit(null, isDir ? entry : null, 'file'); } });
      items.push({ label: '新建文件夹', act: function () { ensureExpanded(isDir ? entry.path : parentDir(entry.path)); beginInlineEdit(null, isDir ? entry : null, 'dir'); } });
      items.push({ sep: true });
      items.push({ label: '复制路径', act: function () { bridge.callHandler('library.copyPath', { path: entry.path }, function () {}); } });
      items.push({ label: '复制', act: function () {   // Typora 的 Duplicate
        bridge.callHandler('library.duplicate', { path: entry.path }, function (res) {
          if (res && res.error) { window.alert(res.error); return; }
          refresh();
        });
      } });
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

  // ---------- 排序 / 最近文件夹（Typora 侧栏底部菜单） ----------

  function setSort(key, groupDirs) {
    if (key) state.sort = key === 'mtime' ? 'mtime' : 'name';
    if (typeof groupDirs === 'boolean') state.groupDirs = !!groupDirs;
    writeStore(STORE_SORT, { sort: state.sort, groupDirs: state.groupDirs });
    refresh();
  }

  function openSortMenu(x, y) {
    closeMenu();
    var items = [
      { label: '按名称' + (state.sort === 'name' ? ' ✓' : ''), act: function () { setSort('name'); } },
      { label: '按修改时间' + (state.sort === 'mtime' ? ' ✓' : ''), act: function () { setSort('mtime'); } },
      { sep: true },
      { label: '文件夹优先' + (state.groupDirs ? ' ✓' : ''), act: function () { setSort(null, !state.groupDirs); } }
    ];
    openMenu(x, y, null, items);
  }

  /** 最近文件夹：固定的排在前面，每条带固定/取消固定；底部可清除列表 */
  function openRecentsMenu(x, y) {
    bridge.callHandler('library.recents', null, function (res) {
      closeMenu();
      var pinned = (res && res.pinned) || [];
      var recent = (res && res.recent) || [];

      menuEl = document.createElement('div');
      menuEl.className = 'mf-lib-menu mf-lib-menu-wide';

      function section(title) {
        var h = document.createElement('div');
        h.className = 'mf-lib-menu-head';
        h.textContent = title;
        menuEl.appendChild(h);
      }
      function entry(path, isPinned) {
        var row = document.createElement('div');
        row.className = 'mf-lib-menu-row';

        var name = document.createElement('button');
        name.className = 'mf-lib-menu-item';
        name.textContent = baseName(path);
        name.title = path;
        name.addEventListener('click', function () {
          closeMenu();
          bridge.callHandler('library.setRoot', { path: path }, function (r) {
            setRootFrom(r);
          });
        });

        var pin = document.createElement('button');
        pin.className = 'mf-lib-menu-pin';
        pin.title = isPinned ? '取消固定' : '固定';
        pin.textContent = isPinned ? '✔' : '＋';
        pin.addEventListener('click', function () {
          bridge.callHandler('library.pinRoot', { path: path }, function () {
            closeMenu();
            openRecentsMenu(x, y);
          });
        });

        var del = document.createElement('button');
        del.className = 'mf-lib-menu-pin';
        del.title = '从列表移除';
        del.textContent = '×';
        del.addEventListener('click', function () {
          bridge.callHandler('library.removeRecent', { path: path }, function () {
            closeMenu();
            openRecentsMenu(x, y);
          });
        });

        row.appendChild(name);
        row.appendChild(pin);
        row.appendChild(del);
        menuEl.appendChild(row);
      }

      if (pinned.length) {
        section('固定的文件夹');
        pinned.forEach(function (p) { entry(p, true); });
      }
      if (recent.length) {
        section('最近的文件夹');
        recent.forEach(function (p) { entry(p, false); });
      }
      if (!pinned.length && !recent.length) {
        var empty = document.createElement('div');
        empty.className = 'mf-lib-menu-head';
        empty.textContent = '还没有最近文件夹';
        menuEl.appendChild(empty);
      } else {
        var sep = document.createElement('div');
        sep.className = 'mf-lib-menu-sep';
        menuEl.appendChild(sep);
        var clear = document.createElement('button');
        clear.className = 'mf-lib-menu-item';
        clear.textContent = '清除最近列表';
        clear.addEventListener('click', function () {
          bridge.callHandler('library.clearRecents', null, function () { closeMenu(); });
        });
        menuEl.appendChild(clear);
      }

      document.body.appendChild(menuEl);
      var w = menuEl.offsetWidth, h = menuEl.offsetHeight;
      menuEl.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x)) + 'px';
      menuEl.style.top = Math.max(6, Math.min(window.innerHeight - h - 36, y)) + 'px';
    });
  }

  // ---------- 拖拽（Typora：树内移动 + 拖到正文插链接） ----------

  function clearDropMarks() {
    var marked = listEl ? listEl.querySelectorAll('.mf-lib-dropping') : [];
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('mf-lib-dropping');
  }

  function moveEntry(path, toDir) {
    bridge.callHandler('library.move', { path: path, toDir: toDir }, function (res) {
      if (res && res.error) { window.alert(res.error); refresh(); return; }
      // 拖走的是当前文档：跟着切过去
      if (res && res.path && path === state.current) {
        openFile(res.path);
        return;
      }
      refresh();
    });
  }

  /** 拖到正文：插入相对链接（Typora 拖文件进正文也是插链接） */
  function insertLinkFor(path) {
    var write = document.getElementById('write');
    if (!write) return;
    var dir = (window.MF && window.MF.docDir && window.MF.docDir()) || '';
    var rel = (dir && path.indexOf(dir) === 0) ? path.slice(dir.length) : path;
    var text = '[' + baseName(path).replace(/\[|\]/g, '') + '](' + rel + ')';

    var point = state.dropPoint;
    var pos = point && document.caretPositionFromPoint
      ? document.caretPositionFromPoint(point.x, point.y) : null;
    if (pos && pos.offsetNode && write.contains(pos.offsetNode)) {
      try {
        var r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      } catch (e) {}
    } else {
      write.focus();
    }
    if (window.MF && window.MF.programEdit) {
      window.MF.programEdit(function () {
        document.execCommand('insertText', false, text);
      });
    } else {
      document.execCommand('insertText', false, text);
    }
  }

  function wireDragAndDrop() {
    listEl.addEventListener('dragstart', function (e) {
      var row = e.target.closest ? e.target.closest('.mf-lib-row') : null;
      if (!row) { e.preventDefault(); return; }
      state.drag = row.getAttribute('data-path');
      try {
        e.dataTransfer.setData('text/plain', state.drag);
        e.dataTransfer.effectAllowed = 'move';
      } catch (err) {}
    });

    listEl.addEventListener('dragend', function () {
      state.drag = '';
      clearDropMarks();
    });

    listEl.addEventListener('dragover', function (e) {
      if (!state.drag) return;
      var row = e.target.closest ? e.target.closest('.mf-lib-row') : null;
      clearDropMarks();
      // 拖到目录行 = 移动进该目录；拖到空白处 = 移动回根目录
      if (row && row.getAttribute('data-dir') === '1' &&
          row.getAttribute('data-path') !== state.drag) {
        row.classList.add('mf-lib-dropping');
        e.preventDefault();
      } else if (!row) {
        e.preventDefault();
      }
    });

    listEl.addEventListener('drop', function (e) {
      var path = state.drag;
      clearDropMarks();
      if (!path) return;
      e.preventDefault();
      var row = e.target.closest ? e.target.closest('.mf-lib-row') : null;
      var dest = (row && row.getAttribute('data-dir') === '1') ? row.getAttribute('data-path') : state.root;
      if (!dest || dest === path || dest === parentDir(path)) return;
      moveEntry(path, dest);
    });

    // 拖到正文：插链接
    var write = document.getElementById('write');
    if (!write) return;
    write.addEventListener('dragover', function (e) {
      if (!state.drag) return;
      e.preventDefault();
      state.dropPoint = { x: e.clientX, y: e.clientY };
    });
    write.addEventListener('drop', function (e) {
      var path = state.drag;
      if (!path) return;
      e.preventDefault();
      state.dropPoint = { x: e.clientX, y: e.clientY };
      insertLinkFor(path);
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
        '<span class="mf-lib-acts">' +
          '<button class="mf-lib-act" data-act="up" title="上级目录">' + ICON.up + '</button>' +
          '<button class="mf-lib-act" data-act="sort" title="排序">' + ICON.sort + '</button>' +
          '<button class="mf-lib-act" data-act="recents" title="最近文件夹">' + ICON.clock + '</button>' +
          '<button class="mf-lib-act" data-act="root" title="打开文件夹…">' + ICON.home + '</button>' +
          '<button class="mf-lib-act" data-act="refresh" title="刷新">' + ICON.refresh + '</button>' +
        '</span>' +
      '</div>';

    listEl = pane.querySelector('.mf-lib-list');
    titleEl = pane.querySelector('.mf-lib-title');
    rootBarEl = pane.querySelector('.mf-lib-rootbar');
    upBtn = rootBarEl.querySelector('[data-act="up"]');

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
      var r = act.getBoundingClientRect();
      // 菜单往左下角展开（按钮在侧栏底部）
      var x = r.left, y = r.top;
      if (a === 'root') bridge.callHandler('library.chooseRoot', null, function () {});
      else if (a === 'refresh') refresh();
      else if (a === 'sort') openSortMenu(x, y);
      else if (a === 'recents') openRecentsMenu(x, y);
      else if (a === 'up') goUp();
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

    wireDragAndDrop();

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
   * 根目录跟随当前文档。
   *
   * 规则（和用户预期的"选中哪个文件夹就在哪一层"一致）：
   *   1. 文件已经在当前根之内 → **不动根**，只展开祖先并高亮。否则每打开
   *      一个文件树就往里钻一层，用户选的文件夹位置一路被顶掉。
   *   2. 文件在根之外（或还没有根）→ 跟到它的父文件夹，否则树里看不到它。
   * 想回上一层用底部操作条的「上级目录」，或者最近文件夹。
   */
  function followDocument(path) {
    var p = path || window.__currentFilePath || '';
    if (!p) return;
    var dir = parentDir(p);
    if (!dir) { revealFile(p); return; }
    // 根内（含根本身）就保持不动
    if (state.root && (p === state.root || p.indexOf(state.root + '/') === 0)) {
      revealFile(p);
      return;
    }
    if (dir === state.root) { revealFile(p); return; }
    bridge.callHandler('library.setRoot', { path: dir }, function (res) {
      state.root = (res && res.root) || dir;
      state.cache = {};
      renderTitle();
      refresh(function () { revealFile(p); });
    });
  }

  /** 返回上一级目录（根已经是 / 或空时不动） */
  function goUp() {
    var up = parentDir(state.root);
    if (!state.root || !up || up === state.root) return;
    bridge.callHandler('library.setRoot', { path: up }, function (res) {
      if (res && res.error) return;
      setRootFrom(res);
    });
  }

  // ---------- 启动 ----------

  build();
  state.expanded = readStore(STORE_EXPANDED, {}) || {};

  // 排序偏好（Typora：排序方式 + 文件夹优先开关）
  var savedSort = readStore(STORE_SORT, null);
  if (savedSort) {
    state.sort = savedSort.sort === 'mtime' ? 'mtime' : 'name';
    state.groupDirs = savedSort.groupDirs !== false;
  }

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
    revealFile: revealFile,
    /** 原生把当前文档移动到了新路径（拖拽时可能发生） */
    documentMoved: function (path) {
      state.current = path || '';
      openFile(path);
    },
    /** 撤销上一次文件操作（新建/复制/重命名/移动） */
    undoFileOp: function () {
      bridge.callHandler('library.undoFileOp', null, function (res) {
        if (res && res.error) { window.alert(res.error); return; }
        refresh();
      });
    }
  };
})();
