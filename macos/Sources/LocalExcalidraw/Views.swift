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
        .navigationTitle(model.selectedDrawing?.name ?? (model.workspace.isOpen ? model.workspace.title : "Local Excalidraw"))
        .navigationSubtitle(model.selectedDrawing != nil && model.workspace.isOpen ? model.workspace.title : "")
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
                if model.selection == nil && !model.workspace.isOpen {
                    WelcomeView(model: model)
                } else if model.selection == nil {
                    ContentUnavailableView {
                        Label("No Drawing Selected", systemImage: "scribble.variable")
                    } description: {
                        Text("Pick a drawing in the sidebar, or create a new one. Files stay on this Mac.")
                    } actions: {
                        Button("New Drawing") { model.newDrawing() }
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

    private var searching: Bool { !model.search.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        List(selection: Binding(get: { model.listSelection }, set: { model.select($0) })) {
            if let d = model.looseDrawing {
                // Like VS Code's Open Editors: the open drawing, when no workspace folder holds it.
                Section("Open Drawing") {
                    DrawingRow(drawing: d)
                        .tag(d.path)
                        .draggable(URL(fileURLWithPath: d.path))
                        .contextMenu { DrawingMenu(model: model, drawing: d) }
                }
            }
            ForEach(model.tree) { root in
                Section(isExpanded: Binding(get: { model.isExpanded(root) }, set: { model.setExpanded(root, $0) })) {
                    if root.children.isEmpty {
                        if searching {
                            Text("No matches").foregroundStyle(.tertiary)
                        } else {
                            EmptyRootRow(model: model, root: root.path)
                        }
                    }
                    ForEach(root.children) { node in
                        TreeRow(model: model, node: node)
                    }
                } header: {
                    RootHeader(model: model, root: root)
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $model.search, placement: .sidebar, prompt: "Filter")
        // Finder folders dropped on empty space become project folders.
        .dropDestination(for: URL.self) { urls, _ in model.drop(urls, into: nil) }
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
            if model.phase == .ready && model.roots.isEmpty {
                if model.loaded {
                    ContentUnavailableView {
                        Label(model.workspace.isOpen ? "No Folders in Workspace" : "No Folder Open", systemImage: "folder.badge.plus")
                    } description: {
                        Text("Add a folder of drawings, such as a project's docs/diagrams, or drop one here from Finder.")
                    } actions: {
                        if model.workspace.isOpen {
                            Button("Add Folder to Workspace…") { model.showAddFolderPanel() }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                        } else {
                            Button("Open Folder…") { model.showOpenFolderPanel() }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .toolbar {
            ToolbarItem {
                Button { model.newDrawing() } label: {
                    Label("New Drawing", systemImage: "square.and.pencil")
                }
                .help("New Drawing (⌘N)")
                .disabled(model.phase != .ready || model.targetFolder == nil)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.workspace.isOpen { WorkspaceHeader(model: model) }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Menu {
                    NewItemMenu(model: model)
                } label: {
                    Image(systemName: "plus")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("Add")
                .help("New drawing, new folder, or add a folder to the workspace")
                Spacer()
            }
            .padding(10)
            .disabled(model.phase != .ready)
        }
    }
}

/// New Drawing, New Folder, then Add Folder to Workspace: the sidebar's "+" menu (the File menu starts the same).
struct NewItemMenu: View {
    let model: AppModel

    var body: some View {
        NewDrawingButtons(model: model)
        Divider()
        Button("Add Folder to Workspace…") { model.showAddFolderPanel() }
            .disabled(model.phase != .ready)
    }
}

struct NewDrawingButtons: View {
    let model: AppModel

    var body: some View {
        Button("New Drawing…") { model.newDrawing() }
            .keyboardShortcut("n")
            .disabled(model.phase != .ready)
        Button("New Folder…") { model.newFolder() }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .disabled(model.phase != .ready || model.targetFolder == nil)
    }
}

/// The workspace's name above the tree, with its menu.
struct WorkspaceHeader: View {
    let model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "square.stack")
                .foregroundStyle(.secondary)
            Text(model.workspace.title)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(model.workspace.file.map { abbreviate($0.path) } ?? "Not saved yet. Save Workspace As… to keep it as a file.")
            Spacer(minLength: 4)
            Menu {
                ViewOptionsMenu(view: Bindable(model.workspace).view)
            } label: {
                Image(systemName: "line.3.horizontal.decrease")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Sort and view options: \(model.workspace.view.summary)")
            Menu {
                Button("Add Folder to Workspace…") { model.showAddFolderPanel() }
                Button("Save Workspace As…") { model.showSaveWorkspacePanel() }
                if let f = model.workspace.file {
                    Button("Show Workspace File in Finder") { model.reveal(f.path) }
                }
                Divider()
                Button("Close Workspace") { model.closeWorkspace() }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Workspace")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

/// Sort By, Folders, Show As and the toggles, like Finder's view options and VS Code's
/// explorer.sortOrder / explorer.compactFolders.
struct ViewOptionsMenu: View {
    @Binding var view: ViewOptions

    var body: some View {
        Picker("Sort By", selection: $view.sortBy) {
            Text("Name").tag(ViewOptions.SortBy.name)
            Text("Date Modified").tag(ViewOptions.SortBy.modified)
        }
        .pickerStyle(.inline)
        Picker("Folders", selection: $view.folders) {
            Text("On Top").tag(ViewOptions.FolderPlacement.top)
            Text("Mixed with Drawings").tag(ViewOptions.FolderPlacement.mixed)
            Text("Below Drawings").tag(ViewOptions.FolderPlacement.bottom)
        }
        .pickerStyle(.inline)
        .disabled(view.layout == .list)
        Picker("Show As", selection: $view.layout) {
            Text("Folder Tree").tag(ViewOptions.Layout.tree)
            Text("Flat List with Paths").tag(ViewOptions.Layout.list)
        }
        .pickerStyle(.inline)
        Divider()
        Toggle("Compact Folders", isOn: $view.compactFolders)
            .disabled(view.layout == .list)
        Toggle("Show All Folders", isOn: $view.showAllFolders)
            .disabled(view.layout == .list)
    }
}

/// No workspace open: start drawing right away, or open a folder or a saved workspace.
struct WelcomeView: View {
    let model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 6) {
                    Image(systemName: "scribble.variable")
                        .font(.system(size: 40))
                        .foregroundStyle(.tint)
                    Text("Local Excalidraw").font(.largeTitle.weight(.semibold))
                    Text("Drawings stay on this Mac, where you and your coding agents can both reach them.")
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Start").font(.title3.weight(.semibold))
                    WelcomeAction(title: "New Drawing", detail: "A blank untitled drawing, saved in \(abbreviate(model.defaultRoot ?? "~/Excalidraw"))", icon: "square.and.pencil") {
                        Task { await model.newUntitledDrawing() }
                    }
                    WelcomeAction(title: "Open Folder…", detail: "Show a folder's drawings, such as a project's docs/diagrams", icon: "folder") {
                        model.showOpenFolderPanel()
                    }
                    WelcomeAction(title: "Open Workspace…", detail: "Several folders, saved as a .lfx-workspace file", icon: "square.stack") {
                        model.showOpenWorkspacePanel()
                    }
                }
                if !model.workspace.recents.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Recent").font(.title3.weight(.semibold))
                        ForEach(model.workspace.recents) { r in
                            WelcomeAction(title: r.name, detail: abbreviate(r.path), icon: r.kind == .workspace ? "square.stack" : "folder") {
                                model.openRecent(r)
                            }
                            .contextMenu {
                                Button("Show in Finder") { model.reveal(r.path) }
                                Button("Remove from Recents") { model.workspace.forget(r) }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 460, alignment: .leading)
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .disabled(model.phase != .ready)
    }
}

struct WelcomeAction: View {
    let title: String
    let detail: String
    let icon: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
            .background(hovering ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// A project folder's section header: its path, and a "+" menu on hover.
struct RootHeader: View {
    let model: AppModel
    let root: TreeNode
    @State private var hovering = false
    @State private var targeted = false

    var body: some View {
        HStack(spacing: 4) {
            Text(abbreviate(root.path))
                .lineLimit(1)
                .truncationMode(.head)
                .help(root.path)
            Spacer(minLength: 4)
            Menu {
                Button("New Drawing…") { model.newDrawing(in: root.path) }
                Button("New Folder…") { model.askNewFolder(in: root.path) }
            } label: {
                Image(systemName: "plus")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("New drawing or folder in \(abbreviate(root.path))")
            .opacity(hovering ? 1 : 0)
            .allowsHitTesting(hovering)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu { FolderMenu(model: model, folder: root) }
        .dropDestination(for: URL.self) { urls, _ in model.drop(urls, into: root.path) } isTargeted: { targeted = $0 }
        .background(DropHighlight(on: targeted))
    }
}

/// An empty project folder: offer the two things to do instead of grey text.
struct EmptyRootRow: View {
    let model: AppModel
    let root: String

    var body: some View {
        HStack(spacing: 12) {
            Button { model.newDrawing(in: root) } label: {
                Label("New Drawing", systemImage: "plus")
            }
            Button { model.askNewFolder(in: root) } label: {
                Label("New Folder", systemImage: "folder.badge.plus")
            }
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .selectionDisabled()
    }
}

struct DropHighlight: View {
    let on: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 5)
            .strokeBorder(Color.accentColor, lineWidth: 2)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
            .opacity(on ? 1 : 0)
    }
}

/// A folder (a disclosure group of its children) or a drawing (a selectable row).
/// Folders carry a tinted filled icon and a drawing count; drawings a quiet icon and no trailing detail,
/// so the two never look alike at any depth.
struct TreeRow: View {
    let model: AppModel
    let node: TreeNode
    @State private var targeted = false

    var body: some View {
        if let d = node.drawing {
            DrawingRow(drawing: d, location: showsLocation ? node.location : "", showsDate: model.workspace.view.sortBy == .modified)
                .tag(d.path)
                .draggable(URL(fileURLWithPath: d.path))
                .contextMenu { DrawingMenu(model: model, drawing: d) }
                // Dropping on a drawing moves into the folder it's in, as in VS Code.
                .dropDestination(for: URL.self) { urls, _ in
                    model.drop(urls, into: (d.path as NSString).deletingLastPathComponent)
                }
        } else {
            DisclosureGroup(isExpanded: Binding(get: { model.isExpanded(node) }, set: { model.setExpanded(node, $0) })) {
                ForEach(node.children) { child in
                    TreeRow(model: model, node: child)
                }
                if node.children.isEmpty {
                    Text("Empty").foregroundStyle(.tertiary).selectionDisabled()
                }
            } label: {
                HStack {
                    Label {
                        Text(node.name).lineLimit(1)
                    } icon: {
                        Image(systemName: "folder.fill").foregroundStyle(.tint)
                    }
                    Spacer()
                    if node.count > 0 {
                        Text("\(node.count)")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                .help("\(node.path)\n\(node.count == 1 ? "1 drawing" : "\(node.count) drawings")")
                .contextMenu { FolderMenu(model: model, folder: node) }
                .dropDestination(for: URL.self) { urls, _ in model.drop(urls, into: node.path) } isTargeted: { targeted = $0 }
                .background(DropHighlight(on: targeted).padding(-3))
            }
            .tag(node.path)
        }
    }

    /// The tree says where a drawing lives, except in a flat list, while filtering (folders
    /// expand around the matches), and with folders mixed in among drawings.
    private var showsLocation: Bool {
        let v = model.workspace.view
        return !model.search.trimmingCharacters(in: .whitespaces).isEmpty || v.layout == .list || v.folders == .mixed
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
        Button("New Drawing…") { model.newDrawing(in: folder.path) }
        Button("New Folder…") { model.askNewFolder(in: folder.path) }
        if !folder.isRoot {
            Button("Rename Folder…") { model.askRenameFolder(folder) }
        }
        Divider()
        Button("Show in Finder") { model.reveal(folder.path) }
        Button("Copy Path") { model.copyPath(folder.path) }
        if folder.isRoot {
            Divider()
            Button("Remove Folder from Workspace") { model.removeFromWorkspace(folder.path) }
        }
    }
}

struct DrawingRow: View {
    let drawing: Drawing
    /// The folder it's in below its root, shown dimmed when the tree alone doesn't say ("" hides it).
    var location = ""
    /// Sorted by date: show when it changed, since that's what orders the rows.
    var showsDate = false

    var body: some View {
        Label {
            HStack(spacing: 6) {
                Text(drawing.name).lineLimit(1)
                if !location.isEmpty {
                    Text(location)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                if showsDate {
                    Spacer(minLength: 4)
                    Text(drawing.modified, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        } icon: {
            Image(systemName: "scribble.variable").foregroundStyle(.secondary)
        }
        .help("\(drawing.path)\nModified \(drawing.modified.formatted(date: .abbreviated, time: .shortened))")
    }
}

struct NewDrawingSheet: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var folder = ""

    var body: some View {
        Form {
            TextField("Name", text: $name, prompt: Text("architecture or sub/dir/name"))
            Picker("Location", selection: $folder) {
                ForEach(model.folderChoices, id: \.root) { group in
                    Section(abbreviate(group.root)) {
                        Text("Top level").tag(group.root)
                        ForEach(group.folders, id: \.self) { f in
                            Text(String(f.dropFirst(group.root.count + 1))).tag(f)
                        }
                    }
                }
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
                    let (n, f) = (name, folder)
                    dismiss()
                    Task { await model.createDrawing(name: n, in: f) }
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || folder.isEmpty)
            }
        }
        .navigationTitle("New Drawing")
        .onAppear {
            // Start where the sidebar points: the picked folder, else the open drawing's folder, else the first root.
            folder = model.newDrawingFolder ?? model.targetFolder ?? ""
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
            Section("Workspace Folders") {
                ForEach(model.roots, id: \.self) { r in
                    Text(abbreviate(r)).help(r)
                }
                Button("Add Folder to Workspace…") { model.showAddFolderPanel() }
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
