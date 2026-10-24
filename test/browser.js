'use strict';
// 测试浏览器的统一生命周期管理。
//
// 为什么需要这个文件：
//   引擎/功能测试要在真实浏览器里跑编辑器的 JS（DOM 渲染、键盘输入、画笔）。
//   以前直接 playwright 的 chromium.launch()，node 进程一旦被强杀
//   （命令超时、Ctrl+C、工具中断），headless Chrome 就会变成孤儿进程留在
//   机器上，只能去活动监视器手动杀。这里把 Chrome 的生死管起来：
//     1. 自己 spawn Chrome（独立进程组），拿得到 pid，想杀就杀
//     2. process.on('exit') 同步兜底 SIGKILL —— process.exit() / 自然结束都覆盖
//     3. SIGINT / SIGTERM 处理器 —— Ctrl+C / 外部中断先杀浏览器再退
//     4. 看门狗进程 —— node 被 SIGKILL 时 1/2/3 都没机会跑，
//         由看门狗发现 node 消失后补刀（macOS 没有 PR_SET_PDEATHSIG，只能这么干）
//
// 用法：
//   const { launchTestBrowser, closeTestBrowser } = require('./browser');
//   let browser;
//   try {
//     browser = await launchTestBrowser();
//     ... 测试体 ...
//   } finally {
//     await closeTestBrowser();   // 幂等：重复调用 / 已关过都安全
//   }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 本地继续用系统 Chrome（一次性 profile）；CI 没有系统 Chrome 时，
// 使用 `playwright-core install chromium` 下载的独立浏览器。
// 也可用 MARKVIS_TEST_CHROME 显式指定，不会读取或修改用户浏览器数据。
function resolveChrome() {
  let bundled = '';
  try { bundled = chromium.executablePath(); } catch (_) {}
  const candidates = [process.env.MARKVIS_TEST_CHROME, SYSTEM_CHROME, bundled];
  return candidates.find(p => p && fs.existsSync(p)) || '';
}
const CHROME = resolveChrome();
const LAUNCH_TIMEOUT_MS = 20000;
const WATCHDOG_MAX_MS = 10 * 60 * 1000; // 看门狗最长盯 10 分钟，防自身泄漏
const WATCHDOG_POLL_S = 0.3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 所有活着的浏览器实例（正常一次只有一个，用集合是为了不漏杀）
const live = new Set();
let guardsInstalled = false;

// ---- Chrome 进程树强杀（同步，任何退出路径都能调）----
function killChromeTree(entry, sig) {
  const pid = entry && entry.chrome && entry.chrome.pid;
  if (!pid) return;
  // Chrome 是 detached 起的，pid 即进程组 id；负号 = 整个组（含 GPU/渲染子进程）
  try { process.kill(-pid, sig); } catch (_) {}
  try { process.kill(pid, sig); } catch (_) {}
}

function removeProfile(entry) {
  if (!entry || !entry.profileDir) return;
  try { fs.rmSync(entry.profileDir, { recursive: true, force: true }); } catch (_) {}
}

function killWatchdog(entry) {
  const dog = entry && entry.watchdog;
  if (!dog || dog.exitCode !== null || dog.killed) return;
  try { dog.kill('SIGKILL'); } catch (_) {}
}

// 同步收尸：SIGKILL 进程组 + 看门狗 + 临时 profile 目录
function hardKill(entry) {
  if (!entry) return;
  killChromeTree(entry, 'SIGKILL');
  killWatchdog(entry);
  removeProfile(entry);
}

// ---- 看门狗：node 被 SIGKILL 时，由它补杀 Chrome ----
function spawnWatchdog(nodePid, chromePid) {
  const ticks = Math.ceil(WATCHDOG_MAX_MS / (WATCHDOG_POLL_S * 1000));
  const script = [
    `n=${nodePid}`,
    `c=${chromePid}`,
    'i=0',
    `while [ $i -lt ${ticks} ]; do`,
    '  kill -0 "$n" 2>/dev/null || break',                                  // node 没了
    '  st=$(ps -p "$n" -o state= 2>/dev/null | tr -d "[:space:]")',
    '  [ "$st" = "Z" ] && break',                                           // 僵尸也算没了
    `  sleep ${WATCHDOG_POLL_S}`,
    '  i=$((i+1))',
    'done',
    'kill -9 -"$c" 2>/dev/null',                                            // 杀 Chrome 进程组
    'kill -9 "$c" 2>/dev/null',
    'exit 0'
  ].join('\n');
  try {
    const dog = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
    dog.unref();
    return dog;
  } catch (_) {
    return null; // 看门狗起不来不影响主路径，1/2/3 层防护还在
  }
}

// ---- 进程级防护（每进程只装一次）----
function installGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;

  // 1) 同步兜底：process.exit()、主流程自然结束都会触发 'exit'
  process.on('exit', () => { for (const e of live) hardKill(e); });

  // 2) Ctrl+C / 外部 SIGTERM（Bash 工具中断命令时发这个）
  const onSignal = code => {
    for (const e of live) hardKill(e);
    process.exit(code);
  };
  process.on('SIGINT', () => onSignal(130));
  process.on('SIGTERM', () => onSignal(143));
}

// ---- 对外 API ----
async function launchTestBrowser() {
  if (!CHROME) {
    throw new Error('未找到测试浏览器：请安装 Google Chrome，或运行 npx playwright-core install chromium；也可用 MARKVIS_TEST_CHROME 指定路径');
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markvis-test-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',          // 随机端口，不冲突
    '--user-data-dir=' + profileDir,      // 一次性 profile，不碰用户数据
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=Translate',
    '--mute-audio',
    '--no-sandbox',
    'about:blank'
  ], { detached: true, stdio: 'ignore' }); // detached：独立进程组，可整组强杀
  chrome.unref();

  // Chrome 就绪后把调试端口写进 <profile>/DevToolsActivePort 第一行
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let port = 0;
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (!port && Date.now() < deadline) {
    if (chrome.exitCode !== null) break; // Chrome 自己退了（崩溃/被禁）
    try {
      const p = parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10);
      if (p > 0) port = p;
    } catch (_) { /* 文件还没写出来，继续等 */ }
    if (!port) await sleep(100);
  }
  if (!port) {
    hardKill({ chrome, profileDir });
    throw new Error(`Chrome 启动失败（${LAUNCH_TIMEOUT_MS}ms 内未就绪）`);
  }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  const entry = {
    chrome,
    profileDir,
    browser,
    watchdog: spawnWatchdog(process.pid, chrome.pid)
  };
  live.add(entry);
  installGuards();
  return browser;
}

async function closeTestBrowser() {
  for (const entry of live) {
    live.delete(entry);
    try { await entry.browser.close(); } catch (_) {}
    // browser.close() 对 CDP 连接不保证终止进程，必须自己补刀
    hardKill(entry);
  }
}

module.exports = { CHROME, launchTestBrowser, closeTestBrowser };
