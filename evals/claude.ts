/**
 * Runs `claude -p` headless and summarises its stream-json transcript.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

export interface ToolCall {
  name: string;
  input: unknown;
  error?: string;
}

export interface TranscriptSummary {
  model?: string;
  mcpServers?: { name: string; status: string }[];
  /** Skills and plugins Claude Code reported at start-up, when it reports them. */
  skills?: string[];
  plugins?: unknown;
  toolCalls: ToolCall[];
  toolCounts: Record<string, number>;
  toolErrors: { name: string; error: string }[];
  skillsUsed: string[];
  permissionDenials: unknown[];
  turns?: number;
  costUsd?: number;
  usage?: unknown;
  durationMs?: number;
  resultSubtype?: string;
  isError?: boolean;
  finalText?: string;
}

type Json = Record<string, any>;

const errorText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ");
  return JSON.stringify(content);
};

/** Parses stream-json lines (one JSON object per line). Unparseable lines are skipped. */
export function summariseTranscript(lines: string[]): TranscriptSummary {
  const s: TranscriptSummary = { toolCalls: [], toolCounts: {}, toolErrors: [], skillsUsed: [], permissionDenials: [] };
  const byId = new Map<string, ToolCall>();
  for (const line of lines) {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init") {
      s.model = m.model;
      s.mcpServers = m.mcp_servers;
      s.skills = m.skills;
      s.plugins = m.plugins;
    } else if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        const call: ToolCall = { name: c.name, input: c.input };
        byId.set(c.id, call);
        s.toolCalls.push(call);
        s.toolCounts[c.name] = (s.toolCounts[c.name] ?? 0) + 1;
        if (c.name === "Skill" && typeof c.input?.skill === "string") s.skillsUsed.push(c.input.skill);
      }
    } else if (m.type === "user") {
      for (const c of m.message?.content ?? []) {
        if (c.type !== "tool_result" || !c.is_error) continue;
        const call = byId.get(c.tool_use_id);
        const error = errorText(c.content).slice(0, 400);
        if (call) call.error = error;
        s.toolErrors.push({ name: call?.name ?? "?", error });
      }
    } else if (m.type === "result") {
      s.turns = m.num_turns;
      s.costUsd = m.total_cost_usd;
      s.usage = m.usage;
      s.durationMs = m.duration_ms;
      s.resultSubtype = m.subtype;
      s.isError = m.is_error;
      s.finalText = typeof m.result === "string" ? m.result : undefined;
      s.permissionDenials = m.permission_denials ?? [];
    }
  }
  return s;
}

export interface ClaudeRun {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  stderr: string;
}

/** Spawns claude, streaming stdout to `transcriptFile`. Kills it after `timeoutSec`. */
export function runClaude(args: string[], opts: { cwd: string; env: Record<string, string>; transcriptFile: string; timeoutSec: number }): Promise<ClaudeRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const out = fs.createWriteStream(opts.transcriptFile);
    const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutSec * 1000);
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const done = (code: number | null) => {
      clearTimeout(timer);
      out.end(() => resolve({ exitCode: code, timedOut, wallMs: Date.now() - started, stderr: stderr.slice(-4000) }));
    };
    child.on("error", (e) => {
      stderr += String(e);
      done(null);
    });
    child.on("close", done);
  });
}
