# local-first-excalidraw

The real Excalidraw editor, running entirely on your machine, with an MCP server so coding agents (Claude Code, Claude Desktop, Cursor, VS Code, …) can draw and edit the same diagrams you do.

- **Your files are the source of truth.** Drawings are plain `.excalidraw` JSON in your repo (default `docs/diagrams/`), with stable 2-space formatting for clean git diffs.
- **Live, both directions.** When an agent edits a drawing, your open tab updates instantly. When you draw, the file is saved within ~250 ms. If the file changes on disk (an editor, `git checkout`), the tab updates too.
- **No network.** No CDN, no telemetry, no share links, no collaboration server. Fonts and code ship in the bundle, and the browser is locked to its own origin by CSP.
- **Optional assistant, your choice of model.** A chat panel beside the canvas that draws and edits with a local model (Ollama, LM Studio, llama.cpp), Claude Code, or an API you configure. It's off until you set it up, and nothing is sent anywhere before then.
- **Agent-friendly.** Agents get high-level tools (graph → auto-laid-out diagram, Mermaid → Excalidraw, labelled shapes with bound arrows) plus a compact text description of a drawing and a PNG render so they can check their own work.

```
 Claude Code / any MCP client              your browser (localhost only)
        │ stdio                                     ▲ WebSocket (same-origin, cookie)
        ▼                                           │
   lfx mcp  ──── HTTP + bearer token ────►  lfx daemon (127.0.0.1:7467)  ◄──► docs/diagrams/*.excalidraw
                                            serves the Excalidraw editor,
                                            merges edits, watches files
```

## Why not `excalidraw/excalidraw-mcp`?

That project is a good MCP App, but it isn't local-first:

| | excalidraw-mcp | this project |
|---|---|---|
| Editor code & fonts | loaded at runtime from `esm.sh` | bundled; CSP `connect-src 'self'`, and the CDN fallback is stripped at build time (the build fails if any CDN URL survives) |
| Sharing | `export_to_excalidraw` uploads the scene to `json.excalidraw.com` | none; export writes `.excalidraw.svg` / `.png` into your repo |
| HTTP mode | binds `0.0.0.0`, `cors()` open to every origin, no auth | binds `127.0.0.1`, Host-header + Origin checks (DNS-rebinding / CSRF safe), bearer token for local clients, one-time login links + `HttpOnly SameSite=Strict` session for the browser |
| Storage | checkpoints in shared `$TMPDIR` | your `.excalidraw` files; daemon state in `~/.local-first-excalidraw` (mode 0700, files 0600) |
| File access | n/a | only `.excalidraw` files under registered project roots; symlink escapes rejected |
| Dependencies at runtime | React, Excalidraw, Redis client, express, … | `@modelcontextprotocol/sdk`, `ws`, `zod`, `@anthropic-ai/sdk` (used only if you pick the Anthropic API); the editor is prebuilt static files |

## Quick start (native)

Requires Node 20+.

```bash
git clone https://github.com/Sean-Michael/local-first-excalidraw && cd local-first-excalidraw
```

```bash
npm ci && npm run build && npm link
```

`npm link` puts `lfx` on your PATH. Then:

```bash
lfx open docs/diagrams/architecture.excalidraw
```

The daemon starts in the background on first use. `lfx open` with no file shows the list of drawings. Other commands: `lfx url` (print the sign-in link instead of opening a browser), `lfx status`, `lfx stop`.

### Claude Code plugin

The plugin adds the MCP server, a diagramming skill, and the `/excalidraw:diagram <what>` and `/excalidraw:open` commands. It runs the `lfx` you linked above. In Claude Code:

```
/plugin marketplace add /path/to/local-first-excalidraw
/plugin install excalidraw@local-first-excalidraw
```

Then try: *"/excalidraw:diagram the request path through our API, from the load balancer to the database"*.

### Plain MCP (any client)

```bash
claude mcp add excalidraw -- lfx mcp
```

or in a client's JSON config:

```json
{ "mcpServers": { "excalidraw": { "command": "lfx", "args": ["mcp"] } } }
```

The project root is the client's MCP root if it provides one, otherwise the server's working directory (`--root DIR` or `LFX_PROJECT_ROOT` override it). Relative drawing paths resolve against it, and a bare name like `auth-flow` becomes `docs/diagrams/auth-flow.excalidraw`.

## macOS app

A native SwiftUI app: a sidebar of your drawings (grouped by folder, filterable), File menu and toolbar commands (New Drawing ⌘N, Open… ⌘O, Add Folder, Export as SVG/PNG, Show in Finder), native save and open panels, and `.excalidraw` files open from Finder. The canvas is the same bundled editor, in a `WKWebView` that talks only to the local daemon. The app reuses a daemon that's already running (started by the CLI or an agent) and otherwise starts its own, which it stops on quit unless you turn on **Keep the daemon running** in Settings.

Install it with Homebrew. The repository doubles as a tap:

```bash
brew tap sean-michael/local-first-excalidraw https://github.com/Sean-Michael/local-first-excalidraw
```

```bash
brew trust sean-michael/local-first-excalidraw
```

```bash
brew install --cask local-first-excalidraw
```

Releases aren't notarized yet, so macOS blocks the first launch. Open **System Settings → Privacy & Security** and click **Open Anyway**. You only need to do this once per install.

The cask also links `lfx` onto your PATH, so the Claude Code plugin and `claude mcp add excalidraw -- lfx mcp` work without cloning the repo. It depends on Homebrew's `node`.

To build it from source instead (Xcode 15+ and Node 20+), run the following. It creates `build/Local Excalidraw.app` (Apple silicon, macOS 14+) and copies it to `/Applications`:

```bash
macos/build-app.sh --install
```

To cut a release, first do this one-time setup. Create a **Developer ID Application** certificate: in Xcode, go to Settings → Accounts → Manage Certificates → + (only the team's Account Holder can do this). Then save notarization credentials with `xcrun notarytool store-credentials lfx-notary --apple-id <you> --team-id <TEAMID>`. After that, bump the version (`npm version patch --no-git-tag-version`), commit it to `main`, and run:

```bash
SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" NOTARY_PROFILE=lfx-notary macos/build-app.sh --release --publish
```

The script checks the certificate, the notary profile and the git state before building. It then signs with hardened runtime, notarizes and staples the app, and creates the GitHub release `v<version>` with the zip. Last, it writes the new sha256 into `Casks/local-first-excalidraw.rb` and pushes that commit. Without `--publish`, it stops after writing the zip and updating the cask. Without the two variables, the build is ad-hoc signed and only suitable for your own Mac.

## Assistant

Click **Assistant** at the top right of a drawing (or **Toggle Assistant**, ⇧⌘A, in the macOS app) to open a chat panel beside the canvas. Ask for a new diagram, or select items (drag a rectangle or click them) and ask for changes to just those. Type `@` to mention a project file or another drawing.

- **Endpoints.** Add one in the panel's settings:
  - **Ollama**, through its native API, so the context window can be set (default 32K; Ollama's own default of 4K is too small for the assistant's tools). Use a model with tool calling, such as `gpt-oss` or `qwen3-coder`.
  - **Any OpenAI-compatible server**: LM Studio, llama.cpp (`llama-server --jinja`), vLLM, OpenAI, OpenRouter, …
  - **Anthropic API** (default model `claude-opus-5-5`).
  - **Claude Code**: runs your local `claude` CLI with your existing login, restricted to read-only file tools and this project's MCP server. It does its own code search.
  - A model without tool calling still works: it answers in Mermaid, which is converted into editable elements.
- **Settings as JSON.** Click **Edit as JSON** at the bottom of the settings, VS Code style: comments and trailing commas are fine, errors show their line, and unknown keys are flagged. You can also edit `~/.local-first-excalidraw/ai.json` directly; the daemon picks up changes without a restart and keeps the last good settings if an edit doesn't parse. API keys never appear in the in-app editor: add `"apiKey": "…"` to an endpoint to set one, or `null` to remove it. Saving from the app rewrites the file, which drops any comments you added by hand.
- **Shapes and libraries.** The assistant draws with library shapes (people, databases, cloud icons, UI parts) instead of imitating them with boxes. Open the panel's **Shapes** view (the grid icon) to manage them:
  - **Built in:** eight of the most-downloaded generic libraries ship with the app and work offline: Software Architecture, System Design Components, Stick Figures, Basic UX/Wireframing, Decision Flow Control, Network Topology Icons, Sticky Notes and Bubbles. They're MIT-licensed, from [the Excalidraw library catalog](https://github.com/excalidraw/excalidraw-libraries); see [libraries/manifest.json](libraries/manifest.json) for authors.
  - **Browse catalog:** all public libraries, most downloaded first, installed in one click. Vendor icon sets (AWS, Google Cloud, Azure, logos) live here rather than in the app. This is the only feature that downloads anything, and only when you click Install.
  - **Import:** drop `.excalidrawlib` files onto the Shapes view.
  - **In this project:** `.excalidrawlib` files committed to the repo are picked up automatically, so a team can share its own icon set.
  - Click a shape's name to rename it. Many published libraries have unnamed items; names come from the catalog or from text inside the shape where possible, and good names are what the assistant searches. Untick a library to hide it from the assistant. **Add to canvas library** copies a set into Excalidraw's own Library sidebar so you can drag shapes in by hand.
- **What it sees.** Each message carries a description of the drawing, the selected elements (plus a snapshot image, for models marked as accepting images), and anything you `@`-mention. With **project files** on (the default), it can also list, search and read files in the drawing's git repository on its own. File access is read-only, never leaves the repository, skips dependencies and `.gitignore`d paths, and refuses anything that looks like a secret (`.env`, keys, credentials).
- **Undo.** The assistant's edits go on the canvas undo stack, so ⌘Z takes them back. Each reply also has **Revert changes**, which restores everything that reply changed except elements you've edited since.
- **Where requests go.** The local daemon makes every model request; the page never talks to anything but the daemon. The panel always shows the destination (`→ localhost:11434 · gpt-oss:20b`). Keys are stored in `~/.local-first-excalidraw/ai.json` (0600) and are never sent back to the browser. Changing an endpoint's URL drops its stored key, so a key can't be redirected to another host. Conversations are kept per drawing in `~/.local-first-excalidraw/chats/`.

## Docker (egress-isolated)

```bash
LFX_WORKSPACE=~/code/my-repo docker compose up -d --build
```

```bash
docker compose exec lfx lfx url
```

- `lfx`, the app container, is attached only to an `internal: true` network, so it has no route to the internet. It runs read-only, non-root, with all capabilities dropped and `no-new-privileges`.
- `gateway` is the same image running a ~30-line TCP forwarder (`lfx proxy`). It publishes the UI on `127.0.0.1:7467` only.
- The workspace mount is the only place drawings can be read or written (`LFX_LOCK_ROOTS=1`).

MCP config for agents when using Docker:

```json
{ "mcpServers": { "excalidraw": { "command": "docker", "args": ["exec", "-i", "lfx", "lfx", "mcp"] } } }
```

Paths in that mode are relative to the mounted workspace.

## MCP tools

| Tool | What it does |
|---|---|
| `create_diagram` | Nodes + edges (+ groups → frames), layered auto-layout, LR or TB. The fastest way to an architecture/flow diagram. A node's `shape` can be a library shape, drawn as that icon with its label below. |
| `list_shapes` / `insert_shape` | Search and place library shapes: the built-in starter libraries, installed ones, `.excalidrawlib` files in the project, and your Excalidraw library. `list_shapes` can return a picture of the matches; `insert_shape` can place a shape `next_to` an existing element. Shapes go in as grouped copies that arrows bind to. |
| `connect_elements` | An arrow from one element to another that stays attached when either moves. |
| `mermaid_to_drawing` | Mermaid flowchart / sequence / class diagram → editable Excalidraw elements. |
| `add_elements` | Simplified elements: shapes with `label`, arrows bound with `start`/`end: {id}`, frames with `children`, palette `color`s. Any raw Excalidraw property also works. |
| `update_elements` | Move, resize, relabel, recolour, or swap rectangle ↔ ellipse ↔ diamond by id. Labels re-centre and bound arrows re-route. |
| `delete_elements` | Removes elements with their labels and detaches arrows. |
| `read_drawing` | Compact listing: `[id] type at (x,y) size WxH "label" fill=…`, arrows as `from -> to`. Raw JSON on request. |
| `render_drawing` | PNG for the agent to look at. |
| `export_drawing` | Writes `name.excalidraw.svg` (scene embedded: viewable on GitHub *and* re-editable) or `.png`. |
| `list_drawings`, `create_drawing`, `open_drawing`, `excalidraw_guide` | Housekeeping and the element cheat-sheet. |

Render, export and Mermaid run in an open editor tab, because only a real browser has the fonts and canvas. If no tab is open, the agent opens one for you. Everything else works headless.

## How concurrent editing works

The same model as Excalidraw's own collaboration: every element has a `version` and a random `versionNonce`, and when copies disagree the higher version wins. Deletions are tombstones, so they propagate rather than being undone by a stale copy. The daemon is the single writer to disk: it merges every save from the browser, the agent and external edits, writes atomically (temp file + rename), and pushes the result to open tabs. Agent edits are applied atomically in the daemon, so they can't race your typing on other elements. If you both change the *same* element at the same moment, one version wins, the same as in Excalidraw collab.

If a drawing is deleted or moved on disk while open, the tab stops saving and offers **Restore it** instead of silently recreating the file.

## Security model

Threats considered: malicious websites in your normal browser (CSRF, DNS rebinding, cross-site WebSocket hijacking), other users or processes on the machine, other hosts on your LAN, supply-chain or CDN compromise at runtime, and data exfiltration from the editor.

- **Network surface:** loopback only (`127.0.0.1`). Requests whose `Host` isn't `localhost`/`127.0.0.1`/`[::1]` on the configured port are rejected (DNS rebinding). Any request with a foreign `Origin` is rejected, and WebSocket upgrades *require* a same-origin `Origin`.
- **Authentication:** local clients (MCP server, CLI) use a 256-bit bearer token in `~/.local-first-excalidraw/token` (0600). Browsers get a single-use, 2-minute login code, exchanged for an `HttpOnly; SameSite=Strict` session cookie. The token never appears in URLs. Root registration, the agent operations API, login-code minting and shutdown are bearer-only. A browser session can't reach them.
- **Filesystem:** only `*.excalidraw` files, only under `~/Excalidraw` plus project roots that local clients register. Paths are canonicalised with `realpath`, so `..` and symlink escapes are refused. Registering `/` is refused. Exports are confined to the project root.
- **Browser:** `default-src 'none'`. Scripts, styles, fonts and connections are allowed from `'self'` only (plus `'wasm-unsafe-eval'` for Excalidraw's font subsetting). `frame-src 'none'` and embeds are disabled. Also `frame-ancestors 'none'`, `no-referrer`, COOP/CORP same-origin, and Excalidraw's built-in AI features (which call excalidraw.com) off.
- **Assistant:** off by default. Model requests come from the daemon, never the page. The `claude` binary is found on `PATH` (or `LFX_CLAUDE_BIN`) and can't be set from the page, since that would let the page choose what to execute. Project-file tools are read-only and confined as described under [Assistant](#assistant).
- **Supply chain:** exact-pinned dependencies, `ignore-scripts=true` in `.npmrc`, browser-only packages are devDependencies (the runtime installs four packages), and the build fails if a CDN URL is left in the bundle.

Not in scope: someone already running code as your user. They can read the token, just as they can read your drawings. Links in Excalidraw's Help dialog and the "Browse libraries" button still open external sites, but only when you click them.

## Configuration

| Env var | Default | |
|---|---|---|
| `LFX_PORT` | `7467` | daemon port |
| `LFX_STATE_DIR` | `~/.local-first-excalidraw` | token, sessions, roots, library, log |
| `LFX_ROOTS` | `~/Excalidraw` | always-allowed roots (`:`-separated) |
| `LFX_DEFAULT_DIR` | `docs/diagrams` | where bare drawing names go |
| `LFX_PROJECT_ROOT` | MCP root / cwd | project root for the MCP server |
| `LFX_LOCK_ROOTS` | unset | `1` = don't allow registering extra roots |
| `LFX_NO_BROWSER` | unset | `1` = print links instead of opening a browser |
| `LFX_CLAUDE_BIN` | `claude` on `PATH` | Claude Code binary for the assistant |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | unset | used when an endpoint has no stored key |
| `LFX_HOST` / `LFX_ALLOWED_HOSTS` | `127.0.0.1` | for containers only |

## Development

```bash
npm run build      # vite (editor) + tsc (daemon, MCP, CLI)
npm test           # node:test unit tests: scene ops, merge, layout, path safety, store
npm run typecheck
npm run build:mac  # macOS app -> build/Local Excalidraw.app (see macos/)
```

Layout: `src/server/` holds the daemon (`daemon.ts`), doc store and merge (`store.ts`, `scene.ts`), auto-layout (`layout.ts`), MCP server (`mcp.ts`), security helpers (`security.ts`) and the CLI. `src/web/` holds the editor (`Editor.tsx`) and the drawing list. `plugin/` is the Claude Code plugin.

The editor is the official [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) package (MIT), the same editor as excalidraw.com, without the hosted app's sharing and collaboration services.
