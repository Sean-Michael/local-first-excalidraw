import AppKit
import SwiftUI

@main
struct LocalExcalidrawApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let model = AppModel.shared

    var body: some Scene {
        Window("Local Excalidraw", id: "main") {
            ContentView(model: model)
                .frame(minWidth: 760, minHeight: 480)
                .task { await model.start() }
        }
        .defaultSize(width: 1546, height: 1009)
        .defaultPosition(.center)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Drawing…") { model.showingNewDrawing = true }
                    .keyboardShortcut("n")
                    .disabled(model.phase != .ready)
                Button("Open…") { model.showOpenPanel() }
                    .keyboardShortcut("o")
                    .disabled(model.phase != .ready)
                Button("Add Folder…") { model.showAddFolderPanel() }
                    .disabled(model.phase != .ready)
            }
            CommandGroup(after: .saveItem) {
                Button("Export as SVG…") { model.export(format: "svg") }
                    .disabled(model.selection == nil)
                Button("Export as PNG…") { model.export(format: "png") }
                    .disabled(model.selection == nil)
                Divider()
                Button("Show in Finder") { model.selection.map(model.reveal) }
                    .disabled(model.selection == nil)
                Button("Open in Browser") { model.openInBrowser(model.selection) }
                    .disabled(model.phase != .ready)
            }
            CommandGroup(after: .sidebar) {
                Button("Toggle Assistant") { model.editor.toggleAssistant() }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
                    .disabled(model.selection == nil)
                Button("Reload Drawing") { model.editor.reload() }
                    .keyboardShortcut("r", modifiers: [.command, .option])
                    .disabled(model.selection == nil)
            }
        }

        Settings {
            SettingsView(model: model)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Finder double-click, drag onto the Dock icon, `open -a "Local Excalidraw" file.excalidraw`.
    func application(_ application: NSApplication, open urls: [URL]) {
        Task { @MainActor in
            for url in urls where url.pathExtension == "excalidraw" { await AppModel.shared.open(url) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { AppModel.shared.shutdown() }
    }
}
