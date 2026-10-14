/**
 * Chat transcript shared by the daemon and the web UI. The daemon owns the transcript and
 * streams events; every tab applies them with the same reducer, so they stay in step.
 * Pure data, no I/O: imported by both the Node build and the Vite build.
 */

export type EndpointKind = "openai" | "ollama" | "anthropic" | "claude-code";

export interface ToolPart {
  type: "tool";
  callId: string;
  name: string;
  args: string;
  status: "running" | "ok" | "error";
  result?: string;
  /** A drawing other than the open one that this call created or changed. */
  drawing?: string;
}

export type AssistantPart = { type: "text"; text: string } | { type: "reasoning"; text: string } | ToolPart;

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  context: { selection: number; mentions: string[]; image: boolean };
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  /** Where the request went, e.g. "localhost:11434 · qwen3-coder:30b". */
  endpoint: string;
  parts: AssistantPart[];
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  /** The daemon still holds the snapshot needed to undo this turn's edits. */
  revertable?: boolean;
  reverted?: boolean;
  /** Number of elements this turn changed. */
  changed?: number;
}

export type ChatItem = UserItem | AssistantItem;

export type ChatEvent =
  | { type: "history"; items: ChatItem[]; busy: boolean }
  | { type: "user"; item: UserItem }
  | { type: "turn-start"; id: string; endpoint: string }
  | { type: "delta"; id: string; part: "text" | "reasoning"; text: string }
  | { type: "tool-start"; id: string; callId: string; name: string; args: string }
  | { type: "tool-end"; id: string; callId: string; ok: boolean; result: string; drawing?: string }
  | { type: "turn-end"; id: string; status: AssistantItem["status"]; error?: string; revertable: boolean; changed: number }
  | { type: "reverted"; id: string; restored: number; skipped: number }
  | { type: "reset" };

export interface Mention {
  kind: "file" | "drawing";
  /** Absolute path. */
  path: string;
}

/** What the page sends with a chat message. */
export interface ChatRequest {
  path: string;
  text: string;
  selection: string[];
  mentions: Mention[];
  image?: { data: string; mime: string };
}

/** Endpoint settings as the page sees them: keys are write-only. */
export interface PublicEndpoint {
  id: string;
  name: string;
  kind: EndpointKind;
  baseUrl?: string;
  model?: string;
  vision?: boolean;
  tools?: boolean;
  effort?: string;
  contextLength?: number;
  hasKey: boolean;
  /** Where a key comes from when none is stored, e.g. "$ANTHROPIC_API_KEY". */
  keyFromEnv?: string;
}

export interface PublicSettings {
  enabled: boolean;
  active?: string;
  codeAccess: boolean;
  endpoints: PublicEndpoint[];
  claudeCode: { available: boolean; path?: string };
  /** Where the settings live on disk; hand edits are picked up without a restart. */
  file?: string;
  /** Set when a hand edit to the file couldn't be loaded; the last good settings stay in use. */
  fileError?: string;
}

export function applyChatEvent(items: ChatItem[], ev: ChatEvent): ChatItem[] {
  const turn = (id: string, f: (t: AssistantItem) => AssistantItem) =>
    items.map((it) => (it.kind === "assistant" && it.id === id ? f(it) : it));
  switch (ev.type) {
    case "history":
      return ev.items;
    case "reset":
      return [];
    case "user":
      return [...items, ev.item];
    case "turn-start":
      return [...items, { kind: "assistant", id: ev.id, endpoint: ev.endpoint, parts: [], status: "running" }];
    case "delta":
      return turn(ev.id, (t) => {
        const last = t.parts[t.parts.length - 1];
        if (last && last.type === ev.part) {
          return { ...t, parts: [...t.parts.slice(0, -1), { ...last, text: last.text + ev.text }] };
        }
        return { ...t, parts: [...t.parts, { type: ev.part, text: ev.text }] };
      });
    case "tool-start":
      return turn(ev.id, (t) => ({
        ...t,
        parts: [...t.parts, { type: "tool", callId: ev.callId, name: ev.name, args: ev.args, status: "running" }],
      }));
    case "tool-end":
      return turn(ev.id, (t) => ({
        ...t,
        parts: t.parts.map((p) =>
          p.type === "tool" && p.callId === ev.callId
            ? { ...p, status: ev.ok ? "ok" : "error", result: ev.result, drawing: ev.drawing }
            : p,
        ),
      }));
    case "turn-end":
      return turn(ev.id, (t) => ({
        ...t,
        status: ev.status,
        error: ev.error,
        revertable: ev.revertable,
        changed: ev.changed,
        parts: t.parts.map((p) => (p.type === "tool" && p.status === "running" ? { ...p, status: "error", result: "Cancelled" } : p)),
      }));
    case "reverted":
      return turn(ev.id, (t) => ({ ...t, reverted: true, revertable: false }));
  }
}

/** "http://localhost:11434/v1" -> "localhost:11434". */
export function endpointHost(e: { kind: EndpointKind; baseUrl?: string }): string {
  if (e.kind === "claude-code") return "Claude Code";
  try {
    return new URL(e.baseUrl ?? (e.kind === "anthropic" ? "https://api.anthropic.com" : e.kind === "ollama" ? "http://localhost:11434" : "")).host;
  } catch {
    return e.baseUrl ?? "";
  }
}

export function endpointLabel(e: { kind: EndpointKind; baseUrl?: string; model?: string }): string {
  const host = endpointHost(e);
  return e.model ? `${host} · ${e.model}` : host;
}
