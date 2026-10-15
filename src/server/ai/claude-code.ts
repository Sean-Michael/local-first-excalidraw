/**
 * Claude Code as the assistant: runs the local `claude` CLI in print mode with this
 * project's MCP server as its only MCP server. Claude Code brings its own harness (file
 * search, context management) and the user's existing login, so no key is stored here.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "./types.js";

export interface ClaudeCodeOptions {
  bin: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Resume the previous conversation for this drawing. */
  sessionId?: string;
  systemPrompt: string;
  /** Environment for the spawned `lfx mcp`, so it reaches this daemon. */
  mcpEnv: Record<string, string>;
  codeAccess: boolean;
  signal: AbortSignal;
}

export type ClaudeCodeEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** `mcp`: one of this project's drawing tools (served by `lfx mcp`) rather than a built-in. */
  | { type: "tool-start"; callId: string; name: string; args: string; mcp: boolean }
  | { type: "tool-end"; callId: string; ok: boolean; result: string; mcp: boolean }
  /** One model call starting and finishing, with the usage Claude Code streams. */
  | { type: "model-start"; id?: string; model?: string; usage: Usage }
  | { type: "model-end"; usage: Usage; stop?: string }
  | { type: "result"; costUsd?: number; turns?: number; durationMs?: number; apiMs?: number };

export interface ClaudeCodeResult {
  sessionId?: string;
  error?: string;
}

const MCP_PREFIX = "mcp__excalidraw__";
const READ_TOOLS = ["Read", "Grep", "Glob"];

function usageOf(u: any): Usage {
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return { input: (u?.input_tokens ?? 0) + cacheRead + cacheWrite, output: u?.output_tokens ?? 0, cacheRead, cacheWrite };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
  }
  return "";
}

export function claudeCodeArgs(o: ClaudeCodeOptions): string[] {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const mcp = {
    mcpServers: {
      excalidraw: { command: process.execPath, args: [cli, "mcp", "--root", o.cwd], env: o.mcpEnv },
    },
  };
  const tools = o.codeAccess ? READ_TOOLS : [];
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // No shell, no code execution, no web; file tools confined to the project.
    "--restricted",
    "--tools", tools.join(",") || "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify(mcp),
    "--allowedTools", ["mcp__excalidraw", ...tools].join(","),
    "--disallowedTools", `${MCP_PREFIX}open_drawing`,
    "--append-system-prompt", o.systemPrompt,
  ];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.sessionId) args.push("--resume", o.sessionId);
  return args;
}

export function runClaudeCode(
  o: ClaudeCodeOptions,
  prompt: string,
  onEvent: (ev: ClaudeCodeEvent) => void,
): Promise<ClaudeCodeResult> {
  return new Promise((resolve) => {
    const child = spawn(o.bin, claudeCodeArgs(o), {
      cwd: o.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "local-first-excalidraw" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let sessionId: string | undefined;
    let error: string | undefined;
    let stderr = "";
    let buf = "";
    const toolNames = new Map<string, { name: string; mcp: boolean }>();
    let lastUsage: any = {};
    let lastStop: string | undefined;

    const onAbort = () => child.kill("SIGTERM");
    o.signal.addEventListener("abort", onAbort, { once: true });

    const handle = (line: string) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.session_id) sessionId = m.session_id;
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") onEvent({ type: "text", text: ev.delta.text });
          else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) onEvent({ type: "reasoning", text: ev.delta.thinking });
        } else if (ev?.type === "message_start") {
          onEvent({ type: "model-start", id: ev.message?.id, model: ev.message?.model, usage: usageOf(ev.message?.usage) });
          lastUsage = ev.message?.usage ?? {};
        } else if (ev?.type === "message_delta") {
          lastUsage = { ...lastUsage, ...ev.usage };
          lastStop = ev.delta?.stop_reason ?? lastStop;
        } else if (ev?.type === "message_stop") {
          onEvent({ type: "model-end", usage: usageOf(lastUsage), stop: lastStop });
          lastStop = undefined;
        }
      } else if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b.type !== "tool_use") continue;
          const mcp = String(b.name).startsWith(MCP_PREFIX);
          const name = String(b.name).replace(MCP_PREFIX, "");
          toolNames.set(b.id, { name, mcp });
          onEvent({ type: "tool-start", callId: b.id, name, args: JSON.stringify(b.input ?? {}), mcp });
        }
      } else if (m.type === "user") {
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          const tool = b.type === "tool_result" ? toolNames.get(b.tool_use_id) : undefined;
          if (!tool) continue;
          onEvent({ type: "tool-end", callId: b.tool_use_id, ok: !b.is_error, result: resultText(b.content).slice(0, 4000), mcp: tool.mcp });
        }
      } else if (m.type === "result") {
        onEvent({ type: "result", costUsd: m.total_cost_usd, turns: m.num_turns, durationMs: m.duration_ms, apiMs: m.duration_api_ms });
        if (m.is_error || (m.subtype && m.subtype !== "success")) {
          error = typeof m.result === "string" && m.result ? m.result : `Claude Code stopped: ${m.subtype ?? "error"}`;
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    child.on("error", (e) => {
      error = `Could not start Claude Code: ${e.message}`;
    });
    child.on("close", (code) => {
      o.signal.removeEventListener("abort", onAbort);
      if (buf.trim()) handle(buf.trim());
      if (!error && code && !o.signal.aborted) error = stderr.trim() || `Claude Code exited with code ${code}`;
      resolve({ sessionId, error });
    });
    child.stdin.end(prompt);
  });
}
