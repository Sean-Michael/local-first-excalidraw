import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A hidden browser that renders drawings when no editor tab is open (agents, CI, evals).
 *
 * The daemon starts a local Chromium-family browser with `--headless=new` against itself.
 * The page signs in with a one-time code, connects back over the WebSocket as a renderer
 * and answers render and Mermaid requests. It never opens a drawing or saves anything.
 */

export type HeadlessMode = "auto" | "off" | "always";

/** LFX_HEADLESS: auto (default), off (open the user's browser instead), always (never use a visible tab). */
export function headlessMode(env: NodeJS.ProcessEnv = process.env): HeadlessMode {
  const v = (env.LFX_HEADLESS ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "always") return "always";
  return "auto";
}

const MAC_APPS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS_APPS = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "Chromium\\Application\\chrome.exe",
];

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The browser to run headless: LFX_BROWSER, else the first Chromium-family browser installed. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.LFX_BROWSER) return isFile(env.LFX_BROWSER) ? env.LFX_BROWSER : onPath(env.LFX_BROWSER, env);
  if (platform === "darwin") {
    const home = env.HOME ?? os.homedir();
    for (const app of MAC_APPS) for (const p of [app, path.join(home, app)]) if (isFile(p)) return p;
  }
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (!base) continue;
      for (const app of WINDOWS_APPS) if (isFile(path.join(base, app))) return path.join(base, app);
    }
    return undefined;
  }
  for (const bin of LINUX_BINS) {
    const p = onPath(bin, env);
    if (p) return p;
  }
  return undefined;
}

function onPath(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  if (bin.includes(path.sep)) return undefined;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir && isFile(path.join(dir, bin))) return path.join(dir, bin);
  }
  return undefined;
}

/** Flags for a private, offline, throwaway browser profile that can only reach the daemon on loopback. */
export function browserArgs(profileDir: string, url: string): string[] {
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    // Chrome exits when this pipe closes, so a crashed or killed daemon never leaks it.
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    "--metrics-recording-only",
    "--no-pings",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-dev-shm-usage",
    "--window-size=1280,900",
    // Offline: every host name fails to resolve and nothing goes through a proxy. The page only uses 127.0.0.1.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--no-proxy-server",
  ];
  // Chromium's sandbox needs user namespaces that containers usually deny, and refuses to run as root.
  // The container (or root) is the isolation boundary there.
  if (process.platform === "linux" && (process.getuid?.() === 0 || fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"))) {
    args.push("--no-sandbox");
  }
  args.push(url);
  return args;
}

export class HeadlessUnavailable extends Error {}

export interface HeadlessOptions {
  /** A fresh one-time sign-in URL that lands on the renderer page. */
  loginUrl: () => string;
  /** Stop the browser after this long without a request. */
  idleMs: number;
  browser?: string;
}

/** One headless browser, started on demand and stopped when idle or when the daemon exits. */
export class HeadlessBrowser {
  readonly browser: string | undefined;
  private child?: ChildProcess;
  private profileDir?: string;
  private idleTimer?: NodeJS.Timeout;
  private busy = 0;
  private exitHook?: () => void;

  constructor(private opts: HeadlessOptions) {
    this.browser = opts.browser ?? findBrowser();
  }

  get available(): boolean {
    return !!this.browser;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get pid(): number | undefined {
    return this.running ? this.child?.pid : undefined;
  }

  /** Starts the browser if it isn't running. The caller waits for the page to connect. */
  start(): void {
    this.touch();
    if (this.running) return;
    if (!this.browser) throw new HeadlessUnavailable("No Chrome or Chromium found for headless rendering. Install Chrome/Chromium or set LFX_BROWSER.");
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-headless-"));
    this.profileDir = profile;
    const child = spawn(this.browser, browserArgs(profile, this.opts.loginUrl()), {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (e) => console.error(`Headless browser failed to start: ${e.message}`));
    child.on("exit", (code) => {
      if (code) console.error(`Headless browser exited with ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
      if (this.child === child) this.child = undefined;
      removeDir(profile);
      if (this.profileDir === profile) this.profileDir = undefined;
    });
    // Belt and braces next to the pipe: kill it synchronously when the daemon exits normally.
    if (!this.exitHook) {
      this.exitHook = () => {
        this.stop();
        if (this.profileDir) removeDir(this.profileDir);
      };
      process.once("exit", this.exitHook);
    }
  }

  /** Records use, postponing the idle shutdown. The countdown only runs while nothing is in flight. */
  touch(): void {
    clearTimeout(this.idleTimer);
    if (this.busy) return;
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleMs);
    this.idleTimer.unref();
  }

  /**
   * Marks a request in flight (a launch, a render), so the idle shutdown can't kill the browser
   * under it on a slow first start. Call the returned function when it is done.
   */
  hold(): () => void {
    this.busy++;
    clearTimeout(this.idleTimer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy--;
      this.touch();
    };
  }

  /** Stops the browser; its profile directory is removed once it has exited. */
  stop(): void {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

function removeDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // the OS cleans its temp directory eventually
  }
}
