import AppKit
import Observation
import UniformTypeIdentifiers

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case starting
        case ready
        case failed(String)
    }

    static let shared = AppModel()

    let daemon = Daemon()
    let editor: EditorController

    var phase: Phase = .starting
    var roots: [String] = []
    var drawings: [Drawing] = []
    var folders: [Folder] = []
    /// An older daemon someone started on purpose is running; offer to restart it.
    var outdatedDaemon: String?
    /// A one-line text prompt (rename, new folder, ...), shown as an alert.
    var prompt: Prompt?
    /// Open folders in the sidebar tree; roots start open.
    var expanded: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "expandedFolders") ?? []) {
        didSet { UserDefaults.standard.set(Array(expanded), forKey: "expandedFolders") }
    }
    var collapsedRoots: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "collapsedRoots") ?? []) {
        didSet { UserDefaults.standard.set(Array(collapsedRoots), forKey: "collapsedRoots") }
    }

    struct Prompt {
        let title: String
        var value: String
        let confirm: String
        let action: (String) async -> Void
    }
    var selection: String? {
        didSet { if selection != oldValue { editor.show(selection) } }
    }
    var search = ""
    var showingNewDrawing = false
    var alert: String?

    /// Files handed to the app (Finder, `open -a`) before the daemon was ready.
    private var pendingOpens: [URL] = []
    private var eventTask: Task<Void, Never>?

    private init() {
        editor = EditorController(daemon: daemon)
    }

    var selectedDrawing: Drawing? { drawings.first { $0.path == selection } }

    /// The sidebar tree: one per root, by folder, filtered by the search field.
    var tree: [TreeNode] {
        DrawingTree.build(roots: roots, drawings: drawings, folders: folders, filter: search)
    }

    func isExpanded(_ node: TreeNode) -> Bool {
        if !search.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        return node.isRoot ? !collapsedRoots.contains(node.path) : expanded.contains(node.path)
    }

    func setExpanded(_ node: TreeNode, _ open: Bool) {
        if node.isRoot {
            if open { collapsedRoots.remove(node.path) } else { collapsedRoots.insert(node.path) }
        } else if open {
            expanded.insert(node.path)
        } else {
            expanded.remove(node.path)
        }
    }

    /// Expands the folders down to the selected drawing.
    func revealSelection() {
        guard let s = selection else { return }
        let need = DrawingTree.ancestors(of: s, in: tree)
        guard let root = need.first else { return }
        if collapsedRoots.contains(root) { collapsedRoots.remove(root) }
        let missing = Set(need.dropFirst()).subtracting(expanded)
        if !missing.isEmpty { expanded.formUnion(missing) }
    }

    // MARK: - Lifecycle

    func start() async {
        phase = .starting
        do {
            outdatedDaemon = try await daemon.ensure()
            phase = .ready
            await refresh()
            let queued = pendingOpens
            pendingOpens = []
            for url in queued { await open(url) }
            watchChanges()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func restartDaemon() async {
        outdatedDaemon = nil
        phase = .starting
        do {
            try await daemon.restart()
            phase = .ready
            await refresh()
            editor.reload()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func shutdown() {
        eventTask?.cancel()
        if !UserDefaults.standard.bool(forKey: Prefs.keepDaemonRunning) { daemon.stop() }
    }

    /// Agents and other editors create drawings too: the daemon says when the drawing set changes.
    /// If the stream drops (daemon restarted, or too old to have one), poll every few seconds instead.
    private func watchChanges() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    guard let lines = try await self?.daemon.eventLines() else { return }
                    for try await line in lines where line == "event: files-changed" {
                        await self?.refresh()
                    }
                } catch {
                    try? await Task.sleep(for: .seconds(3))
                }
                guard let self else { return }
                if NSApp.isActive { await self.refresh() }
            }
        }
    }

    func refresh() async {
        guard phase == .ready else { return }
        do {
            let list = try await daemon.files()
            if list.roots != roots { roots = list.roots }
            if list.drawings != drawings { drawings = list.drawings }
            let f = list.folders ?? []
            if f != folders { folders = f }
        } catch {
            // The daemon went away (`lfx stop`, crash). Bring it back.
            if (try? await daemon.healthy()) != true { await start() }
        }
    }

    // MARK: - Actions

    func open(_ url: URL) async {
        guard phase == .ready else {
            pendingOpens.append(url)
            return
        }
        do {
            try await daemon.registerRoot(url.deletingLastPathComponent())
            await refresh()
            selection = realPath(url.path)
        } catch {
            alert = error.localizedDescription
        }
    }

    func createDrawing(name: String, in root: String) async {
        var clean = name.trimmingCharacters(in: .whitespaces)
        if clean.hasSuffix(".excalidraw") { clean = String(clean.dropLast(".excalidraw".count)) }
        guard !clean.isEmpty else { return }
        do {
            let path = try await daemon.create(URL(fileURLWithPath: root).appending(path: clean + ".excalidraw"))
            await refresh()
            selection = path
        } catch {
            alert = error.localizedDescription
        }
    }

    func showOpenPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.excalidraw]
        panel.allowsMultipleSelection = false
        panel.message = "Open an Excalidraw drawing. Its folder is added to the sidebar."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await open(url) }
    }

    func showAddFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "Add Folder"
        panel.message = "Drawings in this folder (and its subfolders) will appear in the sidebar."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await daemon.registerRoot(url)
                await refresh()
            } catch {
                alert = error.localizedDescription
            }
        }
    }

    func export(format: String) {
        guard let d = selectedDrawing else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [format == "svg" ? .svg : .png]
        panel.nameFieldStringValue = d.name + (format == "svg" ? ".excalidraw.svg" : ".png")
        panel.directoryURL = URL(fileURLWithPath: d.path).deletingLastPathComponent()
        if format == "svg" { panel.message = "The drawing is embedded in the SVG, so it stays editable." }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await daemon.render(file: d.path, format: format).write(to: url, options: .atomic)
            } catch {
                alert = error.localizedDescription
            }
        }
    }

    func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func copyPath(_ path: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
    }

    func openInBrowser(_ path: String?) {
        Task {
            do {
                NSWorkspace.shared.open(try await daemon.loginURL(file: path))
            } catch {
                alert = error.localizedDescription
            }
        }
    }

    func rename(_ d: Drawing, to name: String) async {
        var clean = name.trimmingCharacters(in: .whitespaces)
        if clean.hasSuffix(".excalidraw") { clean = String(clean.dropLast(".excalidraw".count)) }
        guard !clean.isEmpty, clean != d.name else { return }
        let dir = (d.path as NSString).deletingLastPathComponent
        do {
            let path = try await daemon.rename(d.path, to: (dir as NSString).appendingPathComponent(clean + ".excalidraw"))
            await refresh()
            if selection == d.path { selection = path }
        } catch {
            alert = error.localizedDescription
        }
    }

    func move(_ d: Drawing, to dir: String) async {
        do {
            let path = try await daemon.move(d.path, to: dir)
            await refresh()
            if selection == d.path { selection = path }
        } catch {
            alert = error.localizedDescription
        }
    }

    /// Folders a drawing can move to: every root and listed folder except its own.
    func moveTargets(for d: Drawing) -> [String] {
        let here = (d.path as NSString).deletingLastPathComponent
        return (roots + folders.map(\.path)).filter { $0 != here }
    }

    func askNewDrawing(in folder: TreeNode) {
        prompt = Prompt(title: "New Drawing in \(folder.name)", value: "", confirm: "Create") { [weak self] name in
            await self?.createDrawing(name: name, in: folder.path)
        }
    }

    func askNewFolder(in folder: TreeNode) {
        prompt = Prompt(title: "New Folder in \(folder.name)", value: "", confirm: "Create") { [weak self] name in
            guard let self else { return }
            let clean = name.trimmingCharacters(in: .whitespaces)
            guard !clean.isEmpty else { return }
            do {
                _ = try await self.daemon.newFolder((folder.path as NSString).appendingPathComponent(clean))
                self.setExpanded(folder, true)
                await self.refresh()
            } catch {
                self.alert = error.localizedDescription
            }
        }
    }

    func askRename(_ d: Drawing) {
        prompt = Prompt(title: "Rename Drawing", value: d.name, confirm: "Rename") { [weak self] name in
            await self?.rename(d, to: name)
        }
    }

    func askRenameFolder(_ folder: TreeNode) {
        prompt = Prompt(title: "Rename Folder", value: folder.name, confirm: "Rename") { [weak self] name in
            guard let self else { return }
            let clean = name.trimmingCharacters(in: .whitespaces)
            guard !clean.isEmpty, clean != folder.name else { return }
            do {
                let to = try await self.daemon.renameFolder(folder.path, to: clean)
                if let s = self.selection, s.hasPrefix(folder.path + "/") { self.selection = to + s.dropFirst(folder.path.count) }
                self.expanded = Set(self.expanded.map { $0 == folder.path || $0.hasPrefix(folder.path + "/") ? to + $0.dropFirst(folder.path.count) : $0 })
                await self.refresh()
            } catch {
                self.alert = error.localizedDescription
            }
        }
    }

    func duplicate(_ path: String) async {
        do {
            let copy = try await daemon.duplicate(path)
            await refresh()
            selection = copy
        } catch {
            alert = error.localizedDescription
        }
    }

    func moveToTrash(_ path: String) {
        NSWorkspace.shared.recycle([URL(fileURLWithPath: path)]) { [weak self] _, error in
            Task { @MainActor in
                guard let self else { return }
                if let error { self.alert = error.localizedDescription }
                if self.selection == path { self.selection = nil }
                await self.refresh()
            }
        }
    }
}

extension UTType {
    static let excalidraw = UTType(filenameExtension: "excalidraw", conformingTo: .json) ?? .json
}

/// The daemon canonicalises paths with realpath, so match it (e.g. /tmp -> /private/tmp).
func realPath(_ path: String) -> String {
    guard let p = realpath(path, nil) else { return path }
    defer { free(p) }
    return String(cString: p)
}

enum Prefs {
    static let keepDaemonRunning = "keepDaemonRunning"
}
