# Tracing

The daemon and the MCP server can send OpenTelemetry traces of everything the assistant does. Each reply produces one trace: the model calls, the tool calls, and the drawing operations those tools ran. Use it to see where a reply spent its time and tokens, and where the model made mistakes.

Tracing is off by default. Nothing is collected or sent until you set one of the variables below.

## Turn it on

Run a trace viewer locally. [Arize Phoenix](https://github.com/Arize-ai/phoenix) is open source, runs from one container, and shows model and tool calls in readable form:

```bash
docker run -d --name phoenix -p 127.0.0.1:6006:6006 arizephoenix/phoenix:latest
```

Then start the daemon with an OTLP endpoint:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006 \
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \
lfx serve
```

Open http://127.0.0.1:6006 and chat with the assistant. Each reply shows up as an `invoke_agent lfx-assistant` trace. Replies in the same drawing share a session id, so Phoenix groups a drawing's conversation together.

Any OTLP receiver that takes http/protobuf also works: Langfuse, Jaeger, Grafana Tempo, or an OpenTelemetry Collector. gRPC isn't supported.

The macOS app starts the daemon without your shell environment. To trace the app, quit it, run `lfx serve` from a terminal with the variables set, and reopen the app: it uses a daemon that's already running.

## Variables

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Send spans to this OTLP receiver (http/protobuf) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for the receiver, for example `Authorization=Basic ...` for Langfuse |
| `LFX_TRACE_FILE` | Also append each span to this file as one JSON line, for analysis with scripts |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `true` records prompts, replies, tool arguments and tool results |
| `OTEL_SERVICE_NAME` | Overrides the service name (`local-first-excalidraw`, and `local-first-excalidraw-mcp` for the MCP server) |
| `OTEL_SDK_DISABLED` | `true` turns tracing off whatever else is set |

## What a trace contains

```
invoke_agent lfx-assistant        one reply: status, steps, tool calls, tool errors, elements changed, total tokens
├─ chat <model>                   one model call: tokens (and cached tokens), time to first token, stop reason, tools it called
├─ execute_tool create_diagram    one tool call: error kind if it failed, result size, whether the result was truncated
│  └─ lfx.op diagram              the drawing operation the tool ran
│     └─ lfx.editor render        a round trip to the browser tab, for rendering and Mermaid
└─ chat <model>
```

Span names and attributes follow the [OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.*`). They also carry the OpenInference attributes Phoenix reads (`input.value`, `llm.token_count.*`, span kinds). Attributes specific to this app start with `lfx.`.

Some things worth looking at:

- **Failed tool calls.** `execute_tool` spans are marked as errors, with `error.type` set to `unknown_tool`, `invalid_json`, `invalid_arguments` or `tool_error`. Retries after a tool call that couldn't be parsed show up as `lfx.tool_call_parse_retry` events on the reply span.
- **Reverted replies.** **Revert changes** records an `lfx.assistant.revert` span linked to the reply it undid. A revert is the clearest sign a reply was wrong.
- **Slow local models.** For Ollama, `chat` spans carry the server's own timings: `lfx.server.load_ms`, `lfx.server.prompt_ms` and `lfx.server.generate_ms`.
- **Claude Code.** Model calls and Claude Code's file tools are reported from its output stream. Its drawing tools are reported by the `lfx mcp` process it starts, in the same trace. `lfx.claude_code.cost_usd` on the reply span is the cost Claude Code reports.

Drawing tools called by other MCP clients (Claude Code in your terminal, for example) are traced too, as `execute_tool` spans with the daemon's `lfx.op` spans inside them.

## Content and privacy

Without content capture, spans hold counts, timings, tool names, error kinds and drawing paths relative to the project. They hold none of your messages, drawings or code.

With `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, spans also hold the system prompt, your messages, the `<context>` block (which describes the drawing and any files you mentioned), the model's replies, and tool arguments and results. Each value is cut to 16,000 characters, and images are never recorded. Only send content to a receiver you trust, and preferably one on your machine.

To keep spans small, each `chat` span records only the messages that are new since the previous model call: your message for the first call, then the tool results. The reply span records your message and the final reply.

When the assistant runs Claude Code, the exporter settings are passed to the `lfx mcp` process it starts, except `OTEL_EXPORTER_OTLP_HEADERS`. Those settings travel on Claude Code's command line, where other local users could see headers. If your receiver needs headers, the drawing tools in those replies aren't traced.
