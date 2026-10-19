import Foundation

/// How the sidebar sorts and shows the tree. Lives in the workspace (and its .lfx-workspace file),
/// like VS Code's explorer.sortOrder / explorer.compactFolders and Finder's view options.
struct ViewOptions: Codable, Equatable {
    enum SortBy: String, Codable, CaseIterable { case name, modified }
    /// Where folders go among drawings: VS Code's sortOrder "default", "mixed" and "filesFirst".
    enum FolderPlacement: String, Codable, CaseIterable { case top, mixed, bottom }
    /// The folder tree, or every drawing in one list per workspace folder.
    enum Layout: String, Codable, CaseIterable { case tree, list }

    var sortBy: SortBy = .name
    var folders: FolderPlacement = .top
    var layout: Layout = .tree
    /// Folds a chain of folders that each hold just one folder into one row ("a/b/c").
    var compactFolders = true
    /// Also lists folders without drawings (a project's src/, ...), not only just-made empty ones.
    var showAllFolders = false

    init() {}

    // Decode field by field so a workspace file written by another version still opens.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sortBy = (try? c.decode(SortBy.self, forKey: .sortBy)) ?? .name
        folders = (try? c.decode(FolderPlacement.self, forKey: .folders)) ?? .top
        layout = (try? c.decode(Layout.self, forKey: .layout)) ?? .tree
        compactFolders = (try? c.decode(Bool.self, forKey: .compactFolders)) ?? true
        showAllFolders = (try? c.decode(Bool.self, forKey: .showAllFolders)) ?? false
    }

    /// The current order in words, e.g. "By name · folders on top · compact".
    var summary: String {
        var parts = [sortBy == .name ? "By name" : "By date modified"]
        if layout == .list { return (parts + ["flat list"]).joined(separator: " · ") }
        switch folders {
        case .top: parts.append("folders on top")
        case .mixed: parts.append("folders mixed in")
        case .bottom: parts.append("folders below")
        }
        if compactFolders { parts.append("compact") }
        if showAllFolders { parts.append("all folders") }
        return parts.joined(separator: " · ")
    }
}

/// A folder or drawing in the sidebar tree: one tree per workspace folder, the real folder
/// structure below it, ordered by the view options.
struct TreeNode: Identifiable, Hashable {
    let path: String
    var name: String
    let root: String
    var drawing: Drawing?
    var children: [TreeNode] = []
    /// Drawings anywhere below.
    var count = 0
    /// Newest modification time below (a drawing's own for a drawing), for sorting by date.
    var latest: Double = 0
    /// The folder holding this node, relative to its root: "" at the top. Shown dimmed on
    /// drawing rows when the tree alone doesn't say where a drawing lives.
    var location = ""

    var id: String { path }
    var isFolder: Bool { drawing == nil }
    var isRoot: Bool { isFolder && path == root }
}

enum DrawingTree {
    /// Builds the tree for the workspace folders `roots`. A drawing belongs to the outermost
    /// workspace folder holding it, whichever daemon root reported it; drawings outside every
    /// workspace folder are left out. Folders show when they hold drawings, are empty (made with
    /// New Folder), or always with `showAllFolders`.
    static func build(roots: [String], drawings: [Drawing], folders: [Folder], filter: String,
                      options: ViewOptions = ViewOptions()) -> [TreeNode] {
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        func inside(_ p: String, _ r: String) -> Bool { p == r || p.hasPrefix(r + "/") }
        func top(_ p: String) -> String? { roots.filter { inside(p, $0) }.min { $0.count < $1.count } }
        func rel(_ root: String, _ p: String) -> String { String(p.dropFirst(root.count)).trimmingCharacters(in: ["/"]) }

        var tops: [String: TreeNode] = [:]
        var order: [String] = []
        for r in roots where top(r) == r && tops[r] == nil {
            tops[r] = TreeNode(path: r, name: (r as NSString).lastPathComponent, root: r)
            order.append(r)
        }

        /// Walks (creating as needed) to the folder at `parts` and lets `body` change it.
        func update(_ node: inout TreeNode, _ parts: ArraySlice<String>, mtime: Double?, _ body: (inout TreeNode) -> Void) {
            if let mtime {
                node.count += 1
                node.latest = max(node.latest, mtime)
            }
            guard let head = parts.first else { return body(&node) }
            let childPath = node.path + "/" + head
            if let i = node.children.firstIndex(where: { $0.isFolder && $0.path == childPath }) {
                update(&node.children[i], parts.dropFirst(), mtime: mtime, body)
            } else {
                var child = TreeNode(path: childPath, name: head, root: node.root, location: rel(node.root, node.path))
                update(&child, parts.dropFirst(), mtime: mtime, body)
                node.children.append(child)
            }
        }

        var seen = Set<String>()
        for d in drawings {
            guard let t = top(d.path), tops[t] != nil, seen.insert(d.path).inserted else { continue }
            let r = rel(t, d.path)
            if !needle.isEmpty && !r.lowercased().contains(needle) { continue }
            let parts = r.split(separator: "/").map(String.init).dropLast()
            update(&tops[t]!, parts[...], mtime: d.mtime) {
                $0.children.append(TreeNode(path: d.path, name: d.name, root: t, drawing: d, latest: d.mtime,
                                            location: parts.joined(separator: "/")))
            }
        }
        // While filtering, folders only show as the way to a match.
        if needle.isEmpty && options.layout == .tree {
            for f in folders where f.empty == true || options.showAllFolders {
                guard let t = top(f.path), tops[t] != nil else { continue }
                let r = rel(t, f.path)
                if r.isEmpty { continue }
                update(&tops[t]!, r.split(separator: "/").map(String.init)[...], mtime: nil) { _ in }
            }
        }
        return order.map { t in
            var n = tops[t]!
            if options.layout == .list {
                n.children = flatten(n)
            } else if options.compactFolders {
                n.children = n.children.map(compacted)
            }
            return sorted(n, options)
        }
    }

    /// Every drawing below `n`, without the folders.
    private static func flatten(_ n: TreeNode) -> [TreeNode] {
        n.children.flatMap { $0.isFolder ? flatten($0) : [$0] }
    }

    /// VS Code's compact folders: a folder whose only child is a folder becomes one "a/b" row,
    /// standing for the innermost folder (so New Folder, drops and expansion act on that one).
    private static func compacted(_ n: TreeNode) -> TreeNode {
        guard n.isFolder else { return n }
        var n = n
        while n.children.count == 1, let only = n.children.first, only.isFolder {
            var merged = only
            merged.name = n.name + "/" + only.name
            merged.location = n.location
            n = merged
        }
        n.children = n.children.map(compacted)
        return n
    }

    private static func sorted(_ n: TreeNode, _ o: ViewOptions) -> TreeNode {
        var n = n
        n.children = n.children.map { sorted($0, o) }.sorted { a, b in
            if a.isFolder != b.isFolder {
                switch o.folders {
                case .top: return a.isFolder
                case .bottom: return !a.isFolder
                case .mixed: break
                }
            }
            if o.sortBy == .modified && a.latest != b.latest { return a.latest > b.latest }
            let c = a.name.localizedStandardCompare(b.name)
            return c == .orderedSame ? a.path < b.path : c == .orderedAscending
        }
        return n
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

    /// The folders below `node`, depth first, in sidebar order.
    static func folderPaths(in node: TreeNode) -> [String] {
        node.children.filter(\.isFolder).flatMap { [$0.path] + folderPaths(in: $0) }
    }
}
