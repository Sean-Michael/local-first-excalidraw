/** Anthropic Messages API through the official SDK, streamed, with tool use and caching. */
import Anthropic from "@anthropic-ai/sdk";
import type { Msg, Part, Provider, StreamEvent, TurnRequest, TurnResult } from "./types.js";
import { ProviderError } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const DEFAULT_HOST = "api.anthropic.com";

export interface AnthropicOptions {
  baseUrl?: string;
  model: string;
  apiKey?: string;
  effort?: string;
}

/** Models that take adaptive thinking; older ones would reject it. */
const ADAPTIVE = /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/;
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACKS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function blocks(parts: Part[]): any[] {
  return parts.map((p) =>
    p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } },
  );
}

function toWire(messages: Msg[], model: string): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: blocks(m.content) });
    else if (m.role === "assistant") {
      // Replay the exact content (thinking blocks included) when it came from this model.
      const native = m.native?.kind === `anthropic:${model}` ? (m.native.content as any[]) : undefined;
      const content = native ?? [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: safeParse(c.args) })),
      ];
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          is_error: r.isError || undefined,
          content: r.content.length ? blocks(r.content) : [{ type: "text", text: "(no output)" }],
        })),
      });
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

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private defaultHost: boolean;

  constructor(private o: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: o.apiKey ?? null, baseURL: o.baseUrl, maxRetries: 2 });
    this.defaultHost = !o.baseUrl || new URL(o.baseUrl).host === DEFAULT_HOST;
  }

  async turn(req: TurnRequest, onEvent: (ev: StreamEvent) => void): Promise<TurnResult> {
    const model = this.o.model;
    const params: Record<string, unknown> = {
      model,
      max_tokens: 32000,
      system: [{ type: "text", text: req.system }],
      messages: toWire(req.messages, model),
      // Caches the stable prefix (tools, system, earlier turns) across the agent loop.
      cache_control: { type: "ephemeral" },
    };
    if (req.tools.length) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        ...(this.defaultHost ? { eager_input_streaming: true } : {}),
      }));
    }
    if (ADAPTIVE.test(model)) params.thinking = { type: "adaptive", display: "summarized" };
    if (this.o.effort) params.output_config = { effort: this.o.effort };
    const betas: string[] = [];
    if (this.defaultHost && FALLBACKS.has(model)) {
      betas.push("server-side-fallback-2026-07-01");
      params.fallbacks = "default";
    }
    if (betas.length) params.betas = betas;

    let final: any;
    try {
      const stream = this.client.beta.messages.stream(params as any, { signal: req.signal });
      for await (const ev of stream as AsyncIterable<any>) {
        if (ev.type !== "content_block_delta") continue;
        if (ev.delta.type === "text_delta") onEvent({ type: "text", text: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") onEvent({ type: "reasoning", text: ev.delta.thinking });
      }
      final = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new ProviderError(e.message, e.status);
      throw e;
    }

    const content = (final.content ?? []) as any[];
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolCalls = content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id as string, name: b.name as string, args: JSON.stringify(b.input ?? {}) }));
    const sr = final.stop_reason;
    const stop = sr === "max_tokens" ? "length" : sr === "refusal" ? "refusal" : sr === "tool_use" ? "tool" : "end";
    return { text, toolCalls, stop, native: { kind: `anthropic:${model}`, content } };
  }
}

export async function listAnthropicModels(baseUrl: string | undefined, apiKey: string | undefined): Promise<string[]> {
  const client = new Anthropic({ apiKey: apiKey ?? null, baseURL: baseUrl, timeout: 8000, maxRetries: 0 });
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids;
}
