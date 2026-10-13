import { useState } from "react";
import { type EndpointKind, endpointLabel, type PublicEndpoint, type PublicSettings } from "../shared/chat";
import { api } from "./sync";

interface Preset {
  label: string;
  kind: EndpointKind;
  baseUrl?: string;
  model?: string;
  vision?: boolean;
  needsKey?: boolean;
  hint: string;
}

const PRESETS: Preset[] = [
  { label: "Ollama", kind: "ollama", baseUrl: "http://localhost:11434", hint: "Local. Pick a model that supports tool calling, e.g. qwen3-coder or gpt-oss." },
  { label: "LM Studio", kind: "openai", baseUrl: "http://localhost:1234/v1", hint: "Local. Start the server from LM Studio's Developer tab." },
  { label: "llama.cpp server", kind: "openai", baseUrl: "http://localhost:8080/v1", hint: "Local. Run llama-server with --jinja so tool calls work." },
  { label: "Claude Code", kind: "claude-code", hint: "Runs your local `claude` CLI with your existing login. It searches your project itself." },
  { label: "Anthropic API", kind: "anthropic", model: "claude-opus-5-5", vision: true, needsKey: true, hint: "Sends drawings and any files you mention to api.anthropic.com." },
  { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", vision: true, needsKey: true, hint: "Sends drawings and any files you mention to api.openai.com." },
  { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, hint: "Sends drawings and any files you mention to openrouter.ai." },
  { label: "Other OpenAI-compatible server", kind: "openai", baseUrl: "http://localhost:8000/v1", hint: "vLLM, LocalAI, a gateway, …" },
];

/** An endpoint being edited. `apiKey`: string sets it, null clears it, undefined keeps it. */
type Draft = PublicEndpoint & { apiKey?: string | null };

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

export function ChatSettings({ settings, onSaved, onClose }: { settings: PublicSettings; onSaved: (s: PublicSettings) => void; onClose: () => void }) {
  const [enabled, setEnabled] = useState(settings.enabled || settings.endpoints.length === 0);
  const [codeAccess, setCodeAccess] = useState(settings.codeAccess);
  const [active, setActive] = useState(settings.active);
  const [endpoints, setEndpoints] = useState<Draft[]>(settings.endpoints);
  const [editing, setEditing] = useState<string | null>(settings.endpoints.length ? null : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (next = endpoints, nextActive = active) => {
    setSaving(true);
    setError(null);
    try {
      const s = await api<PublicSettings>("PUT", "/api/ai/settings", {
        enabled,
        codeAccess,
        active: nextActive,
        endpoints: next.map((e) => ({ ...e, hasKey: undefined, keyFromEnv: undefined })),
      });
      onSaved(s);
      setEndpoints(s.endpoints);
      setActive(s.active);
      setEditing(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const editingDraft = editing ? endpoints.find((e) => e.id === editing) : undefined;

  return (
    <div className="lfx-settings">
      {editing !== null ? (
        <EndpointForm
          key={editing || "new"}
          initial={editingDraft}
          claudeCode={settings.claudeCode}
          saving={saving}
          error={error}
          onCancel={() => {
            setError(null);
            setEditing(null);
          }}
          onSave={async (d) => {
            const exists = endpoints.some((e) => e.id === d.id);
            const next = exists ? endpoints.map((e) => (e.id === d.id ? d : e)) : [...endpoints, d];
            const ok = await save(next, exists ? active : d.id);
            if (ok) setEnabled(true);
          }}
        />
      ) : (
        <>
          <label className="lfx-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Turn on the assistant</span>
          </label>
          <p className="lfx-settings-sub">Endpoints</p>
          {endpoints.length === 0 && <p className="lfx-muted">No endpoints yet.</p>}
          <ul className="lfx-endpoints">
            {endpoints.map((e) => (
              <li key={e.id}>
                <label>
                  <input type="radio" name="lfx-active" checked={active === e.id} onChange={() => setActive(e.id)} />
                  <span>
                    <strong>{e.name}</strong>
                    <small>
                      {endpointLabel(e)} {isLocal(e) ? "· on this machine" : e.kind === "claude-code" ? "· your Claude login" : "· remote"}
                    </small>
                  </span>
                </label>
                <button type="button" className="lfx-link" onClick={() => setEditing(e.id)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="lfx-link"
                  onClick={() => setEndpoints(endpoints.filter((x) => x.id !== e.id))}
                  aria-label={`Remove ${e.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="lfx-btn" onClick={() => setEditing("")}>
            Add endpoint…
          </button>
          <label className="lfx-check">
            <input type="checkbox" checked={codeAccess} onChange={(e) => setCodeAccess(e.target.checked)} />
            <span>
              Let the assistant search and read project files
              <small>Read-only, inside the project folder. Files that look like secrets (.env, keys, credentials) are always off limits.</small>
            </span>
          </label>
          <p className="lfx-note">
            Requests are made by the local daemon, not this page. API keys are stored in <code>~/.local-first-excalidraw/ai.json</code> (readable only by
            you) and are never sent back to the browser.
          </p>
          {error && <p className="lfx-error-inline">{error}</p>}
          <div className="lfx-row">
            <button type="button" className="lfx-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="lfx-btn lfx-primary" disabled={saving} onClick={async () => (await save()) && onClose()}>
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EndpointForm({
  initial,
  claudeCode,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial?: Draft;
  claudeCode: PublicSettings["claudeCode"];
  saving: boolean;
  error: string | null;
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(
    initial ?? { id: newId(), name: PRESETS[0].label, kind: PRESETS[0].kind, baseUrl: PRESETS[0].baseUrl, hasKey: false, tools: true, contextLength: 32768 },
  );
  const [preset, setPreset] = useState<Preset | undefined>(initial ? undefined : PRESETS[0]);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const urlChanged = !!initial && initial.baseUrl !== d.baseUrl;
  const keyStored = d.hasKey && d.apiKey !== null && !urlChanged;

  const fetchModels = async () => {
    setLoading(true);
    setModelError(null);
    try {
      const r = await api<{ models: string[] }>("POST", "/api/ai/models", {
        id: d.id,
        kind: d.kind,
        baseUrl: d.baseUrl,
        apiKey: typeof d.apiKey === "string" ? d.apiKey : undefined,
      });
      setModels(r.models);
      // Embedding models can't chat; don't suggest one.
      const usable = r.models.filter((m) => !/embed|bge-|nomic|rerank/i.test(m));
      if (!d.model && usable.length) set({ model: usable[0] });
    } catch (e) {
      setModelError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      className="lfx-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(d);
      }}
    >
      {!initial && (
        <label>
          <span>Type</span>
          <select
            value={preset?.label}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.label === e.target.value)!;
              setPreset(p);
              setModels([]);
              set({ name: p.label, kind: p.kind, baseUrl: p.baseUrl, model: p.model, vision: p.vision, tools: true, apiKey: undefined, contextLength: p.kind === "ollama" ? 32768 : undefined });
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.label} disabled={p.kind === "claude-code" && !claudeCode.available}>
                {p.label}
                {p.kind === "claude-code" && !claudeCode.available ? " (not installed)" : ""}
              </option>
            ))}
          </select>
          {preset && <small>{preset.hint}</small>}
        </label>
      )}
      <label>
        <span>Name</span>
        <input value={d.name} onChange={(e) => set({ name: e.target.value })} required maxLength={80} />
      </label>
      {d.kind !== "claude-code" && (
        <label>
          <span>Base URL</span>
          <input
            value={d.baseUrl ?? ""}
            placeholder={d.kind === "anthropic" ? "https://api.anthropic.com (default)" : d.kind === "ollama" ? "http://localhost:11434" : "http://localhost:8000/v1"}
            onChange={(e) => set({ baseUrl: e.target.value || undefined })}
            required={d.kind === "openai"}
            spellCheck={false}
          />
          {!isLocal(d) && d.baseUrl !== undefined && <small>Remote: drawings and any files you mention are sent to {endpointLabel({ kind: d.kind, baseUrl: d.baseUrl })}.</small>}
        </label>
      )}
      {d.kind !== "claude-code" && d.kind !== "ollama" && (
        <label>
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            value={typeof d.apiKey === "string" ? d.apiKey : ""}
            placeholder={keyStored ? "Stored. Leave blank to keep it" : d.keyFromEnv ? `Using ${d.keyFromEnv}` : isLocal(d) ? "Usually not needed for local servers" : "Required"}
            onChange={(e) => set({ apiKey: e.target.value || undefined })}
          />
          {keyStored && (
            <button type="button" className="lfx-link" onClick={() => set({ apiKey: null })}>
              Remove stored key
            </button>
          )}
          {urlChanged && initial?.hasKey && <small>The stored key is dropped when the URL changes. Enter it again if this host should have it.</small>}
        </label>
      )}
      <label>
        <span>Model</span>
        <div className="lfx-row">
          <input
            value={d.model ?? ""}
            list="lfx-models"
            placeholder={d.kind === "claude-code" ? "Default (your Claude Code setting)" : d.kind === "anthropic" ? "claude-opus-5-5" : "e.g. qwen3-coder:30b"}
            onChange={(e) => set({ model: e.target.value || undefined })}
            required={d.kind === "openai" || d.kind === "ollama"}
            spellCheck={false}
          />
          <button type="button" className="lfx-btn" onClick={fetchModels} disabled={loading}>
            {loading ? "…" : "List"}
          </button>
        </div>
        <datalist id="lfx-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {modelError && <small className="lfx-error-inline">{modelError}</small>}
      </label>
      {d.kind !== "claude-code" && (
        <label className="lfx-check">
          <input type="checkbox" checked={!!d.vision} onChange={(e) => set({ vision: e.target.checked })} />
          <span>
            Model accepts images
            <small>Sends a snapshot of the selection and lets it look at its own work.</small>
          </span>
        </label>
      )}
      {d.kind === "ollama" && (
        <label>
          <span>Context window (tokens)</span>
          <input
            type="number"
            min={2048}
            step={1024}
            value={d.contextLength ?? 32768}
            onChange={(e) => set({ contextLength: Number(e.target.value) || undefined })}
          />
          <small>Ollama loads models with 4K tokens unless told otherwise, which is too small for the assistant's tools. Larger windows use more memory.</small>
        </label>
      )}
      {(d.kind === "openai" || d.kind === "ollama") && (
        <label className="lfx-check">
          <input type="checkbox" checked={d.tools !== false} onChange={(e) => set({ tools: e.target.checked })} />
          <span>
            Model supports tool calling
            <small>Turn off for models that can't call tools: they'll answer in Mermaid, which is converted into a drawing.</small>
          </span>
        </label>
      )}
      {(d.kind === "anthropic" || d.kind === "claude-code") && (
        <label>
          <span>Effort</span>
          <select value={d.effort ?? ""} onChange={(e) => set({ effort: e.target.value || undefined })}>
            <option value="">Model default</option>
            {["low", "medium", "high", "xhigh", "max"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      )}
      {d.kind === "claude-code" && <p className="lfx-note">Uses {claudeCode.path ?? "claude"}. It can read project files and edit drawings, but can't run commands or change code.</p>}
      {error && <p className="lfx-error-inline">{error}</p>}
      <div className="lfx-row">
        <button type="button" className="lfx-btn" onClick={onCancel}>
          Back
        </button>
        <button type="submit" className="lfx-btn lfx-primary" disabled={saving}>
          Save endpoint
        </button>
      </div>
    </form>
  );
}
