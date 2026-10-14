/** Provider-neutral conversation format used by the assistant's agent loop. */

export type Part = { type: "text"; text: string } | { type: "image"; data: string; mime: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as the model produced them. */
  args: string;
}

export interface ToolResult {
  id: string;
  name: string;
  content: Part[];
  isError?: boolean;
}

export type Msg =
  | { role: "user"; content: Part[] }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native content, replayed verbatim to the same provider (e.g. Anthropic thinking blocks). */
      native?: { kind: string; content: unknown };
    }
  | { role: "tool"; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent = { type: "text"; text: string } | { type: "reasoning"; text: string };

export interface TurnRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool" | "length" | "refusal";
  native?: { kind: string; content: unknown };
}

export interface Provider {
  turn(req: TurnRequest, onEvent: (ev: StreamEvent) => void): Promise<TurnResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Reads a fetch body as server-sent events, yielding each `data:` payload. */
export async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === "\r" ? 4 : 2));
        const data = chunk
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
    const tail = buf.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.cancel().catch(() => {});
  }
}
