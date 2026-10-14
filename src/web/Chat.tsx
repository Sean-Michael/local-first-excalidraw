import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AssistantItem,
  applyChatEvent,
  type ChatItem,
  endpointLabel,
  type Mention,
  type PublicSettings,
  type ToolPart,
} from "../shared/chat";
import { ChatSettings } from "./ChatSettings";
import { Markdown } from "./Markdown";
import { api, basename, type ServerMsg } from "./sync";

export interface ChatBridge {
  send(msg: Record<string, unknown>): void;
  subscribe(fn: (m: ServerMsg) => void): () => void;
  /** Ids of the selected elements right now. */
  selection(): string[];
  /** PNG of the given elements, for endpoints that accept images. */
  snapshot(ids: string[]): Promise<{ data: string; mime: string } | undefined>;
}

interface Suggestion {
  kind: Mention["kind"];
  path: string;
  rel: string;
}

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

function toolSummary(p: ToolPart): string {
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
  const label = TOOL_LABELS[part.name] ?? part.name;
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
        {item.reverted && <span>Changes reverted</span>}
      </div>
    </div>
  );
}

const STARTERS = [
  "Draw the architecture of this project",
  "Tidy up the selected items and align them",
  "Turn the selection into a sequence diagram",
  "Add a legend explaining the colours",
];

export function Chat({ path, bridge, selectionCount, onClose }: { path: string; bridge: ChatBridge; selectionCount: number; onClose: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Suggestion[]>([]);
  const [useSelection, setUseSelection] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ query: string; items: Suggestion[]; index: number } | null>(null);
  const [pending, setPending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const busy = pending || items.some((i) => i.kind === "assistant" && i.status === "running");
  const active = settings?.enabled ? settings.endpoints.find((e) => e.id === settings.active) : undefined;

  useEffect(() => {
    api<PublicSettings>("GET", "/api/ai/settings").then(setSettings, (e: Error) => setError(e.message));
  }, []);

  useEffect(
    () =>
      bridge.subscribe((m) => {
        if (m.t === "chat") {
          setItems((prev) => applyChatEvent(prev, m.ev));
          if (m.ev.type === "user" || m.ev.type === "history") setPending(false);
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

  const onInput = (value: string, caret: number) => {
    setText(value);
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    setSuggest(m ? (s) => ({ query: m[1], items: s?.items ?? [], index: 0 }) : null);
  };

  const pick = (s: Suggestion) => {
    const el = inputRef.current!;
    const caret = el.selectionStart;
    // Keep the name in the sentence ("based on @daemon.ts"); the chip carries the actual context.
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${s.rel.split("/").pop()} `);
    setText(before + text.slice(caret));
    if (!mentions.some((m) => m.path === s.path)) setMentions([...mentions, s]);
    setSuggest(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const submit = useCallback(
    async (value = text) => {
      const body = value.trim();
      if (!body || busy) return;
      setError(null);
      setPending(true);
      const selection = useSelection ? bridge.selection() : [];
      let image: { data: string; mime: string } | undefined;
      if (selection.length && active?.vision && active.kind !== "claude-code") image = await bridge.snapshot(selection).catch(() => undefined);
      bridge.send({
        t: "chat-send",
        path,
        text: body,
        selection,
        mentions: mentions.map((m) => ({ kind: m.kind, path: m.path })),
        image,
      });
      stick.current = true;
      setText("");
      setMentions([]);
    },
    [text, busy, useSelection, bridge, active, mentions, path],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
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
      if (suggest) setSuggest(null);
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
          <strong>Assistant</strong>
          {configured && view === "chat" && (
            <select
              className="lfx-endpoint"
              value={active!.id}
              title="Where requests go"
              onChange={async (e) => {
                const s = await api<PublicSettings>("PUT", "/api/ai/settings", { active: e.target.value });
                setSettings(s);
              }}
            >
              {settings!.endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name} → {endpointLabel(ep)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="lfx-chat-actions">
          {view === "chat" && items.length > 0 && (
            <button type="button" className="lfx-icon" title="New chat" aria-label="New chat" disabled={busy} onClick={() => bridge.send({ t: "chat-reset" })}>
              <svg viewBox="0 0 20 20" aria-hidden>
                <path d="M10 4v12M4 10h12" />
              </svg>
            </button>
          )}
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

      {view === "settings" && settings ? (
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
                <p>Select items on the canvas to ask about them, or type @ to mention a file or another drawing.</p>
                <div className="lfx-starters">
                  {STARTERS.map((s) => (
                    <button type="button" key={s} onClick={() => submit(s)} disabled={busy}>
                      {s}
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
                  <AssistantTurn key={it.id} item={it} onRevert={() => bridge.send({ t: "chat-revert", id: it.id })} />
                ),
              )
            )}
          </div>

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
                  <span key={m.path} className="lfx-chip lfx-chip-on" title={m.rel}>
                    @{m.rel.split("/").pop()}
                    <button type="button" aria-label={`Remove ${m.rel}`} onClick={() => setMentions(mentions.filter((x) => x.path !== m.path))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {suggest && suggest.items.length > 0 && (
              <ul className="lfx-suggest" role="listbox">
                {suggest.items.map((s, i) => (
                  <li
                    key={s.path}
                    role="option"
                    aria-selected={i === suggest.index}
                    className={i === suggest.index ? "lfx-sel" : ""}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(s);
                    }}
                  >
                    <span className="lfx-kind">{s.kind === "drawing" ? "drawing" : "file"}</span>
                    {s.rel}
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              disabled={!configured}
              placeholder={configured ? (selectionCount && useSelection ? "Ask about the selection…" : "Describe a change or a new diagram…") : "Set up a model first"}
              onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
              onKeyDown={onKeyDown}
              onBlur={() => setTimeout(() => setSuggest(null), 150)}
              aria-label="Message the assistant"
            />
            <div className="lfx-composer-foot">
              <span className="lfx-muted">{active ? `→ ${endpointLabel(active)}` : ""}</span>
              {busy ? (
                <button type="button" className="lfx-btn" onClick={() => bridge.send({ t: "chat-stop" })}>
                  Stop
                </button>
              ) : (
                <button type="button" className="lfx-btn lfx-primary" disabled={!configured || !text.trim()} onClick={() => submit()}>
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
