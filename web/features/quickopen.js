/* 快速打开（F11，Typora 的 Open Quickly）：模糊搜文件名，回车打开
 *
 * 文件清单走原生 library.allFiles（原生遍历根目录，比 JS 一层层懒加载快得多），
 * 匹配在 JS 里做：子序列模糊匹配 + 分词边界/开头命中加分，最近改过的排在前面。
 *
 * 快捷键 Cmd+Shift+P（Cmd+P 留给打印，Typora 在 macOS 上用 Cmd+Shift+O，
 * 而我们的 Cmd+Shift+O 已经是侧栏开关）。
 */

(function () {
  'use strict';

  var bridge = window.bridge;
  var wrap = null, input = null, listEl = null;
  var files = [];        // 全量清单
  var results = [];      // 当前结果
  var selected = 0;
  var lastLoad = 0;
  var LOAD_TTL = 30000;  // 清单缓存 30 秒

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 子序列模糊匹配：失败返回 -1 */
  function score(query, text) {
    var q = query.toLowerCase();
    var t = text.toLowerCase();
    var qi = 0, total = 0, streak = 0;

    for (var k = 0; k < t.length && qi < q.length; k++) {
      if (t.charAt(k) === q.charAt(qi)) {
        streak++;
        total += 2 + streak * 2;
        if (k === 0) total += 6;
        else if (/[^a-z0-9一-龥]/.test(t.charAt(k - 1))) total += 4;  // 分词边界
        qi++;
      } else {
        streak = 0;
      }
    }
    if (qi < q.length) return -1;
    return total - (t.length - q.length) * 0.1;
  }

  function search(q) {
    var query = (q || '').trim();
    if (!query) {
      // 空查询：按最近修改顺序列前 30 个
      return files.slice(0, 30);
    }
    var scored = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var s = score(query, f.rel || f.name);
      if (s >= 0) {
        // 命中文件名（而不是只命中目录名）额外加分
        var nameHit = score(query, f.name);
        if (nameHit >= 0) s += 8;
        scored.push({ file: f, score: s });
      }
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 30).map(function (x) { return x.file; });
  }

  function renderList() {
    if (!listEl) return;
    if (!results.length) {
      listEl.innerHTML = '<div class="mf-qo-empty">没有匹配的文件</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < results.length; i++) {
      var f = results[i];
      var rel = f.rel || f.name;
      var slash = rel.lastIndexOf('/');
      var dir = slash > 0 ? rel.slice(0, slash + 1) : '';
      html += '<button class="mf-qo-item' + (i === selected ? ' mf-on' : '') + '"' +
        ' data-i="' + i + '" title="' + esc(rel) + '">' +
        '<span class="mf-qo-name">' + esc(f.name) + '</span>' +
        '<span class="mf-qo-dir">' + esc(dir) + '</span></button>';
    }
    listEl.innerHTML = html;
  }

  function syncSelection() {
    var items = listEl ? listEl.querySelectorAll('.mf-qo-item') : [];
    for (var i = 0; i < items.length; i++) {
      var on = i === selected;
      items[i].classList.toggle('mf-on', on);
      if (on && typeof items[i].scrollIntoView === 'function') {
        items[i].scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function update() {
    results = search(input ? input.value : '');
    selected = 0;
    renderList();
  }

  function openSelected() {
    var f = results[selected];
    if (!f) return;
    hide();
    bridge.callHandler('document.openPath', { path: f.path }, function () {});
  }

  function loadFiles(cb) {
    var now = Date.now();
    if (files.length && now - lastLoad < LOAD_TTL) { if (cb) cb(); return; }
    bridge.callHandler('library.allFiles', null, function (list) {
      files = Array.isArray(list) ? list : [];
      lastLoad = Date.now();
      if (cb) cb();
    });
  }

  function show() {
    if (!wrap) build();
    wrap.classList.add('mf-show');
    input.value = '';
    loadFiles(function () { update(); });
    input.focus();
  }

  function hide() {
    if (!wrap) return;
    wrap.classList.remove('mf-show');
    var write = document.getElementById('write');
    if (write) write.focus();
  }

  function build() {
    wrap = document.createElement('div');
    wrap.id = 'mf-quickopen';
    wrap.innerHTML =
      '<div class="mf-qo-box">' +
        '<input id="mf-qo-input" class="mf-qo-input" type="text" ' +
        ' placeholder="搜索文件名…" spellcheck="false" autocomplete="off">' +
        '<div class="mf-qo-list"></div>' +
        '<div class="mf-qo-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>' +
      '</div>';
    document.body.appendChild(wrap);

    input = wrap.querySelector('.mf-qo-input');
    listEl = wrap.querySelector('.mf-qo-list');

    input.addEventListener('input', update);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selected = Math.min(results.length - 1, selected + 1);
        syncSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selected = Math.max(0, selected - 1);
        syncSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        openSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    });

    listEl.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.mf-qo-item') : null;
      if (!item) return;
      selected = parseInt(item.getAttribute('data-i'), 10) || 0;
      openSelected();
    });

    // 点遮罩关掉
    wrap.addEventListener('mousedown', function (e) {
      if (e.target === wrap) hide();
    });
  }

  build();

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      show();
    }
  });

  // 文件树那边动了（新建/删除/移动/切根）就作废缓存，下次打开重新拉
  if (window.MFLibrary && window.MFLibrary.refresh) {
    var origRefresh = window.MFLibrary.refresh;
    window.MFLibrary.refresh = function () {
      files = [];
      return origRefresh.apply(this, arguments);
    };
  }

  window.MFQuickOpen = { show: show, hide: hide, search: search };
})();
