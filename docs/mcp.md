# MCP server

`lfx mcp` is an MCP server over stdio. It gives coding agents the same drawing tools the in-app assistant uses, and talks to the local daemon (starting it if needed) with a bearer token.

## Connect a client

All of these assume `lfx` is on your PATH, from `npm link` or the Homebrew cask.

### Claude Code

```bash
claude mcp add excalidraw -- lfx mcp
```

### Claude Code plugin

The plugin adds the MCP server, two skills (diagramming, and a readability review with a rubric for vision-capable models), and three commands: `/excalidraw:diagram <what>` investigates the code, draws, renders to check the layout and fixes problems; `/excalidraw:review <drawing>` renders the drawing and close-ups of each part, checks them against the readability rubric and fixes what's hard to read; `/excalidraw:open` opens the editor. In Claude Code:

```
/plugin marketplace add /path/to/local-first-excalidraw
/plugin install excalidraw@local-first-excalidraw
```

Then try `/excalidraw:diagram the request path through our API, from the load balancer to the database`.

### Any other client

```json
{ "mcpServers": { "excalidraw": { "command": "lfx", "args": ["mcp"] } } }
```

With the [Docker setup](security.md#egress-isolated-docker), run the server inside the container instead. Paths are then relative to the mounted workspace.

```json
{ "mcpServers": { "excalidraw": { "command": "docker", "args": ["exec", "-i", "lfx", "lfx", "mcp"] } } }
```

## Project root and paths

The project root is the client's MCP root if it provides one, otherwise `$CLAUDE_PROJECT_DIR` or the server's working directory. `--root DIR` or `LFX_PROJECT_ROOT` override it.

Relative drawing paths resolve against the project root. A bare name such as `auth-flow` becomes `docs/diagrams/auth-flow.excalidraw` (change the folder with `LFX_DEFAULT_DIR`).

## Tools

| Tool | What it does |
|---|---|
| `create_diagram` | Nodes and edges with layered auto-layout, left to right or top to bottom. Groups become labelled frames. A node's `shape` can be a library shape, drawn as that icon with its label below. The fastest way to an architecture or flow diagram. |
| `list_shapes` | Searches library shapes: the built-in libraries, installed ones, `.excalidrawlib` files in the project, and your Excalidraw library. Can return a picture of the matches. |
| `insert_shape` | Places a library shape, optionally `next_to` an existing element. Shapes go in as grouped copies that arrows can bind to. |
| `connect_elements` | An arrow from one element to another that stays attached when either moves. |
| `mermaid_to_drawing` | Mermaid flowchart, sequence or class diagram to editable Excalidraw elements. |
| `add_elements` | Simplified elements: shapes with `label`, arrows bound with `start`/`end: {id}`, frames with `children`, palette `color`s. Any raw Excalidraw property also works. |
| `update_elements` | Move, resize, relabel, recolour, or swap rectangle, ellipse and diamond by id. Labels re-centre and bound arrows re-route. |
| `delete_elements` | Removes elements with their labels and detaches arrows. |
| `read_drawing` | Compact listing such as `[id] type at (x,y) size WxH "label" fill=…`, with arrows as `from -> to`. Raw JSON on request. |
| `render_drawing` | A PNG of the drawing for the agent to look at. `element_ids` or `region` renders a close-up of part of it at full size, and the result says how big the smallest text appears. |
| `export_drawing` | Writes `name.excalidraw.svg` (scene embedded, so it's viewable on GitHub and still editable) or `.png`. |
| `list_drawings` | Drawings in the project, most recently modified first. |
| `create_drawing` | A new drawing, optionally with initial elements. |
| `open_drawing` | Opens a drawing in the browser. |
| `excalidraw_guide` | The element cheat sheet. |

Render, export and Mermaid conversion run in an open editor tab, because only a real browser has the fonts and canvas. If no tab is open, the server opens one. Everything else works headless.

The in-app assistant has three more tools, `list_files`, `search_files` and `read_file`, for reading the project. They aren't exposed over MCP because coding agents have their own.

## Example

The [architecture diagram](diagrams/architecture.excalidraw) in the README was drawn with one `create_diagram` call, nudged into place with `update_elements`, and exported with `export_drawing`. The call, trimmed:

```json
{
  "path": "docs/diagrams/architecture",
  "direction": "TB",
  "nodes": [
    { "id": "agents", "label": "Coding agents\nClaude Code, Cursor, VS Code", "color": "purple" },
    { "id": "mcp", "label": "lfx mcp\nMCP server over stdio", "color": "purple" },
    { "id": "http", "label": "HTTP + WebSocket\nloopback only, Host/Origin checks", "color": "red", "group": "daemon" },
    { "id": "files", "label": "docs/diagrams/*.excalidraw", "shape": "software-architecture/documents-or-code" }
  ],
  "groups": [{ "id": "daemon", "label": "lfx daemon · 127.0.0.1:7467" }],
  "edges": [
    { "from": "agents", "to": "mcp", "label": "stdio" },
    { "from": "mcp", "to": "http", "label": "bearer token" }
  ]
}
```
