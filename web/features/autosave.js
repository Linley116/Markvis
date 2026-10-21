/* 自动保存：内容变化 1.2s 后静默落盘（仅对已有路径的文档） */

(function () {
  'use strict';

  var MF = window.MF;
  var timer = null;
  var lastSaved = '';

  function saveNow() {
    var md = MF.getMarkdown();
    if (md === lastSaved) return;
    lastSaved = md;
    // 原生侧：无路径则忽略，不会弹保存面板
    MF.bridge.callHandler('document.autoSave', { content: md });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(saveNow, 1200);
  }

  MF.write.addEventListener('input', schedule);

  MF.onDocLoaded(function () {
    lastSaved = MF.getMarkdown();
  });

  window.addEventListener('beforeunload', function () {
    clearTimeout(timer);
  });

  window.MFAutosave = { saveNow: saveNow, schedule: schedule };
})();
