import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseUrl, type Config, ensureStateDir, loadOrCreateToken, VERSION } from "./config.js";
import { traceHeaders } from "./telemetry.js";

export class DaemonError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export interface Health {
  name: string;
  version?: string;
  pid?: number;
  /** Started on demand by `ensure()`, so it may be replaced; anything else is the user's to stop. */
  onDemand?: boolean;
}

/** Compares dotted versions numerically (pre-release tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
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
        ...traceHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new DaemonError(String(data.error ?? res.statusText), res.status, data.code as string | undefined);
    return data as T;
  }

  /** The running daemon's /api/health, or undefined if nothing answers. Throws if the port belongs to something else. */
  async health(): Promise<Health | undefined> {
    let data: Health;
    try {
      const res = await fetch(this.url + "/api/health", { signal: AbortSignal.timeout(1500) });
      data = (await res.json()) as Health;
    } catch {
      return undefined;
    }
    if (data?.name !== "local-first-excalidraw") throw new Error(`Port in use by something else at ${this.url}`);
    return data;
  }

  async healthy(): Promise<boolean> {
    return !!(await this.health());
  }

  /**
   * Starts the daemon in the background if it isn't already running. It stops itself once idle.
   * A daemon of another version is replaced when it is older and was started this way;
   * otherwise (the macOS app's, `lfx serve`, or a newer one) this refuses rather than mix versions.
   */
  async ensure(): Promise<void> {
    const running = await this.health();
    if (running) {
      if (running.version === VERSION) return;
      const older = !running.version || compareVersions(running.version, VERSION) < 0;
      if (!older || !running.onDemand || process.env.LFX_URL) {
        throw new Error(
          `Daemon v${running.version ?? "?"} is running at ${this.url}, but this client is v${VERSION}. ` +
            (older ? "Run `lfx stop` (or quit the app that started it) and try again." : "Upgrade this client, or run `lfx stop` to use this version instead."),
        );
      }
      console.error(`Replacing daemon v${running.version ?? "?"} with v${VERSION}.`);
      if (!(await this.stop())) throw new Error(`Daemon v${running.version} at ${this.url} did not stop; run \`lfx stop\`.`);
    }
    if (process.env.LFX_URL) throw new Error(`Daemon at ${this.url} is not reachable`);
    ensureStateDir(this.cfg);
    const log = fs.openSync(path.join(this.cfg.stateDir, "daemon.log"), "a", 0o600);
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
    const child = spawn(process.execPath, [cli, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { LFX_IDLE_EXIT_MIN: "30", ...process.env, LFX_ON_DEMAND: "1" },
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await this.healthy()) return;
    }
    throw new Error(`Daemon failed to start; see ${path.join(this.cfg.stateDir, "daemon.log")}`);
  }

  /** Asks the daemon to exit and waits until it has. Returns false if it is still answering. */
  async stop(timeoutMs = 5000): Promise<boolean> {
    if (!(await this.healthy())) return true;
    await this.request("POST", "/api/shutdown", {}).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.healthy())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
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
