/**
 * Chat transcript shared by the daemon and the web UI. The daemon owns the transcript and
 * streams events tagged with their session; every tab applies the events of the session it
 * shows with the same reducer, so they stay in step.
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
  /** After a revert: elements put back, and elements kept because the user edited them since. */
  revertedCount?: number;
  keptCount?: number;
  /** Number of elements this turn changed. */
  changed?: number;
}

export type ChatItem = UserItem | AssistantItem;

/** One conversation about a drawing. A drawing keeps every past session; one is open at a time. */
export interface ChatSessionInfo {
  id: string;
  /** From the first message. */
  title: string;
  created: number;
  updated: number;
  /** Id of the endpoint this session talks to; unset means the default endpoint. */
  endpoint?: string;
  /** User messages so far. */
  messages: number;
  /** A reply is being written. */
  busy: boolean;
}

export type ChatEvent =
  /** The open session, sent on connect and whenever another session is opened. */
  | { type: "history"; session: string; endpoint?: string; items: ChatItem[]; busy: boolean; sessions: ChatSessionInfo[] }
  /** The drawing's session list changed (a title, a session starting or finishing a reply). */
  | { type: "sessions"; sessions: ChatSessionInfo[] }
  | { type: "user"; item: UserItem }
  | { type: "turn-start"; id: string; endpoint: string }
  | { type: "delta"; id: string; part: "text" | "reasoning"; text: string }
  | { type: "tool-start"; id: string; callId: string; name: string; args: string }
  | { type: "tool-end"; id: string; callId: string; ok: boolean; result: string; drawing?: string }
  | { type: "turn-end"; id: string; status: AssistantItem["status"]; error?: string; revertable: boolean; changed: number }
  | { type: "reverted"; id: string; restored: number; skipped: number };

export interface Mention {
  /** A folder attaches an overview of it, not every file; a symbol attaches its definition. */
  kind: "file" | "drawing" | "folder" | "symbol";
  /** Absolute path; for a symbol, the file that defines it. */
  path: string;
  /** Only these lines of a file (1-based, inclusive); for a symbol, its definition. */
  lines?: [number, number];
  /** The symbol's name, for a symbol. */
  symbol?: string;
}

/** What the page sends with a chat message. */
export interface ChatRequest {
  path: string;
  /** Session to continue; the drawing's open session when omitted. */
  session?: string;
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
  /** Prompts offered under / in the message box and as starters in an empty chat. */
  prompts: SavedPrompt[];
  /** Tools the assistant isn't given (by name, see GET /api/ai/tools). */
  disabledTools: string[];
}

/** A reusable message for the assistant. */
export interface SavedPrompt {
  id: string;
  /** Short name shown in the / menu, e.g. "UML class diagram". */
  name: string;
  text: string;
}

/** One tool the assistant can call, as the settings page lists it. */
export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  group: "Drawing" | "Code" | "Reference";
  readOnly: boolean;
  enabled: boolean;
  /** Why the assistant never gets it, or gets it only sometimes, whatever the setting. */
  note?: string;
}

/** What GET /api/ai/tools returns: the tools, and the diagram reference topics the assistant can read. */
export interface ToolCatalog {
  tools: ToolInfo[];
  topics: { topic: string; title: string; covers: string[] }[];
}

/**
 * The prompts a new install starts with. Once the user saves their own list (in settings or
 * ai.json), that list replaces these.
 */
export const DEFAULT_PROMPTS: SavedPrompt[] = [
  { id: "architecture", name: "Architecture of this project", text: "Draw the architecture of this project: its services, data stores, queues and external systems, and how they talk to each other." },
  { id: "c4-container", name: "C4 container diagram", text: "Draw a C4 container diagram of this project, with the system boundary, the people who use it and the external systems it depends on." },
  { id: "uml-class", name: "UML class diagram", text: "Draw a UML class diagram of " },
  { id: "sequence", name: "Sequence diagram", text: "Draw a sequence diagram of what happens when " },
  { id: "state", name: "State machine", text: "Draw a state machine diagram of the lifecycle of " },
  { id: "use-case", name: "Use case diagram", text: "Draw a UML use case diagram for " },
  { id: "er", name: "ER diagram", text: "Draw an entity-relationship diagram of the data model in " },
  { id: "update", name: "Update after my change", text: "The code changed. Update this diagram to match: keep my layout and only change what the change affects." },
  { id: "tidy", name: "Tidy the selection", text: "Tidy up the selected items: fix overlaps, align them and make every label fit." },
];

export function applyChatEvent(items: ChatItem[], ev: ChatEvent): ChatItem[] {
  const turn = (id: string, f: (t: AssistantItem) => AssistantItem) =>
    items.map((it) => (it.kind === "assistant" && it.id === id ? f(it) : it));
  switch (ev.type) {
    case "history":
      return ev.items;
    case "sessions":
      return items;
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
      return turn(ev.id, (t) => ({ ...t, reverted: true, revertable: false, revertedCount: ev.restored, keptCount: ev.skipped }));
  }
}

/** What a revert did, e.g. "Reverted 3, kept 1 you edited since". */
export function revertSummary(item: Pick<AssistantItem, "revertedCount" | "keptCount">): string {
  const kept = item.keptCount ?? 0;
  if (!kept) return "Changes reverted";
  return `Reverted ${item.revertedCount ?? 0}, kept ${kept} you edited since`;
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
