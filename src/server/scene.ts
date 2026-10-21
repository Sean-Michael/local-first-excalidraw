/**
 * Pure scene logic shared by the daemon and the MCP server. No I/O here.
 *
 * Elements are plain Excalidraw JSON. Concurrency is handled the same way Excalidraw's
 * own collaboration does it: every element carries a `version` (bumped on each change)
 * and a random `versionNonce`; when two copies disagree the higher version wins, and
 * deletions are `isDeleted: true` tombstones rather than removals.
 */
import crypto from "node:crypto";
import { codeRefOf, formatCodeLink } from "./codelinks.js";

// Excalidraw elements are open-ended JSON; we only rely on a handful of fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type El = Record<string, any> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
};

export interface Scene {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: El[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export const SOURCE = "local-first-excalidraw";

export function emptyScene(): Scene {
  return {
    type: "excalidraw",
    version: 2,
    source: SOURCE,
    elements: [],
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: {},
  };
}

export function parseScene(raw: string): Scene {
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || !Array.isArray(data.elements)) {
    throw new Error("Not an Excalidraw scene (missing elements array)");
  }
  return {
    type: "excalidraw",
    version: 2,
    source: typeof data.source === "string" ? data.source : SOURCE,
    elements: data.elements.filter(
      (e: unknown): e is El =>
        !!e && typeof e === "object" && typeof (e as El).id === "string" && typeof (e as El).type === "string",
    ),
    appState: data.appState && typeof data.appState === "object" ? data.appState : {},
    files: data.files && typeof data.files === "object" ? data.files : {},
  };
}

/** Serialised form on disk: deleted elements dropped, stable 2-space JSON for clean git diffs. */
export function serializeScene(scene: Scene): string {
  return (
    JSON.stringify(
      { ...scene, source: SOURCE, elements: scene.elements.filter((e) => !e.isDeleted) },
      null,
      2,
    ) + "\n"
  );
}

export const live = (els: El[]) => els.filter((e) => !e.isDeleted);

// ---------------------------------------------------------------------------
// Versioning and merge
// ---------------------------------------------------------------------------

export const randInt = () => crypto.randomInt(1, 2 ** 31 - 1);
export const newId = () => crypto.randomBytes(9).toString("base64url");

export function bump(el: El, patch: Partial<El> = {}): El {
  return {
    ...el,
    ...patch,
    version: (el.version ?? 1) + 1,
    versionNonce: randInt(),
    updated: Date.now(),
  };
}

/** True when `incoming` should replace `current` (mirrors Excalidraw's reconcile rule). */
export function wins(incoming: El, current: El | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce <= current.versionNonce;
}

/**
 * Union of two element lists by id where the newer version wins. Order follows the
 * fractional `index` when present; elements without one keep their relative order at the end.
 */
export function mergeElements(base: El[], incoming: El[]): El[] {
  const byId = new Map<string, El>();
  const order: string[] = [];
  for (const e of base) {
    if (!byId.has(e.id)) order.push(e.id);
    byId.set(e.id, e);
  }
  for (const e of incoming) {
    if (!byId.has(e.id)) order.push(e.id);
    if (wins(e, byId.get(e.id))) byId.set(e.id, e);
  }
  const merged = order.map((id) => byId.get(id)!);
  const indexed = merged.filter((e) => typeof e.index === "string");
  const unindexed = merged.filter((e) => typeof e.index !== "string");
  indexed.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  return [...indexed, ...unindexed];
}

/** Elements present in `before` but absent from `after` become tombstones. */
export function tombstonesFor(before: El[], after: El[]): El[] {
  const ids = new Set(after.map((e) => e.id));
  return before.filter((e) => !e.isDeleted && !ids.has(e.id)).map((e) => bump(e, { isDeleted: true }));
}

// ---------------------------------------------------------------------------
// Colours, fonts, text metrics
// ---------------------------------------------------------------------------

export const PALETTE: Record<string, { stroke: string; fill: string }> = {
  gray: { stroke: "#495057", fill: "#e9ecef" },
  black: { stroke: "#1e1e1e", fill: "#ced4da" },
  blue: { stroke: "#1971c2", fill: "#a5d8ff" },
  cyan: { stroke: "#0c8599", fill: "#99e9f2" },
  teal: { stroke: "#099268", fill: "#96f2d7" },
  green: { stroke: "#2f9e44", fill: "#b2f2bb" },
  yellow: { stroke: "#f08c00", fill: "#ffec99" },
  orange: { stroke: "#e8590c", fill: "#ffd8a8" },
  red: { stroke: "#e03131", fill: "#ffc9c9" },
  pink: { stroke: "#c2255c", fill: "#fcc2d7" },
  violet: { stroke: "#6741d9", fill: "#d0bfff" },
  purple: { stroke: "#6741d9", fill: "#d0bfff" },
};

const FONT_FAMILIES: Record<string, number> = {
  hand: 5, // Excalifont
  excalifont: 5,
  virgil: 1,
  normal: 6, // Nunito
  nunito: 6,
  helvetica: 2,
  code: 8, // Comic Shanns
  mono: 8,
};

export function fontFamily(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return FONT_FAMILIES[v.toLowerCase()] ?? 5;
  return 5;
}

export const LINE_HEIGHT = 1.25;

/**
 * Rough text metrics. An open editor recomputes exact metrics with real fonts and saves them
 * with the agent's edit (or, for a drawing it loads, with the user's next edit, never on
 * open), so this only needs to be close enough for layout.
 */
export function measureText(text: string, fontSize: number, family = 5): { width: number; height: number } {
  const mono = family === 3 || family === 8;
  const lines = text.split("\n");
  let max = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) {
      if (mono) w += 0.6;
      else if ("il.,:;'|!`".includes(ch)) w += 0.3;
      else if ("mwMW@".includes(ch)) w += 0.88;
      else if (ch >= "A" && ch <= "Z") w += 0.66;
      else if (ch === " ") w += 0.32;
      else if (ch.charCodeAt(0) > 0x2e80) w += 1.0; // CJK
      else w += 0.56;
    }
    max = Math.max(max, w);
  }
  return { width: Math.ceil(max * fontSize), height: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}

// ---------------------------------------------------------------------------
// Element construction
// ---------------------------------------------------------------------------

function base(type: string, extra: Partial<El> = {}): El {
  return {
    id: newId(),
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randInt(),
    version: 1,
    versionNonce: randInt(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...extra,
  };
}

export function textElement(text: string, opts: Partial<El> = {}): El {
  const fontSize = opts.fontSize ?? 20;
  const family = fontFamily(opts.fontFamily);
  const m = measureText(text, fontSize, family);
  return base("text", {
    width: m.width,
    height: m.height,
    text,
    originalText: text,
    fontSize,
    fontFamily: family,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
    ...opts,
    ...(opts.fontFamily !== undefined ? { fontFamily: family } : {}),
  });
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const LINEAR = new Set(["arrow", "line"]);

export interface LabelSpec {
  text: string;
  fontSize?: number;
  fontFamily?: string | number;
  strokeColor?: string;
}

export interface SkeletonEl {
  type: string;
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  label?: string | LabelSpec;
  color?: string;
  start?: { id: string };
  end?: { id: string };
  points?: [number, number][];
  rounded?: boolean;
  children?: string[];
  name?: string;
  [k: string]: unknown;
}

function addBound(container: El, ref: { id: string; type: "text" | "arrow" }): El {
  const existing = (container.boundElements ?? []) as { id: string; type: string }[];
  if (existing.some((b) => b.id === ref.id)) return container;
  return { ...container, boundElements: [...existing, ref] };
}

/**
 * Places a container's bound text at its centre. With `keepSize` (the text didn't change, only
 * its container moved or resized) a size measured earlier with real fonts, by the editor or the
 * Mermaid converter, is kept rather than replaced by the rough estimate.
 */
export function centerLabel(container: El, text: El, opts: { keepSize?: boolean } = {}): El {
  const est = measureText(text.text, text.fontSize, text.fontFamily);
  const m = opts.keepSize && text.width > 0 && text.height > 0 ? { width: text.width, height: text.height } : est;
  const width = Math.min(m.width, Math.max(20, container.width - 20));
  if (LINEAR.has(container.type)) {
    const [mx, my] = linearMidpoint(container);
    return { ...text, width, height: m.height, x: mx - width / 2, y: my - m.height / 2 };
  }
  return {
    ...text,
    width,
    height: m.height,
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - m.height) / 2,
  };
}

function linearMidpoint(el: El): [number, number] {
  const pts = (el.points as [number, number][]) ?? [[0, 0]];
  if (pts.length % 2 === 1) {
    const p = pts[(pts.length - 1) / 2];
    return [el.x + p[0], el.y + p[1]];
  }
  const a = pts[pts.length / 2 - 1];
  const b = pts[pts.length / 2];
  return [el.x + (a[0] + b[0]) / 2, el.y + (a[1] + b[1]) / 2];
}

function labelSpec(label: string | LabelSpec): LabelSpec {
  return typeof label === "string" ? { text: label } : label;
}

export function makeLabel(container: El, label: string | LabelSpec): El {
  const spec = labelSpec(label);
  const fontSize = spec.fontSize ?? (LINEAR.has(container.type) ? 16 : 20);
  const t = textElement(spec.text, {
    fontSize,
    fontFamily: spec.fontFamily ?? 5,
    strokeColor: spec.strokeColor ?? container.strokeColor ?? "#1e1e1e",
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    groupIds: container.groupIds ?? [],
    frameId: container.frameId ?? null,
  });
  return centerLabel(container, t);
}

/** Point on a shape's outline in the direction (dx, dy) from its centre. */
function boundaryPoint(el: El, dx: number, dy: number, gap: number): [number, number] {
  const hw = el.width / 2;
  const hh = el.height / 2;
  const cx = el.x + hw;
  const cy = el.y + hh;
  // No direction (coincident centres): leave from the right-hand side.
  const len = Math.hypot(dx, dy);
  const ux = len ? dx / len : 1;
  const uy = len ? dy / len : 0;
  let t: number;
  if (el.type === "ellipse") t = 1 / Math.sqrt((ux / hw) ** 2 + (uy / hh) ** 2);
  else if (el.type === "diamond") t = 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh);
  else t = Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity);
  if (!Number.isFinite(t)) t = 0; // zero-sized shape
  return [cx + ux * (t + gap), cy + uy * (t + gap)];
}

const GAP = 6;
const LOOP = 30;

/** Points (relative to the first) and box of a polyline given in absolute coordinates. */
function polyline(arrow: El, abs: [number, number][]): El {
  const [x0, y0] = abs[0];
  const points = abs.map(([x, y]) => [x - x0, y - y0] as [number, number]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    ...arrow,
    x: x0,
    y: y0,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
  };
}

/** A small loop off a shape's top-right, for an arrow that starts and ends on the same shape. */
function selfLoop(arrow: El, el: El): El {
  const start = boundaryPoint(el, el.width / 4, -el.height / 2, GAP);
  const end = boundaryPoint(el, el.width / 2, -el.height / 4, GAP);
  const binding = { elementId: el.id, focus: 0, gap: GAP };
  return {
    ...polyline(arrow, [start, [start[0] + LOOP * 0.4, start[1] - LOOP], [end[0] + LOOP, end[1] - LOOP * 0.4], end]),
    startBinding: binding,
    endBinding: binding,
  };
}

/**
 * Recomputes an arrow between two bound shapes: its ends sit on the outlines, aimed at the
 * other shape (or at the nearest waypoint, which is kept). An arrow from a shape to itself
 * becomes a small loop.
 */
export function routeArrow(arrow: El, from: El | undefined, to: El | undefined): El {
  if (from && to && from.id === to.id) return selfLoop(arrow, from);
  const pts = (arrow.points as [number, number][])?.length >= 2 ? (arrow.points as [number, number][]) : [[0, 0], [100, 0]];
  const abs = pts.map(([px, py]) => [arrow.x + px, arrow.y + py] as [number, number]);
  const inner = abs.slice(1, -1);
  let start = abs[0];
  let end = abs[abs.length - 1];
  const center = (e: El): [number, number] => [e.x + e.width / 2, e.y + e.height / 2];
  const aim0 = inner[0] ?? (to ? center(to) : end);
  const aim1 = inner[inner.length - 1] ?? (from ? center(from) : start);
  // A waypoint square across from a rectangle's side is a port: leave straight towards it.
  const port = (e: El, aim: [number, number]): [number, number] | undefined => {
    if (e.type !== "rectangle" || !inner.length) return;
    const [x0, y0, x1, y1] = [e.x, e.y, e.x + e.width, e.y + e.height];
    const inX = aim[0] > x0 + 8 && aim[0] < x1 - 8;
    const inY = aim[1] > y0 + 8 && aim[1] < y1 - 8;
    if (inX && !inY) return [aim[0], aim[1] < y0 ? y0 - GAP : y1 + GAP];
    if (inY && !inX) return [aim[0] < x0 ? x0 - GAP : x1 + GAP, aim[1]];
  };
  if (from) start = port(from, aim0) ?? boundaryPoint(from, aim0[0] - center(from)[0], aim0[1] - center(from)[1], GAP);
  if (to) end = port(to, aim1) ?? boundaryPoint(to, aim1[0] - center(to)[0], aim1[1] - center(to)[1], GAP);
  return {
    ...polyline(arrow, [start, ...inner, end]),
    startBinding: from ? { elementId: from.id, focus: 0, gap: GAP } : (arrow.startBinding ?? null),
    endBinding: to ? { elementId: to.id, focus: 0, gap: GAP } : (arrow.endBinding ?? null),
  };
}

const END_FONT = 16;

/**
 * Free text beside one end of a routed arrow (a UML multiplicity or role, an ER cardinality),
 * clear of the line, its arrowhead and the shape. Excalidraw binds only one label to an arrow,
 * so the text joins the shape's group instead: it moves with the shape, though it stays on
 * the side it was drawn on if the arrow later meets the shape elsewhere.
 */
function arrowEndLabel(arrow: El, end: "start" | "end", text: string, shape: El): El {
  const pts = arrow.points as [number, number][];
  const [p, q, r] = end === "start" ? pts.slice(0, 3) : pts.slice(-3).reverse();
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  const u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
  const m = measureText(text, END_FONT);
  const reach = (d: number[]) => Math.abs(d[0]) * (m.width / 2) + Math.abs(d[1]) * (m.height / 2);
  const along = reach(u) + 4;
  // Above a mostly horizontal arrow and right of a mostly vertical one, so labels at
  // neighbouring ends line up; where the first stretch is too short for that, on the side
  // the arrow doesn't bend towards.
  let n = [-u[1], u[0]];
  const bend = r && len < along + reach(u) + 4 ? (r[0] - q[0]) * n[0] + (r[1] - q[1]) * n[1] : 0;
  if (Math.abs(bend) > 1 ? bend > 0 : Math.abs(u[0]) >= Math.abs(u[1]) ? n[1] > 0 : n[0] < 0) n = [-n[0], -n[1]];
  const aside = reach(n) + 10; // past an arrowhead's barbs or a crow's foot
  const cx = arrow.x + p[0] + u[0] * along + n[0] * aside;
  const cy = arrow.y + p[1] + u[1] * along + n[1] * aside;
  return textElement(text, {
    id: `${arrow.id}:${end}`,
    x: Math.round(cx - m.width / 2),
    y: Math.round(cy - m.height / 2),
    fontSize: END_FONT,
    groupIds: [...(shape.groupIds ?? [])],
    frameId: shape.frameId ?? null,
    customData: { arrowEnd: { arrowId: arrow.id, end } },
  });
}

/** Smallest comfortable size of a shape whose label measures `m`. */
export function fitSize(type: string, m: { width: number; height: number }): { width: number; height: number } {
  if (type === "diamond") return { width: Math.max(170, m.width * 2 + 50), height: Math.max(100, m.height * 2 + 40) };
  if (type === "ellipse") return { width: Math.max(160, m.width * 1.45 + 50), height: Math.max(80, m.height * 1.45 + 36) };
  return { width: Math.max(120, m.width + 40), height: Math.max(60, m.height + 30) };
}

function styleFrom(s: SkeletonEl): Partial<El> {
  const out: Partial<El> = {};
  if (s.color && PALETTE[s.color]) {
    out.strokeColor = PALETTE[s.color].stroke;
    if (SHAPES.has(s.type)) out.backgroundColor = PALETTE[s.color].fill;
  }
  if (s.rounded === true) out.roundness = { type: 3 };
  return out;
}

const SKELETON_ONLY = new Set(["label", "color", "start", "end", "rounded", "children", "code", "startLabel", "endLabel"]);

function passthrough(s: SkeletonEl): Partial<El> {
  const out: Partial<El> = {};
  for (const [k, v] of Object.entries(s)) if (!SKELETON_ONLY.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** A problem with the caller's input (reported as a 4xx, not a server error). */
export class SceneError extends Error {}

/** Every element type Excalidraw knows; anything else would be saved but never drawn. */
export const ELEMENT_TYPES = new Set([
  "rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "image", "frame", "magicframe", "embeddable", "iframe",
]);

// Words models reach for instead of the real type names.
const TYPE_GUESSES: Record<string, string> = {
  box: "rectangle", rect: "rectangle", square: "rectangle", node: "rectangle", card: "rectangle",
  circle: "ellipse", oval: "ellipse", rhombus: "diamond", decision: "diamond",
  label: "text", note: "text", connector: "arrow", edge: "arrow", link: "arrow", group: "frame", container: "frame",
};

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

/** The candidate nearest to `word` by edit distance, if it's within `max` edits. */
export function closest(word: string, candidates: Iterable<string>, max = 3): string | undefined {
  let best: string | undefined;
  let bestD = max + 1;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}

/** Members of a group, for ids that name a group rather than an element. */
function groupMembers(all: Map<string, El>, groupId: string): El[] {
  return [...all.values()].filter((e) => !e.isDeleted && e.groupIds?.includes(groupId));
}

/** "Element not found", saying when the id is a group's and suggesting a near id otherwise. */
function notFound(all: Map<string, El>, id: string): SceneError {
  const members = groupMembers(all, id);
  if (members.length) {
    const ids = members.filter((e) => !e.containerId).map((e) => e.id);
    return new SceneError(
      `"${id}" is a group id, not an element id. Its members are ${ids.join(", ")}: update them by id (delete_elements accepts the group id).`,
    );
  }
  const near = closest(id, [...all.values()].filter((e) => !e.isDeleted).map((e) => e.id), 2);
  return new SceneError(`Element "${id}" not found${near ? `; did you mean "${near}"?` : ""}`);
}

/** Throws a SceneError naming the closest known type when `type` isn't one. */
export function checkType(type: string): void {
  if (ELEMENT_TYPES.has(type)) return;
  const t = type.toLowerCase();
  let best = TYPE_GUESSES[t] ?? (ELEMENT_TYPES.has(t) ? t : undefined);
  if (!best) {
    const [d, name] = [...ELEMENT_TYPES].map((k) => [editDistance(t, k), k] as const).sort((x, y) => x[0] - y[0])[0];
    if (d <= 3) best = name;
  }
  throw new SceneError(
    `Unknown element type "${type}"${best ? `; did you mean "${best}"?` : "."} Known types: ${[...ELEMENT_TYPES].join(", ")}.`,
  );
}

const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Throws a SceneError if a live element has a non-finite position, size or point. */
export function assertFinite(els: El[]): void {
  for (const e of els) {
    if (e.isDeleted) continue;
    const bad =
      !finite(e.x) ||
      !finite(e.y) ||
      (e.width !== undefined && !finite(e.width)) ||
      (e.height !== undefined && !finite(e.height)) ||
      (Array.isArray(e.points) && e.points.some((p: unknown) => !Array.isArray(p) || !finite(p[0]) || !finite(p[1])));
    if (bad) throw new SceneError(`Element "${e.id}" (${e.type}) has a coordinate that is not a finite number`);
  }
}

/**
 * Converts simplified element specs into complete Excalidraw elements and merges them
 * into `existing`. Supports labels on shapes and arrows, arrows bound to shapes by id,
 * and frames that adopt children. Returns the full new element list plus created ids.
 */
export function addSkeletons(existing: El[], skeletons: SkeletonEl[]): { elements: El[]; created: string[] } {
  const all = new Map<string, El>(existing.map((e) => [e.id, e]));
  const order = existing.map((e) => e.id);
  const created: string[] = [];
  const put = (e: El, isNew: boolean) => {
    const prev = all.get(e.id);
    if (!prev) order.push(e.id);
    // Re-using the id of a deleted element: outrank its tombstone or the merge would keep it deleted.
    else if (prev.isDeleted && e.version <= prev.version) e = { ...e, version: prev.version + 1 };
    all.set(e.id, e);
    if (isNew) created.push(e.id);
  };

  const pendingArrows: { el: El; s: SkeletonEl }[] = [];
  const pendingFrames: { el: El; s: SkeletonEl }[] = [];
  const endLabels = new Map<string, string[]>(); // shape id -> arrow end labels made beside it

  for (const s of skeletons) {
    if (!s || typeof s.type !== "string") throw new SceneError("Each element needs a type");
    // A fully built element (e.g. part of a library shape): taken as-is.
    if (s.type === "placed" && s.element) {
      put(s.element as El, true);
      continue;
    }
    if (s.id && all.has(s.id) && !all.get(s.id)!.isDeleted) {
      throw new SceneError(`Element id "${s.id}" already exists; use update_elements to change it`);
    }
    const id = s.id ?? newId();
    if (SHAPES.has(s.type)) {
      let el = base(s.type, { ...styleFrom(s), ...passthrough(s), id });
      if (s.label !== undefined && s.width === undefined && s.height === undefined) {
        const m = measureText(labelSpec(s.label).text, labelSpec(s.label).fontSize ?? 20);
        Object.assign(el, fitSize(s.type, m));
      }
      if (s.label !== undefined) {
        const t = makeLabel(el, s.label);
        el = addBound(el, { id: t.id, type: "text" });
        put(el, true);
        put(t, false);
      } else put(el, true);
    } else if (s.type === "text") {
      const text = s.text ?? (typeof s.label === "string" ? s.label : "");
      put(textElement(text, { ...styleFrom(s), ...passthrough(s), id, text, originalText: text }), true);
    } else if (LINEAR.has(s.type)) {
      const el = base(s.type, {
        points: [
          [0, 0],
          [s.width ?? 100, s.height ?? 0],
        ],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: s.type === "arrow" ? "arrow" : null,
        elbowed: false,
        roundness: { type: 2 },
        ...styleFrom(s),
        ...passthrough(s),
        id,
      });
      pendingArrows.push({ el, s });
    } else if (s.type === "frame") {
      pendingFrames.push({ el: base("frame", { name: s.name ?? null, ...passthrough(s), id }), s });
    } else {
      // A full raw element of another type (freedraw, image, ...): accept as-is with defaults.
      checkType(s.type);
      put(base(s.type, { ...passthrough(s), id }), true);
    }
  }

  for (const { el: raw, s } of pendingArrows) {
    let el = raw;
    if (s.points?.length) {
      const pts = s.points;
      el.points = pts.map(([px, py]) => [px - pts[0][0], py - pts[0][1]]);
      el.x = (s.x ?? 0) + pts[0][0];
      el.y = (s.y ?? 0) + pts[0][1];
      const xs = el.points.map((p: number[]) => p[0]);
      const ys = el.points.map((p: number[]) => p[1]);
      el.width = Math.max(...xs) - Math.min(...xs);
      el.height = Math.max(...ys) - Math.min(...ys);
    }
    const from = s.start?.id ? all.get(s.start.id) : undefined;
    const to = s.end?.id ? all.get(s.end.id) : undefined;
    if (s.start?.id && !from) throw new SceneError(`Arrow start "${s.start.id}" not found`);
    if (s.end?.id && !to) throw new SceneError(`Arrow end "${s.end.id}" not found`);
    if (from || to) {
      el = routeArrow(el, from, to);
      if (from) all.set(from.id, addBound(all.get(from.id)!, { id: el.id, type: "arrow" }));
      if (to) all.set(to.id, addBound(all.get(to.id)!, { id: el.id, type: "arrow" }));
      for (const t of [from, to]) {
        if (t && existing.some((e) => e.id === t.id)) all.set(t.id, bump(all.get(t.id)!));
      }
    }
    if (s.label !== undefined) {
      const t = makeLabel(el, s.label);
      el = addBound(el, { id: t.id, type: "text" });
      put(el, true);
      put(t, false);
    } else put(el, true);
    for (const [end, text, ref] of [["start", s.startLabel, from], ["end", s.endLabel, to]] as const) {
      if (typeof text !== "string" || !text || !ref || from?.id === to?.id) continue;
      // Join the shape's group, or start one with it (and its label) if it has none.
      let shape = all.get(ref.id)!;
      if (!shape.groupIds?.length) {
        const wasExisting = existing.some((e) => e.id === shape.id);
        const grouped: Partial<El> = { groupIds: [`${shape.id}:ends`] };
        shape = wasExisting ? bump(shape, grouped) : { ...shape, ...grouped };
        all.set(shape.id, shape);
        for (const b of shape.boundElements ?? []) {
          const bt = all.get(b.id);
          if (bt && b.type === "text") all.set(bt.id, wasExisting ? bump(bt, grouped) : { ...bt, ...grouped });
        }
      }
      put(arrowEndLabel(el, end, text, shape), false);
      endLabels.set(shape.id, [...(endLabels.get(shape.id) ?? []), `${el.id}:${end}`]);
    }
  }

  for (const { el: raw, s } of pendingFrames) {
    let el = raw;
    const kids = (s.children ?? []).map((cid) => {
      const k = all.get(cid);
      if (!k) throw new SceneError(`Frame child "${cid}" not found`);
      return k;
    });
    if (kids.length && (s.width === undefined || s.height === undefined)) {
      const b = bounds(kids)!;
      const pad = 40;
      el = { ...el, x: b.minX - pad, y: b.minY - pad - 10, width: b.maxX - b.minX + pad * 2, height: b.maxY - b.minY + pad * 2 + 10 };
    }
    for (const k of kids) {
      const wasExisting = existing.some((e) => e.id === k.id);
      const next = { ...k, frameId: el.id };
      all.set(k.id, wasExisting ? bump(next) : next);
      // Labels, and arrow end labels beside it, follow their shape into the frame.
      for (const b of k.boundElements ?? []) {
        const bt = all.get(b.id);
        if (bt && b.type === "text") all.set(bt.id, { ...bt, frameId: el.id });
      }
      for (const tid of endLabels.get(k.id) ?? []) all.set(tid, { ...all.get(tid)!, frameId: el.id });
    }
    // Frames render beneath their children: put them first among new elements.
    const prev = all.get(el.id);
    if (prev) {
      order.splice(order.indexOf(el.id), 1);
      if (el.version <= prev.version) el = { ...el, version: prev.version + 1 };
    }
    order.splice(Math.min(existing.length, order.length), 0, el.id);
    all.set(el.id, el);
    created.push(el.id);
  }

  return { elements: order.map((id) => all.get(id)!), created };
}

/**
 * Labels of a new diagram's nodes that the drawing already shows, when most of them do: the sign
 * that a model drew the same diagram again instead of editing the one it made. Compares first
 * lines (skipping a «stereotype») without case, spaces or punctuation, so "Order Service" matches
 * "OrderService" and class compartments don't hide a match.
 */
export function repeatedLabels(existing: El[], labels: string[]): string[] {
  const first = (t: string) => t.split("\n").find((l) => l.trim() && !/^«.*»$/.test(l.trim()))?.trim().toLowerCase() ?? "";
  const key = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "");
  const wanted = new Map<string, string>();
  for (const l of labels) {
    const f = first(l);
    if (key(f) && !wanted.has(key(f))) wanted.set(key(f), f);
  }
  if (wanted.size < 2) return [];
  const have = new Set(live(existing).filter((e) => e.type === "text").flatMap((e) => String(e.text ?? "").split("\n").map((l) => key(l.trim().toLowerCase()))));
  const hits = [...wanted].filter(([k]) => have.has(k)).map(([, f]) => f);
  return hits.length / wanted.size >= 0.8 ? hits : [];
}

/** The note create_diagram and mermaid_to_drawing add when they drew a diagram that was already there. */
export function repeatedNote(labels: string[], prefix = "", replaceable = true): string {
  return (
    `The drawing already had nodes labelled ${labels.slice(0, 6).map((l) => `"${l}"`).join(", ")}${labels.length > 6 ? ", …" : ""}, so this added a second copy beside them${prefix ? ` (its ids start with "${prefix}")` : ""}. ` +
    "To change a diagram you drew, edit it in place (update_elements, apply_changes); delete_elements removes this copy." +
    (replaceable ? " Use replace: true only when the user asks to start over." : "")
  );
}

/**
 * Cuts gaps in sequence-diagram lifelines (long, ungrouped vertical lines) where a message label
 * or fragment guard crosses them, so the line doesn't run through the text. The first piece keeps
 * the line's id; the others get "<id>-2", "<id>-3", ….
 */
export function gapLifelines(elements: El[]): El[] {
  const PAD = 4;
  const texts = elements.filter((e) => e.type === "text" && !e.isDeleted);
  const ids = new Set(elements.map((e) => e.id));
  const out: El[] = [];
  for (const e of elements) {
    const pts = e.points as number[][] | undefined;
    const lifeline =
      e.type === "line" && !e.isDeleted && !e.groupIds?.length && pts?.length === 2 && pts[0][0] === 0 && pts[1][0] === 0 && pts[1][1] > 200;
    if (!lifeline) {
      out.push(e);
      continue;
    }
    const top = e.y as number;
    const bottom = top + pts![1][1];
    const cuts = texts
      .filter((t) => t.x - PAD <= e.x && e.x <= t.x + t.width + PAD && t.y + t.height > top && t.y < bottom)
      .map((t) => [Math.max(top, t.y - PAD), Math.min(bottom, t.y + t.height + PAD)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    if (!cuts.length) {
      out.push(e);
      continue;
    }
    const pieces: [number, number][] = [];
    let y = top;
    for (const [a, b] of cuts) {
      if (a > y + 2) pieces.push([y, a]);
      y = Math.max(y, b);
    }
    if (bottom > y + 2) pieces.push([y, bottom]);
    pieces.forEach(([a, b], n) => {
      let id = e.id;
      if (n) for (let k = n + 1; ids.has((id = `${e.id}-${k}`)); k++);
      ids.add(id);
      out.push({ ...e, id, y: a, height: b - a, points: [[0, 0], [0, b - a]], seed: n ? randInt() : e.seed, versionNonce: randInt() });
    });
  }
  return out;
}

export function bounds(els: El[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const ls = live(els);
  if (!ls.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const e of ls) {
    const x2 = e.x + (LINEAR.has(e.type) ? Math.max(0, ...(e.points ?? [[0, 0]]).map((p: number[]) => p[0])) : e.width);
    const y2 = e.y + (LINEAR.has(e.type) ? Math.max(0, ...(e.points ?? [[0, 0]]).map((p: number[]) => p[1])) : e.height);
    const x1 = e.x + (LINEAR.has(e.type) ? Math.min(0, ...(e.points ?? [[0, 0]]).map((p: number[]) => p[0])) : 0);
    const y1 = e.y + (LINEAR.has(e.type) ? Math.min(0, ...(e.points ?? [[0, 0]]).map((p: number[]) => p[1])) : 0);
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  }
  return { minX, minY, maxX, maxY };
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of a scene to render for a close-up. `ids` brings along each element's label,
 * the rest of its group, a frame's children, and arrows bound to any of those (with labels); `region` takes every
 * element whose bounds overlap it. Scene order is kept so stacking doesn't change.
 */
export function selectForRender(els: El[], o: { ids?: string[]; region?: Region }): { elements: El[]; missing: string[] } {
  const ls = live(els);
  const byId = new Map(ls.map((e) => [e.id, e]));
  const keep = new Set<string>();
  const missing: string[] = [];
  for (const id of o.ids ?? []) {
    const e = byId.get(id);
    if (!e) missing.push(id);
    // A selected label stands for its container.
    else keep.add(e.containerId && byId.has(e.containerId) ? e.containerId : id);
  }
  if (o.ids?.length) {
    // Whole groups (library shapes are groups), then frame children, then arrows touching any of it.
    const groups = new Set([...keep].map((id) => byId.get(id)!.groupIds?.at(-1)).filter(Boolean));
    for (const e of ls) if (groups.has(e.groupIds?.at(-1))) keep.add(e.id);
    const frames = new Set(keep);
    for (const e of ls) if (e.frameId && frames.has(e.frameId)) keep.add(e.id);
    const roots = new Set(keep);
    for (const e of ls) {
      if (LINEAR.has(e.type) && (roots.has(e.startBinding?.elementId) || roots.has(e.endBinding?.elementId))) keep.add(e.id);
    }
  }
  if (o.region) {
    const { x, y, width, height } = o.region;
    for (const e of ls) {
      const b = bounds([e]);
      if (b && b.maxX >= x && b.minX <= x + width && b.maxY >= y && b.minY <= y + height) keep.add(e.id);
    }
  }
  // Labels follow their containers (shapes and arrows alike).
  for (const e of ls) if (e.containerId && keep.has(e.containerId)) keep.add(e.id);
  return { elements: ls.filter((e) => keep.has(e.id)), missing };
}

// ---------------------------------------------------------------------------
// Updates and deletes
// ---------------------------------------------------------------------------

export interface ElementUpdate {
  id: string;
  label?: string | LabelSpec | null;
  text?: string;
  color?: string;
  [k: string]: unknown;
}

const IMMUTABLE = new Set(["id", "type", "version", "versionNonce", "isDeleted", "seed"]);

/** Properties an update may set: the simplified ones plus Excalidraw's own element fields. */
const UPDATABLE = new Set([
  "label", "text", "color", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle",
  "strokeWidth", "strokeStyle", "roughness", "opacity", "roundness", "fontSize", "fontFamily", "textAlign",
  "verticalAlign", "link", "locked", "groupIds", "frameId", "points", "startArrowhead", "endArrowhead", "name",
  "customData", "lineHeight", "autoResize", "elbowed", "startBinding", "endBinding", "boundElements", "containerId",
  "originalText", "index", "status", "fileId", "scale", "crop", "code",
]);
const ALIASES: Record<string, string> = {
  fill: "backgroundColor", fillColor: "backgroundColor", background: "backgroundColor", bgColor: "backgroundColor",
  stroke: "strokeColor", borderColor: "strokeColor", textColor: "strokeColor", fontColor: "strokeColor",
};

/**
 * Maps the property names models tend to guess (fill, fillColor, stroke, …) onto real ones and
 * reports anything that would otherwise be silently ignored, so the caller can correct itself.
 */
export function normalizeUpdates(updates: ElementUpdate[]): { updates: ElementUpdate[]; notes: string[] } {
  const notes: string[] = [];
  const out = updates.map((u) => {
    const next: ElementUpdate = { id: u.id };
    for (const [k, v] of Object.entries(u)) {
      if (k === "id") continue;
      const key = ALIASES[k] ?? k;
      if (key !== k) notes.push(`${u.id}: treated "${k}" as "${key}"`);
      if (key === "color" && typeof v === "string" && !PALETTE[v]) {
        if (/^#[0-9a-f]{3,8}$/i.test(v)) {
          next.strokeColor ??= v;
          notes.push(`${u.id}: "color" takes a palette name; set strokeColor to ${v} (use backgroundColor for the fill)`);
        } else notes.push(`${u.id}: unknown colour "${v}"; use one of ${Object.keys(PALETTE).join(", ")}`);
        continue;
      }
      if (!UPDATABLE.has(key)) {
        notes.push(`${u.id}: ignored unknown property "${k}"`);
        continue;
      }
      next[key] = v;
    }
    return next;
  });
  return { updates: out, notes };
}

/** Applies partial updates; keeps labels centred and bound arrows attached. */
export function updateElements(existing: El[], updates: ElementUpdate[]): El[] {
  const all = new Map(existing.map((e) => [e.id, e]));
  const extra: El[] = [];
  const moved = new Set<string>();
  const shifts: { el: El; dx: number; dy: number }[] = [];
  // Labels given new text this call: their size must be estimated again.
  const textChanged = new Set<string>();

  for (const u of updates) {
    const cur = all.get(u.id);
    if (!cur || cur.isDeleted) throw notFound(all, u.id);
    const patch: Partial<El> = {};
    for (const [k, v] of Object.entries(u)) {
      if (IMMUTABLE.has(k) || k === "label" || k === "color" || k === "code" || v === undefined) continue;
      patch[k] = v;
    }
    if (u.color && PALETTE[u.color]) {
      patch.strokeColor = PALETTE[u.color].stroke;
      if (SHAPES.has(cur.type)) patch.backgroundColor = PALETTE[u.color].fill;
    }
    // Shapes can swap type in place (keeping id, label and arrows); anything else can't.
    if (typeof u.type === "string" && u.type !== cur.type) {
      if (!SHAPES.has(cur.type) || !SHAPES.has(u.type)) {
        throw new SceneError(`Can't turn a ${cur.type} into a ${u.type}: only rectangle, ellipse and diamond can be swapped`);
      }
      patch.type = u.type;
      // Ellipses have no corners; keep rounded corners when swapping between the others.
      patch.roundness = u.type === "ellipse" ? null : (cur.roundness ?? (u.type === "diamond" ? { type: 2 } : null));
    }
    if (cur.type === "text" && typeof u.text === "string") {
      patch.originalText = u.text;
      if (!cur.containerId) Object.assign(patch, measureText(u.text, (patch.fontSize as number) ?? cur.fontSize, cur.fontFamily));
    }
    let next = bump(cur, patch);
    if (["x", "y", "width", "height", "type"].some((k) => k in patch)) moved.add(cur.id);
    if (typeof patch.x === "number" || typeof patch.y === "number") {
      shifts.push({ el: cur, dx: (patch.x ?? cur.x) - cur.x, dy: (patch.y ?? cur.y) - cur.y });
    }

    // A longer label grows its shape (around the same centre) unless the caller sized it explicitly.
    if (u.label && SHAPES.has(cur.type) && u.width === undefined && u.height === undefined) {
      const spec = labelSpec(u.label);
      const need = fitSize(cur.type, measureText(spec.text, spec.fontSize ?? 20));
      if (need.width > next.width || need.height > next.height) {
        const w = Math.max(next.width, need.width);
        const h = Math.max(next.height, need.height);
        next = { ...next, x: next.x - (w - next.width) / 2, y: next.y - (h - next.height) / 2, width: w, height: h };
        moved.add(cur.id);
      }
    }
    if (u.label !== undefined) {
      const boundText = (cur.boundElements ?? []).find((b: { type: string }) => b.type === "text");
      const old = boundText ? all.get(boundText.id) : undefined;
      if (u.label === null) {
        if (old) all.set(old.id, bump(old, { isDeleted: true }));
        next = { ...next, boundElements: (next.boundElements ?? []).filter((b: { id: string }) => b.id !== old?.id) };
      } else if (old && !old.isDeleted) {
        const spec = labelSpec(u.label);
        all.set(old.id, centerLabel(next, bump(old, { text: spec.text, originalText: spec.text, ...(spec.fontSize ? { fontSize: spec.fontSize } : {}) })));
        textChanged.add(old.id);
      } else {
        const t = makeLabel(next, u.label);
        next = addBound(next, { id: t.id, type: "text" });
        extra.push(t);
      }
    }
    // A label goes into (or out of) a frame with its container.
    if ("frameId" in patch) {
      for (const b of next.boundElements ?? []) {
        const t = all.get(b.id);
        if (t && b.type === "text" && !t.isDeleted && t.frameId !== patch.frameId) all.set(t.id, bump(t, { frameId: patch.frameId ?? null }));
      }
      for (const t of extra) if (t.containerId === cur.id) t.frameId = patch.frameId ?? null;
    }
    all.set(cur.id, next);
  }

  // A frame carries its children, and a grouped element (such as a library shape's anchor) its
  // whole group, by the same offset. Elements the caller positioned themselves stay put.
  const placed = new Set(updates.map((u) => u.id));
  for (const { el, dx, dy } of shifts) {
    if (!dx && !dy) continue;
    const group = el.groupIds?.at(-1);
    const frame = el.type === "frame" || el.type === "magicframe" ? el.id : undefined;
    for (const e of all.values()) {
      if (e.isDeleted || placed.has(e.id)) continue;
      if ((frame && e.frameId === frame) || (group && e.groupIds?.at(-1) === group)) {
        all.set(e.id, bump(e, { x: e.x + dx, y: e.y + dy }));
        placed.add(e.id);
        moved.add(e.id);
      }
    }
  }

  // Re-centre labels and re-route arrows touching anything that moved.
  for (const id of moved) {
    const el = all.get(id)!;
    for (const b of el.boundElements ?? []) {
      const t = all.get(b.id);
      if (!t || t.isDeleted) continue;
      if (b.type === "text") all.set(t.id, centerLabel(el, bump(t), { keepSize: !textChanged.has(t.id) }));
    }
  }
  for (const e of all.values()) {
    if (!LINEAR.has(e.type) || e.isDeleted) continue;
    const s = e.startBinding?.elementId;
    const t = e.endBinding?.elementId;
    if ((s && moved.has(s)) || (t && moved.has(t))) {
      const routed = bump(routeArrow(e, s ? all.get(s) : undefined, t ? all.get(t) : undefined));
      all.set(e.id, routed);
      for (const b of routed.boundElements ?? []) {
        const lbl = all.get(b.id);
        if (lbl && b.type === "text") all.set(lbl.id, centerLabel(routed, bump(lbl), { keepSize: true }));
      }
    }
  }
  return [...existing.map((e) => all.get(e.id)!), ...extra];
}

/** Deletes elements, their labels, and detaches arrows that pointed at them. */
export function deleteElements(existing: El[], ids: string[]): { elements: El[]; deleted: string[] } {
  const all = new Map(existing.map((e) => [e.id, e]));
  const doomed = new Set<string>();
  // A group id deletes the whole group.
  const expanded = ids.flatMap((id) => (all.get(id) ? [id] : groupMembers(all, id).map((e) => e.id)));
  for (const id of ids) if (!all.get(id) && !groupMembers(all, id).length) throw notFound(all, id);
  for (const id of expanded) {
    const e = all.get(id);
    if (!e || e.isDeleted) throw notFound(all, id);
    doomed.add(id);
    for (const b of e.boundElements ?? []) if (b.type === "text") doomed.add(b.id);
    if (e.type === "frame") {
      for (const k of all.values()) if (k.frameId === id) all.set(k.id, bump(k, { frameId: null }));
    }
  }
  for (const id of doomed) all.set(id, bump(all.get(id)!, { isDeleted: true }));
  for (const e of all.values()) {
    if (e.isDeleted) continue;
    const patch: Partial<El> = {};
    if (e.startBinding && doomed.has(e.startBinding.elementId)) patch.startBinding = null;
    if (e.endBinding && doomed.has(e.endBinding.elementId)) patch.endBinding = null;
    if (e.boundElements?.some((b: { id: string }) => doomed.has(b.id))) {
      patch.boundElements = e.boundElements.filter((b: { id: string }) => !doomed.has(b.id));
    }
    if (e.containerId && doomed.has(e.containerId)) patch.isDeleted = true;
    if (Object.keys(patch).length) all.set(e.id, bump(e, patch));
  }
  return { elements: existing.map((e) => all.get(e.id)!), deleted: [...doomed] };
}

/**
 * Binds an existing arrow to two elements: updates its bindings and both ends' boundElements
 * (detaching it from whatever it was bound to before) and routes it straight between them.
 */
export function connectArrow(existing: El[], arrowId: string, fromId: string, toId: string): El[] {
  const all = new Map(existing.map((e) => [e.id, e]));
  const arrow = all.get(arrowId);
  if (!arrow || arrow.isDeleted) throw notFound(all, arrowId);
  if (arrow.type !== "arrow") throw new SceneError(`Element "${arrowId}" is a ${arrow.type}, not an arrow`);
  const end = (id: string) => {
    const e = all.get(id);
    if (!e || e.isDeleted) throw notFound(all, id);
    if (LINEAR.has(e.type) || (e.type === "text" && e.containerId)) throw new SceneError(`Can't bind an arrow to ${e.type} "${id}"`);
    return e;
  };
  const from = end(fromId);
  const to = end(toId);
  for (const old of [arrow.startBinding?.elementId, arrow.endBinding?.elementId]) {
    const e = old && old !== fromId && old !== toId ? all.get(old) : undefined;
    if (e?.boundElements?.some((b: { id: string }) => b.id === arrowId)) {
      all.set(e.id, bump(e, { boundElements: e.boundElements.filter((b: { id: string }) => b.id !== arrowId) }));
    }
  }
  for (const e of [from, to]) all.set(e.id, bump(addBound(all.get(e.id)!, { id: arrowId, type: "arrow" })));
  // Start from a straight arrow: old waypoints were drawn for other ends.
  const pts = arrow.points as [number, number][];
  const straight = { ...arrow, points: [pts?.[0] ?? [0, 0], pts?.at(-1) ?? [100, 0]] };
  const routed = bump(routeArrow(straight, all.get(fromId), all.get(toId)));
  all.set(arrowId, routed);
  for (const b of routed.boundElements ?? []) {
    const lbl = all.get(b.id);
    if (lbl && b.type === "text" && !lbl.isDeleted) all.set(lbl.id, centerLabel(routed, bump(lbl), { keepSize: true }));
  }
  return existing.map((e) => all.get(e.id)!);
}

/** Tombstones for every element, so new content with reused ids outranks the old. */
export function cleared(existing: El[]): El[] {
  return existing.map((e) => (e.isDeleted ? e : bump(e, { isDeleted: true })));
}

/** Shifts every given element (and their labels) so their bounding box starts at (x, y). */
export function translate(els: El[], dx: number, dy: number): El[] {
  return els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
}

// ---------------------------------------------------------------------------
// Description for agents
// ---------------------------------------------------------------------------

const r = (n: number) => Math.round(n);

function labelOf(el: El, all: Map<string, El>): string | undefined {
  const b = (el.boundElements ?? []).find((x: { type: string }) => x.type === "text");
  const t = b ? all.get(b.id) : undefined;
  return t && !t.isDeleted ? (t.originalText ?? t.text) : undefined;
}

function colorName(hex: string | undefined): string | undefined {
  if (!hex || hex === "transparent") return undefined;
  for (const [name, c] of Object.entries(PALETTE)) {
    if (c.fill.toLowerCase() === hex.toLowerCase() || c.stroke.toLowerCase() === hex.toLowerCase()) return name;
  }
  return hex;
}

/** Compact, token-efficient summary of a scene that an agent can reason about. */
export function describe(scene: Scene, only?: Set<string>): string {
  const all = new Map(live(scene.elements).map((e) => [e.id, e]));
  // A selected label stands for its container; a selected container brings its label along.
  const picked = only
    ? new Set([...only].flatMap((id) => {
        const e = all.get(id);
        return e?.containerId && all.has(e.containerId) ? [id, e.containerId] : [id];
      }))
    : undefined;
  const els = live(scene.elements).filter((e) => !picked || picked.has(e.id));
  const b = bounds(els);
  const lines: string[] = [
    `${els.length} elements` +
      (b ? `; bounds x ${r(b.minX)}..${r(b.maxX)}, y ${r(b.minY)}..${r(b.maxY)}` : "; empty canvas"),
  ];
  for (const e of els) {
    if (e.type === "text" && e.containerId && all.has(e.containerId)) continue;
    const q = (s: string) => JSON.stringify(s.length > 120 ? s.slice(0, 117) + "..." : s);
    const parts: string[] = [`[${e.id}] ${e.type}`];
    if (LINEAR.has(e.type)) {
      const from = e.startBinding?.elementId;
      const to = e.endBinding?.elementId;
      const pts = (e.points ?? []) as number[][];
      const end = pts[pts.length - 1] ?? [0, 0];
      parts.push(from || to ? `${from ?? `(${r(e.x)},${r(e.y)})`} -> ${to ?? `(${r(e.x + end[0])},${r(e.y + end[1])})`}` : `(${r(e.x)},${r(e.y)}) -> (${r(e.x + end[0])},${r(e.y + end[1])})`);
      if (e.strokeStyle && e.strokeStyle !== "solid") parts.push(e.strokeStyle);
    } else {
      parts.push(`at (${r(e.x)},${r(e.y)}) size ${r(e.width)}x${r(e.height)}`);
    }
    const label = e.type === "text" ? e.text : e.type === "frame" ? e.name : labelOf(e, all);
    if (label) parts.push(q(label));
    const fill = colorName(e.backgroundColor);
    if (fill && !LINEAR.has(e.type) && e.type !== "text") parts.push(`fill=${fill}`);
    const stroke = colorName(e.strokeColor);
    if (stroke && stroke !== "black") parts.push(`stroke=${stroke}`);
    if (e.frameId) parts.push(`in frame ${e.frameId}`);
    if (e.groupIds?.length) parts.push(`groups=${e.groupIds.join(",")}`);
    const code = codeRefOf({ link: e.link, customData: e.customData });
    if (code) parts.push(`code=${formatCodeLink(code)}`);
    else if (e.link) parts.push(`link=${e.link}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Revisions, search, arrangement
// ---------------------------------------------------------------------------

/**
 * A short id for the drawing's content: changes whenever any live element does (every edit
 * bumps an element's version), and stays the same across daemon restarts.
 */
export function contentRev(els: El[]): string {
  const h = crypto.createHash("sha256");
  for (const e of live(els).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(`${e.id}:${e.version}:${e.versionNonce};`);
  return h.digest("hex").slice(0, 12);
}

export interface ElementFilter {
  /** Case-insensitive substring of a label, text, frame name or link. */
  query?: string;
  ids?: string[];
  type?: string;
}

/**
 * Ids of the elements matching every given filter. A matching label stands for its
 * container. Unless `type` is given, arrows attached to a match come along, so the result
 * shows how the matches connect.
 */
export function findElements(els: El[], f: ElementFilter): Set<string> {
  const ls = live(els);
  const all = new Map(ls.map((e) => [e.id, e]));
  const q = f.query?.trim().toLowerCase();
  const ids = f.ids?.length ? new Set(f.ids) : undefined;
  const textOf = (e: El): string =>
    [e.type === "text" ? e.text : e.type === "frame" ? e.name : labelOf(e, all), e.link].filter(Boolean).join(" ").toLowerCase();
  const out = new Set<string>();
  for (const e of ls) {
    // Labels are matched through their container.
    if (e.type === "text" && e.containerId && all.has(e.containerId)) continue;
    if (ids && !ids.has(e.id) && !(e.boundElements ?? []).some((b: { id: string }) => ids.has(b.id))) continue;
    if (f.type && e.type !== f.type) continue;
    if (q && !textOf(e).includes(q)) continue;
    out.add(e.id);
  }
  if (!f.type && (q || ids)) {
    for (const e of ls) {
      if (LINEAR.has(e.type) && (out.has(e.startBinding?.elementId) || out.has(e.endBinding?.elementId))) out.add(e.id);
    }
  }
  return out;
}

export type Align = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Distribute = "horizontal" | "vertical";

/**
 * Aligns or evenly spaces elements. Each id moves as a unit with the rest of its group (a
 * library shape) or, for a frame, with its children; labels and bound arrows follow.
 * Distribution keeps the outermost two in place and makes the gaps between the others equal.
 */
export function arrangeElements(existing: El[], ids: string[], how: { align?: Align; distribute?: Distribute }): El[] {
  if (!how.align === !how.distribute) throw new SceneError("Pass either align or distribute");
  const ls = live(existing);
  const byId = new Map(ls.map((e) => [e.id, e]));
  const units = new Map<string, { anchor: El; box: { minX: number; minY: number; maxX: number; maxY: number } }>();
  for (const raw of ids) {
    // A group id stands for the whole group, which moves as one unit anyway.
    let e = byId.get(raw) ?? groupMembers(byId, raw)[0];
    if (!e) throw notFound(byId, raw);
    if (e.type === "text" && e.containerId && byId.has(e.containerId)) e = byId.get(e.containerId)!;
    if (LINEAR.has(e.type)) throw new SceneError(`"${raw}" is ${e.type === "arrow" ? "an arrow" : "a line"}; arrange the shapes it connects instead`);
    const group = e.groupIds?.at(-1);
    const key = group ? `g:${group}` : e.id;
    if (units.has(key)) continue;
    const members = group ? ls.filter((m) => m.groupIds?.at(-1) === group) : [e];
    units.set(key, { anchor: e, box: bounds(members.filter((m) => !LINEAR.has(m.type)))! });
  }
  const list = [...units.values()];
  if (list.length < (how.distribute ? 3 : 2)) {
    throw new SceneError(how.distribute ? "Distribute needs at least three separate elements" : "Align needs at least two separate elements");
  }
  const moves: { el: El; dx: number; dy: number }[] = [];
  if (how.align) {
    const minX = Math.min(...list.map((u) => u.box.minX));
    const maxX = Math.max(...list.map((u) => u.box.maxX));
    const minY = Math.min(...list.map((u) => u.box.minY));
    const maxY = Math.max(...list.map((u) => u.box.maxY));
    for (const { anchor, box } of list) {
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      const dx = { left: minX - box.minX, center: (minX + maxX) / 2 - cx, right: maxX - box.maxX }[how.align as string] ?? 0;
      const dy = { top: minY - box.minY, middle: (minY + maxY) / 2 - cy, bottom: maxY - box.maxY }[how.align as string] ?? 0;
      moves.push({ el: anchor, dx, dy });
    }
  } else {
    const h = how.distribute === "horizontal";
    const lo = (u: (typeof list)[number]) => (h ? u.box.minX : u.box.minY);
    const hi = (u: (typeof list)[number]) => (h ? u.box.maxX : u.box.maxY);
    const sorted = [...list].sort((a, b) => lo(a) + hi(a) - (lo(b) + hi(b)));
    const span = hi(sorted.at(-1)!) - lo(sorted[0]);
    const used = sorted.reduce((n, u) => n + hi(u) - lo(u), 0);
    const gap = (span - used) / (sorted.length - 1);
    let at = lo(sorted[0]);
    for (const u of sorted) {
      const d = at - lo(u);
      moves.push({ el: u.anchor, dx: h ? d : 0, dy: h ? 0 : d });
      at += hi(u) - lo(u) + gap;
    }
  }
  const updates = moves
    .filter((m) => Math.abs(m.dx) > 0.01 || Math.abs(m.dy) > 0.01)
    .map((m) => ({ id: m.el.id, x: m.el.x + m.dx, y: m.el.y + m.dy }));
  return updates.length ? updateElements(existing, updates) : existing;
}

/**
 * Elements that put a drawing back to an earlier state when merged with `replace`: each
 * outranks the current copy of the same id, so the merge takes the old content.
 */
export function restoreElements(current: El[], snapshot: El[]): El[] {
  const now = new Map(current.map((e) => [e.id, e]));
  return live(snapshot).map((e) => {
    const cur = now.get(e.id);
    return { ...e, version: Math.max(e.version ?? 1, cur?.version ?? 0) + 1, versionNonce: randInt(), updated: Date.now() };
  });
}
