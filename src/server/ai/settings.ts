/**
 * Assistant settings in `<stateDir>/ai.json` (mode 0600). API keys are write-only from the
 * page: they are never sent back, and changing an endpoint's URL drops its stored key so a
 * key can't be redirected to a different host.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeFileAtomic } from "../config.js";
import type { EndpointKind, PublicEndpoint, PublicSettings } from "../../shared/chat.js";

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

export class SettingsStore {
  private file: string;
  private data: AiSettings;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "ai.json");
    this.data = { ...DEFAULT_SETTINGS, ...readJson<Partial<AiSettings>>(this.file, {}) };
    if (!Array.isArray(this.data.endpoints)) this.data.endpoints = [];
  }

  get(): AiSettings {
    return this.data;
  }

  active(): Endpoint | undefined {
    if (!this.data.enabled) return undefined;
    return this.data.endpoints.find((e) => e.id === this.data.active) ?? this.data.endpoints[0];
  }

  public(claudeCode: { available: boolean; path?: string }): PublicSettings {
    return {
      enabled: this.data.enabled,
      active: this.active()?.id ?? this.data.active,
      codeAccess: this.data.codeAccess,
      claudeCode,
      endpoints: this.data.endpoints.map((e): PublicEndpoint => {
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
   * Applies an update from the settings form. Per endpoint, `apiKey` is a string to set it,
   * null to clear it, or absent to keep the stored one (unless the URL changed).
   */
  update(body: Record<string, unknown>): AiSettings {
    const prev = new Map(this.data.endpoints.map((e) => [e.id, e]));
    const incoming = Array.isArray(body.endpoints) ? (body.endpoints as Record<string, unknown>[]) : this.data.endpoints;
    if (incoming.length > 50) throw new SettingsError("Too many endpoints");
    const endpoints: Endpoint[] = incoming.map((raw) => {
      const kind = raw.kind as EndpointKind;
      if (!KINDS.includes(kind)) throw new SettingsError(`Unknown endpoint kind: ${String(raw.kind)}`);
      const id = typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : crypto.randomBytes(6).toString("hex");
      const old = prev.get(id);
      const baseUrl = kind === "claude-code" ? undefined : normalizeUrl(raw.baseUrl as string | undefined);
      if (kind === "openai" && !baseUrl) throw new SettingsError("An OpenAI-compatible endpoint needs a base URL");
      const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
      let apiKey = old?.apiKey;
      if (old && (old.baseUrl !== baseUrl || old.kind !== kind)) apiKey = undefined;
      if (raw.apiKey === null) apiKey = undefined;
      else if (typeof raw.apiKey === "string" && raw.apiKey.trim()) apiKey = raw.apiKey.trim();
      const effort = str(raw.effort);
      const ctxLen = Number(raw.contextLength);
      return {
        id,
        name: str(raw.name, 80) ?? (kind === "claude-code" ? "Claude Code" : kind === "ollama" ? "Ollama" : new URL(baseUrl ?? "https://api.anthropic.com").host),
        kind,
        baseUrl,
        model: str(raw.model),
        apiKey,
        vision: raw.vision === undefined ? undefined : !!raw.vision,
        tools: raw.tools === undefined ? undefined : !!raw.tools,
        effort: effort && EFFORTS.has(effort) ? effort : undefined,
        contextLength: kind === "ollama" && Number.isFinite(ctxLen) && ctxLen > 0 ? Math.min(Math.max(Math.round(ctxLen), 2048), 1_048_576) : undefined,
      };
    });
    this.data = {
      enabled: body.enabled === undefined ? this.data.enabled : !!body.enabled,
      codeAccess: body.codeAccess === undefined ? this.data.codeAccess : !!body.codeAccess,
      active: typeof body.active === "string" ? body.active : this.data.active,
      endpoints,
    };
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), 0o600);
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
