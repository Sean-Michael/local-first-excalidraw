/**
 * An isolated daemon per eval run: its own port and state directory, no browser, never the
 * user's normal daemon.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { REPO_ROOT } from "./scenarios.js";

export const CLI = path.join(REPO_ROOT, "dist", "src", "server", "cli.js");

/** A free TCP port in 20000-40000. */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("No free port found");
}

/** Environment for everything in one run: daemon, MCP server and Claude Code. */
export function isolatedEnv(port: number, stateDir: string, projectRoot: string): Record<string, string> {
  return {
    LFX_PORT: String(port),
    LFX_STATE_DIR: stateDir,
    LFX_NO_BROWSER: "1",
    LFX_HEADLESS: "always",
    LFX_ROOTS: projectRoot,
    LFX_IDLE_EXIT_MIN: "15",
  };
}

/** process.env without anything that would point a child at another daemon or session. */
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^LFX_/.test(k) || k === "CLAUDECODE" || k === "CLAUDE_CODE_ENTRYPOINT" || k === "CLAUDE_PROJECT_DIR") continue;
    env[k] = v;
  }
  return env;
}

export class EvalDaemon {
  private child?: ChildProcess;
  readonly url: string;

  constructor(
    readonly port: number,
    readonly stateDir: string,
    readonly env: Record<string, string>,
  ) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(logFile: string): Promise<void> {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const log = fs.openSync(logFile, "a");
    this.child = spawn(process.execPath, [CLI, "serve"], {
      env: { ...baseEnv(), ...this.env, LFX_PARENT_PID: String(process.pid) },
      stdio: ["ignore", log, log],
    });
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.child.exitCode !== null) throw new Error(`Daemon exited early; see ${logFile}`);
      try {
        const res = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return;
      } catch {
        // not up yet
      }
    }
    throw new Error(`Daemon did not start; see ${logFile}`);
  }

  token(): string {
    return fs.readFileSync(path.join(this.stateDir, "token"), "utf8").trim();
  }

  async request<T = Record<string, unknown>>(route: string, body: unknown): Promise<T> {
    const res = await fetch(this.url + route, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${route} ${res.status}: ${String(data.error ?? res.statusText)}`);
    return data as T;
  }

  op<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
    return this.request<T>("/api/op", body);
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    await this.request("/api/shutdown", {}).catch(() => {});
    for (let i = 0; i < 30 && this.child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}
