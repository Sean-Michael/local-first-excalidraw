import AppKit
import SwiftUI
import WebKit

/// Owns the single web view that hosts the Excalidraw canvas served by the daemon.
///
/// The web view signs in once with a one-time login code; the resulting `HttpOnly` session cookie
/// lives in the app's own WebKit store, so switching drawings is a plain same-origin navigation.
@MainActor
final class EditorController: NSObject {
    let webView: WKWebView
    private let daemon: Daemon
    private var current: String?
    private var signedIn = false
    private var signInAttempts = 0

    init(daemon: Daemon) {
        self.daemon = daemon
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.isElementFullscreenEnabled = true
        // The page hides its own drawings sidebar: the app has a native one.
        config.userContentController.addUserScript(
            WKUserScript(source: "window.lfxEmbedded = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        #if DEBUG
        webView.isInspectable = true
        #endif
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    func show(_ path: String?) {
        current = path
        guard let path else {
            webView.loadHTMLString("", baseURL: nil)
            return
        }
        signInAttempts = 0
        load(path)
    }

    func reload() {
        if let current { load(current) }
    }

    /// Shows or hides the assistant panel, which lives in the web page beside the canvas.
    func toggleAssistant() {
        webView.evaluateJavaScript("window.lfx && window.lfx.toggleChat()")
    }

    private func load(_ path: String) {
        if signedIn {
            webView.load(URLRequest(url: daemon.editorURL(file: path)))
            return
        }
        Task {
            do {
                webView.load(URLRequest(url: try await daemon.loginURL(file: path)))
            } catch {
                AppModel.shared.alert = error.localizedDescription
            }
        }
    }

    private func isDaemon(_ url: URL) -> Bool {
        guard let host = url.host, url.port == daemon.port else { return false }
        return host == "localhost" || host == "127.0.0.1"
    }
}

extension EditorController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }
        guard let url = action.request.url else { return .cancel }
        if ["about", "blob", "data"].contains(url.scheme) { return .allow }
        if isDaemon(url) {
            // The web UI's own file list ("All drawings", the name badge): the native sidebar replaces it.
            let hasFile = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "file" } ?? false
            if url.path == "/" && !hasFile {
                AppModel.shared.selection = nil
                return .cancel
            }
            // A code link ("src/a.ts#L42") resolves against the page; the editor already asked the
            // daemon to open it in the user's code editor, so never navigate to it.
            if action.navigationType == .linkActivated && url.path != "/" { return .cancel }
            return .allow
        }
        // Help links, "Browse libraries", etc. open in the user's browser.
        if action.navigationType == .linkActivated || action.targetFrame == nil, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if !response.canShowMIMEType { return .download }
        guard response.isForMainFrame, let http = response.response as? HTTPURLResponse, let url = http.url else { return .allow }
        if http.statusCode == 401, url.path != "/login", let current, signInAttempts < 1 {
            // Session expired or the state directory was reset: sign in again.
            signedIn = false
            signInAttempts += 1
            load(current)
            return .cancel
        }
        if http.statusCode == 200, isDaemon(url) { signedIn = true }
        return .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }
}

extension EditorController: WKDownloadDelegate {
    /// Excalidraw's "Save to disk" and "Export image" fall back to downloads in WebKit; ask where to put them.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        if let current { panel.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent() }
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        try? FileManager.default.removeItem(at: url)
        return url
    }
}

extension EditorController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    /// Image insertion and library import use <input type=file>.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        return panel.runModal() == .OK ? panel.urls : nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

struct EditorView: NSViewRepresentable {
    let controller: EditorController

    func makeNSView(context: Context) -> WKWebView { controller.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
