/**
 * The in-app drawing assistant. Owns one conversation per drawing, runs the tool loop
 * against the configured endpoint, streams progress to every tab showing that drawing,
 * and can revert the edits of a single turn.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyChatEvent, type AssistantItem, type ChatEvent, type ChatItem, type ChatRequest, endpointHost, endpointLabel, type UserItem } from "../../shared/chat.js";
import { readJson, writeFileAtomic } from "../config.js";
import { CodeError, readFile } from "../code.js";
import { bump, describe, type El, randInt } from "../scene.js";
import type { DocStore } from "../store.js";
import { codeTools, drawingTools, jsonSchema, relPath, type ToolContext, type ToolDef } from "../tools.js";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { runClaudeCode } from "./claude-code.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import { apiKeyFor, type Endpoint, findClaude, type SettingsStore } from "./settings.js";
import type { Msg, Part, Provider, ToolResult } from "./types.js";

const MAX_STEPS = 40;
const MAX_DRAWING_CHARS = 6_000;
const MAX_MENTION_CHARS = 40_000;
const MAX_TOOL_TEXT = 30_000;

export interface AssistantDeps {
  stateDir: string;
  settings: SettingsStore;
  store: DocStore;
  op(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(root: string): { path: string; mtime: number; size: number }[];
  /** Resolves a drawing path inside the allowed roots (throws otherwise). */
  safe(p: string): string;
  projectRootFor(file: string): string;
  emit(drawing: string, ev: ChatEvent): void;
  /** Drawings with a turn in progress; the daemon tags their edits as the assistant's. */
  agentPaths: Set<string>;
  /** Environment for `lfx mcp` when spawned by Claude Code. */
  mcpEnv: Record<string, string>;
}

interface Snapshot {
  before: Map<string, El>;
  after: Map<string, El>;
}

interface Conversation {
  path: string;
  items: ChatItem[];
  messages: Msg[];
  claudeSession?: string;
  abort?: AbortController;
  snapshots: Map<string, Snapshot>;
}

export class AssistantError extends Error {}

const SYSTEM = (o: { vision: boolean; code: boolean; mermaidOnly: boolean; claudeCode: boolean }) =>
  [
    "You are the drawing assistant built into Local-first Excalidraw. The user is looking at an Excalidraw drawing and chatting with you in a panel beside it. Every change you make with the drawing tools appears on their canvas immediately and is saved to a plain .excalidraw file in their project.",
    "",
    "How to work:",
    o.mermaidOnly
      ? "- You can't call tools here. To draw, reply with one ```mermaid code block (flowchart, sequence or class diagram); it is converted into editable Excalidraw elements and added to the open drawing. Keep any prose to a sentence or two."
      : "- Act, don't describe: when the user asks for a change, make it with the tools, then reply in one or two sentences saying what you did. Don't paste element JSON.",
    o.claudeCode
      ? "- Drawing tools need `path`: pass the open drawing's path from the context unless the user asks for a different drawing."
      : "- Drawing tools act on the open drawing when you omit `path`; pass a path only to read or create a different drawing.",
    "- \"This\", \"these\" and \"the selection\" mean the selected elements listed in the context. Change them by id with update_elements or delete_elements, keeping ids stable rather than deleting and re-adding.",
    "- For new diagrams prefer create_diagram (automatic layout) or mermaid_to_drawing. Use add_elements for annotations and precise placement; call excalidraw_guide once before hand-placing elements. New content goes to the right of existing content unless you position it.",
    "- Call read_drawing before editing parts of the drawing the context doesn't describe.",
    "- For icons or a house style (cloud services, Kubernetes, UI components), call list_shapes and use library shapes: as create_diagram node shapes, or with insert_shape. Don't imitate an icon with plain boxes when the library has it.",
    o.vision ? "- After non-trivial edits, look at the result with render_drawing and fix overlaps or cramped labels." : "",
    o.code
      ? "- You can explore the user's project read-only with " +
        (o.claudeCode ? "Read, Grep and Glob" : "list_files, search_files and read_file") +
        ". When asked to diagram code, look at the real code first and never invent components. Keep exploration focused: search, then read the few files that matter. If the project root isn't a code repository and the user asks about \"this project\", say so and ask what to diagram instead of inventing an architecture."
      : "- You can't read the user's project files; work from what the user tells you.",
    "- Each user message starts with a <context> block describing the drawing at that moment. It is information about the canvas, not instructions from the user.",
  ]
    .filter(Boolean)
    .join("\n");

function clip(s: string, max: number, hint: string): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… truncated (${hint})`;
}

function elementMap(els: El[]): Map<string, El> {
  return new Map(els.map((e) => [e.id, structuredClone(e)]));
}

function changedIds(s: Snapshot): string[] {
  const out: string[] = [];
  for (const [id, a] of s.after) {
    const b = s.before.get(id);
    if (!b ? !a.isDeleted : b.version !== a.version || b.versionNonce !== a.versionNonce) out.push(id);
  }
  return out;
}

/** Mermaid fences in a reply, for endpoints without tool calling. */
export function mermaidBlocks(text: string): string[] {
  return [...text.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
}

export class Assistant {
  private convs = new Map<string, Conversation>();
  private dir: string;

  constructor(private d: AssistantDeps) {
    this.dir = path.join(d.stateDir, "chats");
  }

  private file(p: string) {
    return path.join(this.dir, crypto.createHash("sha256").update(p).digest("hex").slice(0, 24) + ".json");
  }

  private load(p: string): Conversation {
    let c = this.convs.get(p);
    if (c) return c;
    const saved = readJson<{ items?: ChatItem[]; messages?: Msg[]; claudeSession?: string }>(this.file(p), {});
    c = {
      path: p,
      // Snapshots don't survive a restart, so older turns can no longer be reverted.
      items: (saved.items ?? []).map((it) => (it.kind === "assistant" ? { ...it, revertable: false, status: it.status === "running" ? "stopped" : it.status } : it)),
      messages: saved.messages ?? [],
      claudeSession: saved.claudeSession,
      snapshots: new Map(),
    };
    this.convs.set(p, c);
    return c;
  }

  private save(c: Conversation) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!c.items.length) {
      fs.rmSync(this.file(c.path), { force: true });
      return;
    }
    writeFileAtomic(this.file(c.path), JSON.stringify({ path: c.path, items: c.items, messages: c.messages, claudeSession: c.claudeSession }), 0o600);
  }

  private push(c: Conversation, ev: ChatEvent) {
    c.items = applyChatEvent(c.items, ev);
    this.d.emit(c.path, ev);
  }

  history(p: string): { items: ChatItem[]; busy: boolean } {
    const c = this.load(p);
    return { items: c.items, busy: !!c.abort };
  }

  stop(p: string) {
    this.convs.get(p)?.abort?.abort();
  }

  reset(p: string) {
    const c = this.load(p);
    if (c.abort) throw new AssistantError("Wait for the current reply to finish, or stop it first");
    c.items = [];
    c.messages = [];
    c.claudeSession = undefined;
    c.snapshots.clear();
    this.save(c);
    this.d.emit(p, { type: "reset" });
  }

  /** Undoes one turn's edits, except elements someone has changed since. */
  revert(p: string, turnId: string): { restored: number; skipped: number } {
    const c = this.load(p);
    const snap = c.snapshots.get(turnId);
    if (!snap) throw new AssistantError("That reply can no longer be reverted");
    const current = new Map(this.d.store.get(p).scene.elements.map((e) => [e.id, e]));
    const restore: El[] = [];
    let skipped = 0;
    for (const id of changedIds(snap)) {
      const a = snap.after.get(id)!;
      const cur = current.get(id);
      if (!cur) continue;
      if (cur.version !== a.version || cur.versionNonce !== a.versionNonce) {
        skipped++;
        continue;
      }
      const b = snap.before.get(id);
      restore.push(b ? { ...b, version: cur.version + 1, versionNonce: randInt(), updated: Date.now() } : bump(cur, { isDeleted: true }));
    }
    if (restore.length) {
      this.d.agentPaths.add(p);
      try {
        this.d.store.apply(p, { elements: restore }, "agent");
      } finally {
        this.d.agentPaths.delete(p);
      }
    }
    c.snapshots.delete(turnId);
    this.push(c, { type: "reverted", id: turnId, restored: restore.length, skipped });
    this.save(c);
    return { restored: restore.length, skipped };
  }

  /** Builds the <context> block sent ahead of the user's text. */
  private context(req: ChatRequest, root: string, ep: Endpoint, code: boolean): string {
    const ctx = { projectRoot: root } as ToolContext;
    const doc = this.d.store.getLive(req.path);
    const repo = fs.existsSync(path.join(root, ".git"));
    const lines = [`Open drawing: ${relPath(ctx, req.path)}`, `Project root: ${root}${repo ? "" : " (not a code repository)"}`];
    lines.push(`Drawing contents: ${clip(describe(doc.scene), MAX_DRAWING_CHARS, "call read_drawing for the rest")}`);
    if (req.selection.length) {
      lines.push(`Selected elements (${req.selection.length}): ${describe(doc.scene, new Set(req.selection))}`);
      if (req.image && ep.vision && ep.kind !== "claude-code") lines.push("The attached image is a snapshot of the selection.");
    } else lines.push("Nothing is selected.");
    for (const m of req.mentions) {
      try {
        if (m.kind === "drawing") {
          const file = this.d.safe(m.path);
          const d = this.d.store.getLive(file);
          lines.push(`Mentioned drawing ${relPath(ctx, file)}: ${d.exists ? clip(describe(d.scene), MAX_MENTION_CHARS / 4, "call read_drawing") : "(does not exist)"}`);
        } else if (code) {
          lines.push(`Mentioned file:\n<file>\n${clip(readFile(root, { path: m.path }), MAX_MENTION_CHARS, "call read_file for the rest")}\n</file>`);
        } else {
          lines.push(`Mentioned file ${m.path} (project file access is turned off).`);
        }
      } catch (e) {
        lines.push(`Mentioned ${m.kind} ${m.path}: ${(e as Error).message}`);
      }
    }
    return `<context>\n${lines.join("\n")}\n</context>`;
  }

  private provider(ep: Endpoint): Provider {
    if (ep.kind === "anthropic") {
      return new AnthropicProvider({ baseUrl: ep.baseUrl, model: ep.model || DEFAULT_ANTHROPIC_MODEL, apiKey: apiKeyFor(ep), effort: ep.effort });
    }
    if (!ep.model) throw new AssistantError(`Choose a model for ${ep.name} in the assistant settings`);
    if (ep.kind === "ollama") return new OllamaProvider({ baseUrl: ep.baseUrl, model: ep.model, contextLength: ep.contextLength, vision: ep.vision });
    return new OpenAIProvider({ baseUrl: ep.baseUrl!, model: ep.model, apiKey: apiKeyFor(ep), vision: ep.vision });
  }

  private tools(ep: Endpoint, code: boolean): ToolDef[] {
    return [
      ...drawingTools({ currentDrawing: true }).filter((t) => t.name !== "open_drawing" && (ep.vision || t.name !== "render_drawing")),
      ...(code ? codeTools() : []),
    ];
  }

  /** Runs one user message to completion. Resolves when the turn has ended. */
  async send(req: ChatRequest): Promise<void> {
    const p = this.d.safe(req.path);
    req = { ...req, path: p, text: String(req.text ?? "").slice(0, 20_000), selection: (req.selection ?? []).slice(0, 2000), mentions: (req.mentions ?? []).slice(0, 20) };
    const c = this.load(p);
    if (c.abort) throw new AssistantError("The assistant is still working on the previous message");
    const settings = this.d.settings.get();
    const ep = this.d.settings.active();
    if (!ep) throw new AssistantError("The assistant isn't set up yet. Open its settings to choose a model.");
    if (!req.text.trim()) throw new AssistantError("Empty message");

    const root = this.d.projectRootFor(p);
    const code = settings.codeAccess;
    const abort = new AbortController();
    c.abort = abort;

    const user: UserItem = {
      kind: "user",
      id: crypto.randomUUID(),
      text: req.text,
      context: {
        selection: req.selection.length,
        mentions: req.mentions.map((m) => path.basename(m.path)),
        image: !!(req.image && ep.vision && ep.kind !== "claude-code"),
      },
    };
    this.push(c, { type: "user", item: user });
    const turnId = crypto.randomUUID();
    this.push(c, { type: "turn-start", id: turnId, endpoint: endpointLabel({ ...ep, model: ep.model || (ep.kind === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : ep.model) }) });

    const before = elementMap(this.d.store.get(p).scene.elements);
    this.d.agentPaths.add(p);
    let status: AssistantItem["status"] = "done";
    let error: string | undefined;
    try {
      const contextBlock = this.context(req, root, ep, code);
      if (ep.kind === "claude-code") error = await this.runClaudeCode(c, ep, root, code, contextBlock, req, turnId, abort.signal);
      else error = await this.runLoop(c, ep, root, code, contextBlock, req, turnId, abort.signal);
      if (error) status = "error";
    } catch (e) {
      status = "error";
      const err = e as Error & { cause?: { code?: string } };
      error =
        err.name === "TypeError" && /fetch failed/.test(err.message)
          ? `Couldn't reach ${endpointHost(ep)}${err.cause?.code ? ` (${err.cause.code})` : ""}. Is the server running?`
          : err.message;
    } finally {
      this.d.agentPaths.delete(p);
      c.abort = undefined;
    }
    if (abort.signal.aborted) {
      status = "stopped";
      error = undefined;
    }
    const snap: Snapshot = { before, after: elementMap(this.d.store.get(p).scene.elements) };
    const changed = changedIds(snap).length;
    if (changed) c.snapshots.set(turnId, snap);
    this.push(c, { type: "turn-end", id: turnId, status, error, revertable: changed > 0, changed });
    this.save(c);
  }

  private async runLoop(
    c: Conversation,
    ep: Endpoint,
    root: string,
    code: boolean,
    contextBlock: string,
    req: ChatRequest,
    turnId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const provider = this.provider(ep);
    let useTools = ep.tools !== false;
    const defs = this.tools(ep, code);
    const byName = new Map(defs.map((d) => [d.name, d]));
    const specs = defs.map((d) => ({ name: d.name, description: d.description, parameters: jsonSchema(d) }));
    const ctx: ToolContext = {
      projectRoot: root,
      currentDrawing: c.path,
      op: (body) => this.d.op(body),
      withEditor: (_file, body) => this.d.op(body),
      list: async (dir) => this.d.list(dir),
    };

    const content: Part[] = [{ type: "text", text: `${contextBlock}\n\n${req.text}` }];
    if (req.image && ep.vision) content.push({ type: "image", data: req.image.data, mime: req.image.mime });
    c.messages.push({ role: "user", content });

    for (let step = 0; step < MAX_STEPS; step++) {
      let partial = "";
      let res;
      try {
        res = await provider.turn(
          {
            system: SYSTEM({ vision: !!ep.vision, code, mermaidOnly: !useTools, claudeCode: false }),
            messages: c.messages,
            tools: useTools ? specs : [],
            signal,
          },
          (ev) => {
            if (ev.type === "text") partial += ev.text;
            this.push(c, { type: "delta", id: turnId, part: ev.type, text: ev.text });
          },
        );
      } catch (e) {
        if (partial) c.messages.push({ role: "assistant", text: partial, toolCalls: [] });
        if (signal.aborted) return undefined;
        // Some local models can't call tools at all; fall back to Mermaid replies.
        if (useTools && step === 0 && /does not support tools|tool(s)? (are |is )?not supported|tool_choice/i.test((e as Error).message)) {
          useTools = false;
          this.push(c, { type: "delta", id: turnId, part: "reasoning", text: "This model can't call tools, so it will answer in Mermaid instead.\n" });
          continue;
        }
        throw e;
      }
      c.messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, native: res.native });

      if (!useTools) {
        for (const src of mermaidBlocks(res.text)) await this.runTool(c, turnId, byName, ctx, { id: crypto.randomUUID(), name: "mermaid_to_drawing", args: JSON.stringify({ mermaid: src }) });
        return undefined;
      }
      if (!res.toolCalls.length) {
        if (res.stop === "length") return "The reply was cut off (output limit reached).";
        if (res.stop === "refusal") return "The model declined this request.";
        return undefined;
      }
      if (res.stop === "length" || res.stop === "refusal") {
        // Never run tool calls from a truncated or refused reply, but keep the conversation well-formed.
        c.messages.push({ role: "tool", results: res.toolCalls.map((t) => ({ id: t.id, name: t.name, content: [{ type: "text", text: "Not run: the reply was cut off." }], isError: true })) });
        return res.stop === "length" ? "The reply was cut off before its tool calls finished." : "The model declined this request.";
      }
      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        if (signal.aborted) results.push({ id: call.id, name: call.name, content: [{ type: "text", text: "Cancelled by the user." }], isError: true });
        else results.push(await this.runTool(c, turnId, byName, ctx, call));
      }
      c.messages.push({ role: "tool", results });
      if (signal.aborted) return undefined;
    }
    return `Stopped after ${MAX_STEPS} steps.`;
  }

  private async runTool(
    c: Conversation,
    turnId: string,
    byName: Map<string, ToolDef>,
    ctx: ToolContext,
    call: { id: string; name: string; args: string },
  ): Promise<ToolResult> {
    this.push(c, { type: "tool-start", id: turnId, callId: call.id, name: call.name, args: call.args });
    const fail = (msg: string): ToolResult => {
      this.push(c, { type: "tool-end", id: turnId, callId: call.id, ok: false, result: msg });
      return { id: call.id, name: call.name, content: [{ type: "text", text: msg }], isError: true };
    };
    const def = byName.get(call.name);
    if (!def) return fail(`Unknown tool ${call.name}. Available: ${[...byName.keys()].join(", ")}`);
    let raw: unknown;
    try {
      raw = call.args.trim() ? JSON.parse(call.args) : {};
    } catch {
      return fail(`Invalid JSON arguments: ${call.args.slice(0, 500)}`);
    }
    const parsed = z.object(def.input).safeParse(raw);
    if (!parsed.success) return fail(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
    try {
      const out = await def.run(parsed.data, ctx);
      const text = clip(out.text, MAX_TOOL_TEXT, "narrow the request");
      this.push(c, { type: "tool-end", id: turnId, callId: call.id, ok: true, result: text.slice(0, 4000), drawing: out.drawing });
      const content: Part[] = [{ type: "text", text }];
      if (out.image) content.push({ type: "image", data: out.image.data, mime: out.image.mime });
      return { id: call.id, name: call.name, content };
    } catch (e) {
      return fail(e instanceof CodeError ? e.message : `Error: ${(e as Error).message}`);
    }
  }

  private async runClaudeCode(
    c: Conversation,
    ep: Endpoint,
    root: string,
    code: boolean,
    contextBlock: string,
    req: ChatRequest,
    turnId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const bin = findClaude();
    if (!bin) throw new AssistantError("Claude Code (`claude`) was not found. Install it, or set LFX_CLAUDE_BIN to its path.");
    const run = (sessionId?: string) =>
      runClaudeCode(
        {
          bin,
          cwd: root,
          model: ep.model,
          effort: ep.effort,
          sessionId,
          systemPrompt: SYSTEM({ vision: true, code, mermaidOnly: false, claudeCode: true }),
          mcpEnv: this.d.mcpEnv,
          codeAccess: code,
          signal,
        },
        `${contextBlock}\n\n${req.text}`,
        (ev) => {
          if (ev.type === "text" || ev.type === "reasoning") this.push(c, { type: "delta", id: turnId, part: ev.type, text: ev.text });
          else if (ev.type === "tool-start") this.push(c, { type: "tool-start", id: turnId, callId: ev.callId, name: ev.name, args: ev.args });
          else this.push(c, { type: "tool-end", id: turnId, callId: ev.callId, ok: ev.ok, result: ev.result });
        },
      );
    let r = await run(c.claudeSession);
    if (r.error && c.claudeSession && /no conversation found|session/i.test(r.error) && !signal.aborted) {
      c.claudeSession = undefined;
      r = await run();
    }
    if (r.sessionId) c.claudeSession = r.sessionId;
    return r.error;
  }
}
