// 没有完整 Xcode 时的原生测试运行器。
// 场景与 CI 的 XCTest 共用 NativeScenarios.swift，避免两套测试漂移。
import Foundation

let scenarios: [(String, () throws -> Void)] = [
    ("路径比较与越界防护", nativeScenarioPaths),
    ("会话恢复", nativeScenarioSessionRestore),
    ("JS 桥字符串", nativeScenarioJSBridge),
    ("文件操作与撤销", nativeScenarioLibraryLifecycle),
    ("文件操作安全", nativeScenarioLibrarySafety),
    ("文件树列表与索引", nativeScenarioLibraryList),
    ("目录优先排序", nativeScenarioEntrySorting)
]

var passed = 0
var failures: [String] = []

for (name, scenario) in scenarios {
    do {
        try scenario()
        passed += 1
        print("  ok   \(name)")
    } catch {
        failures.append(name)
        print("  FAIL \(name): \(error)")
    }
}

print("\n\(passed) passed, \(failures.count) failed")
if !failures.isEmpty {
    exit(1)
}
