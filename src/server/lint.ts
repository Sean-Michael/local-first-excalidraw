/**
 * A readability check for a drawing, from its geometry alone: the things a person would ask an
 * agent to "clean up". Every write returns it, so a model learns what is wrong with the layout it
 * just produced without having to notice it in a picture, and the assistant doesn't finish a turn
 * while problems remain.
 *
 * Problems are defects a reader trips over (overlaps, text that doesn't fit, arrows through
 * boxes). Suggestions are judgement calls (a very wide drawing, many crossings). The check is
 * conservative: a zone around other shapes, a title inside a box and the parts of one library
 * shape are not overlaps.
 */
import { type El, live } from "./scene.js";

export interface LayoutCheck {
  problems: string[];
  suggestions: string[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Unit extends Box {
  /** The element (or the first of a group) to name in a message and to move. */
  id: string;
  name: string;
  kind: "shape" | "text" | "frame";
  ids: Set<string>;
  /** Contains another unit: a zone or frame, which arrows may enter and labels may sit in. */
  zone: boolean;
}

interface Label extends Box {
  id: string;
  text: string;
  /** The arrow it belongs to, and the shapes that arrow joins. */
  arrow: string;
}

type Pt = [number, number];

/** Overlaps smaller than this in either direction are strokes touching, not a collision. */
const TOUCH = 4;
/** Shapes closer than this read as touching. */
const TIGHT = 10;
/** Two arrow labels need at least this much air between them. */
const LABEL_GAP = 6;
const MAX_LISTED = 8;
/** Beyond this the pairwise checks would cost more than they tell: say so instead. */
const MAX_UNITS = 600;
const WIDE = 3.2;
const TALL = 4;
const MIN_FONT = 12;

const boxOf = (e: El): Box => {
  if (Array.isArray(e.points) && e.points.length) {
    const xs = (e.points as Pt[]).map((p) => p[0]);
    const ys = (e.points as Pt[]).map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: e.x + minX, y: e.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  return { x: e.x, y: e.y, w: e.width ?? 0, h: e.height ?? 0 };
};

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Width and height of the area two boxes share (negative: the gap between them). */
const shared = (a: Box, b: Box): [number, number] => [
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
];

const collides = (a: Box, b: Box) => {
  const [w, h] = shared(a, b);
  return w > TOUCH && h > TOUCH;
};

const contains = (outer: Box, inner: Box, slack = 2) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;

const inside = (b: Box, [x, y]: Pt, slack = 0) => x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack;

/** Whether the segment a-b passes through the box (Liang-Barsky clipping). */
function segmentHits(a: Pt, b: Pt, box: Box): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - box.x],
    [dx, box.x + box.w - a[0]],
    [-dy, a[1] - box.y],
    [dy, box.y + box.h - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  // A graze along the edge isn't a crossing: require some length inside.
  return Math.hypot(dx, dy) * (t1 - t0) > TOUCH;
}

/** Whether two segments properly cross (not merely touch at an end). */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const [d1, d2, d3, d4] = [o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)];
  return d1 * d2 < -1e-6 && d3 * d4 < -1e-6;
}

/** The box with `by` taken off every side (or added, when negative). */
const shrink = (b: Box, by: number): Box => ({ x: b.x + by, y: b.y + by, w: Math.max(0, b.w - 2 * by), h: Math.max(0, b.h - 2 * by) });

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim().slice(0, 40)}"`;

/** "3 more like this" lines keep a result short however broken the drawing is. */
function capped(items: string[]): string[] {
  return items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `…and ${items.length - MAX_LISTED} more of the same kind.`] : items;
}

export function checkLayout(elements: El[]): LayoutCheck {
  const els = live(elements);
  const byId = new Map(els.map((e) => [e.id, e]));
  const problems: string[] = [];
  const suggestions: string[] = [];

  const textOf = (e: El): string | undefined => {
    if (e.type === "text") return e.text as string;
    const t = (e.boundElements as { id: string; type: string }[] | undefined)?.find((b) => b.type === "text");
    return t ? (byId.get(t.id)?.text as string | undefined) : undefined;
  };
  const isLinear = (e: El) => e.type === "arrow" || e.type === "line";
  const isEndLabel = (e: El) => e.type === "text" && !!(e.customData as { arrowEnd?: unknown } | undefined)?.arrowEnd;

  // ---- units: what a reader sees as one thing (a shape with its label, a library icon, a free text) ----
  const units = new Map<string, Unit>();
  for (const e of els) {
    if (isLinear(e) || (e.type === "text" && e.containerId) || isEndLabel(e)) continue;
    if (e.type === "image" && !e.width) continue;
    const group = (e.groupIds as string[] | undefined)?.at(-1);
    const key = e.type === "frame" ? e.id : group ? `g:${group}` : e.id;
    const box = boxOf(e);
    const u = units.get(key);
    if (u) {
      Object.assign(u, union(u, box));
      u.ids.add(e.id);
      if (u.kind === "text" && e.type !== "text") u.kind = "shape";
      if (!u.name || (e.type !== "text" && textOf(e) && u.name === u.id)) u.name = textOf(e) ?? u.name;
    } else {
      units.set(key, { ...box, id: e.id, name: textOf(e) ?? (e.type === "frame" ? ((e.name as string) ?? e.id) : e.id), kind: e.type === "frame" ? "frame" : e.type === "text" ? "text" : "shape", ids: new Set([e.id]), zone: e.type === "frame" });
    }
  }
  const all = [...units.values()].filter((u) => u.w > 0 || u.h > 0);
  if (all.length > MAX_UNITS) return { problems, suggestions: [`The drawing has ${all.length} shapes, too many to check for overlaps automatically; render parts of it to check them.`] };
  for (const a of all) for (const b of all) if (a !== b && a.kind !== "text" && contains(a, b) && !(contains(b, a) && b.kind !== "text")) a.zone = true;
  const unitOf = new Map<string, Unit>();
  for (const u of all) for (const id of u.ids) unitOf.set(id, u);
  const say = (u: Unit) => (u.name && u.name !== u.id ? `${quote(u.name)} (${u.id})` : u.id);

  // ---- shapes and texts on top of each other ----
  const overlaps: string[] = [];
  const tight: string[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, b] = [all[i], all[j]];
      if (contains(a, b) || contains(b, a)) continue;
      if (collides(a, b)) {
        const frame = a.kind === "frame" ? a : b.kind === "frame" ? b : undefined;
        const other = frame === a ? b : a;
        const child = frame && [...other.ids].some((id) => byId.get(id)?.frameId === frame.id);
        overlaps.push(
          frame
            ? child
              ? `${say(other)} sticks out of its frame ${say(frame)}: move it inside or enlarge the frame.`
              : `${say(other)} overlaps the frame ${say(frame)} without being in it: move it clear, or put it in the frame.`
            : `${say(a)} and ${say(b)} overlap: move one so they are at least 40 px apart.`,
        );
      } else if (a.kind === "shape" && b.kind === "shape" && !a.zone && !b.zone) {
        const [w, h] = shared(a, b);
        // Side by side (they share a stretch of one axis) with almost no gap on the other.
        if ((w > TOUCH && h <= TOUCH && h > -TIGHT) || (h > TOUCH && w <= TOUCH && w > -TIGHT)) tight.push(`${say(a)} and ${say(b)} are less than ${TIGHT} px apart.`);
      }
    }
  }
  problems.push(...capped(overlaps));

  // ---- labels that don't fit their shape ----
  const overflow: string[] = [];
  let smallest = Infinity;
  for (const t of els) {
    if (t.type !== "text") continue;
    if (typeof t.fontSize === "number") smallest = Math.min(smallest, t.fontSize);
    const c = t.containerId ? byId.get(t.containerId as string) : undefined;
    if (!c || isLinear(c)) continue;
    // Excalidraw fits bound text in the inscribed box: about half a diamond, ~70% of an ellipse.
    const f = c.type === "diamond" ? 0.5 : c.type === "ellipse" ? 0.71 : 1;
    const room = { w: (c.width ?? 0) * f - (f === 1 ? 8 : 0), h: (c.height ?? 0) * f - (f === 1 ? 4 : 0) };
    if ((t.width ?? 0) > room.w + 1 || (t.height ?? 0) > room.h + 1) {
      overflow.push(
        `The label ${quote(t.text as string)} doesn't fit its ${c.type} ${c.id} (text ${Math.round(t.width)}×${Math.round(t.height)}, room ${Math.round(room.w)}×${Math.round(room.h)}): enlarge ${c.id} or shorten the label.`,
      );
    }
  }
  problems.push(...capped(overflow));

  // ---- arrows ----
  const arrows = els.filter((e) => e.type === "arrow" && Array.isArray(e.points) && e.points.length > 1);
  const pathOf = (a: El): Pt[] => (a.points as Pt[]).map(([x, y]) => [a.x + x, a.y + y]);
  const endsOf = (a: El) => [(a.startBinding as { elementId?: string } | null)?.elementId, (a.endBinding as { elementId?: string } | null)?.elementId];
  const arrowName = (a: El) => {
    const [s, t] = endsOf(a).map((id) => (id ? unitOf.get(id) : undefined));
    const label = textOf(a);
    return s && t ? `The arrow ${s.name !== s.id ? quote(s.name) : s.id} → ${t.name !== t.id ? quote(t.name) : t.id} (${a.id})` : `The arrow ${a.id}${label ? ` ${quote(label)}` : ""}`;
  };
  const through: string[] = [];
  const blockers = all.filter((u) => !u.zone);
  for (const a of arrows) {
    const pts = pathOf(a);
    const bound = new Set(endsOf(a).map((id) => (id ? unitOf.get(id) : undefined)));
    for (const u of blockers) {
      if (bound.has(u) || inside(u, pts[0], 6) || inside(u, pts[pts.length - 1], 6)) continue;
      const core = shrink(u, 6);
      if (core.w <= 0 || core.h <= 0) continue;
      if (pts.some((p, i) => i > 0 && segmentHits(pts[i - 1], p, core))) {
        through.push(`${arrowName(a)} runs through ${say(u)}${u.kind === "text" ? " (a text)" : ""}: move ${u.id} out of its way, or move the shapes it joins.`);
      }
    }
  }
  problems.push(...capped(through));

  // ---- arrow labels (middle and end labels) covering shapes or each other ----
  const labels: Label[] = [];
  for (const t of els) {
    if (t.type !== "text") continue;
    const c = t.containerId ? byId.get(t.containerId as string) : undefined;
    const end = (t.customData as { arrowEnd?: { arrowId: string } } | undefined)?.arrowEnd;
    if (c?.type === "arrow") labels.push({ ...boxOf(t), id: t.id, text: t.text as string, arrow: c.id });
    else if (end) labels.push({ ...boxOf(t), id: t.id, text: t.text as string, arrow: end.arrowId });
  }
  const covered: string[] = [];
  for (const l of labels) {
    for (const u of blockers) {
      if (u.kind === "frame" || !collides(shrink(l, 2), u)) continue;
      covered.push(`The arrow label ${quote(l.text)} (on ${l.arrow}) sits on top of ${say(u)}: move the shapes further apart, shorten the label, or remove it.`);
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      // Labels that touch read as one ("timeoutreset"): they need a visible gap.
      if (collides(shrink(labels[i], -LABEL_GAP), labels[j])) {
        covered.push(`The arrow labels ${quote(labels[i].text)} (on ${labels[i].arrow}) and ${quote(labels[j].text)} (on ${labels[j].arrow}) overlap: move the shapes apart or drop a label.`);
      }
    }
  }
  problems.push(...capped(covered));

  // ---- judgement calls ----
  suggestions.push(...capped(tight).slice(0, 4));
  let crossings = 0;
  for (let i = 0; i < arrows.length; i++) {
    for (let j = i + 1; j < arrows.length; j++) {
      const [ea, eb] = [endsOf(arrows[i]), endsOf(arrows[j])];
      // Arrows that share a shape fan out from it; they meet there rather than cross.
      if (ea.some((id) => id && eb.includes(id))) continue;
      const [pa, pb] = [pathOf(arrows[i]), pathOf(arrows[j])];
      if (pa.some((p, k) => k > 0 && pb.some((q, m) => m > 0 && segmentsCross(pa[k - 1], p, pb[m - 1], q)))) crossings++;
    }
  }
  if (crossings >= 3) suggestions.push(`${crossings} pairs of arrows cross. Reordering the nodes, or grouping the ones that talk to each other, usually removes most crossings.`);

  const content = all.filter((u) => u.kind !== "frame");
  if (content.length >= 6) {
    const b = content.reduce<Box>((acc, u) => union(acc, u), content[0]);
    const size = `${Math.round(b.w)}×${Math.round(b.h)} px`;
    if (b.h > 0 && b.w / b.h > WIDE) {
      suggestions.push(`The drawing is ${size}, ${(b.w / b.h).toFixed(1)} times wider than tall, so it is small when fitted to a window. Lay it out top to bottom (create_diagram direction "TB"), or stack related nodes in groups, to bring it closer to a screen's shape.`);
    } else if (b.w > 0 && b.h / b.w > TALL) {
      suggestions.push(`The drawing is ${size}, ${(b.h / b.w).toFixed(1)} times taller than wide, so it is small when fitted to a window. Lay it out left to right (create_diagram direction "LR"), or put parallel steps side by side.`);
    }
  }
  if (smallest < MIN_FONT) suggestions.push(`The smallest text is ${smallest} px; under ${MIN_FONT} px is hard to read. Use 16 px or more for labels.`);

  return { problems, suggestions };
}

/** The check as the paragraph a write's result ends with. Empty for a drawing with nothing in it. */
export function layoutReport(check: LayoutCheck | undefined): string {
  if (!check) return "";
  const { problems, suggestions } = check;
  if (!problems.length && !suggestions.length) return "\nLayout check: no overlaps, no labels that don't fit, no arrows through shapes.";
  const lines: string[] = [];
  if (problems.length) lines.push(`Layout check: ${problems.length} problem${problems.length === 1 ? "" : "s"} a reader would trip over. Fix ${problems.length === 1 ? "it" : "them"} (update_elements moves and resizes; bound arrows follow) before you reply:`, ...problems.map((p) => `- ${p}`));
  else lines.push("Layout check: no overlaps, no labels that don't fit, no arrows through shapes.");
  if (suggestions.length) lines.push("Worth improving:", ...suggestions.map((s) => `- ${s}`));
  return `\n${lines.join("\n")}`;
}
