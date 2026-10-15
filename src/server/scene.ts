/**
 * Pure scene logic shared by the daemon and the MCP server. No I/O here.
 *
 * Elements are plain Excalidraw JSON. Concurrency is handled the same way Excalidraw's
 * own collaboration does it: every element carries a `version` (bumped on each change)
 * and a random `versionNonce`; when two copies disagree the higher version wins, and
 * deletions are `isDeleted: true` tombstones rather than removals.
 */
import crypto from "node:crypto";

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
 * Rough text metrics. The editor recomputes exact metrics with real fonts the first time
 * it loads the drawing, so this only needs to be close enough for layout.
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

/** Places a container's bound text at its centre. */
export function centerLabel(container: El, text: El): El {
  const m = measureText(text.text, text.fontSize, text.fontFamily);
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
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let t: number;
  if (el.type === "ellipse") t = 1 / Math.sqrt((ux / hw) ** 2 + (uy / hh) ** 2);
  else if (el.type === "diamond") t = 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh);
  else t = Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity);
  return [cx + ux * (t + gap), cy + uy * (t + gap)];
}

const GAP = 6;

/** Recomputes a straight arrow between two bound shapes. */
export function routeArrow(arrow: El, from: El | undefined, to: El | undefined): El {
  const pts = (arrow.points as [number, number][]) ?? [[0, 0], [100, 0]];
  let start: [number, number] = [arrow.x + pts[0][0], arrow.y + pts[0][1]];
  let end: [number, number] = [arrow.x + pts[pts.length - 1][0], arrow.y + pts[pts.length - 1][1]];
  const center = (e: El): [number, number] => [e.x + e.width / 2, e.y + e.height / 2];
  const aim0 = to ? center(to) : end;
  const aim1 = from ? center(from) : start;
  if (from) start = boundaryPoint(from, aim0[0] - center(from)[0], aim0[1] - center(from)[1], GAP);
  if (to) end = boundaryPoint(to, aim1[0] - center(to)[0], aim1[1] - center(to)[1], GAP);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return {
    ...arrow,
    x: start[0],
    y: start[1],
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
    startBinding: from ? { elementId: from.id, focus: 0, gap: GAP } : (arrow.startBinding ?? null),
    endBinding: to ? { elementId: to.id, focus: 0, gap: GAP } : (arrow.endBinding ?? null),
  };
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

const SKELETON_ONLY = new Set(["label", "color", "start", "end", "rounded", "children"]);

function passthrough(s: SkeletonEl): Partial<El> {
  const out: Partial<El> = {};
  for (const [k, v] of Object.entries(s)) if (!SKELETON_ONLY.has(k) && v !== undefined) out[k] = v;
  return out;
}

export class SceneError extends Error {}

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
      // Unknown or full raw element (freedraw, image, ...): accept as-is with defaults.
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
      // Labels follow their containers into the frame.
      for (const b of k.boundElements ?? []) {
        const bt = all.get(b.id);
        if (bt && b.type === "text") all.set(bt.id, { ...bt, frameId: el.id });
      }
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
  "originalText", "index", "status", "fileId", "scale", "crop",
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

  for (const u of updates) {
    const cur = all.get(u.id);
    if (!cur || cur.isDeleted) throw new SceneError(`Element "${u.id}" not found`);
    const patch: Partial<El> = {};
    for (const [k, v] of Object.entries(u)) {
      if (IMMUTABLE.has(k) || k === "label" || k === "color" || v === undefined) continue;
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
      } else {
        const t = makeLabel(next, u.label);
        next = addBound(next, { id: t.id, type: "text" });
        extra.push(t);
      }
    }
    all.set(cur.id, next);
  }

  // Re-centre labels and re-route arrows touching anything that moved.
  for (const id of moved) {
    const el = all.get(id)!;
    for (const b of el.boundElements ?? []) {
      const t = all.get(b.id);
      if (!t || t.isDeleted) continue;
      if (b.type === "text") all.set(t.id, centerLabel(el, bump(t)));
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
        if (lbl && b.type === "text") all.set(lbl.id, centerLabel(routed, bump(lbl)));
      }
    }
  }
  return [...existing.map((e) => all.get(e.id)!), ...extra];
}

/** Deletes elements, their labels, and detaches arrows that pointed at them. */
export function deleteElements(existing: El[], ids: string[]): { elements: El[]; deleted: string[] } {
  const all = new Map(existing.map((e) => [e.id, e]));
  const doomed = new Set<string>();
  for (const id of ids) {
    const e = all.get(id);
    if (!e || e.isDeleted) throw new SceneError(`Element "${id}" not found`);
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
    if (e.link) parts.push(`link=${e.link}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
