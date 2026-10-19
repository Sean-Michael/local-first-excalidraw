import XCTest
@testable import LocalExcalidraw

final class DrawingTreeTests: XCTestCase {
    let root = "/p"

    func drawing(_ rel: String, _ mtime: Double = 0, root: String = "/p") -> Drawing {
        let json = #"{"path":"\#(root)/\#(rel)","root":"\#(root)","size":1,"mtime":\#(mtime)}"#
        return try! JSONDecoder().decode(Drawing.self, from: Data(json.utf8))
    }

    func folder(_ rel: String, empty: Bool? = nil) -> Folder {
        let e = empty.map { #","empty":\#($0)"# } ?? ""
        return try! JSONDecoder().decode(Folder.self, from: Data(#"{"path":"/p/\#(rel)","root":"/p"\#(e)}"#.utf8))
    }

    func names(_ n: TreeNode) -> [String] { n.children.map(\.name) }

    var sample: [Drawing] {
        [drawing("b.excalidraw", 3), drawing("a.excalidraw", 1), drawing("docs/z.excalidraw", 5),
         drawing("deep/one/two/x.excalidraw", 2)]
    }

    func testFoldersOnTopByName() {
        var o = ViewOptions(); o.compactFolders = false
        let t = DrawingTree.build(roots: [root], drawings: sample, folders: [], filter: "", options: o)
        XCTAssertEqual(names(t[0]), ["deep", "docs", "a", "b"])
        XCTAssertEqual(t[0].count, 4)
        XCTAssertEqual(t[0].name, "p")
    }

    func testFoldersBelowAndMixedByDate() {
        var o = ViewOptions(); o.compactFolders = false
        o.folders = .bottom
        XCTAssertEqual(names(DrawingTree.build(roots: [root], drawings: sample, folders: [], filter: "", options: o)[0]),
                       ["a", "b", "deep", "docs"])
        o.folders = .mixed; o.sortBy = .modified
        // docs holds the newest drawing (5), then b (3), deep (2), a (1).
        XCTAssertEqual(names(DrawingTree.build(roots: [root], drawings: sample, folders: [], filter: "", options: o)[0]),
                       ["docs", "b", "deep", "a"])
    }

    func testCompactFolders() {
        let t = DrawingTree.build(roots: [root], drawings: sample, folders: [], filter: "", options: ViewOptions())
        let deep = t[0].children[0]
        XCTAssertEqual(deep.name, "deep/one/two")
        XCTAssertEqual(deep.path, "/p/deep/one/two")
        XCTAssertEqual(deep.children.first?.location, "deep/one/two")
    }

    func testFlatListKeepsLocations() {
        var o = ViewOptions(); o.layout = .list
        let t = DrawingTree.build(roots: [root], drawings: sample, folders: [], filter: "", options: o)
        XCTAssertTrue(t[0].children.allSatisfy { !$0.isFolder })
        XCTAssertEqual(t[0].children.map(\.location), ["", "", "deep/one/two", "docs"])
    }

    func testShowAllFolders() {
        let fs = [folder("src"), folder("new", empty: true), folder("docs")]
        var o = ViewOptions()
        XCTAssertEqual(names(DrawingTree.build(roots: [root], drawings: sample, folders: fs, filter: "", options: o)[0]),
                       ["deep/one/two", "docs", "new", "a", "b"])
        o.showAllFolders = true
        XCTAssertEqual(names(DrawingTree.build(roots: [root], drawings: sample, folders: fs, filter: "", options: o)[0]),
                       ["deep/one/two", "docs", "new", "src", "a", "b"])
    }

    func testOnlyWorkspaceFoldersByPath() {
        // Reported under daemon root /p, but the workspace shows only /p/docs.
        let t = DrawingTree.build(roots: ["/p/docs"], drawings: sample, folders: [], filter: "")
        XCTAssertEqual(t.count, 1)
        XCTAssertEqual(names(t[0]), ["z"])
    }

    func testWorkspaceRelativePaths() {
        XCTAssertEqual(Workspace.relative("/a/b", from: "/a/b"), ".")
        XCTAssertEqual(Workspace.relative("/a/b/c/d", from: "/a/b/"), "c/d")
        XCTAssertEqual(Workspace.relative("/a/x", from: "/a/b"), "../x")
        XCTAssertEqual(Workspace.relative("/x/y", from: "/a/b"), "/x/y")
    }

    func testViewOptionsDecodeTolerant() throws {
        let v = try JSONDecoder().decode(ViewOptions.self, from: Data(#"{"sortBy":"modified","folders":"weird"}"#.utf8))
        XCTAssertEqual(v.sortBy, .modified)
        XCTAssertEqual(v.folders, .top)
    }
}
