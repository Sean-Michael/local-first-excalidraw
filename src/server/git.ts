/**
 * Git status of drawings, for the badges in the drawing list. Git runs with a timeout; no git,
 * no repository or a slow repository simply means no badges.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type GitState = "modified" | "untracked" | "staged" | "conflict";

const TIMEOUT_MS = 3_000;

/** Parses `git status --porcelain=v1 -z` into repo-relative path -> state. */
export function parsePorcelain(out: string): Map<string, GitState> {
  const m = new Map<string, GitState>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    // Renames and copies are followed by the original path, which we skip.
    if (x === "R" || x === "C") i++;
    let state: GitState;
    if (x === "?" && y === "?") state = "untracked";
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) state = "conflict";
    else if (y !== " " && y !== "!") state = "modified";
    else if (x !== " " && x !== "!") state = "staged";
    else continue;
    m.set(file, state);
  }
  return m;
}

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

/**
 * Files under `root` with uncommitted changes (modified, staged, untracked or conflicted),
 * as paths relative to `root`. Empty when git is missing, slow or the root isn't a repository.
 */
export async function changedFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const realRoot = fs.realpathSync.native(root);
    const top = fs.realpathSync.native((await git(realRoot, ["rev-parse", "--show-toplevel"])).trim());
    const status = await git(realRoot, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    for (const rel of parsePorcelain(status).keys()) {
      const fromRoot = path.relative(realRoot, path.join(top, rel));
      if (!fromRoot.startsWith("..") && !path.isAbsolute(fromRoot)) out.add(fromRoot.split(path.sep).join("/"));
    }
  } catch {
    // no badges, no boost
  }
  return out;
}

/**
 * States of the drawings under each root, keyed by absolute path spelled from the root (as
 * listDrawings spells it). Clean files are left out.
 */
export async function drawingStatus(roots: string[]): Promise<Record<string, GitState>> {
  const out: Record<string, GitState> = {};
  await Promise.all(
    roots.map(async (root) => {
      let top: string;
      let status: string;
      try {
        top = fs.realpathSync.native((await git(root, ["rev-parse", "--show-toplevel"])).trim());
        status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "*.excalidraw"]);
      } catch {
        return;
      }
      const realRoot = fs.realpathSync.native(root);
      for (const [rel, state] of parsePorcelain(status)) {
        const abs = path.join(top, rel);
        const fromRoot = path.relative(realRoot, abs);
        if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) continue;
        out[path.join(root, fromRoot)] = state;
      }
    }),
  );
  return out;
}
