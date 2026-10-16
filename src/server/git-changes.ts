/**
 * git_changes: a read-only summary of what changed in the project, for updating diagrams after
 * a code change. Working tree against HEAD, between two refs, or the last N commits, with
 * per-file stats and an optional unified diff, size-capped.
 *
 * Git runs with a timeout and fixed arguments: refs are validated, external diff drivers,
 * textconv filters and fsmonitor hooks are off (a repository's config can't make it run a
 * program), and files that look like secrets are excluded by pathspec, so they never show up
 * in a listing or a diff.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CodeError, isSecretFile, SECRET_GLOBS } from "./code.js";

const TIMEOUT_MS = Number(process.env.LFX_GIT_TIMEOUT_MS) || 5_000;
const MAX_DIFF_CHARS = 20_000;
const MAX_FILES = 200;
const REF = /^(?!-)[\w./@^~{}:+-]{1,200}$/;

export interface GitChangesOptions {
  /** Base ref (commit, branch, tag, `HEAD~3`). With `to`, compares the two; alone, compares it with the working tree. `A..B` works too. */
  from?: string;
  to?: string;
  /** The last N commits instead, newest first. */
  last?: number;
  /** Limit to this file or folder (relative to the project root). */
  path?: string;
  /** Include the unified diff (capped). */
  diff?: boolean;
}

const run = (root: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "diff.external=", "-c", "log.showSignature=false", ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_NOSYSTEM: "1" } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") reject(new CodeError("git is not installed, so changes can't be listed"));
        else if (e.killed) reject(new CodeError(`git took longer than ${TIMEOUT_MS / 1000} s; narrow it with path`));
        else reject(new CodeError(`git: ${String(stderr).trim().split("\n").slice(-2).join(" ") || e.message}`));
      },
    );
  });

/** The pathspec: the requested path (or the project root) minus every secret-looking file. */
function pathspec(p: string | undefined): string[] {
  let target = ".";
  if (p) {
    const norm = path.posix.normalize(p.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (!norm || norm.startsWith("../") || norm === ".." || path.isAbsolute(norm) || norm.includes("\0")) throw new CodeError(`Path is outside the project: ${p}`);
    if (isSecretFile(norm)) throw new CodeError(`Refusing to show ${norm}: it looks like a secret`);
    // Literal, so a path can't smuggle in pathspec magic.
    target = `:(literal)${norm}`;
  }
  return ["--", target, ...SECRET_GLOBS.map((g) => `:(exclude,glob)${g}`)];
}

function ref(r: string): string {
  if (!REF.test(r) || r.includes("..")) throw new CodeError(`Not a valid git ref: ${r}`);
  return r;
}

interface FileChange {
  status: string;
  path: string;
  from?: string;
  added?: number;
  deleted?: number;
}

/** Joins `--name-status -z` and `--numstat -z` output (renames detected in both). */
export function parseChanges(nameStatus: string, numstat: string): FileChange[] {
  const files: FileChange[] = [];
  const byPath = new Map<string, FileChange>();
  const ns = nameStatus.split("\0");
  for (let i = 0; i < ns.length; i++) {
    const status = ns[i];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const f: FileChange = { status: status[0], from: ns[i + 1], path: ns[i + 2] };
      i += 2;
      files.push(f);
      byPath.set(f.path, f);
    } else {
      const f: FileChange = { status: status[0], path: ns[++i] };
      files.push(f);
      byPath.set(f.path, f);
    }
  }
  const nums = numstat.split("\0");
  for (let i = 0; i < nums.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(nums[i]);
    if (!m) continue;
    let p = m[3];
    // A rename's numstat has an empty path followed by the old and new paths.
    if (!p) {
      p = nums[i + 2];
      i += 2;
    }
    const f = byPath.get(p);
    if (f && m[1] !== "-") {
      f.added = Number(m[1]);
      f.deleted = Number(m[2]);
    }
  }
  return files.filter((f) => f.path && !isSecretFile(f.path));
}

const STATUS: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflict", "?": "untracked" };

function fileLines(files: FileChange[], indent = "  "): string[] {
  const shown = files.slice(0, MAX_FILES).map((f) => {
    const stat = f.added === undefined ? (f.status === "?" ? "" : " (binary)") : ` +${f.added} -${f.deleted}`;
    return `${indent}${f.status} ${f.from ? `${f.from} -> ` : ""}${f.path}${stat}`;
  });
  if (files.length > MAX_FILES) shown.push(`${indent}… ${files.length - MAX_FILES} more files (narrow with path)`);
  return shown;
}

function totals(files: FileChange[]): string {
  const add = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  const kinds = Object.entries(files.reduce<Record<string, number>>((m, f) => ((m[f.status] = (m[f.status] ?? 0) + 1), m), {}))
    .map(([k, n]) => `${n} ${STATUS[k] ?? k}`)
    .join(", ");
  return `${files.length} file${files.length === 1 ? "" : "s"} changed (${kinds || "none"}), +${add} -${del}`;
}

function capDiff(d: string): string {
  if (!d.trim()) return "(no textual diff)";
  return d.length <= MAX_DIFF_CHARS ? d.trimEnd() : `${d.slice(0, MAX_DIFF_CHARS)}\n… diff truncated at ${MAX_DIFF_CHARS / 1000}K characters (narrow it with path)`;
}

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--relative", "-M"];

export async function gitChanges(root: string, opts: GitChangesOptions = {}): Promise<string> {
  const realRoot = fs.realpathSync.native(root);
  try {
    await run(realRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch (e) {
    if (e instanceof CodeError && /not installed/.test(e.message)) throw e;
    throw new CodeError("The project isn't a git repository, so there is no change history. Ask the user what changed, or compare files by reading them.");
  }
  const spec = pathspec(opts.path);
  const scope = opts.path ? ` in ${opts.path}` : "";

  if (opts.last) {
    const n = Math.max(1, Math.min(opts.last, 50));
    const SEP = "\x1e";
    const log = await run(realRoot, ["log", `-n${n}`, `--format=${SEP}%h%x1f%ad%x1f%an%x1f%s`, "--date=short", "--name-status", "-z", ...DIFF_FLAGS, ...spec]);
    const nums = await run(realRoot, ["log", `-n${n}`, `--format=${SEP}%h`, "--numstat", "-z", ...DIFF_FLAGS, ...spec]);
    // With -z each commit is `<SEP>header\0\n` followed by its NUL-separated file records.
    const commits = (s: string) =>
      s.split(SEP).filter(Boolean).map((c): [string, string] => {
        const end = c.indexOf("\0");
        return end < 0 ? [c.trim(), ""] : [c.slice(0, end), c.slice(end + 1).replace(/^\n/, "")];
      });
    const numByCommit = new Map(commits(nums));
    const out = [`Last ${n} commit${n === 1 ? "" : "s"}${scope}, newest first:`];
    for (const [header, body] of commits(log)) {
      const [sha, date, author, subject] = header.split("\x1f");
      const files = parseChanges(body, numByCommit.get(sha) ?? "");
      out.push("", `${sha} ${date} ${author}: ${subject}`);
      if (files.length) out.push(`  ${totals(files)}`, ...fileLines(files, "    "));
      else out.push("  no file changes of its own (a merge, or nothing under this path)");
    }
    if (out.length === 1) return `No commits${scope}.`;
    if (opts.diff) out.push("", capDiff(await run(realRoot, ["log", `-n${n}`, "-p", "--format=commit %h %s", ...DIFF_FLAGS, ...spec])));
    else out.push("", "For the code itself: diff: true (with path for one file), or read_file.");
    return out.join("\n");
  }

  let from = opts.from;
  let to = opts.to;
  if (from?.includes("..")) [from, to] = from.split(/\.{2,3}/) as [string, string];
  const refs = [from ? ref(from) : "HEAD", ...(to ? [ref(to)] : [])];
  const head = await run(realRoot, ["log", "-1", "--format=%h %s"]).catch(() => "");
  if (!head && !from) {
    const untracked = (await run(realRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...spec])).split("\0").filter((p) => p && !isSecretFile(p));
    return [`No commits yet${scope}; ${untracked.length} untracked files:`, ...fileLines(untracked.map((p) => ({ status: "?", path: p })))].join("\n");
  }
  const [nameStatus, numstat] = await Promise.all([
    run(realRoot, ["diff", "--name-status", "-z", ...DIFF_FLAGS, ...refs, ...spec]),
    run(realRoot, ["diff", "--numstat", "-z", ...DIFF_FLAGS, ...refs, ...spec]),
  ]);
  const files = parseChanges(nameStatus, numstat);
  let title: string;
  if (to) title = `Changes from ${from} to ${to}${scope}`;
  else {
    const branch = (await run(realRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
    title = from ? `Changes from ${from} to the working tree${scope}` : `Uncommitted changes${scope} (working tree and staged, against HEAD ${head.trim()}${branch && branch !== "HEAD" ? ` on ${branch}` : ""})`;
    // ls-files lists paths relative to the directory git runs in, like --relative does for diffs.
    const untracked = (await run(realRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...spec])).split("\0").filter((p) => p && !isSecretFile(p));
    files.push(...untracked.map((p) => ({ status: "?", path: p })));
  }
  const out = [title, totals(files), ...fileLines(files)];
  if (!files.length) {
    out.splice(1, out.length - 1, "No changes.");
    if (!to && !from) out.push("To see what the last commits changed, call git_changes with last: 1 (or more).");
    return out.join("\n");
  }
  if (opts.diff) out.push("", capDiff(await run(realRoot, ["diff", ...DIFF_FLAGS, ...refs, ...spec])));
  else out.push("", "For the code itself: diff: true (with path for one file), or read_file.");
  return out.join("\n");
}
