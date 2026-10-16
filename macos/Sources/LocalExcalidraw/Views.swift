import SwiftUI

struct ContentView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationSplitView {
            Sidebar(model: model)
                .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 400)
        } detail: {
            detail
        }
        .navigationTitle(model.selectedDrawing?.name ?? "Local Excalidraw")
        .navigationSubtitle(model.selectedDrawing.map { abbreviate(($0.path as NSString).deletingLastPathComponent) } ?? "")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let d = model.selectedDrawing {
                    Button { model.editor.toggleAssistant() } label: {
                        Label("Assistant", systemImage: "sparkles")
                    }
                    .help("Show or hide the assistant (⇧⌘A)")
                    Menu {
                        Button("Export as SVG…") { model.export(format: "svg") }
                        Button("Export as PNG…") { model.export(format: "png") }
                    } label: {
                        Label("Export", systemImage: "square.and.arrow.up")
                    }
                    .help("Export to an image file")
                    Button { model.reveal(d.path) } label: {
                        Label("Show in Finder", systemImage: "folder")
                    }
                    .help("Show in Finder")
                }
            }
        }
        .sheet(isPresented: $model.showingNewDrawing) {
            NewDrawingSheet(model: model)
        }
        .alert("Something went wrong", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
            Button("OK") { model.alert = nil }
        } message: {
            Text(model.alert ?? "")
        }
        .alert("An older daemon is running", isPresented: Binding(get: { model.outdatedDaemon != nil }, set: { if !$0 { model.outdatedDaemon = nil } })) {
            Button("Restart Daemon") { Task { await model.restartDaemon() } }
            Button("Not Now", role: .cancel) {}
        } message: {
            Text("lfx v\(model.outdatedDaemon ?? "?") is running, started outside this app. Restart it to use this app's version. Open editors reconnect on their own.")
        }
    }

    @ViewBuilder private var detail: some View {
        switch model.phase {
        case .starting:
            ProgressView("Starting the local daemon…")
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't start", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message).textSelection(.enabled)
            } actions: {
                Button("Try Again") { Task { await model.start() } }
            }
        case .ready:
            ZStack {
                EditorView(controller: model.editor)
                    .opacity(model.selection == nil ? 0 : 1)
                if model.selection == nil {
                    ContentUnavailableView {
                        Label("No Drawing Selected", systemImage: "scribble.variable")
                    } description: {
                        Text("Pick a drawing in the sidebar, or create a new one. Files stay on this Mac.")
                    } actions: {
                        Button("New Drawing") { model.showingNewDrawing = true }
                            .keyboardShortcut(.defaultAction)
                    }
                }
            }
        }
    }
}

struct Sidebar: View {
    @Bindable var model: AppModel
    @State private var promptValue = ""

    var body: some View {
        List(selection: $model.selection) {
            ForEach(model.tree) { root in
                Section {
                    if root.children.isEmpty {
                        Text(model.search.isEmpty ? "No drawings yet" : "No matches")
                            .foregroundStyle(.tertiary)
                    }
                    ForEach(root.children) { node in
                        TreeRow(model: model, node: node)
                    }
                } header: {
                    Text(abbreviate(root.path))
                        .help(root.path)
                        .contextMenu { FolderMenu(model: model, folder: root) }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $model.search, placement: .sidebar, prompt: "Filter")
        .onChange(of: model.selection) { model.revealSelection() }
        .onChange(of: model.drawings) { model.revealSelection() }
        .alert(model.prompt?.title ?? "", isPresented: Binding(get: { model.prompt != nil }, set: { if !$0 { model.prompt = nil } })) {
            TextField("Name", text: $promptValue)
            Button(model.prompt?.confirm ?? "OK") {
                if let p = model.prompt {
                    let value = promptValue
                    Task { await p.action(value) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .onChange(of: model.prompt?.title) { promptValue = model.prompt?.value ?? "" }
        .overlay {
            if model.phase == .ready && model.roots.isEmpty { ProgressView() }
        }
        .toolbar {
            ToolbarItem {
                Button { model.showingNewDrawing = true } label: {
                    Label("New Drawing", systemImage: "square.and.pencil")
                }
                .help("New Drawing")
                .disabled(model.phase != .ready)
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button { model.showAddFolderPanel() } label: {
                    Label("Add Folder", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .help("Add a folder of drawings, such as a project's docs/diagrams")
                Spacer()
            }
            .padding(10)
            .disabled(model.phase != .ready)
        }
    }
}

/// A folder (a disclosure group of its children) or a drawing (a selectable row).
struct TreeRow: View {
    let model: AppModel
    let node: TreeNode

    var body: some View {
        if let d = node.drawing {
            DrawingRow(drawing: d)
                .tag(d.path)
                .contextMenu { DrawingMenu(model: model, drawing: d) }
        } else {
            DisclosureGroup(isExpanded: Binding(get: { model.isExpanded(node) }, set: { model.setExpanded(node, $0) })) {
                ForEach(node.children) { child in
                    TreeRow(model: model, node: child)
                }
            } label: {
                HStack {
                    Label(node.name, systemImage: "folder")
                    Spacer()
                    if node.count > 0 {
                        Text("\(node.count)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .help(node.path)
                .contextMenu { FolderMenu(model: model, folder: node) }
            }
        }
    }
}

struct DrawingMenu: View {
    let model: AppModel
    let drawing: Drawing

    var body: some View {
        Button("Show in Finder") { model.reveal(drawing.path) }
        Button("Open in Browser") { model.openInBrowser(drawing.path) }
        Button("Copy Path") { model.copyPath(drawing.path) }
        Divider()
        Button("Rename…") { model.askRename(drawing) }
        Button("Duplicate") { Task { await model.duplicate(drawing.path) } }
        Menu("Move To") {
            ForEach(model.moveTargets(for: drawing), id: \.self) { dir in
                Button(abbreviate(dir)) { Task { await model.move(drawing, to: dir) } }
            }
        }
        Divider()
        Button("Move to Trash", role: .destructive) { model.moveToTrash(drawing.path) }
    }
}

struct FolderMenu: View {
    let model: AppModel
    let folder: TreeNode

    var body: some View {
        Button("New Drawing Here…") { model.askNewDrawing(in: folder) }
        Button("New Folder…") { model.askNewFolder(in: folder) }
        if !folder.isRoot {
            Button("Rename Folder…") { model.askRenameFolder(folder) }
        }
        Divider()
        Button("Show in Finder") { model.reveal(folder.path) }
    }
}

struct DrawingRow: View {
    let drawing: Drawing

    var body: some View {
        Label {
            HStack {
                Text(drawing.name).lineLimit(1)
                Spacer()
                Text(drawing.modified, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        } icon: {
            Image(systemName: "scribble.variable")
        }
        .help(drawing.path)
    }
}

struct NewDrawingSheet: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var root = ""

    var body: some View {
        Form {
            TextField("Name", text: $name, prompt: Text("architecture or sub/dir/name"))
            Picker("Folder", selection: $root) {
                ForEach(model.roots, id: \.self) { r in Text(abbreviate(r)).tag(r) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .fixedSize(horizontal: false, vertical: true)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") {
                    let (n, r) = (name, root)
                    dismiss()
                    Task { await model.createDrawing(name: n, in: r) }
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || root.isEmpty)
            }
        }
        .navigationTitle("New Drawing")
        .onAppear {
            // Default to the folder of the drawing that's open, else the first root.
            root = model.selectedDrawing?.root ?? model.roots.first ?? ""
        }
    }
}

struct SettingsView: View {
    @AppStorage(Prefs.keepDaemonRunning) private var keepRunning = false
    let model: AppModel

    var body: some View {
        Form {
            Section {
                Toggle("Keep the daemon running after quitting", isOn: $keepRunning)
                Text("Off: quitting stops the daemon, whoever started it. Coding agents start it again when they need it, and it stops itself after 30 idle minutes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Folders") {
                ForEach(model.roots, id: \.self) { r in
                    Text(abbreviate(r)).help(r)
                }
                Button("Add Folder…") { model.showAddFolderPanel() }
            }
            Section("Coding agents") {
                LabeledContent("Claude Code") {
                    Text("claude mcp add excalidraw -- lfx mcp").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
                LabeledContent("Daemon") {
                    Text(model.daemon.webBase.absoluteString).textSelection(.enabled)
                }
                LabeledContent("State") {
                    Text(abbreviate(model.daemon.stateDir.path)).textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
    }
}

func abbreviate(_ path: String) -> String {
    (path as NSString).abbreviatingWithTildeInPath
}
