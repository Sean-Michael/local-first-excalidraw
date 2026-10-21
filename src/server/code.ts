/**
 * Read-only access to project files for the drawing assistant: list, search and read.
 *
 * Everything is confined to one project root (after following symlinks), skips VCS and
 * build directories, and refuses files that look like secrets even when asked by name.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", "target", ".venv", "venv",
  "__pycache__", ".cache", ".turbo", ".gradle", ".idea", "coverage", "vendor", "Pods", ".build", "DerivedData",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 120_000;
const MAX_WALK = 20_000;

export class CodeError extends Error {}

const KEY_EXTS = ["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "asc", "gpg", "ovpn", "mobileprovision", "p8", "ppk", "keychain", "keychain-db"];
const DOTFILES = ["netrc", "pgpass", "npmrc", "pypirc", "htpasswd", "git-credentials", "vault-token", "boto", "s3cfg", "dockercfg"];
const SECRET_NAMES = [
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  new RegExp(`\\.(${KEY_EXTS.join("|")})$`, "i"),
  /^id_(rsa|dsa|ecdsa|ed25519)[\w.-]*$/i,
  new RegExp(`^\\.?(${DOTFILES.join("|")})$`, "i"),
  /^credentials(\.json)?$/i,
  /^kubeconfig$/i,
  /^(secrets?|service-account)[\w.-]*\.(json|ya?ml|toml)$/i,
  /\.tfstate(\.backup)?$/i,
  /\.tfvars(\.json)?$/i,
];
const ALLOWED_ENV = /^\.env\.(example|sample|template|defaults)$/i;
/** Directories whose whole contents count as secret: keys, cloud and cluster credentials, git config and remotes. */
const SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".git"];
/** Files that are secret only inside a particular directory. */
const SECRET_PATHS = [".docker/config.json", "gh/hosts.yml", "gcloud/credentials.db"];

/** True for files the assistant must never read (keys, tokens, env files, VCS and cloud config). */
export function isSecretFile(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => SECRET_DIRS.includes(p))) return true;
  const name = parts[parts.length - 1];
  if (SECRET_PATHS.includes(parts.slice(-2).join("/"))) return true;
  if (ALLOWED_ENV.test(name)) return false;
  return SECRET_NAMES.some((re) => re.test(name));
}

/**
 * The same rules as gitignore-style globs, for tools that enforce their own permissions
 * (the Claude Code provider's Read, Grep and Glob). SECRET_GLOB_EXCEPTIONS are carved back out.
 */
export const SECRET_GLOBS = [
  "**/.env", "**/.env.*", "**/.envrc",
  ...KEY_EXTS.map((e) => `**/*.${e}`),
  "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*",
  ...DOTFILES.flatMap((n) => [`**/.${n}`, `**/${n}`]),
  "**/credentials", "**/credentials.json", "**/kubeconfig",
  ...["secret", "service-account"].flatMap((b) => ["json", "yaml", "yml", "toml"].map((e) => `**/${b}*.${e}`)),
  "**/*.tfstate", "**/*.tfstate.backup", "**/*.tfvars", "**/*.tfvars.json",
  ...SECRET_DIRS.map((d) => `**/${d}/**`),
  ...SECRET_PATHS.map((p) => `**/${p}`),
];
export const SECRET_GLOB_EXCEPTIONS = ["example", "sample", "template", "defaults"].map((s) => `**/.env.${s}`);

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** " Top-level folders: a, b, c." for a not-found error, so a model that guessed `src` sees where the code is. */
function topFolders(root: string): string {
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return "";
  }
  if (!dirs.length) return " The project has no folders; paths are relative to its root.";
  return ` Paths are relative to the project root, whose folders are: ${dirs.slice(0, 30).join(", ")}${dirs.length > 30 ? ", …" : ""}.`;
}

/** Resolves a user/model-supplied path inside the root, following symlinks. */
export function resolveInRoot(root: string, input: string): { abs: string; rel: string } {
  if (typeof input !== "string" || input.includes("\0")) throw new CodeError("Invalid path");
  const realRoot = fs.realpathSync.native(root);
  const candidate = path.resolve(realRoot, input || ".");
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    throw new CodeError(`No such file or directory: ${input}.${topFolders(realRoot)}`);
  }
  if (!within(real, realRoot)) throw new CodeError(`Path is outside the project: ${input}`);
  const rel = path.relative(realRoot, real) || ".";
  if (isSecretFile(rel)) throw new CodeError(`Refusing to read ${rel}: it looks like a secret`);
  return { abs: real, rel };
}

/** Minimal glob: `*`, `**`, `?` and `{a,b}`. A pattern without a slash matches basenames. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function globMatcher(glob?: string): (rel: string) => boolean {
  if (!glob) return () => true;
  const re = globToRegExp(glob);
  return glob.includes("/") ? (rel) => re.test(rel) : (rel) => re.test(path.basename(rel));
}

interface IgnoreRule {
  /** Directory of the .gitignore, relative to the walk root ("" for the root). */
  base: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
}

/**
 * .gitignore support: the root's and every nested directory's, with `!` negation, `dir/`,
 * anchored paths and `**`. As in git, the last matching rule wins, and nothing inside an
 * ignored directory can be re-included (the walk never enters it).
 */
export class Gitignore {
  private rules: IgnoreRule[] = [];
  private loaded = new Set<string>();

  constructor(private root: string) {}

  /** Reads `<dir>/.gitignore` once; `dir` is relative to the root. */
  load(dir: string) {
    if (this.loaded.has(dir)) return;
    this.loaded.add(dir);
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, dir, ".gitignore"), "utf8");
    } catch {
      return;
    }
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/\s+$/, "");
      if (!line || line.startsWith("#")) continue;
      const negate = line.startsWith("!");
      if (negate) line = line.slice(1);
      line = line.replace(/^\\([#!])/, "$1");
      const dirOnly = line.endsWith("/");
      const pat = line.replace(/\/+$/, "");
      if (!pat) continue;
      // A slash at the start or in the middle anchors the pattern to the .gitignore's directory.
      const anchored = pat.includes("/");
      this.rules.push({ base: dir, re: globToRegExp(pat.replace(/^\//, "")), negate, dirOnly, anchored });
    }
  }

  /** Loads the .gitignore files from the root down to `rel`, for a walk that starts below the root. */
  loadAncestors(rel: string) {
    const parts = rel === "." || rel === "" ? [] : rel.split("/");
    for (let i = 0; i <= parts.length; i++) this.load(parts.slice(0, i).join("/"));
  }

  ignored(rel: string, isDir: boolean): boolean {
    let out = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.base && !rel.startsWith(`${r.base}/`)) continue;
      const sub = r.base ? rel.slice(r.base.length + 1) : rel;
      if (r.anchored ? r.re.test(sub) : r.re.test(sub.slice(sub.lastIndexOf("/") + 1))) out = !r.negate;
    }
    return out;
  }
}

/**
 * The enclosing git work tree of `dir`: the nearest ancestor (or `dir` itself) with a `.git`.
 * The home directory doesn't count, so a dotfiles repo there (often ignoring `*`) can't hide
 * everything under it.
 */
export function gitTopOf(dir: string): string | undefined {
  const home = path.resolve(os.homedir());
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (d === home) return undefined;
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

/**
 * A gitignore check for walks that start at `start`, which may sit inside a repository: rules
 * come from the enclosing work tree's .gitignore files down to each path checked (and from any
 * repositories nested below `start`). Takes absolute paths.
 */
export function gitignoreFor(start: string): (abs: string, isDir: boolean) => boolean {
  const top = gitTopOf(start) ?? path.resolve(start);
  const ignore = new Gitignore(top);
  return (abs, isDir) => {
    const rel = relOf(top, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    ignore.loadAncestors(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
    return ignore.ignored(rel, isDir);
  };
}

/** A project file found by walking: absolute path, and root-relative path with forward slashes. */
export interface WalkEntry {
  abs: string;
  rel: string;
}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

/**
 * Every non-secret, non-ignored file under `start` (inside `root`), skipping dependency, build
 * and VCS directories. Stops after MAX_WALK directory entries.
 */
export function* walk(root: string, start: string): Generator<WalkEntry> {
  const ignore = new Gitignore(root);
  ignore.loadAncestors(relOf(root, start));
  const stack = [start];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    ignore.load(relOf(root, dir));
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      if (++seen > MAX_WALK) return;
      // Symlinks are never followed while walking; read_file can still open one that stays inside.
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const rel = relOf(root, abs);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github") || ignore.ignored(rel, true)) continue;
        stack.push(abs);
      } else if (e.isFile() && !ignore.ignored(rel, false) && !isSecretFile(rel)) {
        yield { abs, rel };
      }
    }
  }
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function listFiles(root: string, opts: { dir?: string; glob?: string; limit?: number }): string {
  const realRoot = fs.realpathSync.native(root);
  const start = resolveInRoot(realRoot, opts.dir ?? ".").abs;
  const match = globMatcher(opts.glob);
  const limit = Math.min(opts.limit ?? 300, 2000);
  const out: string[] = [];
  let more = false;
  for (const f of walk(realRoot, start)) {
    if (!match(f.rel)) continue;
    if (out.length >= limit) {
      more = true;
      break;
    }
    out.push(f.rel);
  }
  out.sort();
  if (!out.length) return "No matching files.";
  return out.join("\n") + (more ? `\n… more files not shown (narrow with dir or glob)` : "");
}

export interface SearchOptions {
  pattern: string;
  glob?: string;
  dir?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  max_results?: number;
  /** Lines of context before and after each match, like grep -C. */
  context?: number;
  /** Only the files that match, with their match counts (like grep -c). */
  files_only?: boolean;
}

const MAX_PATTERN = 500;
/** How long a regular-expression search may run before it is abandoned. */
export const SEARCH_TIMEOUT_MS = Number(process.env.LFX_SEARCH_TIMEOUT_MS) || 5_000;

/**
 * Searches file contents. A literal pattern runs here; a model-supplied regular expression
 * runs in a worker thread with a time limit, so catastrophic backtracking can't stall the daemon.
 */
export async function searchFiles(root: string, opts: SearchOptions, timeoutMs = SEARCH_TIMEOUT_MS): Promise<string> {
  if (!opts.regex) return searchFilesSync(root, opts);
  if (opts.pattern.length > MAX_PATTERN) throw new CodeError(`Regex is too long (over ${MAX_PATTERN} characters)`);
  compile(opts);
  const worker = new Worker(new URL("./code-worker.js", import.meta.url), { workerData: { root, opts } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new CodeError(`Search timed out after ${timeoutMs / 1000} s. Simplify the regex (avoid nested quantifiers like (a+)+) or narrow it with glob or dir.`));
    }, timeoutMs);
    worker.once("message", (m: { text?: string; error?: string; code?: boolean }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.text !== undefined) resolve(m.text);
      else reject(m.code ? new CodeError(m.error) : new Error(m.error));
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function compile(opts: SearchOptions): RegExp {
  const source = opts.regex ? opts.pattern : opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, opts.case_sensitive ? "" : "i");
  } catch (e) {
    throw new CodeError(`Invalid regex: ${(e as Error).message}`);
  }
}

/** The search itself, synchronous. Only safe on the main thread for literal patterns. */
export function searchFilesSync(root: string, opts: SearchOptions): string {
  const realRoot = fs.realpathSync.native(root);
  const start = resolveInRoot(realRoot, opts.dir ?? ".").abs;
  const re = compile(opts);
  const match = globMatcher(opts.glob);
  const max = Math.min(opts.max_results ?? (opts.files_only ? 200 : 80), 400);
  const ctx = Math.max(0, Math.min(opts.context ?? 0, 10));
  const short = (s: string) => (s.length > 240 ? s.slice(0, 240) + "…" : s);
  const out: string[] = [];
  let matches = 0;
  for (const f of walk(realRoot, start)) {
    if (!match(f.rel)) continue;
    let buf: Buffer;
    try {
      if (fs.statSync(f.abs).size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(f.abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    if (opts.files_only) {
      const n = lines.filter((l) => re.test(l)).length;
      if (!n) continue;
      out.push(`${f.rel} (${n} match${n === 1 ? "" : "es"})`);
      if (out.length >= max) return out.join("\n") + `\n… stopped at ${max} files (narrow with glob or dir)`;
      continue;
    }
    // With context, matches are grouped into hunks: `path:12: match`, `path-11- context`, `--` between hunks.
    let shownTo = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (ctx) {
        const from = Math.max(0, i - ctx, shownTo + 1);
        if (out.length && (shownTo < 0 || from > shownTo + 1)) out.push("--");
        for (let j = from; j < i; j++) out.push(`${f.rel}-${j + 1}- ${short(lines[j])}`);
        out.push(`${f.rel}:${i + 1}: ${short(lines[i])}`);
        let to = Math.min(lines.length - 1, i + ctx);
        // Context after runs until the next match, which prints itself.
        for (let j = i + 1; j <= to; j++) {
          if (re.test(lines[j])) {
            to = j - 1;
            break;
          }
          out.push(`${f.rel}-${j + 1}- ${short(lines[j])}`);
        }
        shownTo = to;
      } else out.push(`${f.rel}:${i + 1}: ${short(lines[i]).trim()}`);
      if (++matches >= max) return out.join("\n") + `\n… stopped at ${max} matches (narrow with glob or dir, or use files_only)`;
    }
  }
  return out.length ? out.join("\n") : "No matches.";
}

export function readFile(root: string, opts: { path: string; start_line?: number; end_line?: number }): string {
  const { abs, rel } = resolveInRoot(root, opts.path);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new CodeError(`${rel} is a directory; use list_files`);
  if (st.size > MAX_FILE_BYTES) throw new CodeError(`${rel} is larger than 1 MB`);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) throw new CodeError(`${rel} is a binary file`);
  const lines = buf.toString("utf8").split("\n");
  const from = Math.max(1, opts.start_line ?? 1);
  let to = Math.min(lines.length, opts.end_line ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
  let body = "";
  for (let i = from; i <= to; i++) {
    const line = `${String(i).padStart(5)}  ${lines[i - 1]}\n`;
    if (body.length + line.length > MAX_READ_CHARS) {
      to = i - 1;
      break;
    }
    body += line;
  }
  const more = to < lines.length ? `\n… ${lines.length - to} more lines (use start_line ${to + 1})` : "";
  return `${rel} (lines ${from}-${to} of ${lines.length})\n${body}${more}`;
}
