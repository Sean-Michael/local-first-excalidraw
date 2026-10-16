/**
 * @-mentions of project code in the assistant's chat: suggestions for the picker, and the
 * context each mention attaches to a message. Folders attach an overview and outline, line
 * ranges attach those lines, symbols attach their definition. Everything goes through the
 * same confinement and secret refusal as the code tools.
 */
import fs from "node:fs";
import path from "node:path";
import { type MentionQuery, mentionTokens, parseMentionQuery } from "../shared/mentions.js";
import type { Mention } from "../shared/chat.js";
import { CodeError, readFile, resolveInRoot, walk } from "./code.js";
import { findDefinitions, languageOf, outlineText, projectOverview } from "./explore.js";

export interface MentionSuggestion {
  kind: "file" | "folder" | "symbol";
  /** Absolute path. */
  path: string;
  /** Relative to the project root; folders end with `/`. */
  rel: string;
  lines?: [number, number];
  symbol?: string;
  /** Has uncommitted changes in git. */
  changed?: boolean;
  /** A short note for the picker, e.g. "class · src/orders/repo.ts:12". */
  detail?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** Lower is better: how well a path matches the query, before recency. */
function matchScore(rel: string, q: string): number | undefined {
  if (!q) return rel.split("/").length;
  const lower = rel.toLowerCase();
  const base = lower.replace(/\/$/, "").split("/").pop()!;
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  return undefined;
}

/**
 * Picker suggestions for a typed query: folders, files (with the typed line range) and
 * symbols. Files with uncommitted changes, then recently modified files, rank higher.
 */
export function suggestMentions(root: string, query: string, opts: { changed?: Set<string>; limit?: number; now?: number } = {}): MentionSuggestion[] {
  const realRoot = fs.realpathSync.native(root);
  const q: MentionQuery = parseMentionQuery(query);
  const needle = q.target.replace(/\/+$/, "").toLowerCase();
  const changed = opts.changed ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 20;
  const files: { s: MentionSuggestion; score: number }[] = [];
  const folders = new Map<string, number>();
  let n = 0;
  for (const f of walk(realRoot, realRoot)) {
    if (++n > 20_000) break;
    if (f.rel.endsWith(".excalidraw")) continue;
    // Folders are the ancestors of the files found, so ignored and secret ones never appear.
    const parts = f.rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = `${parts.slice(0, i).join("/")}/`;
      if (folders.has(d)) continue;
      const sc = matchScore(d, needle);
      folders.set(d, sc === undefined ? Infinity : sc);
    }
    if (q.folder) continue;
    const sc = matchScore(f.rel, needle);
    if (sc === undefined) continue;
    // A bare @ lists what you're working on first; with a query, the match still counts most.
    const weight = needle ? 1 : 100;
    let boost = 0;
    if (changed.has(f.rel)) boost = 2 * weight;
    else {
      try {
        const age = now - fs.statSync(f.abs).mtimeMs;
        boost = (age < DAY ? 1 : age < 7 * DAY ? 0.5 : 0) * weight;
      } catch {
        // gone since the walk
      }
    }
    files.push({ s: { kind: "file", path: f.abs, rel: f.rel, lines: q.lines, changed: changed.has(f.rel) || undefined }, score: sc * 3 - boost });
  }
  files.sort((a, b) => a.score - b.score || a.s.rel.length - b.s.rel.length || (a.s.rel < b.s.rel ? -1 : 1));

  const out: MentionSuggestion[] = [];
  if (!q.lines) {
    // A folder only when the query names it closely enough; a bare @ lists files.
    const dirs = [...folders]
      .filter(([, sc]) => sc !== Infinity && (needle ? sc <= 2 : false))
      .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
      .slice(0, q.folder ? limit : 4);
    out.push(...dirs.map(([rel]) => ({ kind: "folder" as const, path: path.join(realRoot, rel), rel })));
  }
  if (q.symbol && needle.length >= 3) {
    try {
      for (const d of findDefinitions(realRoot, q.target, { prefix: true, limit: 5 })) {
        out.push({ kind: "symbol", path: path.join(realRoot, d.rel), rel: d.rel, lines: [d.line, Math.min(d.end, d.line + 299)], symbol: d.name, detail: `${d.kind} · ${d.rel}:${d.line}` });
      }
    } catch (e) {
      if (!(e instanceof CodeError)) throw e;
    }
  }
  out.push(...files.slice(0, limit - Math.min(out.length, limit / 2)).map((f) => f.s));
  return out.slice(0, limit);
}

/** One line per source file: its top-level declarations and their members. */
function folderOutline(root: string, dir: string, maxFiles = 40): string {
  const lines: string[] = [];
  let more = 0;
  for (const f of walk(root, path.join(root, dir))) {
    const lang = languageOf(f.rel);
    if (!lang) continue;
    if (lines.length >= maxFiles) {
      more++;
      continue;
    }
    let text: string;
    try {
      if (fs.statSync(f.abs).size > 256 * 1024) continue;
      text = fs.readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    const syms = outlineText(text, lang);
    // Members go in brackets after their class: "class OrderRepository:12 (insertPending, markPaid)".
    const grouped: string[] = [];
    for (const s of syms) {
      if (s.depth === 0 || !grouped.length) grouped.push(`${s.kind} ${s.name}:${s.line}`);
      else grouped[grouped.length - 1] += grouped[grouped.length - 1].includes(" (") ? `, ${s.name.split(".").pop()}` : ` (${s.name.split(".").pop()}`;
    }
    const summary = grouped.map((g) => (g.includes(" (") ? `${g})` : g)).join("; ");
    lines.push(`${f.rel}: ${summary || "(no declarations found)"}`);
  }
  lines.sort();
  if (more) lines.push(`… ${more} more source files (use outline_file or project_overview with dir)`);
  return lines.join("\n");
}

/** The context a picked mention attaches. Throws CodeError for a path it can't read. */
export function mentionContext(root: string, m: Mention, maxChars: number): string {
  const clip = (s: string, hint: string) => (s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n… truncated (${hint})`);
  if (m.kind === "folder") {
    const { rel } = resolveInRoot(root, m.path);
    const overview = projectOverview(root, { dir: rel, depth: 2 }).replace(/\n\nNext:.*$/s, "");
    return `Mentioned folder ${rel}/ (an overview, not every file):\n<folder>\n${clip(`${overview}\n\nDeclarations by file:\n${folderOutline(fs.realpathSync.native(root), rel)}`, "call outline_file or read_file for more")}\n</folder>`;
  }
  const range = m.lines ? { start_line: m.lines[0], end_line: m.lines[1] } : {};
  const body = clip(readFile(root, { path: m.path, ...range }), "call read_file for the rest");
  if (m.kind === "symbol") return `Mentioned symbol ${m.symbol ?? "?"}, its definition:\n<file>\n${body}\n</file>`;
  return `Mentioned file${m.lines ? ` lines ${m.lines[0]}-${m.lines[1]}` : ""}:\n<file>\n${body}\n</file>`;
}

/**
 * Mentions typed in the message text that weren't picked from the list: `@services/orders/`,
 * `@src/a.ts:10-40`, `@OrderRepository`. Paths resolve from the root, or else by a unique
 * suffix (`@ledger-orders/` finds `services/ledger-orders/`). Tokens that name nothing are
 * left alone, so an ordinary @word costs nothing.
 */
export function typedMentions(root: string, text: string, picked: Mention[]): Mention[] {
  const realRoot = fs.realpathSync.native(root);
  const out: Mention[] = [];
  const pickedRels = new Set(picked.map((m) => path.relative(realRoot, m.path).split(path.sep).join("/")));
  const pickedSymbols = new Set(picked.map((m) => m.symbol).filter(Boolean));
  let index: { files: string[]; dirs: string[] } | undefined;
  const all = () => {
    if (index) return index;
    const files: string[] = [];
    const dirs = new Set<string>();
    for (const f of walk(realRoot, realRoot)) {
      files.push(f.rel);
      const parts = f.rel.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return (index = { files, dirs: [...dirs] });
  };
  for (const token of mentionTokens(text)) {
    const q = parseMentionQuery(token);
    const target = q.target.replace(/\/+$/, "");
    if (!target) continue;
    let found: Mention | undefined;
    // A path from the root first.
    try {
      const { abs, rel } = resolveInRoot(realRoot, target);
      if (!rel.endsWith(".excalidraw")) {
        const dir = fs.statSync(abs).isDirectory();
        if (dir && !q.lines) found = { kind: "folder", path: abs };
        else if (!dir && !q.folder) found = { kind: "file", path: abs, lines: q.lines };
      }
    } catch {
      // not a path from the root
    }
    // Then a unique suffix match among folders or files.
    if (!found && (target.includes("/") || target.includes(".") || q.folder)) {
      const suffix = `/${target}`;
      const ends = (rel: string) => rel === target || rel.endsWith(suffix);
      const dirs = q.lines ? [] : all().dirs.filter(ends);
      const files = q.folder ? [] : all().files.filter(ends);
      if (dirs.length + files.length === 1) {
        found = dirs.length ? { kind: "folder", path: path.join(realRoot, dirs[0]) } : { kind: "file", path: path.join(realRoot, files[0]), lines: q.lines };
      }
    }
    if (!found && q.symbol && !pickedSymbols.has(q.target)) {
      try {
        const d = findDefinitions(realRoot, q.target, { limit: 1 })[0];
        if (d) found = { kind: "symbol", path: path.join(realRoot, d.rel), lines: [d.line, Math.min(d.end, d.line + 299)], symbol: d.name };
      } catch {
        // not an identifier after all
      }
    }
    if (!found) continue;
    const rel = path.relative(realRoot, found.path).split(path.sep).join("/");
    if (found.kind !== "symbol" && pickedRels.has(rel)) continue;
    if (out.some((o) => o.path === found!.path && o.kind === found!.kind && String(o.lines) === String(found!.lines))) continue;
    out.push(found);
  }
  return out;
}
