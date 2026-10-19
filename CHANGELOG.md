# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-19

### Added

- macOS app: workspaces, like VS Code's. The sidebar shows the folders in the open workspace; **Save Workspace As…** writes a `.lfx-workspace` file (folder paths relative to it, plus the view options) that **Open Workspace…** or a Finder double-click restores. The current workspace reopens at launch. Without one, a Welcome view offers New Drawing (a blank untitled drawing, open at once), Open Folder, Open Workspace and recents. See [Drawings, projects and code](docs/projects.md#macos-app).
- macOS app: sort and view options in the sidebar: sort by name or date modified, folders on top, mixed in or below, folder tree or flat list with paths, compact folders and show all folders.
- macOS app: New Drawing (⌘N) and New Folder (⇧⌘N) act on the selected folder, from a **+** menu at the bottom of the sidebar, a **+** on each folder section's header, and the File menu. The New Drawing sheet can pick any folder. Drag drawings onto folders to move them, and drop Finder folders onto the sidebar to add them.

### Changed

- macOS app: the sidebar makes clear what's inside a folder: collapsible sections per workspace folder, tinted folder icons with drawing counts, and drawing rows without timestamps (the date is in the tooltip, or shown when sorting by date). Rows show their folder when the tree alone doesn't. "Add Folder" is now **Add Folder to Workspace…**, so it no longer looks like New Folder.

### Fixed

- macOS app: the Claude Code assistant no longer asks for `/login` when Claude Code is set up through environment variables (Bedrock, Vertex, `ANTHROPIC_BASE_URL`). Apps opened from Finder don't get your shell's variables, so the app now reads them from your login shell when it starts the daemon. See [Troubleshooting](docs/troubleshooting.md#the-claude-code-assistant-asks-for-login-bedrock-vertex-proxies).

## [1.0.0] - 2026-10-17

### Added

- Code links. Link an element to `src/orders/repo.ts#L42` (or `:42`) and clicking it opens the file at that line in your code editor: VS Code by default, or Cursor, Zed, a JetBrains IDE, `$EDITOR` or a command of your own through `LFX_EDITOR` or `editor.json`. Links outside the project and secret files are refused. See [Drawings, projects and code](docs/projects.md).
- Staleness for code links. Each link records its file's hash; the editor's top bar shows **N links changed** (or missing), selects them on click, and marks them as reviewed with the ✓ button.
- Drawing management in the web UI: rename, duplicate, move to a folder, new folder, and move to the system trash (`LFX_TRASH_DIR` to override) from the drawing list and the editor menu. Open tabs follow a rename or move.
- Git badges (**M**, **U**, **S**, **C**) for modified, untracked, staged and conflicted drawings in the drawing list.
- Edits by MCP agents go on the canvas undo stack, glow briefly, and are announced with a toast such as **Claude Code edited 3 elements** and a **Select** action.
- ⇧⌘A (Ctrl+Shift+A) shows or hides the assistant in the web UI. A banner appears when the tab loses its connection, error banners have a **Dismiss** button, and library load or save failures show as a toast.
- A drawings sidebar in the editor, organised by the project's folders: ⌘B (Ctrl+B) toggles it, with recents, a filter, a "show all folders" toggle, git badges, context menus (including new drawing here, new folder and rename folder), drag to move and tree keyboard navigation. Switching drawings from it keeps the sidebar and the assistant open. The drawing list shows the same tree. See [Drawings, projects and code](docs/projects.md).
- The daemon pushes a `files-changed` event over the WebSocket, and over `GET /api/events` (server-sent events), when drawings or folders are created, renamed, moved or deleted, by anyone.
- The macOS app's sidebar is a folder tree with Rename, Duplicate, Move To, New Folder and Rename Folder, and refreshes from the daemon's event stream instead of polling every 3 seconds. The app replaces an older daemon that was started on demand, and offers to restart an older one started elsewhere.
- Headless rendering. Render, export, Mermaid conversion and shape previews run in a hidden local Chrome, Chromium, Edge or Brave when no tab of the drawing is open, so agents and CI no longer open your browser. Configured with `LFX_HEADLESS` (`auto`, `always`, `off`), `LFX_BROWSER` and `LFX_HEADLESS_IDLE_MIN`; `lfx status` shows its state. The Docker image can include Chromium with `--build-arg WITH_CHROMIUM=1`.
- New MCP tools:
  - `apply_changes`: add, update and delete in one call and one revision.
  - `arrange_elements`: align or distribute elements.
  - `snapshot_drawing`, `list_snapshots` and `restore_drawing`, kept in the state directory.
  - `check_code_links`: reports code links as ok, changed, missing or unknown, and marks them reviewed.
  - `diagram_reference`: the architecture-diagrams reference notes, by topic.
- `read_drawing` returns a revision (`rev`) and filters by `query`, `ids` or `type`. `add_elements`, `update_elements`, `delete_elements`, `apply_changes` and `arrange_elements` take `if_rev` and refuse to overwrite a drawing that changed since it was read.
- `code` on `create_diagram` nodes, `add_elements` shapes and `update_elements` entries, stored as a code link and shown by `read_drawing` as `code=…`.
- `connect_elements` can attach an existing arrow by its `id`.
- `render_drawing` renders close-ups with `element_ids` or `region`, and says how large the smallest text appears.
- Plugin: the architecture-diagrams skill (choosing and drawing C4, UML, data flow, ER, infrastructure and messaging diagrams, with reference notes), the diagram-review skill with `/excalidraw:review`, and `/excalidraw:sync` to update diagrams for the current code changes.
- The assistant explores code like an engineer: new read-only tools `project_overview` (tree, languages, manifests, Compose services, Kubernetes and OpenAPI files, entry points, README, drawings), `outline_file` (classes, functions, methods, types and routes in TS/JS, Python, Go, Rust, Java/Kotlin, C# and Ruby), `find_symbol` (definitions, best first, and references) and `git_changes` (uncommitted changes, the last N commits or a ref range, with an optional capped diff). `search_files` takes `context` and `files_only`. See [Using the assistant](docs/assistant.md#how-it-explores-code).
- Mention code in the assistant: `@folder/` attaches an overview of the folder, `@file:10-40` a line range, `@OrderRepository` a symbol's definition. Typed mentions work without the picker, and the picker lists files with uncommitted or recent changes first. Asking about a selected element with a code link attaches the linked code.
- `project_overview` and `git_changes` are also MCP tools.
- Assistant chat history: each drawing keeps several chats, reopenable from the history menu. A chat remembers its model, and chats on different drawings reply at the same time.
- Opt-in OpenTelemetry tracing of assistant replies, model calls, tool calls and drawing operations, to an OTLP receiver or a JSON-lines file. See [Tracing](docs/tracing.md).
- `lfx roots` lists the folders the daemon may use, and `lfx roots remove DIR` forgets one.
- The daemon stops with the macOS app (`LFX_PARENT_PID`), and a daemon started on demand stops after 30 idle minutes (`LFX_IDLE_EXIT_MIN`).
- An eval harness (`npm run evals`) that drives Claude Code against a fixture project and grades the drawings, either over MCP or through the in-app assistant (`--via assistant`). See [Evals](docs/evals.md).
- GitHub Actions run typecheck, build and tests on Ubuntu and macOS with Node 20 and 22.
- Plugin: the architecture-discovery skill (building an accurate model of a system from its code, manifests and deployment files before drawing) and the architecture-review skill (finding single points of failure, shared databases, long synchronous chains and similar risks, and annotating them on the drawing), with eval scenarios.

### Changed

- A client replaces an older daemon that was started on demand, and refuses to use a daemon of any other version with a message that says what to do. `lfx status` flags a version mismatch.
- The project root registered by an MCP server lasts only until the daemon restarts, instead of being saved forever.
- `create_diagram` layout: node order keeps the fewest edge crossings found, edges that skip layers route around the boxes in between, groups get their own bands so frames don't overlap or enclose other nodes, self-loops are drawn, and parallel edges are spread apart.
- `create_diagram` with `replace: true` replaces the drawing in one atomic write.
- Moving a frame moves its children, and moving part of a group (such as a library shape) moves the whole group.
- The excalidraw skill, the review skill, the drawing guide, the MCP server instructions and the assistant's prompt were rewritten as one set, with sizing rules, layout anti-patterns, a check after every batch, error recovery, and a workflow for updating a diagram after a code change.
- Revert reports when it kept elements you edited since: **Reverted 3, kept 1 you edited since**.
- `lfx stop` says when the daemon is still running instead of always printing "Stopped."
- A 403 for a path outside the allowed roots names the allowed roots.
- Every bundled library shape has a meaningful name and a "use for" note, and `list_shapes` searches those notes, so queries such as `postgres`, `s3`, `kafka`, `mongo` or `kubernetes` find the right shape. Some System Design keys changed (for example `message-q` is now `message-queue`, `mobile` is now `mobile-app`).

### Fixed

- Self-loops and arrows between shapes with the same centre no longer write NaN coordinates. The store refuses non-finite coordinates.
- Unknown element types (such as `{type: "box"}`) are rejected with a suggestion instead of being saved.
- A drawing that isn't valid JSON (for example, with git conflict markers) returns a clear 422 error instead of an HTTP 500 on every operation, and `create_drawing` with `overwrite: true` can replace it.
- Deleted elements no longer come back after a daemon restart when a stale tab saves: recent deletions are kept in `tombstones.json` in the state directory.
- Layout input errors are reported as drawing errors instead of HTTP 500.
- MCP roots with spaces or other escaped characters resolve to the right folder.
- Requests to an editor tab fail as soon as the tab closes, instead of waiting 30 seconds.
- A label keeps its measured size when its shape moves, so it no longer looks as if it overflows.
- A malformed `%` escape in a static path returns 400 instead of 500.
- File writes are flushed to disk, keep the file's permissions, and don't leave temporary files behind on failure. The PNG export's temporary file name is unique.
- Token creation no longer races with a concurrent reader.
- Placing a library shape with a label replaces the shape's built-in caption or placeholder text instead of adding a second label beside it.

### Security

- The assistant's file listing and search respect nested `.gitignore` files and `!` exceptions.
- The assistant's project-file tools also refuse `.git/`, `.kube/`, `.docker/config.json`, `*.tfvars`, `.envrc`, `.vault-token` and similar files.
- Claude Code endpoints get matching `Read(...)` deny rules, since Claude Code's own Read, Grep and Glob tools don't go through the daemon's checks.
- Regular-expression searches run in a worker thread with a time limit (`LFX_SEARCH_TIMEOUT_MS`) and a pattern length cap, so a pathological pattern can't stall the daemon.
- The headless browser runs with a throwaway profile, can resolve only `127.0.0.1`, signs in with a single-use code, can't call the HTTP API, and exits with the daemon.

## [0.1.1] - 2026-10-14

### Added

- An in-app assistant beside the canvas, in the browser and the macOS app. It works with Ollama, OpenAI-compatible servers, the Anthropic API or the local Claude Code CLI, runs its loop in the daemon so keys never reach the page, reads the project read-only, and each reply can be reverted or undone with ⌘Z.
- Library shapes for the assistant and MCP agents: `list_shapes`, `insert_shape`, and library shapes as `create_diagram` nodes.
- A Shapes view with eight built-in starter libraries, the public catalog, import, item renaming, and a choice of which libraries the assistant uses.
- **Edit as JSON** for the assistant settings. The daemon reloads `ai.json` when it changes and keeps the last good settings if an edit doesn't parse.
- `update_elements` can switch a shape between rectangle, ellipse and diamond in place.
- Notarized macOS releases.

### Changed

- The macOS app is built for Apple silicon only.
- The documentation is split into pages for the assistant, the MCP server, architecture, security, configuration and development.

### Fixed

- The assistant edits the open drawing when the model passes its bare file name, instead of creating a second drawing in `docs/diagrams/`.

## [0.1.0] - 2026-10-13

### Added

- `lfx`, a local daemon that serves the official Excalidraw editor on `127.0.0.1`, with every asset bundled, a strict same-origin Content Security Policy, Host and Origin checks, a bearer token for local clients and one-time sign-in links for the browser.
- `.excalidraw` files on disk as the source of truth, with version-based merging so agent, browser and external edits stay in sync live.
- `lfx mcp`, an MCP server with `create_diagram` (auto-layout), Mermaid conversion, add, update and delete elements, read, render to PNG and export to `.excalidraw.svg`.
- A Claude Code plugin with a skill and the `/excalidraw:diagram` and `/excalidraw:open` commands.
- A native macOS app and a Homebrew cask that also puts `lfx` on your PATH.
- A Docker Compose setup with an egress-isolated app container and a loopback-only gateway.

[Unreleased]: https://github.com/Sean-Michael/local-first-excalidraw/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Sean-Michael/local-first-excalidraw/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Sean-Michael/local-first-excalidraw/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/Sean-Michael/local-first-excalidraw/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Sean-Michael/local-first-excalidraw/releases/tag/v0.1.0
