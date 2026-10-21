import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AssistantItem,
  applyChatEvent,
  type ChatItem,
  type ChatSessionInfo,
  endpointLabel,
  type Mention,
  type PublicSettings,
  revertSummary,
  type SavedPrompt,
  type ToolPart,
} from "../shared/chat";
import { mentionLabel } from "../shared/mentions";
import { ChatSettings } from "./ChatSettings";
import { Markdown } from "./Markdown";
import { Shapes } from "./Shapes";
import { api, basename, type ServerMsg } from "./sync";

export interface ChatBridge {
  send(msg: Record<string, unknown>): void;
  subscribe(fn: (m: ServerMsg) => void): () => void;
  /** Ids of the selected elements right now. */
  selection(): string[];
  /** PNG of the given elements, for endpoints that accept images. */
  snapshot(ids: string[]): Promise<{ data: string; mime: string } | undefined>;
  /** Adds shapes to the canvas Library sidebar. */
  addToLibrary(items: { name: string; elements: any[] }[]): void;
}

interface Suggestion {
  kind: Mention["kind"];
  path: string;
  rel: string;
  /** A line range typed after the path (`@src/a.ts:10-40`), or a symbol's definition. */
  lines?: [number, number];
  symbol?: string;
  /** Has uncommitted changes in git. */
  changed?: boolean;
  detail?: string;
}

/** Two mentions of the same thing: same path, lines and symbol. */
const mentionKey = (m: Suggestion) => `${m.kind}:${m.path}:${m.lines?.join("-") ?? ""}:${m.symbol ?? ""}`;

const TOOL_LABELS: Record<string, string> = {
  excalidraw_guide: "Read the element guide",
  list_drawings: "Listed drawings",
  read_drawing: "Read the drawing",
  create_drawing: "Created a drawing",
  create_diagram: "Drew a diagram",
  add_elements: "Added elements",
  update_elements: "Updated elements",
  delete_elements: "Deleted elements",
  mermaid_to_drawing: "Converted Mermaid",
  render_drawing: "Looked at the drawing",
  export_drawing: "Exported an image",
  list_shapes: "Looked up library shapes",
  insert_shape: "Inserted a library shape",
  list_files: "Listed files",
  search_files: "Searched files",
  read_file: "Read a file",
  Read: "Read a file",
  Grep: "Searched files",
  Glob: "Listed files",
};

/** Labels for failed calls, so a failure never reads as "Drew a diagram". */
const FAILED_LABELS: Record<string, string> = {
  create_drawing: "Couldn't create the drawing",
  create_diagram: "Couldn't draw the diagram",
  add_elements: "Couldn't add elements",
  update_elements: "Couldn't update elements",
  delete_elements: "Couldn't delete elements",
  mermaid_to_drawing: "Couldn't convert Mermaid",
  insert_shape: "Couldn't insert the shape",
  apply_changes: "Couldn't apply the changes",
};

/** The first line of an error, without the "Error:" / "Invalid arguments:" prefix. */
function errorLine(result: string | undefined): string | undefined {
  const line = result?.replace(/^(Error|Invalid arguments|Not run):\s*/, "").split("\n").find((l) => l.trim());
  return line ? line.replace(/^✖\s*/, "").trim() : undefined;
}

function toolSummary(p: ToolPart): string {
  if (p.status === "error") return errorLine(p.result) ?? "";
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(p.args || "{}");
  } catch {
    // partial or invalid
  }
  const pick = (k: string) => (typeof args[k] === "string" ? String(args[k]) : undefined);
  const detail =
    pick("pattern") ?? pick("file_path") ?? (pick("path") && p.name !== "add_elements" ? pick("path")!.split("/").slice(-2).join("/") : undefined) ?? pick("glob") ?? pick("title");
  const count = Array.isArray(args.nodes) ? `${args.nodes.length} nodes` : Array.isArray(args.elements) ? `${args.elements.length}` : Array.isArray(args.updates) ? `${args.updates.length}` : Array.isArray(args.ids) ? `${args.ids.length}` : undefined;
  return [detail, count].filter(Boolean).join(" · ");
}

function ToolChip({ part }: { part: ToolPart }) {
  const label = part.status === "error" ? (FAILED_LABELS[part.name] ?? `${TOOL_LABELS[part.name] ?? part.name} (failed)`) : (TOOL_LABELS[part.name] ?? part.name);
  const summary = toolSummary(part);
  return (
    <details className={`lfx-tool lfx-tool-${part.status}`}>
      <summary>
        <span className="lfx-tool-icon" aria-hidden>
          {part.status === "running" ? "" : part.status === "ok" ? "✓" : "!"}
        </span>
        <span className="lfx-tool-label">{label}</span>
        {summary && <span className="lfx-tool-detail">{summary}</span>}
      </summary>
      <div className="lfx-tool-body">
        <div className="lfx-tool-name">{part.name}</div>
        <pre>{prettyJson(part.args)}</pre>
        {part.result && <pre className="lfx-tool-result">{part.result}</pre>}
      </div>
      {part.drawing && (
        <a className="lfx-tool-open" href={`/?file=${encodeURIComponent(part.drawing)}`}>
          Open {basename(part.drawing)}
        </a>
      )}
    </details>
  );
}

function prettyJson(s: string): string {
  try {
    const v = JSON.stringify(JSON.parse(s), null, 2);
    return v.length > 6000 ? v.slice(0, 6000) + "\n…" : v;
  } catch {
    return s;
  }
}

function AssistantTurn({ item, onRevert }: { item: AssistantItem; onRevert: () => void }) {
  return (
    <div className="lfx-msg lfx-assistant">
      {item.parts.map((p, i) =>
        p.type === "text" ? (
          <Markdown key={i} text={p.text} />
        ) : p.type === "reasoning" ? (
          <details key={i} className="lfx-reasoning">
            <summary>{item.status === "running" && i === item.parts.length - 1 ? "Thinking…" : "Thought"}</summary>
            <p>{p.text}</p>
          </details>
        ) : (
          <ToolChip key={p.callId} part={p} />
        ),
      )}
      {item.status === "running" && (
        <div className="lfx-working" role="status">
          <span className="lfx-spinner" aria-hidden /> Working…
        </div>
      )}
      {item.status === "error" && <p className="lfx-turn-error">{item.error}</p>}
      {item.status === "stopped" && <p className="lfx-muted">Stopped.</p>}
      <div className="lfx-turn-meta">
        <span title="Where this request went">{item.endpoint}</span>
        {item.revertable && !item.reverted && item.status !== "running" && (
          <button type="button" className="lfx-link" onClick={onRevert} title="Undo the changes this reply made to the drawing">
            Revert changes ({item.changed})
          </button>
        )}
        {item.reverted && (
          <span title={item.keptCount ? "Elements you changed after this reply were left as they are" : undefined}>{revertSummary(item)}</span>
        )}
      </div>
    </div>
  );
}

function when(t: number): string {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((now.getTime() - t) / 86_400_000);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function SessionList({
  sessions,
  current,
  endpoints,
  onOpen,
  onDelete,
}: {
  sessions: ChatSessionInfo[];
  current: string;
  endpoints: PublicSettings["endpoints"];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const saved = sessions.filter((s) => s.messages > 0);
  if (!saved.length) {
    return (
      <div className="lfx-chat-log">
        <div className="lfx-empty-chat">
          <p className="lfx-empty-title">No past chats</p>
          <p>Chats about this drawing are kept here, so you can come back to them.</p>
        </div>
      </div>
    );
  }
  return (
    <ul className="lfx-chat-log lfx-sessions">
      {saved.map((s) => {
        const ep = endpoints.find((e) => e.id === s.endpoint);
        return (
          <li key={s.id} className={s.id === current ? "lfx-sel" : ""}>
            <button type="button" className="lfx-session" onClick={() => onOpen(s.id)}>
              <span className="lfx-session-title">
                {s.busy && <span className="lfx-spinner" aria-label="Working" />}
                {s.title || "Untitled chat"}
              </span>
              <span className="lfx-muted">
                {[when(s.updated), `${s.messages} message${s.messages === 1 ? "" : "s"}`, ep ? (ep.model ? `${ep.name} · ${ep.model}` : ep.name) : ""].filter(Boolean).join(" · ")}
              </span>
            </button>
            <button
              type="button"
              className="lfx-icon"
              title={s.busy ? "Stop this chat's reply first" : "Delete chat"}
              aria-label={`Delete ${s.title || "chat"}`}
              disabled={s.busy}
              onClick={() => {
                if (confirm(`Delete "${s.title || "this chat"}"? This can't be undone.`)) onDelete(s.id);
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden>
                <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A prompt that ends mid-sentence ("Draw a UML class diagram of ") is for finishing, not sending. */
const unfinished = (p: SavedPrompt) => /(\s|…|:)$/.test(p.text);

/** Saved prompts whose name or text contains every word typed after the "/". */
function matchPrompts(prompts: SavedPrompt[], q: string): SavedPrompt[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return prompts.filter((p) => words.every((w) => `${p.name} ${p.text}`.toLowerCase().includes(w))).slice(0, 12);
}

export function Chat({
  path,
  bridge,
  selectionCount,
  dark,
  onClose,
}: {
  path: string;
  bridge: ChatBridge;
  selectionCount: number;
  dark: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [session, setSession] = useState("");
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [view, setView] = useState<"chat" | "history" | "settings" | "shapes">("chat");
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Suggestion[]>([]);
  const [useSelection, setUseSelection] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ query: string; items: Suggestion[]; index: number } | null>(null);
  /** The / menu of saved prompts: open while the message is "/" plus a filter. */
  const [promptMenu, setPromptMenu] = useState<{ query: string; index: number } | null>(null);
  const [pending, setPending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const busy = pending || items.some((i) => i.kind === "assistant" && i.status === "running");
  // One reply at a time per drawing: another chat's reply blocks sending here.
  const otherBusy = sessions.find((s) => s.busy && s.id !== session);
  const pinned = sessions.find((s) => s.id === session)?.endpoint;
  const active = settings?.enabled
    ? (settings.endpoints.find((e) => e.id === pinned) ?? settings.endpoints.find((e) => e.id === settings.active) ?? settings.endpoints[0])
    : undefined;
  // Events are tagged with their session; only the one shown here applies to the log.
  const sessionRef = useRef("");

  useEffect(() => {
    api<PublicSettings>("GET", "/api/ai/settings").then(setSettings, (e: Error) => setError(e.message));
  }, []);

  useEffect(
    () =>
      bridge.subscribe((m) => {
        if (m.t === "chat") {
          const ev = m.ev;
          if (ev.type === "history") {
            sessionRef.current = ev.session;
            setSession(ev.session);
            setSessions(ev.sessions);
            setItems(ev.items);
            setPending(false);
            return;
          }
          if (ev.type === "sessions") {
            setSessions(ev.sessions);
            return;
          }
          if (m.session !== sessionRef.current) return;
          setItems((prev) => applyChatEvent(prev, ev));
          if (ev.type === "user") setPending(false);
        } else if (m.t === "chat-error") {
          setPending(false);
          setError(m.message);
        }
      }),
    [bridge],
  );

  // Follow the conversation unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // @-mention suggestions.
  useEffect(() => {
    if (!suggest) return;
    const q = suggest.query;
    const t = window.setTimeout(() => {
      api<{ items: Suggestion[] }>("GET", `/api/ai/mentions?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`)
        .then((r) => setSuggest((s) => (s && s.query === q ? { ...s, items: r.items, index: 0 } : s)))
        .catch(() => {});
    }, 120);
    return () => window.clearTimeout(t);
  }, [suggest?.query, path]);

  const prompts = settings?.prompts ?? [];
  const promptItems = promptMenu ? matchPrompts(prompts, promptMenu.query) : [];

  const onInput = (value: string, caret: number) => {
    setText(value);
    const slash = value.slice(0, caret).match(/^\/([^\n]*)$/);
    setPromptMenu(slash && prompts.length ? (s) => ({ query: slash[1], index: s?.query === slash[1] ? s.index : 0 }) : null);
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    setSuggest(m ? (s) => ({ query: m[1], items: s?.items ?? [], index: 0 }) : null);
  };

  const pick = (s: Suggestion) => {
    const el = inputRef.current!;
    const caret = el.selectionStart;
    // Keep the name in the sentence ("based on @daemon.ts"); the chip carries the actual context.
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${mentionLabel(s)} `);
    setText(before + text.slice(caret));
    if (!mentions.some((m) => mentionKey(m) === mentionKey(s))) setMentions([...mentions, s]);
    setSuggest(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  /** Puts a saved prompt in the message box, with the cursor at its end to finish or send it. */
  const applyPrompt = (p: SavedPrompt) => {
    const el = inputRef.current;
    setText(p.text);
    setPromptMenu(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(p.text.length, p.text.length);
    });
  };

  const submit = useCallback(
    async (value = text) => {
      const body = value.trim();
      if (!body || busy || otherBusy) return;
      setError(null);
      setPending(true);
      const selection = useSelection ? bridge.selection() : [];
      let image: { data: string; mime: string } | undefined;
      if (selection.length && active?.vision && active.kind !== "claude-code") image = await bridge.snapshot(selection).catch(() => undefined);
      bridge.send({
        t: "chat-send",
        path,
        session,
        text: body,
        selection,
        mentions: mentions.map((m) => ({ kind: m.kind, path: m.path, lines: m.lines, symbol: m.symbol })),
        image,
      });
      stick.current = true;
      setText("");
      setMentions([]);
    },
    [text, busy, otherBusy, useSelection, bridge, active, mentions, path, session],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (promptMenu && promptItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = promptItems.length;
        setPromptMenu({ ...promptMenu, index: (promptMenu.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyPrompt(promptItems[Math.min(promptMenu.index, promptItems.length - 1)]);
        return;
      }
    }
    if (suggest && suggest.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggest.items.length;
        setSuggest({ ...suggest, index: (suggest.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggest.items[suggest.index]);
        return;
      }
    }
    if (e.key === "Escape") {
      if (promptMenu) setPromptMenu(null);
      else if (suggest) setSuggest(null);
      else onClose();
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const configured = !!active;

  return (
    <aside className="lfx-chat" aria-label="Assistant">
      <header className="lfx-chat-head">
        <div className="lfx-chat-title">
          <strong>{view === "shapes" ? "Shapes" : view === "settings" ? "Assistant Settings" : view === "history" ? "Chats" : "Assistant"}</strong>
          {configured && view === "chat" && (
            <select
              className="lfx-endpoint"
              value={active!.id}
              title="Where this chat's requests go"
              onChange={async (e) => {
                const id = e.target.value;
                // This chat switches; new chats start with the last model picked.
                bridge.send({ t: "chat-endpoint", session, endpoint: id });
                setSessions((list) => list.map((s) => (s.id === session ? { ...s, endpoint: id } : s)));
                setSettings(await api<PublicSettings>("PUT", "/api/ai/settings", { active: id }));
              }}
            >
              {settings!.endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.model ? `${ep.name} · ${ep.model}` : ep.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="lfx-chat-actions">
          {(view === "history" || (view === "chat" && items.length > 0)) && (
            <button
              type="button"
              className="lfx-icon"
              title="New chat"
              aria-label="New chat"
              onClick={() => {
                bridge.send({ t: "chat-new" });
                setView("chat");
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden>
                <path d="M10 4v12M4 10h12" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={`lfx-icon${view === "history" ? " lfx-on" : ""}`}
            title="Past chats"
            aria-label="Past chats"
            onClick={() => setView(view === "history" ? "chat" : "history")}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <circle cx="10" cy="10" r="7" />
              <path d="M10 6v4l2.5 2.5" />
            </svg>
          </button>
          <button
            type="button"
            className={`lfx-icon${view === "shapes" ? " lfx-on" : ""}`}
            title="Shapes and libraries"
            aria-label="Shapes and libraries"
            onClick={() => setView(view === "shapes" ? "chat" : "shapes")}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <rect x="3" y="3" width="6" height="6" rx="1" />
              <circle cx="14" cy="6" r="3" />
              <path d="M6 11.5l3 5H3z" />
              <rect x="11" y="11" width="6" height="6" rx="1" />
            </svg>
          </button>
          <button
            type="button"
            className={`lfx-icon${view === "settings" ? " lfx-on" : ""}`}
            title="Assistant settings"
            aria-label="Assistant settings"
            onClick={() => setView(view === "settings" ? "chat" : "settings")}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <circle cx="10" cy="10" r="2.5" />
              <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
            </svg>
          </button>
          <button type="button" className="lfx-icon" title="Close" aria-label="Close assistant" onClick={onClose}>
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
      </header>

      {view === "shapes" ? (
        <Shapes path={path} dark={dark} onAddToCanvas={bridge.addToLibrary} />
      ) : view === "history" ? (
        <SessionList
          sessions={sessions}
          current={session}
          endpoints={settings?.endpoints ?? []}
          onOpen={(id) => {
            if (id !== session) bridge.send({ t: "chat-open", session: id });
            setView("chat");
          }}
          onDelete={(id) => bridge.send({ t: "chat-delete", session: id })}
        />
      ) : view === "settings" && settings ? (
        <ChatSettings settings={settings} onSaved={setSettings} onClose={() => setView("chat")} />
      ) : (
        <>
          <div
            className="lfx-chat-log"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {!settings ? null : !configured ? (
              <div className="lfx-empty-chat">
                <p className="lfx-empty-title">Connect a model</p>
                <p>
                  The assistant can draw and edit diagrams for you, using a local model (Ollama, LM Studio, llama.cpp), Claude Code, or an API you choose. Nothing
                  is sent anywhere until you set one up.
                </p>
                <button type="button" className="lfx-btn lfx-primary" onClick={() => setView("settings")}>
                  Set up the assistant
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="lfx-empty-chat">
                <p className="lfx-empty-title">What should we draw?</p>
                <p>
                  Select items on the canvas to ask about them, type @ to mention a file, a folder, lines (@file:10-40), a symbol or another drawing, or / for a saved
                  prompt.
                </p>
                <div className="lfx-starters">
                  {prompts.slice(0, 4).map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      title={p.text}
                      onClick={() => (unfinished(p) ? applyPrompt(p) : submit(p.text))}
                      disabled={busy || !!otherBusy}
                    >
                      {unfinished(p) ? `${p.text.trimEnd()}…` : p.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              items.map((it) =>
                it.kind === "user" ? (
                  <div key={it.id} className="lfx-msg lfx-user">
                    <p>{it.text}</p>
                    {(it.context.selection > 0 || it.context.mentions.length > 0) && (
                      <small>
                        {[
                          it.context.selection ? `${it.context.selection} selected${it.context.image ? " + snapshot" : ""}` : "",
                          ...it.context.mentions.map((m) => `@${m}`),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    )}
                  </div>
                ) : (
                  <AssistantTurn key={it.id} item={it} onRevert={() => bridge.send({ t: "chat-revert", session, id: it.id })} />
                ),
              )
            )}
          </div>

          {otherBusy && !busy && (
            <p className="lfx-chat-note">
              Another chat on this drawing is working ({otherBusy.title || "New chat"}).{" "}
              <button type="button" className="lfx-link" onClick={() => bridge.send({ t: "chat-open", session: otherBusy.id })}>
                Show it
              </button>
            </p>
          )}

          {error && (
            <p className="lfx-chat-error" role="alert" onClick={() => setError(null)}>
              {error}
            </p>
          )}

          <div className={`lfx-composer${configured ? "" : " lfx-disabled"}`}>
            {(selectionCount > 0 || mentions.length > 0) && (
              <div className="lfx-chips">
                {selectionCount > 0 && (
                  <button
                    type="button"
                    className={`lfx-chip${useSelection ? " lfx-chip-on" : ""}`}
                    onClick={() => setUseSelection(!useSelection)}
                    title={useSelection ? "The selection is sent as context. Click to leave it out." : "Click to include the selection"}
                  >
                    {useSelection ? "✓ " : ""}
                    {selectionCount} selected
                  </button>
                )}
                {mentions.map((m) => (
                  <span key={mentionKey(m)} className="lfx-chip lfx-chip-on" title={m.lines ? `${m.rel}:${m.lines[0]}-${m.lines[1]}` : m.rel}>
                    @{mentionLabel(m)}
                    <button type="button" aria-label={`Remove ${mentionLabel(m)}`} onClick={() => setMentions(mentions.filter((x) => mentionKey(x) !== mentionKey(m)))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {promptMenu && promptItems.length > 0 && (
              <ul className="lfx-suggest" role="listbox" aria-label="Saved prompts">
                {promptItems.map((p, i) => (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={i === promptMenu.index}
                    className={i === promptMenu.index ? "lfx-sel" : ""}
                    title={p.text}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyPrompt(p);
                    }}
                  >
                    <span className="lfx-prompt-name">{p.name}</span>
                    <span className="lfx-muted">{p.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {suggest && suggest.items.length > 0 && (
              <ul className="lfx-suggest" role="listbox">
                {suggest.items.map((s, i) => (
                  <li
                    key={mentionKey(s)}
                    role="option"
                    aria-selected={i === suggest.index}
                    className={i === suggest.index ? "lfx-sel" : ""}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(s);
                    }}
                  >
                    <span className="lfx-kind">{s.kind}</span>
                    {s.kind === "symbol" ? (
                      <>
                        {s.symbol}
                        <span className="lfx-muted">{s.detail}</span>
                      </>
                    ) : (
                      <>
                        {s.rel}
                        {s.lines && <span className="lfx-muted">lines {s.lines[0]}-{s.lines[1]}</span>}
                        {s.changed && (
                          <span className="lfx-muted" title="Uncommitted changes">
                            modified
                          </span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              disabled={!configured}
              placeholder={configured ? (selectionCount && useSelection ? "Ask about the selection…" : "Describe a change or a new diagram, or type / for a saved prompt") : "Set up a model first"}
              onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
              onKeyDown={onKeyDown}
              onBlur={() =>
                setTimeout(() => {
                  setSuggest(null);
                  setPromptMenu(null);
                }, 150)
              }
              aria-label="Message the assistant"
            />
            <div className="lfx-composer-foot">
              <span className="lfx-muted">{active ? `→ ${endpointLabel(active)}` : ""}</span>
              {busy ? (
                <button type="button" className="lfx-btn" onClick={() => bridge.send({ t: "chat-stop", session })}>
                  Stop
                </button>
              ) : (
                <button type="button" className="lfx-btn lfx-primary" disabled={!configured || !text.trim() || !!otherBusy} onClick={() => submit()}>
                  Send
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
