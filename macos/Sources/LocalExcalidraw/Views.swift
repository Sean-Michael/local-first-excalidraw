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
    @State private var newName = ""

    var body: some View {
        List(selection: $model.selection) {
            ForEach(model.sections, id: \.root) { section in
                Section {
                    if section.drawings.isEmpty {
                        Text(model.search.isEmpty ? "No drawings yet" : "No matches")
                            .foregroundStyle(.tertiary)
                    }
                    ForEach(section.drawings) { d in
                        DrawingRow(drawing: d)
                            .tag(d.path)
                            .contextMenu { menu(for: d) }
                    }
                } header: {
                    Text(abbreviate(section.root)).help(section.root)
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $model.search, placement: .sidebar, prompt: "Filter")
        .alert("Rename Drawing", isPresented: Binding(get: { model.renaming != nil }, set: { if !$0 { model.renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Rename") {
                if let d = model.renaming {
                    let name = newName
                    Task { await model.rename(d, to: name) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
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

    @ViewBuilder private func menu(for d: Drawing) -> some View {
        Button("Show in Finder") { model.reveal(d.path) }
        Button("Open in Browser") { model.openInBrowser(d.path) }
        Button("Copy Path") { model.copyPath(d.path) }
        Divider()
        Button("Rename…") {
            newName = d.name
            model.renaming = d
        }
        Button("Duplicate") { Task { await model.duplicate(d.path) } }
        Divider()
        Button("Move to Trash", role: .destructive) { model.moveToTrash(d.path) }
    }
}

struct DrawingRow: View {
    let drawing: Drawing

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(drawing.name).lineLimit(1)
            HStack(spacing: 4) {
                if !drawing.folder.isEmpty {
                    Text(drawing.folder).lineLimit(1).truncationMode(.head)
                    Text("·")
                }
                Text(drawing.modified, format: .relative(presentation: .named))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
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
