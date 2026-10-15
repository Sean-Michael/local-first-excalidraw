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
    var selection: String? {
        didSet { if selection != oldValue { editor.show(selection) } }
    }
    var search = ""
    var showingNewDrawing = false
    var alert: String?

    /// Files handed to the app (Finder, `open -a`) before the daemon was ready.
    private var pendingOpens: [URL] = []
    private var pollTask: Task<Void, Never>?

    private init() {
        editor = EditorController(daemon: daemon)
    }

    var selectedDrawing: Drawing? { drawings.first { $0.path == selection } }

    /// Drawings grouped by root, filtered by the search field. Every root is listed, even when empty.
    var sections: [(root: String, drawings: [Drawing])] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return roots.map { root in
            (root, drawings.filter { $0.root == root && (q.isEmpty || $0.path.lowercased().contains(q)) })
        }
    }

    // MARK: - Lifecycle

    func start() async {
        phase = .starting
        do {
            try await daemon.ensure()
            phase = .ready
            await refresh()
            let queued = pendingOpens
            pendingOpens = []
            for url in queued { await open(url) }
            startPolling()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func shutdown() {
        pollTask?.cancel()
        if !UserDefaults.standard.bool(forKey: Prefs.keepDaemonRunning) { daemon.stop() }
    }

    /// Agents and other editors create drawings too, so keep the sidebar current while the app is in front.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, NSApp.isActive else { continue }
                await self.refresh()
            }
        }
    }

    func refresh() async {
        guard phase == .ready else { return }
        do {
            let list = try await daemon.files()
            if list.roots != roots { roots = list.roots }
            if list.drawings != drawings { drawings = list.drawings }
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
