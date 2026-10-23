/* 主题：跟随系统 / 明亮 / 深色 / 护眼 / Nord，以及用户放进主题文件夹的自定义 CSS
 *
 * 自定义主题的取用顺序：localStorage 里上次缓存的 CSS 先顶上（启动不闪），
 * 再通过 bridge 读一次磁盘（用户可能刚改过）。文件被删掉就回落到「跟随系统」。
 */

(function () {
  'use strict';

  var BUILTIN = [
    { id: 'auto', label: '跟随系统' },
    { id: 'light', label: '明亮' },
    { id: 'dark', label: '深色' },
    { id: 'sepia', label: '护眼' },
    { id: 'nord', label: 'Nord' }
  ];

  var CUSTOM_PREFIX = 'file:';
  var STYLE_ID = 'mf-custom-theme';
  var CACHE_PREFIX = 'mf.theme.css.';
  var CACHE_LIMIT = 200 * 1024;

  var bridge = window.bridge;
  var current = 'auto';
  var customs = [];            // [{ id, name }]
  var menu = null;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------- 元信息：@name / @base ----------

  // 只认「独立的单行指令」：/* @name: 纸墨 */ 或裸写 @name: 纸墨。
  // 多行注释里的说明文字（用来当文档的）不会被误当成指令。
  var META_BLOCK = /^\s*\/\*\s*@(name|base)\s*:\s*([^*]*?)\s*\*\/\s*$/;
  var META_BARE = /^\s*@(name|base)\s*:\s*(.+?)\s*$/;

  function parseMeta(css) {
    var lines = String(css || '').split(/\r?\n/).slice(0, 40);
    var name = '', base = '';
    for (var i = 0; i < lines.length; i++) {
      var m = META_BLOCK.exec(lines[i]) || META_BARE.exec(lines[i]);
      if (!m) continue;
      var v = m[2].trim();
      if (m[1] === 'name' && !name) name = v;
      if (m[1] === 'base' && !base) base = v.toLowerCase();
    }
    var allowed = ['auto', 'light', 'dark', 'sepia', 'nord'];
    if (allowed.indexOf(base) < 0) base = 'light';
    return { name: name, base: base };
  }

  // ---------- 缓存 ----------

  function readCache(name) {
    try { return localStorage.getItem(CACHE_PREFIX + name) || ''; } catch (e) { return ''; }
  }

  function writeCache(name, css) {
    if (css.length > CACHE_LIMIT) return;
    try { localStorage.setItem(CACHE_PREFIX + name, css); } catch (e) {}
  }

  // ---------- 注入 ----------

  function injectCSS(css) {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  function removeCSS() {
    var el = document.getElementById(STYLE_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function setBase(base) {
    if (base === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', base);
  }

  function setLabel(text) {
    var btn = document.getElementById('mf-theme-btn');
    if (btn) btn.textContent = text;
  }

  function isBuiltin(id) {
    for (var i = 0; i < BUILTIN.length; i++) if (BUILTIN[i].id === id) return true;
    return false;
  }

  function persist(id) {
    try { localStorage.setItem('mf.theme', id); } catch (e) {}
  }

  // ---------- 应用 ----------

  function apply(id, persistIt) {
    if (persistIt === undefined) persistIt = true;
    if (typeof id !== 'string' || !id) id = 'auto';

    if (id.indexOf(CUSTOM_PREFIX) === 0) {
      applyCustom(id.slice(CUSTOM_PREFIX.length), persistIt);
      return;
    }
    if (!isBuiltin(id)) id = 'auto';

    removeCSS();
    setBase(id);
    current = id;
    for (var i = 0; i < BUILTIN.length; i++) {
      if (BUILTIN[i].id === id) setLabel(BUILTIN[i].label);
    }
    if (persistIt) persist(id);
  }

  function applyCustom(name, persistIt) {
    var id = CUSTOM_PREFIX + name;
    var cached = readCache(name);
    var meta = parseMeta(cached);

    setBase(meta.base);
    injectCSS(cached);
    current = id;
    setLabel(meta.name || name);
    if (persistIt !== false) persist(id);

    // 磁盘上的可能刚改过（首次也没有缓存），读一次覆盖
    bridge.callHandler('themes.read', { id: name }, function (res) {
      if (current !== id) return;
      if (!res || typeof res.css !== 'string') {
        apply('auto');
        return;
      }
      var m = parseMeta(res.css);
      writeCache(name, res.css);
      setBase(m.base);
      injectCSS(res.css);
      setLabel(m.name || name);
    });
  }

  // ---------- 主题文件夹 ----------

  function openFolder() {
    bridge.callHandler('themes.openFolder', null, function () {});
  }

  function refresh(rebuildMenu) {
    bridge.callHandler('themes.list', null, function (list) {
      var next = [];
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id) next.push({ id: list[i].id, name: list[i].name || list[i].id });
        }
      }
      customs = next;

      if (current.indexOf(CUSTOM_PREFIX) === 0) {
        var alive = false;
        for (var j = 0; j < customs.length; j++) {
          if (CUSTOM_PREFIX + customs[j].id === current) alive = true;
        }
        if (!alive) apply('auto');
      }
      if (rebuildMenu) renderMenu();
    });
  }

  // ---------- 菜单 ----------

  function closeMenu() {
    if (menu) menu.classList.remove('mf-show');
  }

  function itemHTML(id, label) {
    var on = id === current;
    return '<button class="mf-menu-item' + (on ? ' mf-on' : '') + '" role="menuitem"' +
      ' data-theme-id="' + esc(id) + '">' +
      '<span class="mf-menu-check">' + (on ? '✓' : '') + '</span>' +
      '<span class="mf-menu-label">' + esc(label) + '</span></button>';
  }

  function renderMenu() {
    if (!menu) return;
    var html = '<div class="mf-menu-title">主题</div>';
    for (var i = 0; i < BUILTIN.length; i++) {
      html += itemHTML(BUILTIN[i].id, BUILTIN[i].label);
    }

    if (customs.length) {
      html += '<div class="mf-menu-sep"></div><div class="mf-menu-title">自定义</div>';
      for (var j = 0; j < customs.length; j++) {
        html += itemHTML(CUSTOM_PREFIX + customs[j].id, customs[j].name || customs[j].id);
      }
    } else {
      html += '<div class="mf-menu-sep"></div><div class="mf-menu-empty">' +
        '把 .css 放进主题文件夹，就会出现在这里</div>';
    }

    html += '<div class="mf-menu-sep"></div>' +
      '<button class="mf-menu-act" data-action="open">打开主题文件夹…</button>' +
      '<button class="mf-menu-act" data-action="reload">重新加载</button>';

    menu.innerHTML = html;
  }

  function ensureMenu() {
    if (menu) return menu;

    menu = document.createElement('div');
    menu.id = 'mf-theme-menu';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);

    menu.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('[data-theme-id]') : null;
      if (item) {
        apply(item.getAttribute('data-theme-id'));
        closeMenu();
        return;
      }
      var act = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!act) return;
      if (act.getAttribute('data-action') === 'open') {
        openFolder();
        closeMenu();
      } else {
        refresh(true);
      }
    });

    document.addEventListener('mousedown', function (e) {
      if (!menu.classList.contains('mf-show')) return;
      if (menu.contains(e.target)) return;
      var btn = document.getElementById('mf-theme-btn');
      if (btn && btn.contains(e.target)) return;
      closeMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    return menu;
  }

  function openMenu() {
    var btn = document.getElementById('mf-theme-btn');
    if (!btn) return;
    ensureMenu();
    renderMenu();
    menu.classList.add('mf-show');

    var r = btn.getBoundingClientRect();
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    menu.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  }

  function toggleMenu() {
    ensureMenu();
    if (menu.classList.contains('mf-show')) closeMenu();
    else openMenu();
  }

  // ---------- 循环切换 ----------

  function cycle() {
    var ids = [];
    for (var i = 0; i < BUILTIN.length; i++) ids.push(BUILTIN[i].id);
    for (var j = 0; j < customs.length; j++) ids.push(CUSTOM_PREFIX + customs[j].id);
    var at = ids.indexOf(current);
    apply(ids[(at + 1) % ids.length]);
  }

  // ---------- 启动 ----------

  var btn = document.getElementById('mf-theme-btn');
  if (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMenu();
    });
  }

  var saved = null;
  try { saved = localStorage.getItem('mf.theme'); } catch (e) {}
  apply(saved || 'auto', false);
  refresh(false);

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      cycle();
    }
  });

  window.MFTheme = {
    apply: apply,
    cycle: cycle,
    reload: function () { refresh(true); },
    openFolder: openFolder,
    parseMeta: parseMeta,
    list: function () {
      var out = [];
      for (var i = 0; i < BUILTIN.length; i++) out.push({ id: BUILTIN[i].id, label: BUILTIN[i].label });
      for (var j = 0; j < customs.length; j++) {
        out.push({ id: CUSTOM_PREFIX + customs[j].id, label: customs[j].name || customs[j].id });
      }
      return out;
    },
    current: function () { return current; }
  };
})();
