#!/bin/zsh
# 原生层自动化测试。
#   - 有完整 Xcode：用 SwiftPM 跑 XCTest（CI 走这条）
#   - 只有 Command Line Tools：没有 XCTest 框架，编译轻量运行器，
#     执行与 XCTest 完全相同的一组 NativeScenarios
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"

if [[ "${MARKFRAME_FORCE_HARNESS:-0}" != "1" && "$DEV_DIR" == *".app/Contents/Developer"* ]]; then
  # 本机部分终端环境不允许 SwiftPM 再套一层 sandbox-exec；
  # 项目没有插件或构建工具，关闭 SwiftPM 自身沙箱不影响测试隔离。
  exec swift test --disable-sandbox --package-path "$ROOT" "$@"
fi

echo "==> XCTest 不可用（$DEV_DIR），使用原生运行器"
mkdir -p "$ROOT/build"
swiftc -swift-version 5 -D NATIVE_TEST_HARNESS \
  "$ROOT/Sources/App.swift" \
  "$ROOT/Sources/L10n.swift" \
  "$ROOT/Sources/NativeSupport.swift" \
  "$ROOT/Sources/EditorWindow.swift" \
  "$ROOT/test/NativeTests/NativeScenarios.swift" \
  "$ROOT/test/NativeTests/main.swift" \
  -o "$ROOT/build/native-tests" \
  -framework Cocoa -framework WebKit -framework PDFKit -framework CoreServices
"$ROOT/build/native-tests"
