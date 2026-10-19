import Foundation

/// A folder or drawing in the sidebar tree, mirroring the web sidebar (src/shared/tree.ts):
/// one tree per root, the real folder structure below it, folders first, then by name.
struct TreeNode: Identifiable, Hashable {
    let path: String
    let name: String
    let root: String
    var drawing: Drawing?
    var children: [TreeNode] = []
    /// Drawings anywhere below.
    var count = 0

    var id: String { path }
    var isFolder: Bool { drawing == nil }
    var isRoot: Bool { isFolder && path == root }
}

enum DrawingTree {
    /// Builds the tree. Folders show when they hold drawings, or are empty (made with New Folder).
    /// A root inside another root is shown once, inside the outer one.
    static func build(roots: [String], drawings: [Drawing], folders: [Folder], filter: String) -> [TreeNode] {
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        func inside(_ p: String, _ r: String) -> Bool { p == r || p.hasPrefix(r + "/") }
        func outer(_ r: String) -> String { roots.filter { inside(r, $0) }.min { $0.count < $1.count } ?? r }
        func rel(_ root: String, _ p: String) -> String { String(p.dropFirst(root.count)).trimmingCharacters(in: ["/"]) }

        var tops: [String: TreeNode] = [:]
        var order: [String] = []
        for r in roots where outer(r) == r && tops[r] == nil {
            tops[r] = TreeNode(path: r, name: r, root: r)
            order.append(r)
        }
        /// The shown root a path belongs to.
        func top(_ p: String) -> String? { order.first { inside(p, $0) } }

        /// Walks (creating as needed) to the folder at `parts` and lets `body` change it.
        func update(_ node: inout TreeNode, _ parts: ArraySlice<String>, counting: Bool, _ body: (inout TreeNode) -> Void) {
            if counting { node.count += 1 }
            guard let head = parts.first else { return body(&node) }
            let childPath = node.path + "/" + head
            if let i = node.children.firstIndex(where: { $0.isFolder && $0.path == childPath }) {
                update(&node.children[i], parts.dropFirst(), counting: counting, body)
            } else {
                var child = TreeNode(path: childPath, name: head, root: node.root)
                update(&child, parts.dropFirst(), counting: counting, body)
                node.children.append(child)
            }
        }

        var seen = Set<String>()
        for d in drawings {
            // By path, not d.root: a workspace folder may sit inside (or around) the daemon root the drawing came from.
            guard let top = top(d.path), seen.insert(d.path).inserted else { continue }
            let r = rel(top, d.path)
            if !needle.isEmpty && !r.lowercased().contains(needle) { continue }
            let parts = r.split(separator: "/").map(String.init).dropLast()
            update(&tops[top]!, parts[...], counting: true) {
                $0.children.append(TreeNode(path: d.path, name: d.name, root: top, drawing: d))
            }
        }
        for f in folders where f.empty == true {
            guard let top = top(f.path) else { continue }
            let r = rel(top, f.path)
            if r.isEmpty || (!needle.isEmpty && !r.lowercased().contains(needle)) { continue }
            update(&tops[top]!, r.split(separator: "/").map(String.init)[...], counting: false) { _ in }
        }
        return order.map { sorted(tops[$0]!) }
    }

    private static func sorted(_ n: TreeNode) -> TreeNode {
        var n = n
        n.children = n.children.map(sorted).sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
        return n
    }

    /// The folders below `node`, depth first, in sidebar order.
    static func folderPaths(in node: TreeNode) -> [String] {
        node.children.filter(\.isFolder).flatMap { [$0.path] + folderPaths(in: $0) }
    }

    /// The folders to expand so `file` shows: everything from its root down.
    static func ancestors(of file: String, in tree: [TreeNode]) -> [String] {
        guard let root = tree.first(where: { file.hasPrefix($0.path + "/") }) else { return [] }
        var out = [root.path]
        var dir = root.path
        for part in file.dropFirst(root.path.count + 1).split(separator: "/").dropLast() {
            dir += "/" + part
            out.append(dir)
        }
        return out
    }
}
