# Configuration

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `LFX_PORT` | `7467` | Daemon port |
| `LFX_STATE_DIR` | `~/.local-first-excalidraw` | Token, sessions, roots, libraries, assistant settings and chats, log |
| `LFX_ROOTS` | `~/Excalidraw` | Always-allowed roots, `:`-separated |
| `LFX_DEFAULT_DIR` | `docs/diagrams` | Where bare drawing names go |
| `LFX_PROJECT_ROOT` | MCP root, `$CLAUDE_PROJECT_DIR`, or cwd | Project root for the MCP server (same as `lfx mcp --root`) |
| `LFX_LOCK_ROOTS` | unset | `1` refuses registration of extra roots |
| `LFX_NO_BROWSER` | unset | `1` prints links instead of opening a browser |
| `LFX_IDLE_EXIT_MIN` | `30` when started on demand | The daemon stops after this many minutes with no editor open, no request and no reply in progress. Unset for `lfx serve` |
| `LFX_PARENT_PID` | set by the macOS app | The daemon stops when this process exits |
| `LFX_CLAUDE_BIN` | `claude` on `PATH` | Claude Code binary for the assistant |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | unset | Used when an endpoint for that service has no stored key |
| `LFX_HOST`, `LFX_ALLOWED_HOSTS` | `127.0.0.1` | Bind address and extra allowed `Host` headers, for containers only |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `LFX_TRACE_FILE` | unset | Send traces of the assistant to an OTLP receiver or a file; see [Tracing](tracing.md) |

## ai.json

Assistant settings live in `~/.local-first-excalidraw/ai.json` (mode 0600). Edit them in the app with **Edit as JSON**, or edit the file directly: the daemon reloads it without a restart and keeps the last good settings if it doesn't parse. Comments and trailing commas are allowed.

```jsonc
{
  "enabled": true,
  "codeAccess": true,        // let the model list, search and read project files
  "active": "cc",            // id of the endpoint in use
  "endpoints": [
    { "id": "cc", "name": "Claude Code", "kind": "claude-code", "model": "sonnet" },
    {
      "id": "ol",
      "name": "Ollama",
      "kind": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "gpt-oss:20b",
      "tools": true,
      "contextLength": 32768,
    },
  ],
}
```

Endpoint fields:

| Field | Applies to | Meaning |
|---|---|---|
| `id` | all | Unique id, referenced by `active` |
| `name` | all | Label in the panel |
| `kind` | all | `ollama`, `openai`, `anthropic` or `claude-code` |
| `baseUrl` | `ollama`, `openai`, `anthropic` | Server URL. Changing it drops the stored key. |
| `model` | all | Model name; for `claude-code`, any value `claude --model` accepts |
| `apiKey` | `openai`, `anthropic` | Write-only. Set a string to store a key, `null` to remove it. Never shown in the app. |
| `tools` | all but `claude-code` | Model supports tool calling. Off means it answers in Mermaid. |
| `vision` | all but `claude-code` | Model accepts images, so the selection is sent as a snapshot too |
| `effort` | `anthropic`, `claude-code` | `low`, `medium`, `high`, `xhigh` or `max` |
| `contextLength` | `ollama` | Context window to load the model with |
