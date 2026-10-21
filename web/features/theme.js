/* 主题：跟随系统 / 明亮 / 深色 / 护眼 / Nord */

(function () {
  'use strict';

  var THEMES = [
    { id: 'auto', label: '跟随系统' },
    { id: 'light', label: '明亮' },
    { id: 'dark', label: '深色' },
    { id: 'sepia', label: '护眼' },
    { id: 'nord', label: 'Nord' }
  ];

  var idx = 0;

  function apply(id, persist) {
    if (id === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', id);

    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === id) idx = i;
    }

    var btn = document.getElementById('mf-theme-btn');
    if (btn) btn.textContent = THEMES[idx].label;

    if (persist !== false) {
      try { localStorage.setItem('mf.theme', id); } catch (e) {}
    }
  }

  function cycle() {
    apply(THEMES[(idx + 1) % THEMES.length].id);
  }

  var saved = null;
  try { saved = localStorage.getItem('mf.theme'); } catch (e) {}
  apply(saved || 'auto', false);

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      cycle();
    }
  });

  window.MFTheme = { apply: apply, cycle: cycle };
})();
