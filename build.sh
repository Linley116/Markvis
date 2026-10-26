#!/bin/zsh
# 构建 Markvis 并安装到 ~/Applications
#   ./build.sh          构建 + 安装，不留下 build/Markvis.app
#   ./build.sh --keep   构建 + 安装，并保留 build/.Markvis.bundle 供分发打包
#
# build/stage 是非 .app 目录，LaunchServices 不会把它当成应用注册；
# 安装用 rsync 覆盖，避免 rm 旧 .app 后被安全删除机制移进废纸篓留下一堆副本。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$ROOT/build/.Markvis.bundle"
STAGE="$ROOT/build/stage"
DEST="$HOME/Applications/Markvis.app"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
KEEP=0
[[ "$1" == "--keep" ]] && KEEP=1
[[ "${MARKVIS_NO_INSTALL:-0}" == "1" ]] && KEEP=1

unregister() {
  [[ -x "$LSREG" ]] && "$LSREG" -u "$1" >/dev/null 2>&1 || true
}

# 构建副本只是中转，先从 LaunchServices 摘掉，避免启动台/聚焦出现两份
unregister "$BUNDLE"

rm -rf "$STAGE"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
touch "$ROOT/build/.metadata_never_index" 2>/dev/null || true

echo "==> compiling Swift"
swiftc -O \
  "$ROOT/Sources/main.swift" \
  "$ROOT/Sources/App.swift" \
  "$ROOT/Sources/L10n.swift" \
  "$ROOT/Sources/NativeSupport.swift" \
  "$ROOT/Sources/Migration.swift" \
  "$ROOT/Sources/EditorWindow.swift" \
  -o "$STAGE/Contents/MacOS/Markvis" \
  -framework Cocoa -framework WebKit

echo "==> assembling bundle"
cp "$ROOT/Info.plist" "$STAGE/Contents/Info.plist"
cp -R "$ROOT/web" "$STAGE/Contents/Resources/web"
printf 'APPL????' > "$STAGE/Contents/PkgInfo"

sign_app() {
  echo "==> ad-hoc signing"
  codesign --force --deep --sign - "$1" 2>/dev/null || echo "   (codesign skipped)"
}

if [[ $KEEP -eq 1 ]]; then
  mkdir -p "$BUNDLE"
  /usr/bin/rsync -a --delete "$STAGE/" "$BUNDLE/"
  sign_app "$BUNDLE"
  unregister "$BUNDLE"
  echo "==> kept build artifact (unregistered): $BUNDLE"
fi

if [[ "${MARKVIS_NO_INSTALL:-0}" == "1" ]]; then
  echo "==> skipping install (MARKVIS_NO_INSTALL=1)"
else
  echo "==> installing to $DEST"
  pkill -f "Markvis.app/Contents/MacOS/Markvis" 2>/dev/null || true
  sleep 0.4
  mkdir -p "$HOME/Applications" "$DEST"
  /usr/bin/rsync -a --delete "$STAGE/" "$DEST/"
  sign_app "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  codesign --verify --deep --strict "$DEST" 2>/dev/null || true
  [[ -x "$LSREG" ]] && "$LSREG" -f "$DEST" >/dev/null 2>&1 || true
fi

rm -rf "$STAGE"

if [[ "${MARKVIS_NO_INSTALL:-0}" == "1" ]]; then
  echo "==> done: $BUNDLE"
  du -sh "$BUNDLE"
else
  echo "==> done: $DEST"
  du -sh "$DEST"
fi
