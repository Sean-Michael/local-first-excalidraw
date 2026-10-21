import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { PublicSettings } from "../shared/chat";
import { JsoncError, parseJsonc, tokenize } from "../shared/jsonc";
import { api } from "./sync";

const TOP_KEYS = ["enabled", "active", "codeAccess", "endpoints", "prompts", "disabledTools"];
const PROMPT_KEYS = ["id", "name", "text"];
const ENDPOINT_KEYS = ["id", "name", "kind", "baseUrl", "model", "apiKey", "vision", "tools", "effort", "contextLength"];
const KINDS = ["openai", "ollama", "anthropic", "claude-code"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, "~");

/** The settings as the editor shows them. Stored keys appear only as a comment. */
export function settingsToJsonc(s: PublicSettings): string {
  const pad = (text: string, n: number) => text.replace(/\n/g, `\n${" ".repeat(n)}`);
  const endpoints = s.endpoints.map((e) => {
    const { hasKey, keyFromEnv, ...rest } = e;
    const body = JSON.stringify(rest, null, 2);
    const note = hasKey ? "API key: stored (write-only)" : keyFromEnv ? `API key: from ${keyFromEnv}` : "";
    return note ? body.replace("{\n", `{\n  // ${note}\n`) : body;
  });
  const lines = [
    "// Assistant settings. They live in",
    `// ${s.file ? tilde(s.file) : "ai.json"}, and edits`,
    "// made there apply without a restart.",
    "//",
    "// API keys are write-only. To set one, add",
    '// "apiKey": "…" to an endpoint; null removes it.',
    "{",
    `  "enabled": ${s.enabled},`,
    ...(s.active ? [`  "active": ${JSON.stringify(s.active)},`] : []),
    `  "codeAccess": ${s.codeAccess},`,
    (endpoints.length ? `  "endpoints": [\n    ${endpoints.map((e) => pad(e, 4)).join(",\n    ")}\n  ]` : '  "endpoints": []') + ",",
    "  // Offered under / in the message box.",
    `  "prompts": [${s.prompts.length ? `\n    ${s.prompts.map((p) => `{ ${Object.entries(p).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`).join(",\n    ")}\n  ` : ""}],`,
    "  // Tools the assistant isn't given, by name (see Tools in the settings).",
    `  "disabledTools": ${JSON.stringify(s.disabledTools)}`,
    "}",
    "",
  ];
  return lines.join("\n");
}

/** Problems worth pointing out that the daemon would silently ignore. */
function lint(v: unknown): string[] {
  const out: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["Settings must be an object"];
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TOP_KEYS.includes(k)) out.push(`Unknown setting "${k}"`);
  for (const k of ["enabled", "codeAccess"]) if (k in o && typeof o[k] !== "boolean") out.push(`"${k}" should be true or false`);
  if (o.endpoints !== undefined && !Array.isArray(o.endpoints)) return [...out, '"endpoints" should be a list'];
  const eps = (o.endpoints ?? []) as Record<string, unknown>[];
  eps.forEach((e, n) => {
    const label = typeof e?.name === "string" ? `"${e.name}"` : `endpoint ${n + 1}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) return out.push(`Endpoint ${n + 1} should be an object`);
    for (const k of Object.keys(e)) if (!ENDPOINT_KEYS.includes(k)) out.push(`Unknown property "${k}" in ${label}`);
    if (!KINDS.includes(e.kind as string)) out.push(`${label}: "kind" should be one of ${KINDS.join(", ")}`);
    if (e.id === undefined) out.push(`${label} has no "id"; one will be made up when you save`);
    if (e.effort !== undefined && !EFFORTS.includes(e.effort as string)) out.push(`${label}: "effort" should be one of ${EFFORTS.join(", ")}`);
    if (e.contextLength !== undefined && e.kind !== "ollama") out.push(`${label}: "contextLength" only applies to Ollama`);
    if (e.kind === "claude-code" && e.baseUrl !== undefined) out.push(`${label}: Claude Code ignores "baseUrl"`);
  });
  if (typeof o.active === "string" && !eps.some((e) => e?.id === o.active)) out.push(`"active" doesn't match any endpoint id; the first endpoint is used`);
  if (o.prompts !== undefined && !Array.isArray(o.prompts)) out.push('"prompts" should be a list');
  else
    ((o.prompts ?? []) as Record<string, unknown>[]).forEach((p, n) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return out.push(`Prompt ${n + 1} should be an object`);
      const label = typeof p.name === "string" ? `prompt "${p.name}"` : `prompt ${n + 1}`;
      for (const k of Object.keys(p)) if (!PROMPT_KEYS.includes(k)) out.push(`Unknown property "${k}" in ${label}`);
      if (typeof p.name !== "string" || !p.name.trim()) out.push(`Prompt ${n + 1} needs a "name"`);
      if (typeof p.text !== "string" || !p.text.trim()) out.push(`${label} needs a "text"`);
    });
  if (o.disabledTools !== undefined && (!Array.isArray(o.disabledTools) || o.disabledTools.some((t) => typeof t !== "string"))) {
    out.push('"disabledTools" should be a list of tool names');
  }
  return out;
}

export function SettingsJson({ settings, onSaved, onBack }: { settings: PublicSettings; onSaved: (s: PublicSettings) => void; onBack: () => void }) {
  const [base, setBase] = useState(() => settingsToJsonc(settings));
  const [text, setText] = useState(base);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileError, setFileError] = useState(settings.fileError);
  const [saved, setSaved] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== base;

  // Start from what's on disk now, in case the file was edited by hand.
  useEffect(() => {
    api<PublicSettings>("GET", "/api/ai/settings").then((s) => {
      onSaved(s);
      setFileError(s.fileError);
      const t = settingsToJsonc(s);
      setBase(t);
      setText((cur) => (cur === base ? t : cur));
    }, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = useMemo((): { value?: unknown; error?: Error } => {
    try {
      return { value: parseJsonc(text) };
    } catch (e) {
      return { error: e as Error };
    }
  }, [text]);
  const warnings = useMemo(() => (parsed.error ? [] : lint(parsed.value)), [parsed]);
  const isObject = !parsed.error && !!parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value);
  const lineCount = text.split("\n").length;
  const errorLine = parsed.error instanceof JsoncError ? parsed.error.line : undefined;

  const save = async () => {
    if (!isObject || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const v = parsed.value as Record<string, unknown>;
      const s = await api<PublicSettings>("PUT", "/api/ai/settings", {
        // Left out means the default, as in VS Code.
        enabled: v.enabled ?? false,
        codeAccess: v.codeAccess ?? true,
        active: v.active,
        endpoints: Array.isArray(v.endpoints) ? v.endpoints.map((e: Record<string, unknown>) => ({ ...e, hasKey: undefined, keyFromEnv: undefined })) : [],
        prompts: v.prompts ?? null,
        disabledTools: v.disabledTools ?? [],
      });
      onSaved(s);
      setFileError(s.fileError);
      const t = settingsToJsonc(s);
      setBase(t);
      setText(t);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const insert = (s: string) => {
    // execCommand keeps the browser's undo stack; fall back to a plain edit.
    if (!document.execCommand("insertText", false, s)) {
      const el = ta.current!;
      const { selectionStart: a, selectionEnd: b } = el;
      setText(text.slice(0, a) + s + text.slice(b));
      requestAnimationFrame(() => el.setSelectionRange(a + s.length, a + s.length));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void save();
    } else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      insert("  ");
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Keep the indent, and indent one more after an opening bracket.
      const el = e.currentTarget;
      const before = text.slice(0, el.selectionStart);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const indent = /^\s*/.exec(line)![0];
      e.preventDefault();
      insert(`\n${indent}${/[[{]\s*$/.test(line) ? "  " : ""}`);
    }
  };

  return (
    <div className="lfx-settings">
      <div className="lfx-navbar">
        <button type="button" className="lfx-back" onClick={onBack} aria-label="Back">
          <svg viewBox="0 0 10 16" aria-hidden>
            <path d="M8 2L2 8l6 6" />
          </svg>
        </button>
        <h2>
          ai.json{dirty && <span className="lfx-dirty" title="Unsaved changes" />}
        </h2>
      </div>
      {fileError && (
        <p className="lfx-banner" role="alert">
          {fileError}. The last good settings are still in use.
        </p>
      )}
      <div className="lfx-code" onClick={() => ta.current?.focus()}>
        <div className="lfx-code-inner">
          <div className="lfx-gutter" aria-hidden>
            {Array.from({ length: lineCount }, (_, n) => (
              <span key={n} className={n + 1 === errorLine ? "lfx-gutter-err" : undefined}>
                {n + 1}
              </span>
            ))}
          </div>
          <div className="lfx-code-stack">
            <pre aria-hidden>
              {tokenize(text).map((t, n) => (t.kind === "space" ? t.text : <span key={n} className={`lfx-t-${t.kind}`}>{t.text}</span>))}
              {"\n"}
            </pre>
            <textarea
              ref={ta}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              wrap="off"
              data-lfx-own-save
              aria-label="Assistant settings as JSON"
            />
          </div>
        </div>
      </div>
      {(parsed.error || saveError || warnings.length > 0) && (
        <ul className="lfx-problems" aria-live="polite">
          {parsed.error && <li className="lfx-problem-err">{parsed.error.message}</li>}
          {saveError && <li className="lfx-problem-err">{saveError}</li>}
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <footer className="lfx-pane-foot">
        <button type="button" className="lfx-btn" onClick={() => setText(base)} disabled={!dirty || saving}>
          Revert
        </button>
        <span className="lfx-spacer" />
        <span className="lfx-foot-status">{saved ? "Saved" : dirty ? `${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘S" : "Ctrl+S"} to save` : ""}</span>
        <button type="button" className="lfx-btn lfx-primary" onClick={save} disabled={!dirty || saving || !isObject}>
          Save
        </button>
      </footer>
    </div>
  );
}
