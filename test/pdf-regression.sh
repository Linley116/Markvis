#!/bin/zsh
# PDF 导出回归：分页结构 + 内容完整性
#
# 这份脚本守的是两个真实 bug：
#   1. 页数、体积都正常，但除第 1 页外全是空白（createPDF 只渲染可视区域）
#   2. 长表格 / 长代码块在页尾被裁掉（分页测量与实际渲染的换行规则不一致）
# 所以测试文档必须同时包含长表格和长代码块。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Markvis.app/Contents/MacOS/Markvis"
TMP="$(mktemp -d)"
APP_PID=0
cleanup() {
  if [[ "$APP_PID" -gt 0 ]]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

if [[ ! -x "$APP" ]]; then
  echo "未安装：$APP（先跑 ./build.sh）"
  exit 2
fi

python3 - "$TMP/doc.md" <<'PY'
import sys
parts = ['# PDF 回归测试', '', '用于验证分页、表格拆页与代码块折行。', '']

# 长表格：跨多页，续页需重复表头
parts += ['## 长表格', '', '| 序号 | 类别 | 说明 | 角色 |', '|---:|---|---|---|']
for i in range(1, 61):
    parts.append(f'| {i} | 检查项 {i} | 这是第 {i} 行的说明文字，长度足够占据一行以上，用来把表格撑到多页。 | 设计顾问自查 |')
parts.append('')

# 长代码块：必须折行，且跨页时不能丢行
parts += ['## 长代码块', '', '```css']
for i in range(1, 81):
    parts.append(f'.rule-{i} {{ margin: 0 0 {i}px; padding: {i}px 12px; border-left: 3px solid #ccc; color: #333; }}')
parts.append('```')
parts.append('')

# 块级 HTML：验证 sandbox iframe 在 PDF 里被展开成普通 DOM
parts += ['## HTML 块', '',
          '<div style="padding:8px 12px;border:1px solid #999">HTML-BLOCK-MARKER 这一段由块级 HTML 渲染，必须出现在 PDF 里。</div>', '']

# 正文末段：用来验证页尾没有被裁
parts += ['## 结尾', '', 'END-OF-DOCUMENT-MARKER 这一段必须完整出现在 PDF 的最后一页，否则说明导出被截断。', '']

open(sys.argv[1], 'w').write('\n'.join(parts))
PY

echo "==> 导出中…"
MARKVIS_EXPORT_PDF="$TMP/out.pdf" "$APP" "$TMP/doc.md" >/dev/null 2>&1 &
APP_PID=$!

# 不按固定秒数猜：等文件出现且大小连续两秒不变，慢的 CI 也能跑完
last_size=-1
stable=0
for _ in {1..90}; do
  if [[ -s "$TMP/out.pdf" ]]; then
    size=$(stat -f%z "$TMP/out.pdf" 2>/dev/null || echo 0)
    if [[ "$size" -gt 0 && "$size" -eq "$last_size" ]]; then
      stable=$((stable + 1))
    else
      stable=0
    fi
    [[ "$stable" -ge 2 ]] && break
    last_size=$size
  fi
  sleep 1
done

if [[ ! -s "$TMP/out.pdf" ]]; then
  echo "FAIL: 90 秒内没有生成 PDF"
  exit 1
fi

swift "$ROOT/test/pdfcheck.swift" "$TMP/out.pdf" "$TMP/doc.md" "HTML-BLOCK-MARKER"
