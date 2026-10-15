/**
 * OpenAI-compatible Chat Completions, streamed. Covers OpenAI, Ollama, LM Studio,
 * llama.cpp's server, vLLM, OpenRouter and most other local or hosted servers.
 */
import type { Msg, Provider, StreamEvent, ToolCall, TurnRequest, TurnResult } from "./types.js";
import { ProviderError, sse } from "./types.js";

export interface OpenAIOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  vision?: boolean;
}

function headers(apiKey?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function errorOf(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.error?.message ?? j.error ?? j.message ?? body;
  } catch {
    // not JSON
  }
  return new ProviderError(`${res.status} ${res.statusText}: ${String(msg).slice(0, 500)}`, res.status);
}

function toWire(messages: Msg[], vision: boolean): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const images = vision ? m.content.filter((p) => p.type === "image") : [];
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
      out.push({
        role: "user",
        content: images.length
          ? [
              { type: "text", text },
              ...images.map((p) => ({ type: "image_url", image_url: { url: `data:${(p as any).mime};base64,${(p as any).data}` } })),
            ]
          : text,
      });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || (m.toolCalls.length ? null : ""),
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) }
          : {}),
      });
    } else {
      const images: unknown[] = [];
      for (const r of m.results) {
        const text = r.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
        out.push({ role: "tool", tool_call_id: r.id, content: (r.isError ? "Error: " : "") + (text || "(no output)") });
        if (vision) {
          for (const p of r.content) if (p.type === "image") images.push({ type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } });
        }
      }
      // Tool messages can't carry images in Chat Completions; attach them as a user turn.
      if (images.length) out.push({ role: "user", content: [{ type: "text", text: "Image returned by the tool above:" }, ...images] });
    }
  }
  return out;
}

export class OpenAIProvider implements Provider {
  constructor(private o: OpenAIOptions) {}

  async turn(req: TurnRequest, onEvent: (ev: StreamEvent) => void): Promise<TurnResult> {
    const body: Record<string, unknown> = {
      model: this.o.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: req.system }, ...toWire(req.messages, !!this.o.vision)],
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const post = () =>
      fetch(`${this.o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(this.o.apiKey),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    let res = await post();
    if (res.status === 400 || res.status === 422) {
      const err = await errorOf(res);
      if (!/stream_options|include_usage/i.test(err.message)) throw err;
      // Some compatible servers reject usage reporting; ask again without it.
      delete body.stream_options;
      res = await post();
    }
    if (!res.ok || !res.body) throw await errorOf(res);

    let text = "";
    let finish: string | undefined;
    let usage: TurnResult["usage"];
    let model: string | undefined;
    let responseId: string | undefined;
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const data of sse(res.body, req.signal)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(String(chunk.error.message ?? chunk.error));
      model ??= chunk.model;
      responseId ??= chunk.id;
      // With include_usage the totals arrive in a final chunk that has no choices.
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
        usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0, ...(cached ? { cacheRead: cached } : {}) };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === "string" && reasoning) onEvent({ type: "reasoning", text: reasoning });
      if (typeof d.content === "string" && d.content) {
        text += d.content;
        onEvent({ type: "text", text: d.content });
      }
      for (const [n, tc] of ((d.tool_calls ?? []) as any[]).entries()) {
        const i = typeof tc.index === "number" ? tc.index : n;
        calls[i] ??= { id: "", name: "", args: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) {
          calls[i].args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls: ToolCall[] = calls
      .filter((c) => c && c.name)
      .map((c, i) => ({ id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.name, args: c.args }));
    const stop = finish === "length" ? "length" : finish === "content_filter" ? "refusal" : toolCalls.length ? "tool" : "end";
    return { text, toolCalls, stop, usage, model, responseId, finish };
  }
}

export async function listOpenAIModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: headers(apiKey), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw await errorOf(res);
  const j = (await res.json()) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id).sort();
}
