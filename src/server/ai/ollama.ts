/**
 * Ollama's native chat API. Preferred over its OpenAI-compatible endpoint because only the
 * native API can set the context window: Ollama loads models with 4K tokens by default,
 * which silently truncates the assistant's instructions and tool definitions.
 */
import type { Msg, Provider, StreamEvent, ToolCall, TurnRequest, TurnResult } from "./types.js";
import { ProviderError } from "./types.js";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_CONTEXT = 32_768;

export interface OllamaOptions {
  baseUrl?: string;
  model: string;
  contextLength?: number;
  vision?: boolean;
}

function toWire(messages: Msg[], vision: boolean): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const images = vision ? m.content.flatMap((p) => (p.type === "image" ? [p.data] : [])) : [];
      out.push({
        role: "user",
        content: m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n"),
        ...(images.length ? { images } : {}),
      });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text,
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: safeParse(c.args) } })) } : {}),
      });
    } else {
      for (const r of m.results) {
        const images = vision ? r.content.flatMap((p) => (p.type === "image" ? [p.data] : [])) : [];
        out.push({
          role: "tool",
          tool_name: r.name,
          content: (r.isError ? "Error: " : "") + (r.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") || "(no output)"),
          ...(images.length ? { images } : {}),
        });
      }
    }
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

export class OllamaProvider implements Provider {
  private base: string;

  constructor(private o: OllamaOptions) {
    this.base = (o.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/v1$/, "");
  }

  async turn(req: TurnRequest, onEvent: (ev: StreamEvent) => void): Promise<TurnResult> {
    const body: Record<string, unknown> = {
      model: this.o.model,
      stream: true,
      messages: [{ role: "system", content: req.system }, ...toWire(req.messages, !!this.o.vision)],
      options: { num_ctx: this.o.contextLength ?? DEFAULT_CONTEXT },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const res = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let msg = text;
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {
        // not JSON
      }
      throw new ProviderError(`${res.status} ${res.statusText}: ${String(msg).slice(0, 500)}`, res.status);
    }

    let text = "";
    let doneReason: string | undefined;
    let final: any;
    const toolCalls: ToolCall[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line: string) => {
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        return;
      }
      if (chunk.error) throw new ProviderError(String(chunk.error));
      const msg = chunk.message ?? {};
      if (typeof msg.thinking === "string" && msg.thinking) onEvent({ type: "reasoning", text: msg.thinking });
      if (typeof msg.content === "string" && msg.content) {
        text += msg.content;
        onEvent({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        const args = tc.function?.arguments;
        toolCalls.push({
          id: tc.id ?? `call_${Date.now().toString(36)}_${toolCalls.length}`,
          name: String(tc.function?.name ?? ""),
          args: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        });
      }
      if (chunk.done) {
        doneReason = chunk.done_reason;
        final = chunk;
      }
    };
    try {
      while (!req.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) handle(line);
        }
      }
      if (buf.trim()) handle(buf.trim());
    } finally {
      reader.cancel().catch(() => {});
    }
    const stop = doneReason === "length" ? "length" : toolCalls.length ? "tool" : "end";
    // Ollama reports durations in nanoseconds on the final chunk.
    const timings: Record<string, number> = {};
    for (const [k, f] of [["load", "load_duration"], ["prompt", "prompt_eval_duration"], ["generate", "eval_duration"], ["total", "total_duration"]]) {
      if (typeof final?.[f] === "number") timings[k] = Math.round(final[f] / 1e6);
    }
    return {
      text,
      toolCalls,
      stop,
      usage: final?.eval_count !== undefined ? { input: final.prompt_eval_count ?? 0, output: final.eval_count } : undefined,
      model: final?.model,
      finish: doneReason,
      timings,
    };
  }
}

export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const base = (baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/v1$/, "");
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new ProviderError(`${res.status} ${res.statusText}`, res.status);
  const j = (await res.json()) as { models?: { name: string }[] };
  return (j.models ?? []).map((m) => m.name).sort();
}
