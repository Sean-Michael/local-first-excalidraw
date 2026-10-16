/**
 * Opening a code link in the user's editor. The editor comes from LFX_EDITOR, else the
 * `editor` key of `<state dir>/editor.json`, else VS Code. Values: vscode, cursor, zed,
 * idea / webstorm / pycharm / goland / jetbrains, `$EDITOR`, or a command template with
 * `{file}` and `{line}` (split on spaces, run without a shell).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./config.js";

export interface Launch {
  cmd: string;
  args: string[];
  /** What was picked, for the reply ("vscode", "url", "template"...). */
  via: string;
}

const JETBRAINS = new Set(["idea", "webstorm", "pycharm", "goland", "phpstorm", "rubymine", "clion", "rider"]);
// GUI apps often aren't on a launchd PATH; their CLI shims usually live here.
const EXTRA_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"];

/** The configured editor setting (LFX_EDITOR wins over editor.json). */
export function editorSetting(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.LFX_EDITOR?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readJson<{ editor?: unknown }>(path.join(stateDir, "editor.json"), {}).editor;
  return typeof fromFile === "string" && fromFile.trim() ? fromFile.trim() : "vscode";
}

/** The executable's full path if it is on PATH (or a usual install dir). */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bin.includes("/")) return fs.existsSync(bin) ? bin : undefined;
  const dirs = [...(env.PATH ?? "").split(path.delimiter), ...EXTRA_PATH].filter(Boolean);
  for (const d of dirs) {
    const full = path.join(d, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return undefined;
}

const urlOpener = (platform: NodeJS.Platform) => (platform === "darwin" ? "open" : "xdg-open");

/** How to open `file` at `line` with `setting`. Pure apart from looking binaries up on PATH. */
export function editorCommand(
  file: string,
  line: number | undefined,
  setting: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; find?: (bin: string) => string | undefined } = {},
): Launch {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const find = opts.find ?? ((b: string) => which(b, env));
  const at = line ? `${file}:${line}` : file;
  const s = setting.trim();
  const key = s.toLowerCase();

  if (s.includes("{file}")) {
    const [cmd, ...rest] = s.split(/\s+/);
    const args = rest.map((a) => a.replaceAll("{file}", file).replaceAll("{line}", String(line ?? 1)));
    return { cmd, args, via: "template" };
  }
  if (key === "vscode" || key === "code" || key === "cursor") {
    const bin = key === "cursor" ? "cursor" : "code";
    const found = find(bin);
    if (found) return { cmd: found, args: ["-g", at], via: key === "cursor" ? "cursor" : "vscode" };
    const scheme = key === "cursor" ? "cursor" : "vscode";
    return { cmd: urlOpener(platform), args: [`${scheme}://file${encodeURI(file)}${line ? `:${line}` : ""}`], via: "url" };
  }
  if (key === "zed") {
    const found = find("zed");
    if (found) return { cmd: found, args: [at], via: "zed" };
    return { cmd: urlOpener(platform), args: [`zed://file${encodeURI(file)}${line ? `:${line}` : ""}`], via: "url" };
  }
  if (key === "jetbrains" || JETBRAINS.has(key)) {
    const bin = key === "jetbrains" ? "idea" : key;
    const found = find(bin) ?? bin;
    return { cmd: found, args: line ? ["--line", String(line), file] : [file], via: bin };
  }
  if (key === "$editor" || key === "editor") {
    const ed = (env.VISUAL || env.EDITOR || "").trim();
    if (!ed) throw new Error("LFX_EDITOR is $EDITOR, but neither VISUAL nor EDITOR is set");
    const [cmd, ...rest] = ed.split(/\s+/);
    return { cmd, args: [...rest, ...(line ? [`+${line}`] : []), file], via: "$EDITOR" };
  }
  // Any other single word: a CLI that takes `file:line` (subl, mate, etc).
  const [cmd, ...rest] = s.split(/\s+/);
  return { cmd, args: [...rest, at], via: cmd };
}

/** Starts the editor detached; rejects if it can't be started at all. */
export function launch(l: Launch): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(l.cmd, l.args, { detached: true, stdio: "ignore" });
    } catch (e) {
      return reject(e);
    }
    child.once("error", (e) => reject(new Error(`Could not start ${l.cmd}: ${e.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
