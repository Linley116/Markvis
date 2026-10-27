#!/usr/bin/env node
// 从 scripts/versions.json + ROADMAP.md 的「已修复」表 + git 提交历史生成 CHANGELOG.md。
//
//   node scripts/gen-changelog.js            # 写入 CHANGELOG.md
//   node scripts/gen-changelog.js --check    # 只校验现有 CHANGELOG.md 是否最新（CI 用）
//
// 设计：版本 → commit 的映射放在 versions.json（唯一真源）；每个版本的说明取自
// ROADMAP 第四节「已修复」表里该版本的条目，标题取自对应 commit 的 subject。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSIONS_FILE = path.join(ROOT, 'scripts', 'versions.json');
const ROADMAP_FILE = path.join(ROOT, 'ROADMAP.md');
const OUT_FILE = path.join(ROOT, 'CHANGELOG.md');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function versionKey(v) {
  return v
    .slice(1)
    .split('.')
    .map((n) => Number(n))
    .concat([0, 0]);
}

function compareVersions(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i += 1) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

// ROADMAP 第四节：| 版本 | 问题 | 修法 |
function readRoadmapFixes() {
  const lines = fs.readFileSync(ROADMAP_FILE, 'utf8').split('\n');
  const fixes = new Map();
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    if (!/^v\d/.test(cells[0])) continue;
    if (!fixes.has(cells[0])) fixes.set(cells[0], []);
    fixes.get(cells[0]).push({ problem: cells[1], solution: cells[2] });
  }
  return fixes;
}

function main() {
  const check = process.argv.includes('--check');
  const versions = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
  const fixes = readRoadmapFixes();

  const blocks = versions
    .slice()
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((entry) => {
      const { version, commit } = entry;
      const subject = git('log', '-1', '--format=%s', commit);
      const date = git('log', '-1', '--format=%cs', commit);
      const full = git('rev-parse', commit);
      const short = full.slice(0, 7);
      const items = (fixes.get(version) || []).map((f) => ({
        problem: f.problem.replace(/<br>/g, '\n  ').trim(),
        solution: f.solution.replace(/<br>/g, '\n  ').trim(),
      }));

      const lines = [];
      lines.push(`## ${version} — ${date}`);
      lines.push('');
      lines.push(`**${subject}**`);
      lines.push('');
      lines.push(`- 提交：[${short}](https://github.com/Linley116/Markvis/commit/${full})`);
      for (const item of items) {
        lines.push(`- ${item.problem}`);
        lines.push(`  - 修法：${item.solution}`);
      }
      return lines.join('\n');
    });

  const header = [
    '# Changelog',
    '',
    '本文件由 `node scripts/gen-changelog.js` 生成，请勿手工编辑；',
    '版本与提交的映射见 `scripts/versions.json`，改动说明取自 [ROADMAP.md](ROADMAP.md) 第四节的「已修复」表。',
    '',
    '每个版本同时会作为 GitHub Release 发布，页面见 <https://github.com/Linley116/Markvis/releases>。',
    '',
    '---',
    '',
    '',
  ].join('\n');

  const output = `${header}${blocks.join('\n\n')}\n`;

  if (check) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== output) {
      console.error('CHANGELOG.md 与 scripts/versions.json / ROADMAP.md 不同步，请运行 node scripts/gen-changelog.js');
      process.exit(1);
    }
    console.log(`CHANGELOG.md 已同步（${versions.length} 个版本）`);
    return;
  }

  fs.writeFileSync(OUT_FILE, output);
  console.log(`已写入 CHANGELOG.md（${versions.length} 个版本）`);
}

main();
