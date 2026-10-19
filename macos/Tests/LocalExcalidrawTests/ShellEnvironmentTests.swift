import XCTest
@testable import LocalExcalidraw

final class ShellEnvironmentTests: XCTestCase {
    func testParseSkipsRcOutputBeforeMarker() {
        var data = Data("welcome banner\nA=stale\0".utf8)
        data.append(Data("__MARK__".utf8))
        data.append(Data("CLAUDE_CODE_USE_BEDROCK=1\0MULTI=a\nb\0EQ=x=y\0".utf8))
        let env = Runtime.parseEnv(data, after: "__MARK__")
        XCTAssertEqual(env?["CLAUDE_CODE_USE_BEDROCK"], "1")
        XCTAssertEqual(env?["MULTI"], "a\nb")
        XCTAssertEqual(env?["EQ"], "x=y")
        XCTAssertNil(env?["A"])
    }

    func testParseWithoutMarkerFails() {
        XCTAssertNil(Runtime.parseEnv(Data("A=1\0".utf8), after: "__MARK__"))
    }

    func testMergePathsKeepsFirstOccurrence() {
        XCTAssertEqual(Runtime.mergePaths("/a:/b", nil, "/b:/c:"), "/a:/b:/c")
    }

    func testReadsLoginShellEnvironment() throws {
        let env = try XCTUnwrap(Runtime.loginShellEnvironment(timeout: 10))
        XCTAssertNotNil(env["HOME"])
        XCTAssertEqual(env["LFX_RESOLVING_SHELL_ENV"], "1")
    }
}
