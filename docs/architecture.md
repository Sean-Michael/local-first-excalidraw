# About the architecture

Every diagram on this page was drawn by the tool itself and is a normal `.excalidraw` file in [docs/diagrams/](diagrams/). Open one with `lfx open docs/diagrams/<name>.excalidraw` to edit it.

## One daemon owns the drawings

![Architecture: coding agents reach the daemon through lfx mcp over stdio; the browser tab or macOS app connects with a session cookie; inside the daemon, HTTP and WebSocket handling feeds the assistant agent loop and a tool registry shared by MCP and the assistant; the tool registry writes through the DocStore to .excalidraw files and reads project files; the agent loop calls a model endpoint only if one is configured](diagrams/architecture.excalidraw.svg)

*Drawn by a coding agent through `lfx mcp` with `create_diagram`, then adjusted with `update_elements`.*

`lfx daemon` listens on `127.0.0.1:7467`. It serves the prebuilt Excalidraw editor, holds every open drawing in memory, and is the only process that writes drawing files. Everything else is a client:

- **The browser tab or macOS app** loads the editor from the daemon and syncs the scene over a WebSocket, authenticated with a session cookie.
- **`lfx mcp`** is a thin stdio MCP server. Each tool call becomes an HTTP request to the daemon with a bearer token.
- **The assistant** runs inside the daemon, so the page never talks to a model and API keys never reach it.

The macOS app is a SwiftUI shell around the same editor in a `WKWebView`. It reuses a daemon that's already running (started by the CLI or an agent) and otherwise starts its own.

## One tool registry for agents and the assistant

[src/server/tools.ts](../src/server/tools.ts) defines every drawing tool once, as a zod schema and a handler over a small context interface. The MCP server exposes them to coding agents and the assistant offers them to its model, so the two can't drift apart. The assistant adds three read-only code tools (`list_files`, `search_files`, `read_file`) that coding agents don't need.

Tools don't touch files. They call `op()`, which the daemon applies to the in-memory document and then writes and broadcasts like any other edit.

| Piece | Files | Role |
|---|---|---|
| Daemon | `src/server/daemon.ts` | HTTP and WebSocket server, auth, routes, broadcast to tabs |
| Document store | `src/server/store.ts`, `scene.ts` | In-memory scenes, version merge, atomic writes, file watching, scene operations |
| Auto-layout | `src/server/layout.ts` | Layered layout for `create_diagram` |
| Tool registry | `src/server/tools.ts` | Every tool, shared by MCP and the assistant |
| MCP server | `src/server/mcp.ts` | stdio transport, project root detection |
| Code search | `src/server/code.ts` | Read-only file tools, confined to the project and refusing secrets |
| Libraries | `src/server/library.ts`, `catalog.ts` | Built-in, installed and project shape libraries, shape search |
| Assistant | `src/server/ai/agent.ts` | Context building, tool loop, per-turn revert, chat history |
| Providers | `src/server/ai/openai.ts`, `ollama.ts`, `anthropic.ts`, `claude-code.ts` | One streaming interface per endpoint kind |
| AI settings | `src/server/ai/settings.ts` | `ai.json`, write-only keys, hot reload |
| Editor | `src/web/Editor.tsx`, `sync.ts` | Excalidraw, scene sync, selection snapshots, undo integration |
| Chat panel | `src/web/Chat.tsx`, `ChatSettings.tsx`, `Shapes.tsx` | Chats and chat history, settings, shape libraries |

## How the assistant handles a message

![One chat message through the assistant: the user types in the chat panel; Assistant.send builds the context and snapshots the canvas; runLoop calls provider.turn up to 40 steps, exchanging messages with the model endpoint; runTool validates arguments and runs drawing tools; edits appear live on the canvas](diagrams/assistant-loop.excalidraw.svg)

*Drawn by the assistant itself, from reading `src/server/ai/agent.ts`. This is the run recorded in the README's GIF.*

1. The panel sends the message with the selected element ids, a snapshot of the selection for models that accept images, and any `@` mentions.
2. `Assistant.send` builds a context block: a compact description of the drawing, the selection, and the mentioned files and drawings. It snapshots the drawing so the turn can be reverted.
3. `runLoop` calls the provider, streaming text and tool calls back to every tab showing the drawing. It runs at most 40 steps.
4. `runTool` validates each call against the tool's schema and runs it. Drawing edits go through the same `op()` path as MCP edits, tagged as the assistant's so the canvas puts them on the undo stack.
5. When the model stops calling tools, the turn ends and the chat session is saved under its drawing.

Claude Code endpoints skip the loop. The daemon runs the `claude` CLI with read-only file tools and an MCP config pointing at `lfx mcp`, and relays its stream to the panel. Claude Code runs its own loop and edits the drawing through MCP.

A model without tool calling gets a prompt asking for Mermaid. Each Mermaid block in its answer is converted with `mermaid_to_drawing`.

## How concurrent editing works

![Sequence: the browser tab saves its scene (debounced 250 ms); the daemon merges by element version and writes atomically; an agent's update_elements is applied with bumped versions and written; the daemon pushes the merged scene to the tab; an external edit such as git checkout is also merged and pushed](diagrams/sync.excalidraw.svg)

*Converted from Mermaid with `mermaid_to_drawing`.*

The daemon uses the same model as Excalidraw's own collaboration. Every element has a `version` and a random `versionNonce`, and when copies disagree the higher version wins. Deletions are tombstones, so they propagate instead of being undone by a stale copy.

Files on disk don't keep tombstones, so the daemon also records recently deleted ids in `tombstones.json` in its state directory (up to 2000 per drawing, for 7 days). After a restart, a tab that still holds a deleted element can't bring it back when it saves.

The daemon is the single writer. It merges every save from the browser, the agent and external edits, writes atomically (temp file and rename), and pushes the result to open tabs. Agent edits are applied inside the daemon, so they can't race your typing on other elements. If you and an agent change the *same* element at the same moment, one version wins, the same as in Excalidraw collaboration.

If a drawing is deleted or moved on disk while open, the tab stops saving and offers **Restore it** instead of silently recreating the file.

## Why the daemon runs the assistant

Running the model calls from the page would have been simpler, but it would mean relaxing the page's `connect-src 'self'` policy and handing API keys to the browser. With the loop in the daemon, the page stays locked to its own origin, keys stay in a 0600 file, and local servers like Ollama are reachable without CORS. It also lets every tab on a drawing see the same chat, and lets the assistant reuse the tool registry and the document store unchanged.
