/**
 * `--via assistant`: runs a scenario through the daemon's in-app assistant instead of
 * `claude -p` over MCP. The isolated daemon gets an ai.json with one Claude Code endpoint (which
 * uses your `claude` login), and the harness acts as an editor tab: it opens the drawing over
 * the WebSocket, sends the prompt as a chat message, and records the chat events until the turn
 * ends. Cost and turns come from the daemon's trace file.
 */
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import type { TranscriptSummary } from "./claude.js";
import type { EvalDaemon } from "./daemon.js";

/** ai.json for the isolated daemon: the assistant on, project file access on, Claude Code as the only endpoint. */
export function assistantSettings(model?: string) {
  return {
    enabled: true,
    active: "claude-code",
    codeAccess: true,
    endpoints: [{ id: "claude-code", name: "Claude Code", kind: "claude-code", ...(model ? { model } : {}) }],
  };
}

export interface AssistantRun {
  status: "done" | "error" | "stopped" | "timeout";
  error?: string;
  wallMs: number;
}

/**
 * Opens `drawing` as an editor tab would and sends `prompt` to the assistant. Every chat event
 * goes to `transcriptFile` (one JSON object per line). Stops the turn after `timeoutSec`.
 */
export async function runAssistant(daemon: EvalDaemon, drawing: string, prompt: string, opts: { transcriptFile: string; timeoutSec: number }): Promise<AssistantRun> {
  const started = Date.now();
  const out = fs.createWriteStream(opts.transcriptFile);
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { headers: { Authorization: `Bearer ${daemon.token()}`, Origin: daemon.url } });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let session = "";
  let sent = false;
  const result = await new Promise<AssistantRun>((resolve) => {
    const finish = (r: Omit<AssistantRun, "wallMs">) => resolve({ ...r, wallMs: Date.now() - started });
    const timer = setTimeout(() => {
      ws.send(JSON.stringify({ t: "chat-stop", session }));
      // Give the stop a moment to land so the transcript ends cleanly.
      setTimeout(() => finish({ status: "timeout", error: `No reply within ${opts.timeoutSec} s` }), 3000);
    }, opts.timeoutSec * 1000);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "chat-error") {
        out.write(`${JSON.stringify(m)}\n`);
        clearTimeout(timer);
        finish({ status: "error", error: m.message });
        return;
      }
      if (m.t !== "chat") return;
      if (m.ev.type === "history" && !sent) {
        sent = true;
        session = m.ev.session;
        ws.send(JSON.stringify({ t: "chat-send", path: drawing, session, text: prompt, selection: [], mentions: [] }));
        return;
      }
      if (m.session !== session) return;
      out.write(`${JSON.stringify(m.ev)}\n`);
      if (m.ev.type === "turn-end") {
        clearTimeout(timer);
        finish({ status: m.ev.status, error: m.ev.error });
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      finish({ status: "error", error: "The daemon closed the connection" });
    });
    ws.send(JSON.stringify({ t: "open", path: drawing }));
  });
  ws.removeAllListeners("close");
  ws.close();
  await new Promise<void>((r) => out.end(r));
  return result;
}

/** Claude Code's own tools; everything else the assistant calls is a drawing or code tool over MCP. */
const BUILTIN = /^[A-Z]/;

/**
 * The chat events of one turn in the shape the report expects. Drawing and code tools are
 * counted as MCP tools (`mcp__excalidraw__name`), as they are in a `claude -p` run.
 */
export function summariseChat(lines: string[], traceFile?: string): TranscriptSummary {
  const s: TranscriptSummary = { toolCalls: [], toolCounts: {}, toolErrors: [], skillsUsed: [], permissionDenials: [] };
  const byId = new Map<string, TranscriptSummary["toolCalls"][number]>();
  let text = "";
  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "tool-start") {
      const name = BUILTIN.test(ev.name) ? ev.name : `mcp__excalidraw__${ev.name}`;
      const call = { name, input: (() => { try { return JSON.parse(ev.args); } catch { return ev.args; } })() };
      byId.set(ev.callId, call);
      s.toolCalls.push(call);
      s.toolCounts[name] = (s.toolCounts[name] ?? 0) + 1;
    } else if (ev.type === "tool-end" && !ev.ok) {
      const call = byId.get(ev.callId);
      const error = String(ev.result).slice(0, 400);
      if (call) call.error = error;
      s.toolErrors.push({ name: call?.name ?? "?", error });
    } else if (ev.type === "delta" && ev.part === "text") text += ev.text;
    else if (ev.type === "turn-end") {
      s.resultSubtype = ev.status;
      s.isError = ev.status === "error";
    } else if (ev.type === "chat-error") s.isError = true;
  }
  s.finalText = text || undefined;
  // The turn's span carries Claude Code's reported cost, turns and duration.
  if (traceFile && fs.existsSync(traceFile)) {
    for (const line of fs.readFileSync(traceFile, "utf8").split("\n")) {
      if (!line.includes("invoke_agent")) continue;
      try {
        const span = JSON.parse(line);
        if (!String(span.name).startsWith("invoke_agent")) continue;
        const a = span.attributes ?? {};
        s.costUsd = (s.costUsd ?? 0) + (Number(a["lfx.claude_code.cost_usd"]) || 0);
        s.turns = (s.turns ?? 0) + (Number(a["lfx.claude_code.turns"]) || 0);
        s.durationMs = (s.durationMs ?? 0) + (Number(span.durationMs) || 0);
        s.model = a["gen_ai.request.model"] ?? s.model;
      } catch {
        // a partial line
      }
    }
  }
  return s;
}

export const traceFileFor = (runDir: string) => path.join(runDir, "trace.jsonl");
