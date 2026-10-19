import Foundation
import Observation
import UniformTypeIdentifiers

/// The folders the sidebar shows, the way a VS Code workspace works: an ordered list of folders,
/// "Untitled" until saved as a `.lfx-workspace` file. The daemon may know more roots (agents' session
/// roots, older registrations); only the workspace's show. Autosaved to UserDefaults, so a relaunch
/// reopens it; a closed workspace relaunches to the Welcome view.
@MainActor
@Observable
final class Workspace {
    struct Recent: Codable, Hashable, Identifiable {
        enum Kind: String, Codable { case folder, workspace }
        let kind: Kind
        let path: String
        var id: String { kind.rawValue + ":" + path }
        var name: String {
            let last = (path as NSString).lastPathComponent
            return kind == .workspace ? (last as NSString).deletingPathExtension : last
        }
    }

    private struct State: Codable {
        var open: Bool
        var folders: [String]
        var file: String?
        var view: ViewOptions?
    }

    /// The `.lfx-workspace` file: `{"folders":[{"path":"relative/or/absolute"}],"view":{...}}`, like `.code-workspace`.
    private struct FileFormat: Codable {
        struct Entry: Codable { let path: String }
        var folders: [Entry]
        var view: ViewOptions?
    }

    static let fileType = UTType(filenameExtension: "lfx-workspace", conformingTo: .json) ?? .json
    private static let stateKey = "workspace"
    private static let recentsKey = "workspaceRecents"
    /// The view options last used anywhere: a new workspace starts with them.
    private static let viewKey = "workspaceView"

    /// false: no workspace, show the Welcome view.
    private(set) var isOpen = false
    private(set) var folders: [String] = []
    /// Where it's saved; nil while untitled.
    private(set) var file: URL?
    private(set) var recents: [Recent] = []
    /// How the sidebar sorts and shows the tree. Saved with the workspace, and in its file.
    var view = ViewOptions() {
        didSet {
            guard view != oldValue else { return }
            if let data = try? JSONEncoder().encode(view) { UserDefaults.standard.set(data, forKey: Self.viewKey) }
            persist(writeFile: true)
        }
    }

    var name: String { file.map { $0.deletingPathExtension().lastPathComponent } ?? "Untitled" }
    var title: String { "\(name) (Workspace)" }

    init() {
        let d = UserDefaults.standard
        let saved = d.data(forKey: Self.stateKey).flatMap { try? JSONDecoder().decode(State.self, from: $0) }
        if let s = saved {
            isOpen = s.open
            folders = s.folders
            file = s.file.map { URL(fileURLWithPath: $0) }
        }
        view = saved?.view ?? d.data(forKey: Self.viewKey).flatMap { try? JSONDecoder().decode(ViewOptions.self, from: $0) } ?? ViewOptions()
        if let data = d.data(forKey: Self.recentsKey), let r = try? JSONDecoder().decode([Recent].self, from: data) {
            recents = r
        }
    }

    /// Opens an empty untitled workspace if none is open (a lone drawing still needs a window to live in).
    func begin() {
        guard !isOpen else { return }
        isOpen = true
        folders = []
        file = nil
        persist()
    }

    /// Replaces the workspace with an untitled one holding just `path`.
    func openFolder(_ path: String) {
        isOpen = true
        folders = [path]
        file = nil
        remember(.folder, path)
        persist()
    }

    func add(_ path: String) {
        begin()
        if !folders.contains(path) { folders.append(path) }
        remember(.folder, path)
        persist(writeFile: true)
    }

    /// Takes the folder out of the workspace only; the daemon keeps it as a root, since agents may rely on it.
    func remove(_ path: String) {
        folders.removeAll { $0 == path }
        persist(writeFile: true)
    }

    func close() {
        isOpen = false
        folders = []
        file = nil
        persist()
    }

    func open(file url: URL) throws {
        let parsed = try JSONDecoder().decode(FileFormat.self, from: Data(contentsOf: url))
        let dir = url.deletingLastPathComponent()
        folders = parsed.folders.map { Self.resolve($0.path, from: dir) }
        if let v = parsed.view { view = v }
        file = url
        isOpen = true
        remember(.workspace, url.path)
        persist()
    }

    func save(to url: URL) throws {
        try write(to: url)
        file = url
        isOpen = true
        remember(.workspace, url.path)
        persist()
    }

    /// First launch after workspaces arrived: offer the folders the daemon already knew as recents.
    func seedRecents(_ paths: [String]) {
        guard recents.isEmpty, !paths.isEmpty else { return }
        recents = paths.map { Recent(kind: .folder, path: $0) }
        saveRecents()
    }

    func forget(_ recent: Recent) {
        recents.removeAll { $0 == recent }
        saveRecents()
    }

    // MARK: - Storage

    private func remember(_ kind: Recent.Kind, _ path: String) {
        let r = Recent(kind: kind, path: path)
        recents.removeAll { $0 == r }
        recents.insert(r, at: 0)
        recents = Array(recents.prefix(12))
        saveRecents()
    }

    private func saveRecents() {
        if let data = try? JSONEncoder().encode(recents) { UserDefaults.standard.set(data, forKey: Self.recentsKey) }
    }

    /// Autosaves to UserDefaults, and to the workspace file when the folder list changed.
    private func persist(writeFile: Bool = false) {
        let s = State(open: isOpen, folders: folders, file: file?.path, view: view)
        if let data = try? JSONEncoder().encode(s) { UserDefaults.standard.set(data, forKey: Self.stateKey) }
        if writeFile, let file { try? write(to: file) }
    }

    private func write(to url: URL) throws {
        let dir = url.deletingLastPathComponent().standardizedFileURL.path
        let body = FileFormat(folders: folders.map { .init(path: Self.relative($0, from: dir)) }, view: view)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        try enc.encode(body).write(to: url, options: .atomic)
    }

    /// `path` relative to `dir` when they share more than the filesystem root, else absolute.
    nonisolated static func relative(_ path: String, from dir: String) -> String {
        let a = path.split(separator: "/"), b = dir.split(separator: "/")
        var i = 0
        while i < a.count, i < b.count, a[i] == b[i] { i += 1 }
        if i == 0 { return path }
        let rel = Array(repeating: "..", count: b.count - i) + a[i...].map(String.init)
        return rel.isEmpty ? "." : rel.joined(separator: "/")
    }

    static func resolve(_ path: String, from dir: URL) -> String {
        let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : dir.appending(path: path)
        return realPath(url.standardizedFileURL.path)
    }
}
