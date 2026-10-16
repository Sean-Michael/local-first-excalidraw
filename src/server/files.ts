/**
 * File management for drawings: rename/move, duplicate, new folder, and delete to the system
 * trash. Callers resolve and check every path against the allowed roots first; these helpers
 * only refuse to overwrite.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKIP_DIRS } from "./store.js";

export class FileOpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Moves a file or folder, refusing to replace anything. Works across volumes. */
export function moveFile(from: string, to: string): void {
  if (!fs.existsSync(from)) throw new FileOpError(`No such file: ${from}`, 404);
  if (fs.existsSync(to)) throw new FileOpError(`${path.basename(to)} already exists there`, 409);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true });
  }
}

/** `name copy.excalidraw`, then `name copy 2.excalidraw` and so on, next to the original. */
export function copyName(file: string): string {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const dir = path.dirname(file);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base} copy${i > 1 ? ` ${i}` : ""}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export function duplicateFile(from: string, to: string): void {
  if (!fs.existsSync(from)) throw new FileOpError(`No such file: ${from}`, 404);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new FileOpError(`${path.basename(to)} already exists there`, 409);
    throw e;
  }
}

export function makeFolder(dir: string): void {
  if (fs.existsSync(dir)) throw new FileOpError(`${path.basename(dir)} already exists`, 409);
  fs.mkdirSync(dir, { recursive: true });
}

/** A name in `dir` that isn't taken: `a.excalidraw`, `a 2.excalidraw`, ... */
function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 1; ; i++) {
    const candidate = `${base}${i > 1 ? ` ${i}` : ""}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

const trashInfoDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * Moves a file to the trash and returns where it went. LFX_TRASH_DIR overrides the location
 * (tests, containers). macOS: ~/.Trash under a unique name. Linux: `gio trash` when available,
 * else the XDG trash (~/.local/share/Trash) with its .trashinfo, so "Restore" works.
 */
export function moveToTrash(file: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (!fs.existsSync(file)) throw new FileOpError(`No such file: ${file}`, 404);
  const override = env.LFX_TRASH_DIR;
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    const dest = path.join(override, freeName(override, path.basename(file)));
    moveFile(file, dest);
    return dest;
  }
  if (platform === "darwin") {
    const trash = path.join(os.homedir(), ".Trash");
    fs.mkdirSync(trash, { recursive: true });
    const dest = path.join(trash, freeName(trash, path.basename(file)));
    moveFile(file, dest);
    return dest;
  }
  if (platform === "linux") {
    try {
      execFileSync("gio", ["trash", file], { timeout: 5_000, stdio: "ignore" });
      if (!fs.existsSync(file)) return "trash";
    } catch {
      // no gio, or no trash on this volume: fall back to the XDG layout
    }
    const home = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const files = path.join(home, "Trash", "files");
    const info = path.join(home, "Trash", "info");
    fs.mkdirSync(files, { recursive: true });
    fs.mkdirSync(info, { recursive: true });
    const name = freeName(files, path.basename(file));
    fs.writeFileSync(path.join(info, `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(file)}\nDeletionDate=${trashInfoDate(new Date())}\n`);
    const dest = path.join(files, name);
    moveFile(file, dest);
    return dest;
  }
  throw new FileOpError(`Moving files to the trash isn't supported on ${platform}; set LFX_TRASH_DIR`, 501);
}

/** Folders under the roots (bounded), for "move to folder" and empty new folders. */
export function listFolders(roots: string[], maxDepth = 4, limit = 300): { path: string; root: string }[] {
  const out: { path: string; root: string }[] = [];
  const walk = (root: string, dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      out.push({ path: full, root });
      walk(root, full, depth + 1);
    }
  };
  for (const r of roots) walk(r, r, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
