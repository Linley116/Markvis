#!/usr/bin/env node
// 发布 GitHub Release：把 scripts/versions.json 里的每个版本做成一条 Release，
// 发布说明取自 CHANGELOG.md 对应小节。
//
//   node scripts/publish-release.js               # 发布所有缺失的版本（自动补 tag）
//   node scripts/publish-release.js v0.14.6       # 只发布指定版本
//   node scripts/publish-release.js --dry-run     # 只打印将要做什么
//
// 鉴权：环境变量 GITHUB_TOKEN（CI 里用 secrets.GITHUB_TOKEN / ${{ github.token }}）。
// 幂等：已存在的 tag 与 Release 会跳过，重复执行安全。

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const VERSIONS_FILE = path.join(ROOT, 'scripts', 'versions.json');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || 'Linley116/Markvis';
const DRY_RUN = process.argv.includes('--dry-run');

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

function api(method, apiPath, body) {
  const options = {
    method,
    hostname: 'api.github.com',
    path: `/repos/${REPO}${apiPath}`,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'markvis-release-bot',
    },
  };
  if (TOKEN) options.headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (e) {
          parsed = text;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, data: parsed });
        else reject(new Error(`GitHub API ${method} ${apiPath} → ${res.statusCode}: ${text.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// 从 CHANGELOG.md 里截出某个版本的小节正文
function changelogSection(version) {
  if (!fs.existsSync(CHANGELOG_FILE)) return '';
  const text = fs.readFileSync(CHANGELOG_FILE, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l.startsWith(`## ${version}\n`));
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

async function ensureTag(version, shortSha) {
  const ref = await api('GET', `/git/ref/tags/${version}`).catch(() => null);
  if (ref && ref.status === 200) return ref.data.object;
  if (DRY_RUN) return `dry-run:${shortSha}`;

  const commit = await api('GET', `/commits/${shortSha}`);
  const res = await api('POST', '/git/refs', JSON.stringify({
    ref: `refs/tags/${version}`,
    sha: commit.data.sha,
  }));
  console.log(`  · 创建 tag ${version} → ${commit.data.sha.slice(0, 7)}`);
  return res.data.object;
}

async function releaseExists(version) {
  const res = await api('GET', `/releases/tags/${version}`).catch(() => null);
  return res && res.status === 200 ? res.data : null;
}

async function publishOne(entry, isLatest) {
  const { version, commit } = entry;
  const existing = await releaseExists(version);
  if (existing) {
    console.log(`· ${version} 已存在 Release，跳过`);
    return false;
  }

  await ensureTag(version, commit);

  const section = changelogSection(version);
  const footer = [
    '---',
    '',
    `完整改动记录见 [CHANGELOG.md](https://github.com/${REPO}/blob/main/CHANGELOG.md)。`,
    '',
    '> 本项目仅以源码分发，不提供预编译或已公证的二进制；请按 [README](https://github.com/' + REPO + ') 自行构建。',
  ].join('\n');
  const body = section ? `${section}\n\n${footer}` : footer;

  if (DRY_RUN) {
    console.log(`· [dry-run] 将创建 Release ${version}（${body.length} 字符说明）`);
    return true;
  }

  try {
    const res = await api('POST', '/releases', JSON.stringify({
      tag_name: version,
      name: `Markvis ${version}`,
      body,
      prerelease: false,
      draft: false,
      make_latest: isLatest ? 'true' : 'false',
    }));
    console.log(`✓ ${version} → ${res.data.html_url}`);
    return true;
  } catch (err) {
    // 并发运行时可能已有别的任务先建好同名 Release，忽略即可
    if (/422|already_exists/.test(err.message)) {
      console.log(`· ${version} 已被并发创建，跳过`);
      return false;
    }
    throw err;
  }
}

async function main() {
  if (!TOKEN && !DRY_RUN) {
    console.error('缺少 GITHUB_TOKEN 环境变量');
    process.exit(1);
  }

  const only = process.argv.slice(2).filter((a) => /^v\d/.test(a));
  const all = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8')).sort((a, b) => compareVersions(a.version, b.version));
  const targets = only.length ? all.filter((e) => only.includes(e.version)) : all;
  if (!targets.length) {
    console.error('没有匹配的版本');
    process.exit(1);
  }

  const newest = all[all.length - 1].version;
  let created = 0;
  for (const entry of targets) {
    if (await publishOne(entry, entry.version === newest)) created += 1;
  }
  console.log(`完成：新建 ${created} 条 Release，共处理 ${targets.length} 个版本`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
