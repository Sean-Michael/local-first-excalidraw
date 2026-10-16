import Foundation

/// Talks to the `lfx` daemon over loopback HTTP with the bearer token, and starts it when needed.
///
/// The app shares the daemon, token and state directory with the `lfx` CLI and the MCP server,
/// so an agent and the native window always see the same drawings.
final class Daemon: @unchecked Sendable {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    let port: Int
    let stateDir: URL
    /// Loopback base for API calls from this process.
    let apiBase: URL
    /// What the web view loads. "localhost" is a secure context, which Excalidraw's clipboard needs.
    let webBase: URL

    private var process: Process?
    private var token: String?
    private let session: URLSession

    init() {
        let env = ProcessInfo.processInfo.environment
        port = Int(env["LFX_PORT"] ?? "") ?? 7467
        stateDir = URL(fileURLWithPath: env["LFX_STATE_DIR"] ?? NSHomeDirectory() + "/.local-first-excalidraw")
        apiBase = URL(string: "http://127.0.0.1:\(port)")!
        webBase = URL(string: "http://localhost:\(port)")!
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 60
        session = URLSession(configuration: cfg)
    }

    var ownsProcess: Bool { process?.isRunning == true }

    // MARK: - Lifecycle

    /// Reuses a running daemon (started by the CLI, an agent, or a previous launch) or starts one.
    func ensure() async throws {
        if try await healthy() {
            try loadToken()
            return
        }
        try start()
        for _ in 0..<60 {
            try await Task.sleep(for: .milliseconds(150))
            if try await healthy() {
                try loadToken()
                return
            }
            if let p = process, !p.isRunning { break }
        }
        throw Failure(message: "The daemon failed to start. See \(logURL.path).\n\n\(logTail())")
    }

    /// Stops the daemon, including one the CLI or an agent started that this app adopted.
    /// Agents start it again on demand.
    func stop() {
        if let p = process, p.isRunning {
            p.terminate()
            p.waitUntilExit()
            process = nil
            return
        }
        guard let token else { return }
        var req = URLRequest(url: apiBase.appending(path: "/api/shutdown"))
        req.httpMethod = "POST"
        req.timeoutInterval = 2
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        // Called while the app terminates, so wait for the request instead of returning early.
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 2.5)
    }

    func healthy() async throws -> Bool {
        var req = URLRequest(url: apiBase.appending(path: "/api/health"))
        req.timeoutInterval = 1.5
        guard let (data, _) = try? await session.data(for: req) else { return false }
        let name = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["name"] as? String
        if name != "local-first-excalidraw" {
            throw Failure(message: "Port \(port) is in use by another program.")
        }
        return true
    }

    private var logURL: URL { stateDir.appending(path: "daemon.log") }

    private func start() throws {
        let runtime = try Runtime.locate()
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()

        let p = Process()
        p.executableURL = runtime.node
        p.arguments = [runtime.cli.path, "serve"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Runtime.searchPath
        env["LFX_NO_BROWSER"] = "1"
        env.removeValue(forKey: "LFX_IDLE_EXIT_MIN")
        // Unless the user wants it kept, the daemon exits with this app, even after a crash or force quit.
        if !UserDefaults.standard.bool(forKey: Prefs.keepDaemonRunning) {
            env["LFX_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        }
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = log
        p.standardError = log
        try p.run()
        process = p
    }

    private func loadToken() throws {
        let file = stateDir.appending(path: "token")
        guard let t = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              t.count >= 32 else {
            throw Failure(message: "Could not read the daemon token at \(file.path).")
        }
        token = t
    }

    private func logTail() -> String {
        guard let s = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
        return s.split(separator: "\n").suffix(8).joined(separator: "\n")
    }

    // MARK: - API

    func request<T: Decodable>(_ method: String, _ route: String, body: [String: Any]? = nil,
                               as: T.Type = T.self) async throws -> T {
        guard let token else { throw Failure(message: "Not connected to the daemon.") }
        var req = URLRequest(url: apiBase.appending(path: route))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, res) = try await session.data(for: req)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw Failure(message: msg ?? "Daemon returned HTTP \(status).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func files() async throws -> FileList {
        try await request("GET", "/api/files")
    }

    func registerRoot(_ dir: URL) async throws {
        let _: Empty = try await request("POST", "/api/roots", body: ["path": dir.path])
    }

    func create(_ file: URL) async throws -> String {
        let r: PathResult = try await request("POST", "/api/new", body: ["path": file.path])
        return r.path
    }

    /// Renames or moves a drawing; open tabs of it follow.
    func rename(_ path: String, to newPath: String) async throws -> String {
        let r: PathResult = try await request("POST", "/api/files/rename", body: ["path": path, "to": newPath])
        return r.path
    }

    /// Copies a drawing next to itself ("name copy") and returns the copy's path.
    func duplicate(_ path: String) async throws -> String {
        let r: PathResult = try await request("POST", "/api/files/duplicate", body: ["path": path])
        return r.path
    }

    /// One-time sign-in link for the web view; it lands on the given drawing.
    func loginURL(file: String?) async throws -> URL {
        let r: LoginCode = try await request("POST", "/api/login-code", body: file.map { ["path": $0] } ?? [:])
        var c = URLComponents(url: webBase.appending(path: "/login"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "code", value: r.code)]
        return c.url!
    }

    func editorURL(file: String) -> URL {
        var c = URLComponents(url: webBase, resolvingAgainstBaseURL: false)!
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "file", value: file)]
        return c.url!
    }

    /// Rendered by the open editor (only a real browser has the fonts and canvas).
    func render(file: String, format: String) async throws -> Data {
        let opts: [String: Any] = format == "svg" ? ["format": "svg", "embedScene": true] : ["format": "png", "scale": 2]
        let r: Rendered = try await request("POST", "/api/op", body: ["op": "render", "path": file, "opts": opts])
        guard let data = Data(base64Encoded: r.data) else { throw Failure(message: "The editor returned an invalid image.") }
        return data
    }
}

struct Drawing: Decodable, Identifiable, Hashable {
    let path: String
    let root: String
    let size: Int
    let mtime: Double
    var id: String { path }
    var name: String { ((path as NSString).lastPathComponent as NSString).deletingPathExtension }
    var modified: Date { Date(timeIntervalSince1970: mtime / 1000) }
    /// Folder relative to its root, "" when the drawing sits at the top.
    var folder: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.hasPrefix(root) ? String(dir.dropFirst(root.count)).trimmingCharacters(in: ["/"]) : dir
    }
}

struct FileList: Decodable {
    let roots: [String]
    let drawings: [Drawing]
}

private struct Empty: Decodable {}
private struct PathResult: Decodable { let path: String }
private struct LoginCode: Decodable { let code: String }
private struct Rendered: Decodable { let data: String; let mime: String }

/// Where the bundled JavaScript runtime and a Node.js binary live.
enum Runtime {
    /// GUI apps don't inherit the shell's PATH, so look where Node is usually installed.
    static let searchPath = [
        "/opt/homebrew/bin", "/usr/local/bin", NSHomeDirectory() + "/.volta/bin",
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ].joined(separator: ":")

    static func locate() throws -> (node: URL, cli: URL) {
        guard let cli = cliScript() else {
            throw Daemon.Failure(message: "The bundled lfx runtime is missing. Reinstall the app, or run `npm run build` when developing.")
        }
        guard let node = nodeBinary() else {
            throw Daemon.Failure(message: "Node.js 20 or newer is required. Install it with `brew install node`, or set LFX_NODE.")
        }
        return (node, cli)
    }

    private static func cliScript() -> URL? {
        let fm = FileManager.default
        if let res = Bundle.main.resourceURL?.appending(path: "lfx/dist/src/server/cli.js"),
           fm.fileExists(atPath: res.path) {
            return res
        }
        // `swift run` during development: walk up from the executable to the repository's dist/.
        var dir = Bundle.main.executableURL?.deletingLastPathComponent()
        while let d = dir, d.path != "/" {
            let candidate = d.appending(path: "dist/src/server/cli.js")
            if fm.fileExists(atPath: candidate.path) { return candidate }
            dir = d.deletingLastPathComponent()
        }
        return nil
    }

    private static func nodeBinary() -> URL? {
        let fm = FileManager.default
        var candidates: [String] = []
        if let env = ProcessInfo.processInfo.environment["LFX_NODE"] { candidates.append(env) }
        if let bundled = Bundle.main.resourceURL?.appending(path: "node/bin/node").path { candidates.append(bundled) }
        candidates += [
            "/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node",
            "/usr/local/bin/node", "/usr/local/opt/node/bin/node",
            NSHomeDirectory() + "/.volta/bin/node", "/usr/bin/node",
        ]
        return candidates.first(where: { fm.isExecutableFile(atPath: $0) }).map { URL(fileURLWithPath: $0) }
    }
}
