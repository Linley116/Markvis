#!/bin/zsh
# 构建 Markvis 并安装到 ~/Applications
#   ./build.sh          构建 + 安装（只保留一份，避免启动台出现重复图标）
#   ./build.sh --keep   构建 + 安装，但保留 build/ 下的产物（用于分发打包）
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/Markvis.app"
DEST="$HOME/Applications/Markvis.app"
KEEP=0
[[ "$1" == "--keep" ]] && KEEP=1

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> compiling Swift"
swiftc -O \
  "$ROOT/Sources/main.swift" \
  "$ROOT/Sources/App.swift" \
  "$ROOT/Sources/L10n.swift" \
  "$ROOT/Sources/NativeSupport.swift" \
  "$ROOT/Sources/Migration.swift" \
  "$ROOT/Sources/EditorWindow.swift" \
  -o "$APP/Contents/MacOS/Markvis" \
  -framework Cocoa -framework WebKit

echo "==> assembling bundle"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
cp -R "$ROOT/web" "$APP/Contents/Resources/web"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> ad-hoc signing"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   (codesign skipped)"

if [[ "${MARKVIS_NO_INSTALL:-0}" == "1" ]]; then
  echo "==> skipping install (MARKVIS_NO_INSTALL=1)"
else
  echo "==> installing to $DEST"
  pkill -f "Markvis.app/Contents/MacOS/Markvis" 2>/dev/null || true
  sleep 0.4
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
fi

if [[ $KEEP -eq 0 ]]; then
  echo "==> removing build artifacts (single visible copy only)"
  rm -rf "$APP"
fi

echo "==> done: $DEST"
du -sh "$DEST"
