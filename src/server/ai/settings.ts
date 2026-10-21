/**
 * Assistant settings in `<stateDir>/ai.json` (mode 0600). API keys are write-only from the
 * page: they are never sent back, and changing an endpoint's URL drops its stored key so a
 * key can't be redirected to a different host.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../config.js";
import { DEFAULT_PROMPTS, type EndpointKind, type PublicEndpoint, type PublicSettings, type SavedPrompt } from "../../shared/chat.js";
import { parseJsonc } from "../../shared/jsonc.js";

export interface Endpoint {
  id: string;
  name: string;
  kind: EndpointKind;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Can take images (selection snapshots, render_drawing). */
  vision?: boolean;
  /** Supports tool calling. Off: the model answers in Mermaid, which is converted for it. */
  tools?: boolean;
  effort?: string;
  /** Ollama only: context window to load the model with. */
  contextLength?: number;
}

export interface AiSettings {
  enabled: boolean;
  active?: string;
  /** Let the assistant list, search and read project files. */
  codeAccess: boolean;
  endpoints: Endpoint[];
  /** Saved prompts; unset means the defaults. */
  prompts?: SavedPrompt[];
  /** Tool names the assistant isn't given. */
  disabledTools?: string[];
}

const KINDS: EndpointKind[] = ["openai", "ollama", "anthropic", "claude-code"];
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_SETTINGS: AiSettings = { enabled: false, codeAccess: true, endpoints: [] };

export class SettingsError extends Error {}

function normalizeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    throw new SettingsError(`Invalid URL: ${u}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SettingsError("Endpoint URL must be http or https");
  if (url.username || url.password) throw new SettingsError("Put credentials in the API key field, not the URL");
  return url.toString().replace(/\/+$/, "");
}

/** Environment variable a key falls back to when none is stored. */
export function envKeyName(e: Pick<Endpoint, "kind" | "baseUrl">): string | undefined {
  if (e.kind === "anthropic") return "ANTHROPIC_API_KEY";
  if (e.kind !== "openai" || !e.baseUrl) return undefined;
  const host = new URL(e.baseUrl).host;
  if (host === "api.openai.com") return "OPENAI_API_KEY";
  if (host === "openrouter.ai") return "OPENROUTER_API_KEY";
  return undefined;
}

export function apiKeyFor(e: Endpoint): string | undefined {
  if (e.apiKey) return e.apiKey;
  const env = envKeyName(e);
  return env ? process.env[env] || undefined : undefined;
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Validates one endpoint. The caller decides what happens to its API key. */
function parseEndpoint(raw: Record<string, unknown>): Omit<Endpoint, "apiKey"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError("Each endpoint must be an object");
  const kind = raw.kind as EndpointKind;
  if (!KINDS.includes(kind)) throw new SettingsError(`Unknown endpoint kind: ${String(raw.kind)}. Use one of ${KINDS.join(", ")}`);
  const id = typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : crypto.randomBytes(6).toString("hex");
  const baseUrl = kind === "claude-code" ? undefined : normalizeUrl(raw.baseUrl as string | undefined);
  if (kind === "openai" && !baseUrl) throw new SettingsError("An OpenAI-compatible endpoint needs a base URL");
  const effort = str(raw.effort);
  const ctxLen = Number(raw.contextLength);
  return {
    id,
    name: str(raw.name, 80) ?? (kind === "claude-code" ? "Claude Code" : kind === "ollama" ? "Ollama" : new URL(baseUrl ?? "https://api.anthropic.com").host),
    kind,
    baseUrl,
    model: str(raw.model),
    vision: raw.vision === undefined ? undefined : !!raw.vision,
    tools: raw.tools === undefined ? undefined : !!raw.tools,
    effort: effort && EFFORTS.has(effort) ? effort : undefined,
    contextLength: kind === "ollama" && Number.isFinite(ctxLen) && ctxLen > 0 ? Math.min(Math.max(Math.round(ctxLen), 2048), 1_048_576) : undefined,
  };
}

/** Validates saved prompts: at most 100, each with a name and text. */
function parsePrompts(raw: unknown): SavedPrompt[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new SettingsError('"prompts" must be an array');
  if (raw.length > 100) throw new SettingsError("Too many prompts (100 at most)");
  const ids = new Set<string>();
  return raw.map((p: Record<string, unknown>, n) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new SettingsError(`Prompt ${n + 1} must be an object`);
    const name = str(p.name, 80);
    const text = typeof p.text === "string" ? p.text.slice(0, 8000) : "";
    if (!name) throw new SettingsError(`Prompt ${n + 1} needs a "name"`);
    if (!text.trim()) throw new SettingsError(`Prompt "${name}" needs a "text"`);
    let id = typeof p.id === "string" && /^[\w-]{1,64}$/.test(p.id) ? p.id : crypto.randomBytes(4).toString("hex");
    while (ids.has(id)) id = crypto.randomBytes(4).toString("hex");
    ids.add(id);
    return { id, name, text };
  });
}

function parseToolNames(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) throw new SettingsError('"disabledTools" must be a list of tool names');
  return [...new Set((raw as string[]).map((t) => t.trim()).filter((t) => /^[\w-]{1,64}$/.test(t)))].slice(0, 200);
}

export class SettingsStore {
  private file: string;
  private data: AiSettings = { ...DEFAULT_SETTINGS };
  private mtime = -1;
  /** Why the last hand edit to ai.json was ignored, until it's fixed. */
  private fileError?: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "ai.json");
    this.reload();
  }

  /** Picks up edits made to ai.json outside the app, like VS Code's settings.json. */
  private reload(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.mtime = -1;
      return;
    }
    if (st.mtimeMs === this.mtime) return;
    this.mtime = st.mtimeMs;
    try {
      // Hand edits may use comments and trailing commas, as in VS Code (saving from the app drops them).
      const raw = parseJsonc(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError("ai.json must contain a JSON object");
      const list = raw.endpoints === undefined ? [] : raw.endpoints;
      if (!Array.isArray(list)) throw new SettingsError('"endpoints" must be an array');
      this.data = {
        enabled: raw.enabled === undefined ? DEFAULT_SETTINGS.enabled : !!raw.enabled,
        codeAccess: raw.codeAccess === undefined ? DEFAULT_SETTINGS.codeAccess : !!raw.codeAccess,
        active: typeof raw.active === "string" ? raw.active : undefined,
        endpoints: (list as Record<string, unknown>[]).map((e) => ({ ...parseEndpoint(e), apiKey: str(e.apiKey, 4096) })),
        prompts: parsePrompts(raw.prompts),
        disabledTools: parseToolNames(raw.disabledTools),
      };
      this.fileError = undefined;
    } catch (e) {
      // Keep the last good settings so a half-saved edit doesn't switch the assistant off.
      this.fileError = `${path.basename(this.file)} was not loaded: ${(e as Error).message}`;
    }
  }

  get(): AiSettings {
    this.reload();
    return this.data;
  }

  /** The settings file, for showing the user where hand edits go. */
  get path(): string {
    return this.file;
  }

  active(): Endpoint | undefined {
    const data = this.get();
    if (!data.enabled) return undefined;
    return data.endpoints.find((e) => e.id === data.active) ?? data.endpoints[0];
  }

  /** The endpoint a chat session picked, or the default one if it picked none or it was removed. */
  endpoint(id: string | undefined): Endpoint | undefined {
    const data = this.get();
    if (!data.enabled) return undefined;
    return (id && data.endpoints.find((e) => e.id === id)) || this.active();
  }

  /** The saved prompts, or the defaults until the user saves a list of their own. */
  prompts(): SavedPrompt[] {
    return this.get().prompts ?? DEFAULT_PROMPTS;
  }

  /** Whether the assistant may call a tool. */
  toolEnabled(name: string): boolean {
    return !(this.get().disabledTools ?? []).includes(name);
  }

  public(claudeCode: { available: boolean; path?: string }): PublicSettings {
    const data = this.get();
    return {
      enabled: data.enabled,
      active: this.active()?.id ?? data.active,
      codeAccess: data.codeAccess,
      claudeCode,
      file: this.file,
      fileError: this.fileError,
      prompts: this.prompts(),
      disabledTools: data.disabledTools ?? [],
      endpoints: data.endpoints.map((e): PublicEndpoint => {
        const env = envKeyName(e);
        return {
          id: e.id,
          name: e.name,
          kind: e.kind,
          baseUrl: e.baseUrl,
          model: e.model,
          vision: e.vision,
          tools: e.tools,
          effort: e.effort,
          contextLength: e.contextLength,
          hasKey: !!e.apiKey,
          keyFromEnv: !e.apiKey && env && process.env[env] ? `$${env}` : undefined,
        };
      }),
    };
  }

  /**
   * Applies an update from the settings form or JSON editor. Per endpoint, `apiKey` is a
   * string to set it, null to clear it, or absent to keep the stored one (unless the URL changed).
   */
  update(body: Record<string, unknown>): AiSettings {
    const current = this.get();
    const prev = new Map(current.endpoints.map((e) => [e.id, e]));
    if (body.endpoints !== undefined && !Array.isArray(body.endpoints)) throw new SettingsError('"endpoints" must be an array');
    const incoming = (Array.isArray(body.endpoints) ? body.endpoints : current.endpoints) as Record<string, unknown>[];
    if (incoming.length > 50) throw new SettingsError("Too many endpoints");
    const endpoints: Endpoint[] = incoming.map((raw) => {
      const ep = parseEndpoint(raw);
      const old = prev.get(ep.id);
      let apiKey = old?.apiKey;
      if (old && (old.baseUrl !== ep.baseUrl || old.kind !== ep.kind)) apiKey = undefined;
      if (raw.apiKey === null) apiKey = undefined;
      else if (typeof raw.apiKey === "string" && raw.apiKey.trim()) apiKey = raw.apiKey.trim();
      return { ...ep, apiKey };
    });
    const ids = new Set<string>();
    for (const e of endpoints) {
      if (ids.has(e.id)) throw new SettingsError(`Two endpoints share the id "${e.id}"`);
      ids.add(e.id);
    }
    this.data = {
      enabled: body.enabled === undefined ? current.enabled : !!body.enabled,
      codeAccess: body.codeAccess === undefined ? current.codeAccess : !!body.codeAccess,
      active: typeof body.active === "string" ? body.active : current.active,
      endpoints,
      prompts: body.prompts === undefined ? current.prompts : parsePrompts(body.prompts),
      disabledTools: body.disabledTools === undefined ? current.disabledTools : parseToolNames(body.disabledTools),
    };
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), 0o600);
    this.mtime = fs.statSync(this.file).mtimeMs;
    this.fileError = undefined;
    return this.data;
  }
}

/** Finds the `claude` CLI. Never configurable from the page: that would be code execution. */
export function findClaude(): string | undefined {
  const fromEnv = process.env.LFX_CLAUDE_BIN;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : undefined;
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}
