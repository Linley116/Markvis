import XCTest
@testable import MarkFrame

// CI（完整 Xcode）使用 XCTest；本机只有 Command Line Tools 时，
// test/native.sh 用 main.swift 运行同一组 NativeScenarios，不复制测试逻辑。
final class NativeSupportTests: XCTestCase {
    func testPaths() throws { try nativeScenarioPaths() }
    func testSessionRestore() throws { try nativeScenarioSessionRestore() }
    func testJSBridge() throws { try nativeScenarioJSBridge() }
}

final class LibraryTests: XCTestCase {
    func testLibraryLifecycle() throws { try nativeScenarioLibraryLifecycle() }
    func testLibrarySafety() throws { try nativeScenarioLibrarySafety() }
    func testLibraryList() throws { try nativeScenarioLibraryList() }
    func testEntrySorting() throws { try nativeScenarioEntrySorting() }
}
