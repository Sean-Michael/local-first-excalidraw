import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, type Config, ensureStateDir, loadOrCreateToken } from "./config.js";

export class DaemonError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export class DaemonClient {
  readonly url: string;
  private token: string;

  constructor(private cfg: Config) {
    this.url = process.env.LFX_URL ?? baseUrl(cfg);
    this.token = process.env.LFX_TOKEN ?? loadOrCreateToken(cfg);
  }

  async request<T = Record<string, unknown>>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url + route, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new DaemonError(String(data.error ?? res.statusText), res.status, data.code as string | undefined);
    return data as T;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(this.url + "/api/health", { signal: AbortSignal.timeout(1500) });
      const data = (await res.json()) as { name?: string };
      if (data.name !== "local-first-excalidraw") {
        throw new Error(`Port in use by something else at ${this.url}`);
      }
      return true;
    } catch (e) {
      if ((e as Error).message.startsWith("Port in use")) throw e;
      return false;
    }
  }

  /** Starts the daemon in the background if it isn't already running. */
  async ensure(): Promise<void> {
    if (await this.healthy()) return;
    if (process.env.LFX_URL) throw new Error(`Daemon at ${this.url} is not reachable`);
    ensureStateDir(this.cfg);
    const log = fs.openSync(path.join(this.cfg.stateDir, "daemon.log"), "a", 0o600);
    const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "cli.js");
    const child = spawn(process.execPath, [cli, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await this.healthy()) return;
    }
    throw new Error(`Daemon failed to start; see ${path.join(this.cfg.stateDir, "daemon.log")}`);
  }

  /** One-time sign-in URL that lands on the given drawing. */
  async loginUrl(file?: string): Promise<string> {
    const { code } = await this.request<{ code: string }>("POST", "/api/login-code", { path: file });
    // Prefer "localhost" for the browser: it is a secure context, which Excalidraw's clipboard needs.
    const u = new URL(this.url);
    if (u.hostname === "127.0.0.1") u.hostname = "localhost";
    return `${u.origin}/login?code=${encodeURIComponent(code)}`;
  }
}

/** Opens a URL in the user's default browser. Returns false if that isn't possible here. */
export function openInBrowser(url: string): boolean {
  if (process.env.LFX_NO_BROWSER === "1" || fs.existsSync("/.dockerenv")) return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
