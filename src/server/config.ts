import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/src/server -> package.json, which ships alongside dist/ in every layout (repo, npm, Docker, macOS app).
export const VERSION: string = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8"),
).version;

export interface Config {
  /** Directory holding the token, sessions, roots and logs (mode 0700). */
  stateDir: string;
  /** Interface the daemon binds to. 127.0.0.1 unless running inside a container. */
  host: string;
  port: number;
  /** Host headers the daemon accepts (DNS-rebinding protection). */
  allowedHosts: Set<string>;
  /** Roots that are always allowed, in addition to registered project roots. */
  defaultRoots: string[];
  /** Whether bearer clients may register additional roots at runtime. */
  allowRootRegistration: boolean;
  webDir: string;
  /** Built-in starter libraries (libraries/ next to dist/). */
  librariesDir?: string;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(path.delimiter === ";" ? /[,;]/ : /[,:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const stateDir = path.resolve(
    process.env.LFX_STATE_DIR ?? path.join(os.homedir(), ".local-first-excalidraw"),
  );
  const host = process.env.LFX_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.LFX_PORT ?? "7467", 10);
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...(process.env.LFX_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);
  const defaultRoots = (envList("LFX_ROOTS").length
    ? envList("LFX_ROOTS")
    : [path.join(os.homedir(), "Excalidraw")]
  ).map((p) => path.resolve(p));
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/server -> dist/web
  const webDir = process.env.LFX_WEB_DIR ?? path.resolve(here, "..", "..", "web");
  return {
    stateDir,
    host,
    port,
    allowedHosts,
    defaultRoots,
    allowRootRegistration: process.env.LFX_LOCK_ROOTS !== "1",
    webDir,
    librariesDir: process.env.LFX_LIBRARIES_DIR ?? path.resolve(here, "..", "..", "..", "libraries"),
  };
}

export function ensureStateDir(cfg: Config): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  // Tighten permissions even if the directory pre-existed with looser ones.
  fs.chmodSync(cfg.stateDir, 0o700);
}

/**
 * The bearer token shared by the daemon and local clients (MCP server, CLI).
 * Written in full to a temp file and then hard-linked into place, which fails if the token
 * already exists: concurrent starters never disagree on it, and a reader never sees it half-written.
 */
export function loadOrCreateToken(cfg: Config): string {
  ensureStateDir(cfg);
  const file = path.join(cfg.stateDir, "token");
  if (!fs.existsSync(file)) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tmp = tempName(file);
    try {
      fs.writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
      fs.linkSync(tmp, file);
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`Token file ${file} is malformed; delete it and retry.`);
  return token;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const tempName = (file: string) =>
  path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);

/**
 * Atomic, durable write: a temp file in the same directory, flushed to disk, then renamed over
 * the target. Without `mode`, an existing file keeps its permissions (new files get 0644).
 * The temp file is removed if anything fails.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): void {
  let perm = mode;
  if (perm === undefined) {
    try {
      perm = fs.statSync(file).mode & 0o7777;
    } catch {
      perm = 0o644;
    }
  }
  const tmp = tempName(file);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", perm);
    fs.writeFileSync(fd, data);
    // The umask may have narrowed the creation mode.
    fs.fchmodSync(fd, perm);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  // Persist the rename itself. Not every platform can open a directory, so this is best effort.
  try {
    const dfd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // ignore
  }
}

export function baseUrl(cfg: Config): string {
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}
