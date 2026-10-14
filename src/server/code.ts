/**
 * Read-only access to project files for the drawing assistant: list, search and read.
 *
 * Everything is confined to one project root (after following symlinks), skips VCS and
 * build directories, and refuses files that look like secrets even when asked by name.
 */
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", "target", ".venv", "venv",
  "__pycache__", ".cache", ".turbo", ".gradle", ".idea", "coverage", "vendor", "Pods", ".build", "DerivedData",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 120_000;
const MAX_WALK = 20_000;

export class CodeError extends Error {}

const SECRET_NAMES = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg|ovpn|mobileprovision|p8)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|pgpass|npmrc|pypirc|htpasswd|git-credentials)$/i,
  /^credentials(\.json)?$/i,
  /^(secrets?|service-account)[\w.-]*\.(json|ya?ml|toml)$/i,
  /\.tfstate(\.backup)?$/i,
];
const ALLOWED_ENV = /^\.env\.(example|sample|template|defaults)$/i;

/** True for files the assistant must never read (keys, tokens, env files). */
export function isSecretFile(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === ".ssh" || p === ".gnupg" || p === ".aws")) return true;
  const name = parts[parts.length - 1];
  if (ALLOWED_ENV.test(name)) return false;
  return SECRET_NAMES.some((re) => re.test(name));
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
    throw new CodeError(`No such file or directory: ${input}`);
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

/** Simple root .gitignore support: plain names, `dir/`, `*.ext` and anchored paths. */
function gitignore(root: string): (rel: string, isDir: boolean) => boolean {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n");
  } catch {
    return () => false;
  }
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => {
      const dirOnly = l.endsWith("/");
      const pat = l.replace(/\/$/, "");
      const anchored = pat.startsWith("/") || pat.includes("/");
      const re = globToRegExp(pat.replace(/^\//, ""));
      return { dirOnly, anchored, re };
    });
  return (rel, isDir) =>
    rules.some((r) => (!r.dirOnly || isDir) && (r.anchored ? r.re.test(rel) : rel.split("/").some((seg) => r.re.test(seg))));
}

function* walk(root: string, start: string): Generator<{ abs: string; rel: string }> {
  const ignored = gitignore(root);
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
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      if (++seen > MAX_WALK) return;
      // Symlinks are never followed while walking; read_file can still open one that stays inside.
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github") || ignored(rel, true)) continue;
        stack.push(abs);
      } else if (e.isFile() && !ignored(rel, false) && !isSecretFile(rel)) {
        yield { abs, rel };
      }
    }
  }
}

function isBinary(buf: Buffer): boolean {
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

export function searchFiles(
  root: string,
  opts: { pattern: string; glob?: string; dir?: string; regex?: boolean; case_sensitive?: boolean; max_results?: number },
): string {
  const realRoot = fs.realpathSync.native(root);
  const start = resolveInRoot(realRoot, opts.dir ?? ".").abs;
  const source = opts.regex ? opts.pattern : opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(source, opts.case_sensitive ? "" : "i");
  } catch (e) {
    throw new CodeError(`Invalid regex: ${(e as Error).message}`);
  }
  const match = globMatcher(opts.glob);
  const max = Math.min(opts.max_results ?? 80, 400);
  const out: string[] = [];
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
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const line = lines[i].length > 240 ? lines[i].slice(0, 240) + "…" : lines[i];
      out.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      if (out.length >= max) return out.join("\n") + `\n… stopped at ${max} matches`;
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

/** File names under the root matching a query, for the @-mention picker. */
export function suggestFiles(root: string, query: string, limit = 30): string[] {
  const realRoot = fs.realpathSync.native(root);
  const q = query.toLowerCase();
  const scored: { rel: string; score: number }[] = [];
  for (const f of walk(realRoot, realRoot)) {
    const lower = f.rel.toLowerCase();
    const base = path.basename(lower);
    let score: number;
    if (!q) score = f.rel.split("/").length;
    else if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else continue;
    scored.push({ rel: f.rel, score });
    if (scored.length > 5000) break;
  }
  scored.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1));
  return scored.slice(0, limit).map((s) => path.join(realRoot, s.rel));
}
