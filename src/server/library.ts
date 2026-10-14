/**
 * Library shapes: reusable groups of elements. Excalidraw has a fixed set of element types; a
 * library "shape" is a named group of them, so placing one copies its elements into a drawing.
 *
 * Sources, in the order they're listed:
 *   built-in   starter libraries shipped with the app (libraries/, MIT, see its manifest)
 *   installed  libraries the user imported or installed from the catalog (<stateDir>/libraries)
 *   project    .excalidrawlib files in the drawing's project (shared with the team via git)
 *   personal   the user's Excalidraw library (the editor's Library sidebar)
 *
 * Many published libraries carry no item names, so names fall back through: the user's rename,
 * the item's own name, the catalog's item names, text drawn inside the item, then "<library> N".
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeFileAtomic } from "./config.js";
import { addSkeletons, bounds, type El, live, newId, randInt, textElement } from "./scene.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", ".venv", "venv", "__pycache__", "vendor", "Pods"]);
const MAX_LIB_BYTES = 20 * 1024 * 1024;
const MAX_LIB_FILES = 50;
const LABEL_FONT = 16;
const LABEL_GAP = 8;
/** Library items are drawn at all sizes; diagrams scale them so the longest side is this. */
export const DEFAULT_SHAPE_SIZE = 96;

export const PRIMITIVE_SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

export type LibraryOrigin = "built-in" | "installed" | "project" | "personal";

export interface LibraryInfo {
  id: string;
  name: string;
  origin: LibraryOrigin;
  description?: string;
  authors?: string[];
  /** Where it came from (catalog page or GitHub file). */
  url?: string;
  /** Project libraries: path relative to the project. */
  file?: string;
  items: number;
  /** Used by the assistant. */
  enabled: boolean;
}

export interface LibraryShape {
  /** Stable handle for tools: "<library>/<item>". */
  key: string;
  name: string;
  library: string;
  libraryName: string;
  /** Item id (v2) or index (v1), for renames. */
  itemId: string;
  elements: El[];
  width: number;
  height: number;
  /** What's inside, for items without a meaningful name. */
  description: string;
}

export class LibraryError extends Error {}

interface RawItem {
  id?: string;
  name?: string;
  elements: El[];
}

/** Old libraries predate fields the editor and our layout rely on; bring them up to date. */
export function upgradeElement(e: El): El {
  const out: El = { ...e };
  if (out.type === "draw") out.type = "line";
  if (!("boundElements" in out) && Array.isArray(out.boundElementIds)) {
    out.boundElements = out.boundElementIds.map((id: string) => ({ id, type: "arrow" }));
  }
  delete out.boundElementIds;
  if (!("roundness" in out) && typeof out.strokeSharpness === "string") {
    const linear = out.type === "line" || out.type === "arrow";
    out.roundness = out.strokeSharpness === "round" ? { type: linear ? 2 : 3 } : null;
  }
  delete out.strokeSharpness;
  if (out.type === "text" && typeof out.text === "string" && out.originalText === undefined) out.originalText = out.text;
  return out;
}

/** Reads a library file: v2 `libraryItems` (may be named) or v1 `library` (arrays of elements). */
export function parseLibrary(raw: string): RawItem[] {
  const data = JSON.parse(raw);
  let items: RawItem[];
  if (Array.isArray(data?.libraryItems)) {
    items = data.libraryItems
      .filter((it: any) => it && Array.isArray(it.elements))
      .map((it: any) => ({ id: typeof it.id === "string" ? it.id : undefined, name: typeof it.name === "string" && it.name.trim() ? it.name.trim() : undefined, elements: it.elements }));
  } else if (Array.isArray(data?.library)) {
    items = data.library.filter(Array.isArray).map((elements: El[]) => ({ elements }));
  } else throw new LibraryError("Not an Excalidraw library (expected libraryItems or library)");
  return items.map((it) => ({ ...it, elements: it.elements.filter((e) => e && typeof e === "object" && typeof e.id === "string").map(upgradeElement) }));
}

function findLibraryFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_LIB_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".excalidrawlib")) out.push(full);
    }
  };
  walk(root, 0);
  return out.sort();
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "shape";

function itemText(els: El[]): string[] {
  return live(els)
    .filter((e) => e.type === "text" && typeof e.text === "string" && e.text.trim())
    .sort((a, b) => b.fontSize - a.fontSize || a.y - b.y)
    .map((e) => String(e.text).replace(/\s+/g, " ").trim());
}

function describeItem(els: El[]): string {
  const counts = new Map<string, number>();
  for (const e of live(els)) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => (n > 1 ? `${n} ${t}s` : t));
  const text = itemText(els).slice(0, 3).map((t) => JSON.stringify(t.slice(0, 40)));
  return parts.join(", ") + (text.length ? `; text ${text.join(", ")}` : "");
}

/** Text worth using as a name: short, and not a generic word every item in the library shares. */
function nameFromText(els: El[], shared: Set<string>): string | undefined {
  const words = itemText(els).filter((t) => t.length <= 40 && !shared.has(t.toLowerCase()));
  return words.length ? words.slice(0, 2).join(" ") : undefined;
}

// ---------------------------------------------------------------------------
// The registry: sources, user state, and the catalog of shapes
// ---------------------------------------------------------------------------

interface InstalledMeta {
  name: string;
  file: string;
  description?: string;
  authors?: string[];
  url?: string;
  /** Catalog item names, applied to items that have none. */
  itemNames?: string[];
  installedAt: number;
}

interface LibraryState {
  disabled: string[];
  /** libraryId -> itemId -> name */
  names: Record<string, Record<string, string>>;
  installed: Record<string, InstalledMeta>;
}

interface Source {
  info: Omit<LibraryInfo, "items" | "enabled">;
  file: string;
  itemNames?: string[];
}

const cache = new Map<string, { mtimeMs: number; size: number; items: RawItem[] }>();

function readItems(file: string): RawItem[] {
  const st = fs.statSync(file);
  if (st.size > MAX_LIB_BYTES) throw new LibraryError(`${path.basename(file)} is larger than 20 MB`);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.items;
  const items = parseLibrary(fs.readFileSync(file, "utf8"));
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, items });
  return items;
}

export class Libraries {
  private stateFile: string;
  private installedDir: string;

  constructor(
    stateDir: string,
    private personalFile: string,
    private bundledDir: string | undefined,
  ) {
    this.stateFile = path.join(stateDir, "libraries.json");
    this.installedDir = path.join(stateDir, "libraries");
  }

  private state(): LibraryState {
    const s = readJson<Partial<LibraryState>>(this.stateFile, {});
    return { disabled: s.disabled ?? [], names: s.names ?? {}, installed: s.installed ?? {} };
  }

  private save(s: LibraryState) {
    writeFileAtomic(this.stateFile, JSON.stringify(s, null, 2), 0o600);
  }

  private sources(projectRoot?: string): Source[] {
    const out: Source[] = [];
    if (this.bundledDir) {
      const manifest = readJson<{ libraries?: { file: string; name: string; description?: string; authors?: string[]; url?: string; itemNames?: string[] }[] }>(
        path.join(this.bundledDir, "manifest.json"),
        {},
      );
      for (const m of manifest.libraries ?? []) {
        const file = path.join(this.bundledDir, m.file);
        if (!fs.existsSync(file)) continue;
        out.push({
          info: { id: `built-in:${path.basename(m.file, ".excalidrawlib")}`, name: m.name, origin: "built-in", description: m.description, authors: m.authors, url: m.url },
          file,
          itemNames: m.itemNames,
        });
      }
    }
    for (const [id, m] of Object.entries(this.state().installed)) {
      const file = path.join(this.installedDir, m.file);
      if (!fs.existsSync(file)) continue;
      out.push({ info: { id, name: m.name, origin: "installed", description: m.description, authors: m.authors, url: m.url }, file, itemNames: m.itemNames });
    }
    if (projectRoot) {
      for (const file of findLibraryFiles(projectRoot)) {
        const rel = path.relative(projectRoot, file);
        out.push({ info: { id: `project:${rel}`, name: path.basename(file, ".excalidrawlib").replace(/[-_]+/g, " "), origin: "project", file: rel }, file });
      }
    }
    if (fs.existsSync(this.personalFile)) {
      out.push({ info: { id: "personal", name: "Your Excalidraw library", origin: "personal", description: "Items in the editor's Library sidebar" }, file: this.personalFile });
    }
    return out;
  }

  /** Every library, with item counts and whether the assistant uses it. */
  list(projectRoot?: string): LibraryInfo[] {
    const disabled = new Set(this.state().disabled);
    return this.sources(projectRoot).map((s) => {
      let items = 0;
      try {
        items = readItems(s.file).length;
      } catch {
        // unreadable: listed with 0 items so the user can remove it
      }
      return { ...s.info, items, enabled: !disabled.has(s.info.id) };
    });
  }

  /** Shapes from every enabled library (or one library, enabled or not). */
  shapes(projectRoot?: string, only?: string): LibraryShape[] {
    const state = this.state();
    const disabled = new Set(state.disabled);
    const shapes: LibraryShape[] = [];
    for (const src of this.sources(projectRoot)) {
      const id = src.info.id;
      if (only ? id !== only : disabled.has(id)) continue;
      let items: RawItem[];
      try {
        items = readItems(src.file);
      } catch {
        continue;
      }
      // Text that appears in most items ("Condition", "Yes") doesn't tell them apart.
      const freq = new Map<string, number>();
      for (const it of items) for (const t of new Set(itemText(it.elements).map((x) => x.toLowerCase()))) freq.set(t, (freq.get(t) ?? 0) + 1);
      const shared = new Set([...freq].filter(([, n]) => items.length > 2 && n > items.length / 2).map(([t]) => t));
      const libSlug = slug(src.info.name);
      const keys = new Set<string>();
      const renames = state.names[id] ?? {};
      items.forEach((it, i) => {
        const els = live(it.elements);
        const b = bounds(els);
        if (!b) return;
        const itemId = it.id ?? String(i);
        const name =
          renames[itemId] ?? it.name ?? src.itemNames?.[i]?.trim() ?? nameFromText(els, shared) ?? `${src.info.name} ${i + 1}`;
        let key = `${libSlug}/${slug(name)}`;
        for (let n = 2; keys.has(key); n++) key = `${libSlug}/${slug(name)}-${n}`;
        keys.add(key);
        shapes.push({
          key,
          name,
          library: id,
          libraryName: src.info.name,
          itemId,
          elements: els,
          width: Math.round(b.maxX - b.minX),
          height: Math.round(b.maxY - b.minY),
          description: describeItem(els),
        });
      });
    }
    return shapes;
  }

  setEnabled(id: string, enabled: boolean) {
    const s = this.state();
    s.disabled = enabled ? s.disabled.filter((d) => d !== id) : [...new Set([...s.disabled, id])];
    this.save(s);
  }

  rename(id: string, itemId: string, name: string | null) {
    const s = this.state();
    const m = (s.names[id] ??= {});
    if (name && name.trim()) m[itemId] = name.trim().slice(0, 80);
    else delete m[itemId];
    this.save(s);
  }

  /** Saves a library file (imported or downloaded) and registers it. */
  install(content: string, meta: { name?: string; fileName?: string; description?: string; authors?: string[]; url?: string; itemNames?: string[] }): LibraryInfo {
    const items = parseLibrary(content);
    if (!items.length) throw new LibraryError("That library has no items");
    // Same file as a built-in library: installing it again would only duplicate every shape.
    const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
    const mine = digest(content);
    for (const src of this.sources()) {
      if (src.info.origin === "built-in" && digest(fs.readFileSync(src.file, "utf8")) === mine) {
        throw new LibraryError(`${src.info.name} is already built in`);
      }
    }
    let name = meta.name?.trim();
    if (!name) {
      const data = JSON.parse(content);
      name = (typeof data.name === "string" && data.name) || (meta.fileName ? path.basename(meta.fileName, ".excalidrawlib").replace(/[-_]+/g, " ") : "Imported library");
    }
    name = name!.slice(0, 80);
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
    const id = `installed:${slug(name)}`;
    const file = `${slug(name)}-${hash}.excalidrawlib`;
    fs.mkdirSync(this.installedDir, { recursive: true, mode: 0o700 });
    const s = this.state();
    const prev = s.installed[id];
    if (prev && prev.file !== file) fs.rmSync(path.join(this.installedDir, prev.file), { force: true });
    writeFileAtomic(path.join(this.installedDir, file), content, 0o600);
    s.installed[id] = { name, file, description: meta.description, authors: meta.authors, url: meta.url, itemNames: meta.itemNames, installedAt: Date.now() };
    this.save(s);
    return { id, name, origin: "installed", description: meta.description, authors: meta.authors, url: meta.url, items: items.length, enabled: !s.disabled.includes(id) };
  }

  remove(id: string) {
    const s = this.state();
    const m = s.installed[id];
    if (!m) throw new LibraryError("Only installed libraries can be removed");
    fs.rmSync(path.join(this.installedDir, m.file), { force: true });
    delete s.installed[id];
    delete s.names[id];
    s.disabled = s.disabled.filter((d) => d !== id);
    this.save(s);
  }

  installedUrls(): Set<string> {
    return new Set(Object.values(this.state().installed).flatMap((m) => (m.url ? [m.url] : [])));
  }
}

/** Ranks shapes for a query: name words first, then library name, then what's drawn inside. */
/** Words diagrams use for the same thing, so "user" also finds stick figures and "db" databases. */
const SYNONYMS: string[][] = [
  ["user", "person", "people", "human", "customer", "client", "actor", "man", "woman", "guy", "girl", "figure", "stick", "users"],
  ["database", "db", "sql", "postgres", "mysql", "storage", "datastore", "store"],
  ["server", "host", "machine", "vm", "instance", "node", "compute"],
  ["queue", "bus", "topic", "kafka", "stream", "broker", "pubsub", "message", "messaging", "q"],
  ["cache", "redis", "memcached"],
  ["browser", "web", "website", "frontend", "page"],
  ["mobile", "phone", "app", "device", "ios", "android"],
  ["service", "microservice", "api", "backend"],
  ["note", "sticky", "postit", "memo"],
  ["bubble", "speech", "thought", "comment", "callout"],
  ["decision", "condition", "if", "branch", "choice"],
  ["cloud", "internet"],
  ["file", "document", "documents", "doc", "docs"],
  ["load", "balancer", "lb", "proxy", "gateway"],
];
const SYN = new Map<string, Set<string>>();
for (const group of SYNONYMS) for (const w of group) SYN.set(w, new Set([...(SYN.get(w) ?? []), ...group.filter((x) => x !== w)]));

export function searchShapes(shapes: LibraryShape[], query: string): LibraryShape[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return shapes;
  const scored: { s: LibraryShape; score: number }[] = [];
  for (const s of shapes) {
    const name = s.name.toLowerCase();
    const nameWords = name.split(/[^a-z0-9]+/);
    const lib = s.libraryName.toLowerCase();
    const desc = s.description.toLowerCase();
    let score = 0;
    for (const w of words) {
      const alt = [...(SYN.get(w) ?? [])];
      if (name === w || nameWords.includes(w)) score += 5;
      else if (name.includes(w)) score += 3;
      else if (alt.some((a) => nameWords.includes(a))) score += 2;
      else if (lib.includes(w) || alt.some((a) => lib.split(/[^a-z0-9]+/).includes(a))) score += 1;
      else if (desc.includes(w)) score += 1;
      else {
        score = -1;
        break;
      }
    }
    if (score > 0) scored.push({ s, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length).map((x) => x.s);
}

/** Finds a shape by key or name (exact, then the best unambiguous search match). */
export function findShape(shapes: LibraryShape[], query: string): LibraryShape {
  const q = query.trim().toLowerCase();
  const exact =
    shapes.find((s) => s.key === q) ??
    shapes.find((s) => s.name.toLowerCase() === q) ??
    shapes.find((s) => s.key.endsWith(`/${slug(q)}`));
  if (exact) return exact;
  if (!shapes.length) {
    throw new LibraryError("No library shapes are available. The user can add libraries in the assistant's Shapes view, or put an .excalidrawlib file in the project.");
  }
  const hits = searchShapes(shapes, q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new LibraryError(`"${query}" matches several shapes: ${hits.slice(0, 12).map((s) => s.key).join(", ")}`);
  throw new LibraryError(`No library shape "${query}". Call list_shapes to search.`);
}

/** Scale that fits a shape into a box, or makes its longest side `DEFAULT_SHAPE_SIZE` for diagrams. */
export function shapeScale(shape: LibraryShape, opts: { width?: number; height?: number; normalize?: boolean }): number {
  const { width: w, height: h } = shape;
  if (opts.width && opts.height) return Math.min(opts.width / (w || 1), opts.height / (h || 1));
  if (opts.width) return opts.width / (w || 1);
  if (opts.height) return opts.height / (h || 1);
  if (opts.normalize) return DEFAULT_SHAPE_SIZE / Math.max(w, h, 1);
  return 1;
}

export function labelSize(label: string): { width: number; height: number } {
  const t = textElement(label, { fontSize: LABEL_FONT });
  return { width: t.width, height: t.height + LABEL_GAP };
}

export interface Placed {
  elements: El[];
  /** The element arrows bind to: the shape itself, or an invisible box around a multi-part shape. */
  anchorId: string;
  ids: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Copies a shape into a drawing at (x, y): fresh ids (with bindings, containers and groups
 * remapped), optionally scaled, all grouped so it moves as one, with an optional label below.
 */
export function placeShape(
  shape: LibraryShape,
  opts: { x: number; y: number; scale?: number; label?: string; anchorId?: string },
): Placed {
  const s = opts.scale ?? 1;
  const b = bounds(shape.elements)!;
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  const parts = shape.elements.filter((e) => e.type !== "text");
  // An item that is one closed shape is its own arrow target. Anything with several parts gets an
  // invisible box around the whole drawing, so arrows stop at its edge rather than at one part.
  const single = parts.length === 1 && PRIMITIVE_SHAPES.has(parts[0].type) ? parts[0] : undefined;
  for (const e of shape.elements) ids.set(e.id, e === single && opts.anchorId ? opts.anchorId : newId());
  const outer = newId();
  const now = Date.now();
  const mapBinding = (bd: any) => (bd && ids.has(bd.elementId) ? { ...bd, elementId: ids.get(bd.elementId) } : null);

  const elements: El[] = shape.elements.map((e) => {
    const next: El = {
      ...structuredClone(e),
      id: ids.get(e.id)!,
      x: opts.x + (e.x - b.minX) * s,
      y: opts.y + (e.y - b.minY) * s,
      width: e.width * s,
      height: e.height * s,
      groupIds: [...(e.groupIds ?? []).map((g: string) => groups.get(g) ?? groups.set(g, newId()).get(g)!), outer],
      frameId: null,
      containerId: e.containerId && ids.has(e.containerId) ? ids.get(e.containerId) : null,
      boundElements: (e.boundElements ?? []).filter((r: { id: string }) => ids.has(r.id)).map((r: { id: string; type: string }) => ({ ...r, id: ids.get(r.id) })),
      startBinding: mapBinding(e.startBinding),
      endBinding: mapBinding(e.endBinding),
      version: 1,
      versionNonce: randInt(),
      seed: randInt(),
      updated: now,
      isDeleted: false,
      locked: false,
    };
    delete next.index;
    if (Array.isArray(e.points)) next.points = e.points.map((p: number[]) => [p[0] * s, p[1] * s]);
    if (typeof e.fontSize === "number") next.fontSize = e.fontSize * s;
    if (e.type !== "arrow" && e.type !== "line") {
      delete next.startBinding;
      delete next.endBinding;
    }
    if (!next.boundElements.length) next.boundElements = null;
    return next;
  });

  const width = (b.maxX - b.minX) * s;
  let height = (b.maxY - b.minY) * s;
  // The drawing itself, without captions: what arrows should point at.
  const art = bounds(shape.elements.filter((e) => e.type !== "text")) ?? b;
  const artBox = { x: opts.x + (art.minX - b.minX) * s, y: opts.y + (art.minY - b.minY) * s, w: (art.maxX - art.minX) * s, h: (art.maxY - art.minY) * s };
  let anchorId = single ? ids.get(single.id)! : undefined;
  if (!anchorId) {
    anchorId = opts.anchorId ?? newId();
    const box = addSkeletons([], [{ type: "rectangle", id: anchorId, x: artBox.x, y: artBox.y, width: artBox.w, height: artBox.h }]).elements[0];
    Object.assign(box, { strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0, groupIds: [outer] });
    elements.unshift(box);
  }
  if (opts.label) {
    // Icons often carry their own caption underneath ("User", "Amazon S3"): relabel it rather than adding a second one.
    const captions = elements.filter((e) => e.type === "text" && !e.containerId && e.y >= artBox.y + artBox.h - 2);
    if (captions.length === 1) {
      const c = captions[0];
      const m = textElement(opts.label, { fontSize: c.fontSize, fontFamily: c.fontFamily });
      Object.assign(c, { text: opts.label, originalText: opts.label, width: m.width, height: m.height, x: artBox.x + artBox.w / 2 - m.width / 2, textAlign: "center" });
    } else {
      const t = textElement(opts.label, { fontSize: LABEL_FONT, textAlign: "center", groupIds: [outer] });
      t.x = opts.x + width / 2 - t.width / 2;
      t.y = opts.y + height + LABEL_GAP;
      elements.push(t);
      height += LABEL_GAP + t.height;
    }
  }
  return {
    elements,
    anchorId,
    ids: elements.map((e) => e.id),
    bounds: { x: opts.x, y: opts.y, width, height },
  };
}
