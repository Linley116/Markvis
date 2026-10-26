#!/bin/zsh
# 构建可分发的 DMG。
#   ./release.sh                  仅打包（ad-hoc 签名，未公证）
#   MARKVIS_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" ./release.sh
#                                 用 Developer ID 签名
#   再提供 Apple 公证凭据即自动提交公证并装订票据：
#     APPLE_ID=... APPLE_TEAM_ID=... APPLE_APP_PASSWORD=... ./release.sh
#   或使用已保存的 notarytool 钥匙串配置：
#     MARKVIS_NOTARY_PROFILE=markvis ./release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/.Markvis.bundle"
DIST="$ROOT/dist"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/Info.plist")"
DMG="$DIST/Markvis-$VERSION.dmg"
IDENTITY="${MARKVIS_SIGN_IDENTITY:-}"

if [[ "$IDENTITY" == "-" ]]; then IDENTITY=""; fi

echo "==> build $VERSION"
MARKVIS_NO_INSTALL=1 "$ROOT/build.sh" --keep >/dev/null

if [[ -n "$IDENTITY" ]]; then
  echo "==> sign with $IDENTITY"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  echo "==> no MARKVIS_SIGN_IDENTITY：保留 ad-hoc 签名"
fi

echo "==> stage DMG"
STAGE="$ROOT/build/.dmg-stage"
mkdir -p "$STAGE" "$DIST"
# ditto 覆盖而不是先 rm -rf：构建目录也遵守本机的批量删除保护
ditto "$APP" "$STAGE/Markvis.app"
# DMG staging 也是 .app，不能让它留在 LaunchServices 里变成第二个图标
[[ -x "$LSREG" ]] && "$LSREG" -u "$STAGE/Markvis.app" >/dev/null 2>&1 || true
ln -sfn /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Markvis $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
hdiutil verify -quiet "$DMG"
# 打包完把 staging app 改名成非 .app，避免被索引回应用列表
[[ -d "$STAGE/Markvis.app" ]] && mv "$STAGE/Markvis.app" "$STAGE/Markvis.bundle"
[[ -x "$LSREG" ]] && "$LSREG" -u "$STAGE/Markvis.app" >/dev/null 2>&1 || true

if [[ -n "$IDENTITY" ]]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
fi

NOTARY_ARGS=()
if [[ -n "${MARKVIS_NOTARY_PROFILE:-}" ]]; then
  NOTARY_ARGS=(--keychain-profile "$MARKVIS_NOTARY_PROFILE")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  NOTARY_ARGS=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
fi

if [[ ${#NOTARY_ARGS[@]} -gt 0 ]]; then
  if [[ -z "$IDENTITY" || "$IDENTITY" != Developer\ ID\ Application:* ]]; then
    echo "!! 公证需要 Developer ID Application 证书；当前不是，跳过公证" >&2
    exit 3
  fi
  echo "==> notarize（可能需要几分钟）"
  xcrun notarytool submit "$DMG" "${NOTARY_ARGS[@]}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature -v "$DMG"
  echo "==> notarized + stapled"
else
  echo "!! 未提供公证凭据：这个 DMG 已打包，但其他 Mac 上仍可能被 Gatekeeper 拦截" >&2
fi

echo "==> done: $DMG"
du -sh "$DMG"
