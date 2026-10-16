# MCP server

`lfx mcp` is an MCP server over stdio. It gives coding agents the same drawing tools the in-app assistant uses, and talks to the local daemon (starting it if needed) with a bearer token.

## Connect a client

All of these assume `lfx` is on your PATH, from `npm link` or the Homebrew cask.

### Claude Code

```bash
claude mcp add excalidraw -- lfx mcp
```

### Claude Code plugin

The plugin adds the MCP server and three skills:

- **Diagramming:** drawing with the MCP tools, the layout rules and the check after every batch, error recovery, and updating a diagram after a code change.
- **Architecture diagrams:** choosing the right diagram for the question and the audience (C4 levels, UML sequence, state and class, ER, deployment and infrastructure, data flow with trust boundaries, event flows), with a recipe for each and reference notes on notation, visual principles, and keeping diagrams in step with the code.
- **Review:** a readability review with a rubric for vision-capable models.

It also adds four commands:

- `/excalidraw:diagram <what>` investigates the code, draws, renders to check the layout and fixes problems.
- `/excalidraw:sync [drawing, commit or range]` updates the diagrams for the current code changes: it reads the diff, finds the affected elements by their code links and labels, snapshots the drawing, applies one targeted edit that keeps ids, renders it and reports each code change and the edit it caused.
- `/excalidraw:review <drawing>` renders the drawing and close-ups of each part, checks them against the readability rubric and fixes what's hard to read.
- `/excalidraw:open [drawing]` opens a drawing in the editor. Without a name, it lists the drawings and asks which one.

In Claude Code:

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

If the server picks the wrong project, or tools fail with "Path is outside the allowed roots", see [Troubleshooting](troubleshooting.md#the-mcp-server-cant-see-the-project).

## Tools

| Tool | What it does |
|---|---|
| `create_diagram` | Nodes and edges with layered auto-layout, left to right or top to bottom, placed to the right of anything already in the drawing. Edges (solid, dashed or dotted, optionally labelled) bend around the boxes they would cross, self-loops are drawn as small loops, and edges between the same two nodes are spread apart. Groups become labelled frames that don't overlap. A node's `shape` can be a library shape, drawn as that icon with its label below, and its `code` a [code link](#code-links). `replace: true` swaps the drawing's content for the diagram in one write. The fastest way to an architecture or flow diagram. |
| `list_shapes` | Searches library shapes: the built-in libraries, installed ones, `.excalidrawlib` files in the project, and your Excalidraw library. Can return a picture of the matches. |
| `insert_shape` | Places a library shape, optionally `next_to` an existing element, with an optional label below it. Shapes go in as grouped copies that arrows can bind to. |
| `connect_elements` | An arrow from one element to another that stays attached when either moves. Given the `id` of an existing arrow, it attaches that arrow instead of drawing a new one. |
| `mermaid_to_drawing` | Mermaid to Excalidraw elements. Only `flowchart` and `sequenceDiagram` become editable shapes and arrows; class, ER, state and other diagrams arrive as one image, so the tool steers to `create_diagram` for those. |
| `add_elements` | Simplified elements: shapes with `label` and `code`, arrows bound with `start`/`end: {id}`, frames with `children`, palette `color`s. Any raw Excalidraw property also works. |
| `update_elements` | Move, resize, relabel, recolour, re-link (`code`), or swap rectangle, ellipse and diamond by id. Labels re-centre and bound arrows re-route. Moving a frame moves its children, moving part of a group (such as a library shape) moves the whole group, and setting `frameId` brings the shape's label into the frame. |
| `delete_elements` | Removes elements with their labels. Arrows attached to them are detached, not deleted. |
| `apply_changes` | `add`, `update` and `delete` in one call and one revision (deletes, then adds, then updates). If any part fails, nothing changes. |
| `arrange_elements` | Aligns elements (left, center, right, top, middle, bottom) or distributes them evenly (horizontal, vertical) by id. Each moves with its label, its group or, for a frame, its children. |
| `read_drawing` | Compact listing such as `[id] type at (x,y) size WxH "label" fill=… code=src/a.ts#L4`, with arrows as `from -> to`, and the drawing's `rev`. `query` (label, text or link substring), `ids` and `type` filter it; matches bring the arrows attached to them. Raw JSON on request. Ends with the state of any code links. |
| `snapshot_drawing` | Saves the drawing's current state in the state directory (not the project). Each drawing keeps its newest 20. |
| `list_snapshots` | A drawing's snapshots, newest first. |
| `restore_drawing` | Puts the drawing back to a snapshot (by id or name, default the newest) in one revision. It snapshots the current state first, so a restore can be undone. |
| `check_code_links` | Each code-linked element (`link: "src/a.ts#L42"`) as ok, changed, missing or unknown. `mark_reviewed: true` records the linked files' current state once the diagram is up to date. See [Diagrams that reference code](projects.md#diagrams-that-reference-code). |
| `render_drawing` | A PNG of the drawing for the agent to look at. `element_ids` or `region` renders a close-up of part of it at full size, and the result says how big the smallest text appears. |
| `export_drawing` | Writes `name.excalidraw.svg` or `.png` next to the drawing, or to `output` inside the project. The scene is embedded by default, so the file shows on GitHub and still opens for editing. |
| `list_drawings` | Drawings in the project, most recently modified first. |
| `create_drawing` | A new drawing, optionally with initial elements. `overwrite: true` replaces an existing drawing, including a file that isn't valid JSON, such as one with git conflict markers (other tools refuse such a file with HTTP 422). |
| `open_drawing` | Opens a drawing in the user's browser, creating an empty one if it doesn't exist. |
| `excalidraw_guide` | The drawing guide: element format, sizing rules, layout anti-patterns, the check after every batch, error recovery, and updating a diagram after a code change. |
| `diagram_reference` | The architecture-diagrams skill's reference notes (C4, UML, data flow and threat models, ER, infrastructure, messaging, visual principles, living diagrams), by topic. Lists the topics when called without one. |

Render, export, Mermaid conversion and shape previews need a real browser for the fonts and canvas. An open tab of the drawing does the work if there is one; otherwise the daemon uses its own headless Chrome or Chromium, so these tools work without opening your browser, including in CI. Only `open_drawing` opens your browser. If no Chromium-family browser is installed, or `LFX_HEADLESS=off`, the server opens the drawing in your browser to do the work, as before. See [Headless rendering](configuration.md#headless-rendering), and [Troubleshooting](troubleshooting.md#render-export-or-mermaid-fails) when it fails.

### Revisions and `if_rev`

`read_drawing` returns a `rev`: a short id for the drawing's content that changes with every edit, by anyone, and stays the same across daemon restarts. `add_elements`, `update_elements`, `delete_elements`, `apply_changes` and `arrange_elements` take it as `if_rev`. If the drawing changed since (say the user dragged a box), the write fails with "The drawing changed since you read it" and changes nothing, so the agent reads it again instead of overwriting the user's edit. Writes report the new rev.

### Code links

A shape can point at the code it stands for. Pass `code: "src/orders/repo.ts"` or `code: "src/orders/repo.ts:42"` to a `create_diagram` node, an `add_elements` shape or an `update_elements` entry (`null` removes it). The element's `link` then holds the project-relative path with an optional `#L<line>` (`src/orders/repo.ts#L42`), and `customData.lfxCode` holds `{ path, line, sha }`, where `sha` is the file's SHA-256 when the link was made. `read_drawing` shows `code=src/orders/repo.ts#L42`. A `link` set directly to a project path is stored the same way. A path to a file that doesn't exist is linked anyway, and the tool result says so.

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
