/**
 * Library shapes: reusable groups of elements from the user's Excalidraw library and from
 * `.excalidrawlib` files in the project (e.g. an AWS or Kubernetes icon set kept next to the
 * diagrams). Excalidraw has a fixed set of element types; a library "shape" is a named group
 * of them, so placing one means copying its elements with fresh ids into the drawing.
 */
import fs from "node:fs";
import path from "node:path";
import { addSkeletons, bounds, type El, live, newId, randInt, textElement } from "./scene.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", ".venv", "venv", "__pycache__", "vendor", "Pods"]);
const MAX_LIB_BYTES = 20 * 1024 * 1024;
const MAX_LIB_FILES = 50;
const LABEL_FONT = 16;
const LABEL_GAP = 8;
/** Library items are drawn at all sizes; diagrams scale them so the longest side is this. */
export const DEFAULT_SHAPE_SIZE = 96;

export const PRIMITIVE_SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

export interface LibraryShape {
  /** Stable handle for tools: a slug of the name, unique across sources. */
  key: string;
  name: string;
  /** "personal library" or the .excalidrawlib path relative to the project. */
  source: string;
  elements: El[];
  width: number;
  height: number;
  /** What's inside, for items without a meaningful name. */
  description: string;
}

export class LibraryError extends Error {}

interface RawItem {
  name?: string;
  elements: El[];
}

/** Reads a library file: v2 `libraryItems` (named) or v1 `library` (arrays of elements). */
export function parseLibrary(raw: string): RawItem[] {
  const data = JSON.parse(raw);
  if (Array.isArray(data?.libraryItems)) {
    return data.libraryItems
      .filter((it: any) => it && Array.isArray(it.elements))
      .map((it: any) => ({ name: typeof it.name === "string" ? it.name : undefined, elements: it.elements }));
  }
  if (Array.isArray(data?.library)) return data.library.filter(Array.isArray).map((elements: El[]) => ({ elements }));
  throw new LibraryError("Not an Excalidraw library");
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

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "shape";

function describeItem(els: El[]): string {
  const counts = new Map<string, number>();
  for (const e of els) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => (n > 1 ? `${n} ${t}s` : t));
  const text = els
    .filter((e) => e.type === "text" && e.text)
    .map((e) => JSON.stringify(String(e.text).slice(0, 40)))
    .slice(0, 3);
  return parts.join(", ") + (text.length ? `; text ${text.join(", ")}` : "");
}

/** All shapes available for a project: the personal library first, then project libraries. */
export function loadShapes(personalLibrary: string, projectRoot?: string): LibraryShape[] {
  const sources: { source: string; items: RawItem[] }[] = [];
  try {
    sources.push({ source: "personal library", items: parseLibrary(fs.readFileSync(personalLibrary, "utf8")) });
  } catch {
    // no personal library yet
  }
  if (projectRoot) {
    for (const file of findLibraryFiles(projectRoot)) {
      try {
        if (fs.statSync(file).size > MAX_LIB_BYTES) continue;
        sources.push({ source: path.relative(projectRoot, file), items: parseLibrary(fs.readFileSync(file, "utf8")) });
      } catch {
        // unreadable or not a library: skip it
      }
    }
  }
  const shapes: LibraryShape[] = [];
  const keys = new Set<string>();
  for (const { source, items } of sources) {
    const fileStem = source === "personal library" ? "item" : slug(path.basename(source, ".excalidrawlib"));
    items.forEach((it, i) => {
      const els = live(it.elements);
      const b = bounds(els);
      if (!b) return;
      const name = it.name?.trim() || `${fileStem} ${i + 1}`;
      let key = slug(name);
      for (let n = 2; keys.has(key); n++) key = `${slug(name)}-${n}`;
      keys.add(key);
      shapes.push({
        key,
        name,
        source,
        elements: els,
        width: Math.round(b.maxX - b.minX),
        height: Math.round(b.maxY - b.minY),
        description: describeItem(els),
      });
    });
  }
  return shapes;
}

/** Finds a shape by key or name (exact, then a unique partial match). */
export function findShape(shapes: LibraryShape[], query: string): LibraryShape {
  const q = query.trim().toLowerCase();
  const exact = shapes.find((s) => s.key === q || s.name.toLowerCase() === q) ?? shapes.find((s) => s.key === slug(q));
  if (exact) return exact;
  const partial = shapes.filter((s) => s.key.includes(slug(q)) || s.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (!shapes.length) throw new LibraryError("The library is empty. Add items in the editor's Library panel, or put an .excalidrawlib file in the project.");
  const hint = (partial.length ? partial : shapes).slice(0, 12).map((s) => s.key).join(", ");
  throw new LibraryError(
    partial.length ? `"${query}" matches several shapes: ${hint}` : `No library shape "${query}". Call list_shapes; some keys: ${hint}`,
  );
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
  const parts = shape.elements.filter((e) => e.type !== "text" && e.type !== "arrow" && e.type !== "line");
  // A single-shape item is its own arrow target. Anything with several parts gets an invisible
  // box around the whole icon, so arrows stop at its edge instead of at whichever part is biggest.
  const single = parts.length === 1 ? parts[0] : undefined;
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
  let anchorId = single ? ids.get(single.id)! : undefined;
  if (!anchorId) {
    anchorId = opts.anchorId ?? newId();
    const box = addSkeletons([], [{ type: "rectangle", id: anchorId, x: opts.x, y: opts.y, width, height }]).elements[0];
    Object.assign(box, { strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0, groupIds: [outer] });
    elements.unshift(box);
  }
  if (opts.label) {
    const t = textElement(opts.label, { fontSize: LABEL_FONT, textAlign: "center", groupIds: [outer] });
    t.x = opts.x + width / 2 - t.width / 2;
    t.y = opts.y + height + LABEL_GAP;
    elements.push(t);
    height += LABEL_GAP + t.height;
  }
  return {
    elements,
    anchorId,
    ids: elements.map((e) => e.id),
    bounds: { x: opts.x, y: opts.y, width, height },
  };
}
