import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

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
  };
}

export function ensureStateDir(cfg: Config): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  // Tighten permissions even if the directory pre-existed with looser ones.
  fs.chmodSync(cfg.stateDir, 0o700);
}

/**
 * The bearer token shared by the daemon and local clients (MCP server, CLI).
 * Created once with O_EXCL so concurrent starters never disagree on it.
 */
export function loadOrCreateToken(cfg: Config): string {
  ensureStateDir(cfg);
  const file = path.join(cfg.stateDir, "token");
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    const token = crypto.randomBytes(32).toString("base64url");
    fs.writeSync(fd, token);
    fs.closeSync(fd);
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
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

/** Atomic write: temp file in the same directory, then rename. */
export function writeFileAtomic(file: string, data: string, mode = 0o644): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function baseUrl(cfg: Config): string {
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}
