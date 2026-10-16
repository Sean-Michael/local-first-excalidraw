/**
 * Code links: a drawing element that points at source code. The element's `link` holds a
 * project-relative path with an optional line (`src/orders/repo.ts#L42`), and
 * `customData.lfxCode` mirrors it with the hash of the file when the link was made, so a
 * later check can tell the code has changed since.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CodeLink {
  path: string;
  line?: number;
}

export interface CodeRef extends CodeLink {
  /** sha256 of the file's contents when the link was made or last reviewed. */
  sha?: string;
}

export type LinkState = "ok" | "changed" | "missing" | "unknown";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Parses `path`, `path:42`, `path#L42` or `path#L42-L50`; anything with a URL scheme or an absolute path isn't a code link. */
export function parseCodeLink(link: string): CodeLink | undefined {
  const s = link.trim();
  if (!s || SCHEME.test(s) || s.startsWith("/") || s.startsWith("\\") || s.startsWith("#")) return undefined;
  const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))?$/.exec(s);
  if (!m || !m[1]) return undefined;
  const p = path.posix.normalize(m[1].replace(/\\/g, "/"));
  if (p === "." || p.startsWith("../") || p === "..") return undefined;
  const line = Number(m[2] ?? m[3]);
  return line > 0 ? { path: p, line } : { path: p };
}

export function formatCodeLink(c: CodeLink): string {
  return c.line ? `${c.path}#L${c.line}` : c.path;
}

export function hashFile(file: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

/** The element's code reference, from customData.lfxCode or else its link. */
export function codeRefOf(el: { link?: string | null; customData?: Record<string, unknown> }): CodeRef | undefined {
  const c = el.customData?.lfxCode as CodeRef | undefined;
  if (c && typeof c.path === "string") return c;
  return el.link ? parseCodeLink(el.link) : undefined;
}

/** Compares a reference with the file under `root` now. */
export function linkState(root: string, ref: CodeRef): LinkState {
  const file = path.resolve(root, ref.path);
  if (path.relative(root, file).startsWith("..")) return "missing";
  const sha = hashFile(file);
  if (!sha) return "missing";
  if (ref.line) {
    const lines = fs.readFileSync(file, "utf8").split("\n").length;
    if (ref.line > lines) return "missing";
  }
  if (!ref.sha) return "unknown";
  return sha === ref.sha ? "ok" : "changed";
}
