/* 专注模式 / 打字机模式 */

(function () {
  'use strict';

  var MF = window.MF;
  var write = MF.write;
  var scroll = document.getElementById('scroll');

  var focusOn = false;
  var typewriter = false;

  function currentBlock() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    return MF.topBlockOf(sel.getRangeAt(0).startContainer);
  }

  function applyFocus() {
    var blocks = write.querySelectorAll('.md-block');
    var cur = currentBlock();
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].classList.toggle('mf-focus-current', blocks[i] === cur);
    }
  }

  function typewriterScroll() {
    if (!typewriter) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    var r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    var rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;

    var base = scroll.getBoundingClientRect();
    var target = base.top + scroll.clientHeight * 0.42;
    var delta = rect.top - target;
    if (Math.abs(delta) > 3) scroll.scrollTop += delta;
  }

  function toggleFocus() {
    focusOn = !focusOn;
    document.body.classList.toggle('mf-focus', focusOn);
    if (focusOn) applyFocus();
  }

  function toggleTypewriter() {
    typewriter = !typewriter;
    document.body.classList.toggle('mf-typewriter', typewriter);
    if (typewriter) typewriterScroll();
  }

  document.addEventListener('selectionchange', function () {
    if (focusOn) applyFocus();
  });

  scroll.addEventListener('scroll', function () {
    if (focusOn) applyFocus();
  }, { passive: true });

  write.addEventListener('input', typewriterScroll);
  write.addEventListener('keyup', typewriterScroll);

  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFocus();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      toggleTypewriter();
    }
  });

  window.MFFocus = { toggleFocus: toggleFocus, toggleTypewriter: toggleTypewriter };
})();
