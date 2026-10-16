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

type Linkable = { id: string; type?: string; link?: string | null; isDeleted?: boolean; customData?: Record<string, unknown>; version: number; versionNonce: number };

const sameTarget = (a: CodeLink, b: CodeLink) => a.path === b.path && (a.line ?? 0) === (b.line ?? 0);

const bump = <T extends Linkable>(e: T, customData: Record<string, unknown> | undefined): T => {
  const out = { ...e, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } as T;
  if (customData && Object.keys(customData).length) out.customData = customData;
  else delete out.customData;
  return out;
};

/**
 * Keeps customData.lfxCode in step with each element's `link`: a new or retargeted code link
 * records the file's current hash, and a link that is no longer a code link drops it. Returns
 * the elements with the changed ones replaced (version bumped) and how many changed.
 */
export function stampCodeLinks<T extends Linkable>(elements: T[], root: string): { elements: T[]; stamped: number } {
  let stamped = 0;
  const out = elements.map((e) => {
    if (e.isDeleted) return e;
    const target = e.link ? parseCodeLink(e.link) : undefined;
    const have = e.customData?.lfxCode as CodeRef | undefined;
    if (!target) {
      if (!have) return e;
      stamped++;
      const { lfxCode: _drop, ...rest } = e.customData ?? {};
      return bump(e, rest);
    }
    if (have && typeof have.path === "string" && sameTarget(have, target) && have.sha) return e;
    const file = path.resolve(root, target.path);
    const sha = path.relative(root, file).startsWith("..") ? undefined : hashFile(file);
    // A link to a file that doesn't exist yet gets its hash once it does.
    if (have && sameTarget(have, target) && !sha) return e;
    stamped++;
    const ref: CodeRef = { ...target, ...(sha ? { sha } : {}) };
    return bump(e, { ...e.customData, lfxCode: ref });
  });
  return { elements: out, stamped };
}

export interface LinkReport extends CodeRef {
  id: string;
  state: LinkState;
}

/** The state of every code link in a drawing. */
export function checkLinks(elements: Linkable[], root: string): LinkReport[] {
  const out: LinkReport[] = [];
  for (const e of elements) {
    if (e.isDeleted) continue;
    const ref = codeRefOf(e);
    if (!ref) continue;
    out.push({ id: e.id, ...ref, state: linkState(root, ref) });
  }
  return out;
}

/** "3 links: 1 ok, 2 changed (a, b)" style one-liner for agents. */
export function summarizeLinks(reports: LinkReport[]): string {
  if (!reports.length) return "No code links.";
  const by = (s: LinkState) => reports.filter((r) => r.state === s);
  const parts = (["ok", "changed", "missing", "unknown"] as const)
    .filter((s) => by(s).length)
    .map((s) => `${by(s).length} ${s}`);
  const lines = [`${reports.length} code link${reports.length === 1 ? "" : "s"}: ${parts.join(", ")}.`];
  for (const r of reports) if (r.state !== "ok") lines.push(`[${r.id}] ${formatCodeLink(r)}: ${r.state}`);
  return lines.join("\n");
}

/**
 * "Mark as reviewed": re-records the current hash of the linked files, for the given ids or
 * every code-linked element. Returns only the elements that changed.
 */
export function refreshLinks<T extends Linkable>(elements: T[], root: string, ids?: string[]): T[] {
  const only = ids?.length ? new Set(ids) : undefined;
  const out: T[] = [];
  for (const e of elements) {
    if (e.isDeleted || (only && !only.has(e.id))) continue;
    const ref = codeRefOf(e);
    if (!ref) continue;
    const file = path.resolve(root, ref.path);
    const sha = path.relative(root, file).startsWith("..") ? undefined : hashFile(file);
    if (!sha || sha === ref.sha) continue;
    out.push(bump(e, { ...e.customData, lfxCode: { path: ref.path, ...(ref.line ? { line: ref.line } : {}), sha } }));
  }
  return out;
}
