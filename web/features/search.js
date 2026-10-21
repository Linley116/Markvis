/* 查找替换
 *
 * 高亮用 CSS Custom Highlight API，不往 DOM 里插 <mark>，
 * 因此不会干扰画笔的「无损 DOM」不变式。
 */

(function () {
  'use strict';

  var MF = window.MF;
  var write = MF.write;
  var scroll = document.getElementById('scroll');

  var CAN_HIGHLIGHT = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  var panel, findInput, replaceInput, countEl, caseChk;
  var hits = [];
  var current = -1;
  var built = false;

  function build() {
    if (built) return;
    built = true;

    panel = document.createElement('div');
    panel.id = 'mf-search';
    panel.innerHTML =
      '<div class="mf-search-row">' +
        '<input id="mf-find" type="text" placeholder="查找" spellcheck="false" autocomplete="off">' +
        '<span id="mf-count">0/0</span>' +
        '<button id="mf-prev" title="上一个">↑</button>' +
        '<button id="mf-next" title="下一个">↓</button>' +
        '<label id="mf-case" title="区分大小写"><input id="mf-case-chk" type="checkbox">Aa</label>' +
        '<button id="mf-close" title="关闭 Esc">×</button>' +
      '</div>' +
      '<div class="mf-search-row">' +
        '<input id="mf-replace" type="text" placeholder="替换为" spellcheck="false" autocomplete="off">' +
        '<button id="mf-rep">替换</button>' +
        '<button id="mf-repall">全部替换</button>' +
      '</div>';

    document.body.appendChild(panel);

    findInput = panel.querySelector('#mf-find');
    replaceInput = panel.querySelector('#mf-replace');
    countEl = panel.querySelector('#mf-count');
    caseChk = panel.querySelector('#mf-case-chk');

    // 点面板不要把选区丢掉
    panel.addEventListener('mousedown', function (e) {
      if (e.target.tagName !== 'INPUT') e.preventDefault();
    });

    findInput.addEventListener('input', refresh);
    findInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        goto(e.shiftKey ? current - 1 : current + 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
      }
    });

    replaceInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
    });

    panel.querySelector('#mf-next').addEventListener('click', function () { goto(current + 1); });
    panel.querySelector('#mf-prev').addEventListener('click', function () { goto(current - 1); });
    panel.querySelector('#mf-rep').addEventListener('click', replaceCurrent);
    panel.querySelector('#mf-repall').addEventListener('click', replaceAll);
    panel.querySelector('#mf-close').addEventListener('click', hide);
    caseChk.addEventListener('change', refresh);
  }

  function collect(query) {
    var ranges = [];
    if (!query) return ranges;

    var caseSensitive = caseChk && caseChk.checked;
    var needle = caseSensitive ? query : query.toLowerCase();

    var walker = document.createTreeWalker(write, NodeFilter.SHOW_TEXT, null);
    var node;

    while ((node = walker.nextNode())) {
      var hay = caseSensitive ? node.nodeValue : node.nodeValue.toLowerCase();
      var from = 0;
      var idx;

      while ((idx = hay.indexOf(needle, from)) >= 0) {
        var r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + needle.length);
        ranges.push(r);
        from = idx + needle.length;
      }
    }
    return ranges;
  }

  function paint() {
    if (!CAN_HIGHLIGHT) return;

    var h = new Highlight();
    for (var i = 0; i < hits.length; i++) h.add(hits[i]);
    CSS.highlights.set('mf-search', h);

    if (current >= 0 && hits[current]) {
      var hc = new Highlight();
      hc.add(hits[current]);
      CSS.highlights.set('mf-current', hc);
    } else {
      CSS.highlights.delete('mf-current');
    }
  }

  function refresh() {
    build();
    hits = collect(findInput.value);
    current = hits.length ? 0 : -1;
    countEl.textContent = hits.length ? '1/' + hits.length : '0/0';
    paint();
    if (hits.length) scrollTo(hits[0]);
  }

  function scrollTo(range) {
    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    var base = scroll.getBoundingClientRect();
    var delta = rect.top - base.top - scroll.clientHeight / 2;
    scroll.scrollTop += delta;
  }

  function goto(i) {
    if (!hits.length) return;
    current = (i % hits.length + hits.length) % hits.length;
    countEl.textContent = (current + 1) + '/' + hits.length;
    paint();
    scrollTo(hits[current]);
  }

  function markEdited() {
    MF.notifyEdited();
    var kids = write.children;
    for (var i = 0; i < kids.length; i++) MF.markDirty(kids[i]);
  }

  function replaceCurrent() {
    if (current < 0 || !hits.length) return;

    var range = hits[current];
    var text = replaceInput.value;

    range.deleteContents();
    if (text) range.insertNode(document.createTextNode(text));

    markEdited();
    refresh();
  }

  function replaceAll() {
    if (!hits.length || !findInput.value) return;

    var text = replaceInput.value;
    // 倒序替换：前面的 Range 不会因后面的 DOM 变更而失效
    for (var i = hits.length - 1; i >= 0; i--) {
      var range = hits[i];
      range.deleteContents();
      if (text) range.insertNode(document.createTextNode(text));
    }

    markEdited();
    refresh();
  }

  function show() {
    build();
    panel.classList.add('mf-show');
    findInput.focus();
    findInput.select();
    if (findInput.value) refresh();
  }

  function hide() {
    if (!panel) return;
    panel.classList.remove('mf-show');
    if (CAN_HIGHLIGHT) {
      CSS.highlights.delete('mf-search');
      CSS.highlights.delete('mf-current');
    }
    write.focus();
  }

  function toggle() {
    if (panel && panel.classList.contains('mf-show')) hide();
    else show();
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      show();
    } else if (e.key === 'Escape' && panel && panel.classList.contains('mf-show')) {
      e.preventDefault();
      hide();
    }
  });

  // 文档换了就重算
  MF.onDocLoaded(function () {
    if (panel && panel.classList.contains('mf-show')) refresh();
  });

  window.MFSearch = { show: show, hide: hide, toggle: toggle, replace: replaceAll };
})();
