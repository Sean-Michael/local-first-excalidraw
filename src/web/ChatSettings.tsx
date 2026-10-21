import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { DEFAULT_PROMPTS, type EndpointKind, endpointLabel, type PublicEndpoint, type PublicSettings, type SavedPrompt, type ToolCatalog } from "../shared/chat";
import { SettingsJson } from "./SettingsJson";
import { api } from "./sync";

type Icon = "local" | "lmstudio" | "llamacpp" | "terminal" | "spark" | "cloud" | "router" | "server" | "prompts" | "tools";

interface Preset {
  label: string;
  kind: EndpointKind;
  icon: Icon;
  group: "On This Mac" | "Claude" | "Cloud" | "Other";
  baseUrl?: string;
  model?: string;
  vision?: boolean;
  blurb: string;
  hint: string;
}

const PRESETS: Preset[] = [
  { label: "Ollama", kind: "ollama", icon: "local", group: "On This Mac", baseUrl: "http://localhost:11434", blurb: "Run open models locally", hint: "Pick a model that supports tool calling, e.g. qwen3-coder or gpt-oss." },
  { label: "LM Studio", kind: "openai", icon: "lmstudio", group: "On This Mac", baseUrl: "http://localhost:1234/v1", blurb: "Local server from LM Studio", hint: "Start the server from LM Studio's Developer tab." },
  { label: "llama.cpp", kind: "openai", icon: "llamacpp", group: "On This Mac", baseUrl: "http://localhost:8080/v1", blurb: "llama-server on this Mac", hint: "Run llama-server with --jinja so tool calls work." },
  { label: "Claude Code", kind: "claude-code", icon: "terminal", group: "Claude", blurb: "Uses your claude CLI login", hint: "Runs your local claude CLI with your existing login. It searches your project itself." },
  { label: "Anthropic API", kind: "anthropic", icon: "spark", group: "Claude", model: "claude-opus-5-5", vision: true, blurb: "Claude models with an API key", hint: "Claude models, billed to your Anthropic API key." },
  { label: "OpenAI", kind: "openai", icon: "cloud", group: "Cloud", baseUrl: "https://api.openai.com/v1", vision: true, blurb: "GPT models with an API key", hint: "GPT models, billed to your OpenAI API key." },
  { label: "OpenRouter", kind: "openai", icon: "router", group: "Cloud", baseUrl: "https://openrouter.ai/api/v1", blurb: "Many providers, one key", hint: "Models from many providers through one OpenRouter key." },
  { label: "OpenAI-Compatible", kind: "openai", icon: "server", group: "Other", baseUrl: "http://localhost:8000/v1", blurb: "vLLM, LocalAI, a gateway…", hint: "Any server that speaks the OpenAI chat completions API." },
];
const GROUPS = ["On This Mac", "Claude", "Cloud", "Other"] as const;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CONTEXTS = [8192, 16384, 32768, 65536, 131072];

/** An endpoint being edited. `apiKey`: string sets it, null clears it, undefined keeps it. */
type Draft = PublicEndpoint & { apiKey?: string | null };

type Page =
  | { name: "list" }
  | { name: "json" }
  | { name: "providers" }
  | { name: "form"; id?: string; preset?: Preset }
  | { name: "tools" }
  | { name: "prompts" }
  | { name: "prompt"; id?: string };

const newId = () => Math.random().toString(36).slice(2, 10);

function isLocal(e: { kind: EndpointKind; baseUrl?: string }) {
  if (e.kind === "claude-code") return false;
  try {
    const h = new URL(e.baseUrl ?? "https://api.anthropic.com").hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".local");
  } catch {
    return false;
  }
}

/** The icon for a saved endpoint, guessed from where it points. */
function iconFor(e: { kind: EndpointKind; baseUrl?: string }): Icon {
  if (e.kind === "claude-code") return "terminal";
  if (e.kind === "anthropic") return "spark";
  if (e.kind === "ollama") return "local";
  const url = e.baseUrl ?? "";
  if (url.includes("openrouter.ai")) return "router";
  if (url.includes("api.openai.com")) return "cloud";
  if (/:1234\b/.test(url)) return "lmstudio";
  if (/:8080\b/.test(url)) return "llamacpp";
  return isLocal(e) ? "server" : "cloud";
}

function where(e: PublicEndpoint) {
  return e.kind === "claude-code" ? "Your Claude login" : isLocal(e) ? "On this Mac" : endpointLabel({ kind: e.kind, baseUrl: e.baseUrl }).replace(/ · .*$/, "");
}

const strip = (e: Draft) => ({ ...e, hasKey: undefined, keyFromEnv: undefined });

export function ChatSettings({ settings, onSaved, onClose }: { settings: PublicSettings; onSaved: (s: PublicSettings) => void; onClose: () => void }) {
  const [page, setPage] = useState<Page>(settings.endpoints.length ? { name: "list" } : { name: "providers" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** Settings apply as soon as they change, like System Settings. */
  const save = async (patch: Partial<Omit<PublicSettings, "endpoints" | "claudeCode">> & { endpoints?: Draft[] }) => {
    setSaving(true);
    setError(null);
    try {
      const s = await api<PublicSettings>("PUT", "/api/ai/settings", { ...patch, endpoints: patch.endpoints?.map(strip) });
      onSaved(s);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (page.name === "json") {
    return <SettingsJson settings={settings} onSaved={onSaved} onBack={() => setPage({ name: "list" })} />;
  }

  if (page.name === "tools") {
    return <ToolsPage settings={settings} saving={saving} error={error} onSave={(disabledTools) => save({ disabledTools })} onBack={() => setPage({ name: "list" })} />;
  }

  if (page.name === "prompts") {
    return (
      <PromptsPage
        prompts={settings.prompts}
        saving={saving}
        error={error}
        onOpen={(id) => setPage({ name: "prompt", id })}
        onReset={async () => {
          if (window.confirm("Replace your saved prompts with the default ones?")) await save({ prompts: DEFAULT_PROMPTS });
        }}
        onBack={() => setPage({ name: "list" })}
      />
    );
  }

  if (page.name === "prompt") {
    const initial = page.id ? settings.prompts.find((p) => p.id === page.id) : undefined;
    const back = () => {
      setError(null);
      setPage({ name: "prompts" });
    };
    return (
      <PromptForm
        key={page.id ?? "new"}
        initial={initial}
        saving={saving}
        error={error}
        onCancel={back}
        onRemove={
          initial &&
          (async () => {
            if (await save({ prompts: settings.prompts.filter((p) => p.id !== initial.id) })) back();
          })
        }
        onSave={async (d) => {
          const next = initial ? settings.prompts.map((p) => (p.id === initial.id ? d : p)) : [...settings.prompts, d];
          if (await save({ prompts: next })) back();
        }}
      />
    );
  }

  if (page.name === "providers") {
    return (
      <div className="lfx-settings">
        <NavBar title="Add a Model" onBack={settings.endpoints.length ? () => setPage({ name: "list" }) : undefined} />
        <div className="lfx-pane">
          <p className="lfx-pane-intro">Choose where the assistant’s model runs. Nothing is sent anywhere until you add one.</p>
          {GROUPS.map((g) => (
            <Section key={g} title={g}>
              <ul className="lfx-group lfx-list">
                {PRESETS.filter((p) => p.group === g).map((p) => {
                  const missing = p.kind === "claude-code" && !settings.claudeCode.available;
                  return (
                    <li key={p.label}>
                      <button type="button" className="lfx-cell" disabled={missing} onClick={() => setPage({ name: "form", preset: p })}>
                        <Glyph icon={p.icon} />
                        <span className="lfx-cell-text">
                          <span>{p.label}</span>
                          <small>{p.blurb}</small>
                        </span>
                        {missing ? <span className="lfx-cell-value">Not Installed</span> : <Chevron />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ))}
        </div>
      </div>
    );
  }

  if (page.name === "form") {
    const initial = page.id ? settings.endpoints.find((e) => e.id === page.id) : undefined;
    const back = () => {
      setError(null);
      setPage(initial || !page.preset ? { name: "list" } : { name: "providers" });
    };
    return (
      <EndpointForm
        key={page.id ?? page.preset?.label}
        initial={initial}
        preset={page.preset}
        claudeCode={settings.claudeCode}
        saving={saving}
        error={error}
        onCancel={back}
        onRemove={
          initial &&
          (async () => {
            if (!window.confirm(`Remove “${initial.name}”?`)) return;
            const next = settings.endpoints.filter((e) => e.id !== initial.id);
            const active = settings.active === initial.id ? next[0]?.id : settings.active;
            if (await save({ endpoints: next, active })) setPage({ name: "list" });
          })
        }
        onSave={async (d) => {
          const exists = settings.endpoints.some((e) => e.id === d.id);
          const next = exists ? settings.endpoints.map((e) => (e.id === d.id ? d : e)) : [...settings.endpoints, d];
          const ok = await save({
            endpoints: next,
            active: exists ? settings.active : d.id,
            enabled: settings.enabled || settings.endpoints.length === 0 || undefined,
          });
          if (ok) setPage({ name: "list" });
        }}
      />
    );
  }

  return (
    <div className="lfx-settings">
      {settings.fileError && (
        <p className="lfx-banner" role="alert">
          {settings.fileError}. The last good settings are still in use.{" "}
          <button type="button" className="lfx-link" onClick={() => setPage({ name: "json" })}>
            Open JSON
          </button>
        </p>
      )}
      <div className="lfx-pane">
        <Section footer="Draws and edits diagrams on this canvas using the model you choose below.">
          <div className="lfx-group">
            <SwitchRow label="Assistant" checked={settings.enabled} disabled={saving} onChange={(enabled) => save({ enabled })} />
          </div>
        </Section>

        <Section title="Models" footer={settings.endpoints.length > 1 ? "Click a model to use it. Your choice is also in the menu above the chat." : undefined}>
          <ul className="lfx-group lfx-list">
            {settings.endpoints.map((e) => {
              const on = settings.active === e.id;
              return (
                <li key={e.id} className="lfx-cell-split">
                  <button
                    type="button"
                    className="lfx-cell"
                    aria-pressed={on}
                    disabled={saving}
                    onClick={() => !on && save({ active: e.id })}
                  >
                    <Glyph icon={iconFor(e)} />
                    <span className="lfx-cell-text">
                      <span>{e.name}</span>
                      <small>
                        {e.model ?? "Default model"} · {where(e)}
                      </small>
                    </span>
                    {on && <Check />}
                  </button>
                  <button type="button" className="lfx-info" title={`Edit ${e.name}`} aria-label={`Edit ${e.name}`} onClick={() => setPage({ name: "form", id: e.id })}>
                    <svg viewBox="0 0 20 20" aria-hidden>
                      <circle cx="10" cy="10" r="7.25" />
                      <path d="M10 9v4.5" />
                      <circle cx="10" cy="6.4" r=".4" />
                    </svg>
                  </button>
                </li>
              );
            })}
            <li>
              <button type="button" className="lfx-cell lfx-cell-add" onClick={() => setPage({ name: "providers" })}>
                <span className="lfx-add-icon" aria-hidden>
                  +
                </span>
                <span className="lfx-cell-text">
                  <span>Add Model…</span>
                </span>
              </button>
            </li>
          </ul>
        </Section>

        <Section title="Prompts and Tools" footer="Type / in the message box to use a saved prompt.">
          <ul className="lfx-group lfx-list">
            <li>
              <button type="button" className="lfx-cell" onClick={() => setPage({ name: "prompts" })}>
                <Glyph icon="prompts" />
                <span className="lfx-cell-text">
                  <span>Saved Prompts</span>
                  <small>Reusable requests, from “UML class diagram” to “Update after my change”</small>
                </span>
                <span className="lfx-cell-value">{settings.prompts.length}</span>
                <Chevron />
              </button>
            </li>
            <li>
              <button type="button" className="lfx-cell" onClick={() => setPage({ name: "tools" })}>
                <Glyph icon="tools" />
                <span className="lfx-cell-text">
                  <span>Tools</span>
                  <small>What the assistant can do, and what it knows about diagrams</small>
                </span>
                <span className="lfx-cell-value">{settings.disabledTools.length ? `${settings.disabledTools.length} off` : "All on"}</span>
                <Chevron />
              </button>
            </li>
          </ul>
        </Section>

        <Section
          title="Privacy"
          footer={
            <>
              Requests are made by the local daemon, not this page. API keys are stored in <code>~/.local-first-excalidraw/ai.json</code>, readable only by
              you, and are never sent back to the browser.
            </>
          }
        >
          <div className="lfx-group">
            <SwitchRow
              label="Read project files"
              detail="Search and read files in the project folder. Files that look like secrets (.env, keys, credentials) are always off limits."
              checked={settings.codeAccess}
              disabled={saving}
              onChange={(codeAccess) => save({ codeAccess })}
            />
          </div>
        </Section>
        {error && (
          <p className="lfx-error-inline lfx-pane-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="lfx-pane-foot">
        <button type="button" className="lfx-btn lfx-json-btn" onClick={() => setPage({ name: "json" })}>
          <span aria-hidden>{"{ }"}</span> Edit as JSON
        </button>
        <span className="lfx-spacer" />
        <button type="button" className="lfx-btn lfx-primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </div>
  );
}

function EndpointForm({
  initial,
  preset,
  claudeCode,
  saving,
  error,
  onSave,
  onCancel,
  onRemove,
}: {
  initial?: Draft;
  preset?: Preset;
  claudeCode: PublicSettings["claudeCode"];
  saving: boolean;
  error: string | null;
  onSave: (d: Draft) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const p = preset ?? PRESETS[0];
  const [d, setD] = useState<Draft>(
    initial ?? {
      id: newId(),
      name: p.label,
      kind: p.kind,
      baseUrl: p.baseUrl,
      model: p.model,
      vision: p.vision,
      hasKey: false,
      tools: true,
      contextLength: p.kind === "ollama" ? 32768 : undefined,
    },
  );
  const [models, setModels] = useState<string[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const urlChanged = !!initial && initial.baseUrl !== d.baseUrl;
  const keyStored = d.hasKey && d.apiKey !== null && !urlChanged;
  const queried = useRef("");

  const fetchModels = async () => {
    const q = JSON.stringify([d.kind, d.baseUrl, d.apiKey]);
    queried.current = q;
    setLoading(true);
    setModelError(null);
    try {
      const r = await api<{ models: string[] }>("POST", "/api/ai/models", {
        id: d.id,
        kind: d.kind,
        baseUrl: d.baseUrl,
        apiKey: typeof d.apiKey === "string" ? d.apiKey : undefined,
      });
      if (queried.current !== q) return;
      setModels(r.models);
      // Embedding models can't chat; don't suggest one.
      const usable = r.models.filter((m) => !/embed|bge-|nomic|rerank/i.test(m));
      // Claude Code's blank model means the user's own CLI default; keep it.
      setD((x) => (!x.model && usable.length && x.kind !== "claude-code" ? { ...x, model: usable[0] } : x));
    } catch (e) {
      if (queried.current !== q) return;
      setModels(null);
      const msg = (e as Error).message;
      // Node reports an unreachable server as a bare "fetch failed".
      setModelError(/fetch failed|ECONNREFUSED/i.test(msg) ? `Can’t reach ${d.baseUrl ?? "the server"}. Is it running?` : msg.replace(/^Could not list models: /, ""));
    } finally {
      if (queried.current === q) setLoading(false);
    }
  };
  // Look up the model list right away, and again when the server or key changes.
  const refetchIfChanged = () => {
    if (queried.current !== JSON.stringify([d.kind, d.baseUrl, d.apiKey])) void fetchModels();
  };
  useEffect(() => {
    void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hint = preset?.hint ?? PRESETS.find((x) => x.icon === iconFor(d))?.hint;
  const remote = d.kind !== "claude-code" && !isLocal(d);
  const ids = { name: useId(), url: useId(), key: useId(), model: useId(), effort: useId(), ctx: useId() };

  return (
    <form
      className="lfx-settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(d);
      }}
    >
      <NavBar title={initial ? initial.name : p.label} onBack={onCancel} />
      <div className="lfx-pane">
        <div className="lfx-hero">
          <Glyph icon={preset?.icon ?? iconFor(d)} large />
          <div>
            <strong>{preset?.label ?? d.name}</strong>
            {hint && <p>{hint}</p>}
          </div>
        </div>

        <Section
          footer={
            <>
              {remote && d.baseUrl !== undefined && <>Drawings and any files you mention are sent to {endpointLabel({ kind: d.kind, baseUrl: d.baseUrl })}. </>}
              {remote && d.kind === "anthropic" && !d.baseUrl && <>Drawings and any files you mention are sent to api.anthropic.com. </>}
              {urlChanged && initial?.hasKey && <>The stored key is dropped when the URL changes. Enter it again if this host should have it. </>}
              {keyStored && (
                <button type="button" className="lfx-link" onClick={() => set({ apiKey: null })}>
                  Remove Stored Key
                </button>
              )}
            </>
          }
        >
          <div className="lfx-group">
            <Row label="Name" htmlFor={ids.name}>
              <input id={ids.name} value={d.name} onChange={(e) => set({ name: e.target.value })} required maxLength={80} />
            </Row>
            {d.kind !== "claude-code" && (
              <Row label="Server" htmlFor={ids.url}>
                <input
                  id={ids.url}
                  value={d.baseUrl ?? ""}
                  placeholder={d.kind === "anthropic" ? "api.anthropic.com" : d.kind === "ollama" ? "http://localhost:11434" : "http://localhost:8000/v1"}
                  onChange={(e) => set({ baseUrl: e.target.value || undefined })}
                  onBlur={refetchIfChanged}
                  required={d.kind === "openai"}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </Row>
            )}
            {d.kind !== "claude-code" && d.kind !== "ollama" && (
              <Row label="API Key" htmlFor={ids.key}>
                <input
                  id={ids.key}
                  type="password"
                  autoComplete="off"
                  value={typeof d.apiKey === "string" ? d.apiKey : ""}
                  placeholder={keyStored ? "Stored" : d.keyFromEnv ? `From ${d.keyFromEnv}` : isLocal(d) ? "Optional" : "Required"}
                  onChange={(e) => set({ apiKey: e.target.value || undefined })}
                  onBlur={refetchIfChanged}
                />
              </Row>
            )}
          </div>
        </Section>

        <Section
          title="Model"
          footer={
            d.kind === "ollama"
              ? "Ollama loads models with a 4K window unless told otherwise, which is too small for the assistant’s tools. Larger windows use more memory."
              : d.kind === "claude-code"
                ? `Uses ${claudeCode.path ?? "claude"}. It can read project files and edit drawings, but can’t run commands or change code.`
                : undefined
          }
        >
          <div className="lfx-group">
            <Row label="Model" htmlFor={ids.model}>
              <ModelPicker
                id={ids.model}
                value={d.model ?? ""}
                onChange={(model) => set({ model: model || undefined })}
                models={models}
                loading={loading}
                error={modelError}
                onRefresh={fetchModels}
                placeholder={d.kind === "claude-code" ? "Default" : d.kind === "anthropic" ? "claude-opus-5-5" : "Choose…"}
                required={d.kind === "openai" || d.kind === "ollama"}
              />
            </Row>
            {(d.kind === "anthropic" || d.kind === "claude-code") && (
              <Row label="Effort" htmlFor={ids.effort}>
                <select id={ids.effort} className="lfx-popup" value={d.effort ?? ""} onChange={(e) => set({ effort: e.target.value || undefined })}>
                  <option value="">Default</option>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {x === "xhigh" ? "Extra High" : x[0].toUpperCase() + x.slice(1)}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            {d.kind === "ollama" && (
              <Row label="Context Window" htmlFor={ids.ctx}>
                <select
                  id={ids.ctx}
                  className="lfx-popup"
                  value={d.contextLength ?? 32768}
                  onChange={(e) => set({ contextLength: Number(e.target.value) })}
                >
                  {[...new Set([...CONTEXTS, d.contextLength ?? 32768])]
                    .sort((a, b) => a - b)
                    .map((n) => (
                      <option key={n} value={n}>
                        {n % 1024 ? n.toLocaleString() : `${n / 1024}K`} tokens
                      </option>
                    ))}
                </select>
              </Row>
            )}
          </div>
        </Section>

        {d.kind !== "claude-code" && (
          <Section title="Capabilities">
            <div className="lfx-group">
              <SwitchRow
                label="Images"
                detail="Sends a snapshot of the selection and lets the model look at its own work."
                checked={!!d.vision}
                onChange={(vision) => set({ vision })}
              />
              {(d.kind === "openai" || d.kind === "ollama") && (
                <SwitchRow
                  label="Tool calling"
                  detail="Turn off for models that can’t call tools: they’ll answer in Mermaid, which is converted into a drawing."
                  checked={d.tools !== false}
                  onChange={(tools) => set({ tools })}
                />
              )}
            </div>
          </Section>
        )}

        {error && (
          <p className="lfx-error-inline lfx-pane-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="lfx-pane-foot">
        {onRemove && (
          <button type="button" className="lfx-btn lfx-btn-danger" onClick={onRemove} disabled={saving}>
            Remove
          </button>
        )}
        <span className="lfx-spacer" />
        <button type="button" className="lfx-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="lfx-btn lfx-primary" disabled={saving}>
          {initial ? "Save" : "Add Model"}
        </button>
      </footer>
    </form>
  );
}

/** A text field with a menu of the models the server reports, like an NSComboBox. */
function ModelPicker({
  id,
  value,
  onChange,
  models,
  loading,
  error,
  onRefresh,
  placeholder,
  required,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  models: string[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  placeholder: string;
  required: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const all = models ?? [];
  const shown = filter && value ? all.filter((m) => m.toLowerCase().includes(value.toLowerCase())) : all;

  useEffect(() => {
    if (!open) return;
    const i = Math.max(0, shown.indexOf(value));
    setHi(i);
    listRef.current?.children[i]?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const pick = (m: string) => {
    onChange(m);
    setOpen(false);
    setFilter(false);
  };

  return (
    <div className="lfx-combo">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        value={value}
        placeholder={loading && !value ? "Loading…" : placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setFilter(true);
          setOpen(true);
          setHi(0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return setOpen(true);
            const n = shown.length;
            if (n) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
          } else if (e.key === "Enter" && open && shown[hi]) {
            e.preventDefault();
            pick(shown[hi]);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        required={required}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
      />
      <button
        type="button"
        className="lfx-combo-btn"
        tabIndex={-1}
        aria-label="Show models"
        onMouseDown={(e) => {
          e.preventDefault();
          document.getElementById(id)?.focus();
          setFilter(false);
          setOpen((o) => !o);
          if (!models && !loading) onRefresh();
        }}
      >
        {loading ? (
          <span className="lfx-spinner" />
        ) : (
          <svg viewBox="0 0 12 16" aria-hidden>
            <path d="M3 6l3-3 3 3M3 10l3 3 3-3" />
          </svg>
        )}
      </button>
      {open && (
        <div className="lfx-menu" onMouseDown={(e) => e.preventDefault()}>
          {shown.length > 0 ? (
            <ul id={`${id}-list`} role="listbox" ref={listRef}>
              {shown.map((m, i) => (
                <li key={m} role="option" aria-selected={m === value} className={i === hi ? "lfx-hi" : undefined} onMouseEnter={() => setHi(i)} onClick={() => pick(m)}>
                  <span className="lfx-menu-check">{m === value ? "✓" : ""}</span>
                  {m}
                </li>
              ))}
            </ul>
          ) : (
            <p className="lfx-menu-empty">
              {loading ? "Loading models…" : error ? error : models ? (value ? "No matching models" : "No models found") : "Models haven’t loaded"}
            </p>
          )}
          <button type="button" className="lfx-menu-refresh" onClick={onRefresh} disabled={loading}>
            Refresh List
          </button>
        </div>
      )}
    </div>
  );
}

function NavBar({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div className="lfx-navbar">
      {onBack && (
        <button type="button" className="lfx-back" onClick={onBack} aria-label="Back">
          <svg viewBox="0 0 10 16" aria-hidden>
            <path d="M8 2L2 8l6 6" />
          </svg>
        </button>
      )}
      <h2>{title}</h2>
    </div>
  );
}

function Section({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="lfx-section">
      {title && <h3>{title}</h3>}
      {children}
      {footer && <p className="lfx-section-foot">{footer}</p>}
    </section>
  );
}

function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="lfx-row-cell">
      <label htmlFor={htmlFor}>{label}</label>
      <div className="lfx-row-control">{children}</div>
    </div>
  );
}

function SwitchRow({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="lfx-row-cell">
      <label htmlFor={id} className="lfx-switch-label">
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </label>
      <input id={id} type="checkbox" role="switch" className="lfx-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

function Chevron() {
  return (
    <svg className="lfx-chevron" viewBox="0 0 8 14" aria-hidden>
      <path d="M1.5 1.5L6.5 7l-5 5.5" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="lfx-check-mark" viewBox="0 0 16 16" aria-label="In use">
      <path d="M3 8.5l3.2 3.2L13 4.8" />
    </svg>
  );
}

/** A rounded, tinted tile in the style of System Settings icons. */
function Glyph({ icon, large }: { icon: Icon; large?: boolean }) {
  const paths: Record<Icon, ReactNode> = {
    local: (
      <>
        <rect x="3" y="4.5" width="14" height="9" rx="1.5" />
        <path d="M7.5 16.5h5M10 13.5v3" />
      </>
    ),
    lmstudio: (
      <>
        <path d="M4 6h9M4 10h12M4 14h7" />
      </>
    ),
    llamacpp: (
      <>
        <path d="M7.5 5L4 10l3.5 5M12.5 5L16 10l-3.5 5" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <path d="M6.5 8.5L9 10.5l-2.5 2M10.5 13h3" />
      </>
    ),
    spark: <path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" />,
    cloud: <path d="M6.5 15h7.5a3 3 0 00.4-6A4.5 4.5 0 005.8 8.3 3.4 3.4 0 006.5 15z" />,
    router: (
      <>
        <circle cx="5" cy="10" r="1.6" />
        <circle cx="15" cy="5" r="1.6" />
        <circle cx="15" cy="15" r="1.6" />
        <path d="M6.6 10H10l3.5-4.2M10 10l3.5 4.2" />
      </>
    ),
    prompts: (
      <>
        <path d="M5 4.5h10a1.5 1.5 0 011.5 1.5v6a1.5 1.5 0 01-1.5 1.5H9l-3.5 3v-3H5A1.5 1.5 0 013.5 12V6A1.5 1.5 0 015 4.5z" />
        <path d="M7 8h6M7 10.5h4" />
      </>
    ),
    tools: (
      <>
        <path d="M12.6 4.2a3.3 3.3 0 00-4.2 4.2L4 12.8a1.4 1.4 0 002 2l4.4-4.4a3.3 3.3 0 004.2-4.2l-2 2-1.6-.4-.4-1.6z" />
      </>
    ),
    server: (
      <>
        <rect x="4" y="4" width="12" height="5" rx="1.2" />
        <rect x="4" y="11" width="12" height="5" rx="1.2" />
        <path d="M6.5 6.5h.01M6.5 13.5h.01" />
      </>
    ),
  };
  return (
    <span className={`lfx-glyph lfx-glyph-${icon}${large ? " lfx-glyph-lg" : ""}`} aria-hidden>
      <svg viewBox="0 0 20 20">{paths[icon]}</svg>
    </span>
  );
}

const GROUP_FOOT: Record<string, string> = {
  Drawing: "Read, create and edit drawings. These change the drawing you have open (and any you mention).",
  Code: "Read-only access to the project, inside its folder. Needs Read project files.",
  Reference: "What the assistant reads to get a diagram's notation and layout right.",
};

function ToolsPage({
  settings,
  saving,
  error,
  onSave,
  onBack,
}: {
  settings: PublicSettings;
  saving: boolean;
  error: string | null;
  onSave: (disabled: string[]) => Promise<boolean>;
  onBack: () => void;
}) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api<ToolCatalog>("GET", "/api/ai/tools").then(setCatalog, (e: Error) => setLoadError(e.message));
  }, []);
  const disabled = new Set(settings.disabledTools);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(disabled);
    if (on) next.delete(name);
    else next.add(name);
    void onSave([...next]);
  };
  const groups = ["Drawing", "Code", "Reference"] as const;
  return (
    <div className="lfx-settings">
      <NavBar title="Tools" onBack={onBack} />
      <div className="lfx-pane">
        <p className="lfx-pane-intro">
          The tools the assistant may call. Switching one off takes it away from every model, including Claude Code. In <code>ai.json</code> this is{" "}
          <code>"disabledTools"</code>.
        </p>
        {loadError && <p className="lfx-error-inline lfx-pane-error">{loadError}</p>}
        {!catalog && !loadError && <p className="lfx-pane-intro">Loading…</p>}
        {catalog &&
          groups.map((g) => {
            const tools = catalog.tools.filter((t) => t.group === g);
            if (!tools.length) return null;
            return (
              <Section key={g} title={g} footer={GROUP_FOOT[g]}>
                <ul className="lfx-group lfx-list lfx-toolrows">
                  {tools.map((t) => (
                    <li key={t.name}>
                      <div className="lfx-row-cell lfx-toolrow">
                        <button type="button" className="lfx-toolrow-text" aria-expanded={open === t.name} onClick={() => setOpen(open === t.name ? null : t.name)}>
                          <span>
                            <code>{t.name}</code>
                            {t.readOnly && <span className="lfx-tag">read-only</span>}
                          </span>
                          <small className={open === t.name ? "lfx-toolrow-desc lfx-open" : "lfx-toolrow-desc"}>{t.description}</small>
                          {t.note && <small className="lfx-toolrow-note">{t.note}</small>}
                        </button>
                        <input
                          type="checkbox"
                          role="switch"
                          className="lfx-switch"
                          aria-label={`Let the assistant use ${t.name}`}
                          checked={!disabled.has(t.name)}
                          disabled={saving}
                          onChange={(e) => toggle(t.name, e.target.checked)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            );
          })}
        {catalog && catalog.topics.length > 0 && (
          <Section title="Diagram Knowledge" footer="Notes the assistant reads with diagram_reference before drawing a kind of diagram. They are the architecture-diagrams skill’s references, shared with Claude Code’s plugin.">
            <ul className="lfx-group lfx-list lfx-toolrows">
              {catalog.topics.map((t) => (
                <li key={t.topic}>
                  <div className="lfx-row-cell lfx-toolrow">
                    <div className="lfx-toolrow-text">
                      <span>{t.title}</span>
                      {t.covers.length > 0 && <small className="lfx-toolrow-desc lfx-open">{t.covers.join(" · ")}</small>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {error && (
          <p className="lfx-error-inline lfx-pane-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function PromptsPage({
  prompts,
  saving,
  error,
  onOpen,
  onReset,
  onBack,
}: {
  prompts: SavedPrompt[];
  saving: boolean;
  error: string | null;
  onOpen: (id?: string) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  return (
    <div className="lfx-settings">
      <NavBar title="Saved Prompts" onBack={onBack} />
      <div className="lfx-pane">
        <p className="lfx-pane-intro">
          Type <kbd>/</kbd> in the message box to pick one. A prompt that ends mid-sentence (“Draw a UML class diagram of ”) leaves the cursor there for you to finish. In{" "}
          <code>ai.json</code> these are <code>"prompts"</code>.
        </p>
        <Section
          footer={
            <button type="button" className="lfx-link" disabled={saving} onClick={onReset}>
              Restore Default Prompts
            </button>
          }
        >
          <ul className="lfx-group lfx-list">
            {prompts.map((p) => (
              <li key={p.id}>
                <button type="button" className="lfx-cell" onClick={() => onOpen(p.id)}>
                  <span className="lfx-cell-text">
                    <span>{p.name}</span>
                    <small>{p.text}</small>
                  </span>
                  <Chevron />
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="lfx-cell lfx-cell-add" onClick={() => onOpen()}>
                <span className="lfx-add-icon" aria-hidden>
                  +
                </span>
                <span className="lfx-cell-text">
                  <span>Add Prompt…</span>
                </span>
              </button>
            </li>
          </ul>
        </Section>
        {error && (
          <p className="lfx-error-inline lfx-pane-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function PromptForm({
  initial,
  saving,
  error,
  onSave,
  onCancel,
  onRemove,
}: {
  initial?: SavedPrompt;
  saving: boolean;
  error: string | null;
  onSave: (p: SavedPrompt) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const [d, setD] = useState<SavedPrompt>(initial ?? { id: newId(), name: "", text: "" });
  const ids = { name: useId(), text: useId() };
  return (
    <form
      className="lfx-settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...d, name: d.name.trim(), text: d.text.replace(/^\s+/, "") });
      }}
    >
      <NavBar title={initial ? initial.name : "New Prompt"} onBack={onCancel} />
      <div className="lfx-pane">
        <Section>
          <div className="lfx-group">
            <Row label="Name" htmlFor={ids.name}>
              <input id={ids.name} value={d.name} placeholder="UML class diagram" onChange={(e) => setD({ ...d, name: e.target.value })} required maxLength={80} />
            </Row>
          </div>
        </Section>
        <Section title="Prompt" footer="Sent as if you typed it. You can still edit it in the message box before sending.">
          <div className="lfx-group">
            <textarea
              id={ids.text}
              className="lfx-prompt-text"
              aria-label="Prompt text"
              value={d.text}
              rows={6}
              maxLength={8000}
              required
              placeholder="Draw a UML class diagram of "
              onChange={(e) => setD({ ...d, text: e.target.value })}
            />
          </div>
        </Section>
        {error && (
          <p className="lfx-error-inline lfx-pane-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="lfx-pane-foot">
        {onRemove && (
          <button type="button" className="lfx-btn lfx-btn-danger" disabled={saving} onClick={onRemove}>
            Delete
          </button>
        )}
        <span className="lfx-spacer" />
        <button type="button" className="lfx-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="lfx-btn lfx-primary" disabled={saving || !d.name.trim() || !d.text.trim()}>
          Save
        </button>
      </footer>
    </form>
  );
}
