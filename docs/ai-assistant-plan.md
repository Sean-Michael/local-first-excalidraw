# AI assistant: plan

A chat panel next to the canvas, in both the browser and the macOS app, that can create and edit drawings with any model the user points it at. It is off until the user configures an endpoint.

## Goals

- Chat beside the diagram. The assistant sees the current selection (a rectangle drag or individual items) and can edit it, extend the drawing, or start a new drawing.
- `@` mentions for other drawings and for project files, plus agentic search: the model can list, grep and read files in the project on its own.
- Works with any inference endpoint:
  - **OpenAI-compatible** Chat Completions: OpenAI, Ollama, LM Studio, llama.cpp server, vLLM, OpenRouter, …
  - **Anthropic** Messages API (official SDK).
  - **Claude Code**: the local `claude` CLI, using the user's existing login. Its own harness does the file search; drawing edits go through `lfx mcp`.
- The local-first guarantees stay intact: nothing leaves the machine unless the user configures a remote endpoint, the browser stays locked to its own origin, and keys never reach the page.

## Architecture

```
 browser / WKWebView                     lfx daemon (127.0.0.1)                       model
 ┌──────────────────────┐   WebSocket   ┌────────────────────────────────────┐
 │ canvas  │ chat panel │ ────────────► │ agent loop ──► provider adapter ───┼──► OpenAI-compatible / Anthropic
 │         │            │ ◄──────────── │   │  stream events                 │
 └──────────────────────┘  chat events  │   ▼                                │
         ▲  scene updates (existing)    │ tool registry (shared with MCP)    │
         └───────────────────────────── │   drawing ops → DocStore → file    │
                                        │   code search (read-only, roots)   │
                                        │ claude CLI subprocess ──► lfx mcp ─┼──► Claude Code's own model
                                        └────────────────────────────────────┘
```

- **The agent loop runs in the daemon.** The page keeps `connect-src 'self'`; API keys stay in `~/.local-first-excalidraw/ai.json` (0600) and are never sent to the page; local servers like Ollama are reachable.
- **One tool registry** (`src/server/tools.ts`) defines every drawing tool once (zod schema + handler over a small context interface). The MCP server and the chat agent both use it, so the two can't drift apart. Chat adds three read-only code tools: `list_files`, `search_files`, `read_file`.
- **Edits flow through the existing path:** tool → `op()` → DocStore → file write → WebSocket scene broadcast → canvas. Nothing new on the sync side.

## Components

| Piece | File(s) | Notes |
|---|---|---|
| Shared tool registry | `src/server/tools.ts` | MCP tools + code tools; zod → JSON Schema via `z.toJSONSchema` |
| Code search | `src/server/code.ts` | Confined to the project root (realpath check), skips VCS/build dirs, refuses secret-looking files (`.env*`, keys, credentials), size and result caps |
| AI settings | `src/server/ai/settings.ts` | `ai.json` 0600. Keys are write-only from the page, and changing an endpoint's URL drops its stored key, so a key can't be redirected to another host |
| Providers | `src/server/ai/openai.ts`, `anthropic.ts`, `claude-code.ts` | Common streaming interface; neutral message format, with provider-native blocks kept for replay (Anthropic thinking blocks) |
| Agent | `src/server/ai/agent.ts` | System prompt, per-message context (selection, mentions), tool loop with validation, step cap, stop, per-turn revert, history persisted per drawing |
| Daemon wiring | `src/server/daemon.ts` | `/api/ai/*` routes (settings, models, file mentions), WebSocket `chat*` messages, broadcast of chat events to every tab on that drawing |
| Chat panel | `src/web/Chat.tsx`, `ChatSettings.tsx` | Docked sidebar, streaming markdown-lite rendering, tool-call chips, selection chip, `@` autocomplete, stop/revert/new chat, settings form with presets |
| Canvas integration | `src/web/Editor.tsx` | Selection → context (ids + PNG snapshot for vision models); agent edits recorded as undo steps |
| macOS | `Views.swift`, `App.swift`, `Editor.swift` | Toolbar button + ⌘⇧A toggle the panel via the page's `window.lfx.toggleChat()` |

## Context sent with each message

- The drawing's compact description (`describe()`), as already used by `read_drawing`.
- The selection: element ids plus their description, and a PNG of the selected region if the endpoint is marked vision-capable.
- Mentioned drawings (description) and files (contents, capped).
- The project root, so the model knows where its file tools are confined.

## Undo and revert

- Each agent edit arrives as a scene update flagged as coming from the assistant, and the canvas records it as an undo step, so ⌘Z works.
- Each assistant turn also gets a **Revert** button. The daemon snapshots the drawing before the turn and, on revert, restores only the elements the turn changed that nobody has edited since.

## Security

- Settings and chat are available to the signed-in browser session and to bearer clients; nothing new is exposed to other origins.
- The Claude Code binary comes from `PATH` or `LFX_CLAUDE_BIN`, never from page-supplied settings (that would be code execution from the page). It runs with `--strict-mcp-config`, only the excalidraw MCP server, and only read-only built-in tools (Read, Grep, Glob, LS).
- Code tools never write and never leave the project root. Secret-looking files are refused even when asked for by name.
- The panel always shows where requests go (`→ localhost:11434 · qwen3-coder:30b` or `→ api.anthropic.com · claude-opus-5-5`).

## Testing

- Unit: code-search confinement (`..`, absolute paths, symlinks, secrets), settings key handling, the tool registry's JSON Schemas, revert logic.
- Integration: a real daemon in-process plus fake OpenAI-compatible and Anthropic streaming servers, driving a full chat turn with tool calls, and checking that the drawing changed on disk and the events streamed.
- End to end: the browser pane against a local Ollama model, and the Claude Code adapter against the real `claude` CLI.

## Not in this round

- macOS Keychain storage for keys (the 0600 state file is used on every platform for now).
- Write access to code files. The assistant edits drawings only.
