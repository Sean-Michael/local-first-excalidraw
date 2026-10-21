/**
 * Minimal layered graph layout (longest-path layering + barycentre ordering) so agents
 * can describe a diagram as nodes and edges instead of computing coordinates.
 *
 * Edges that skip layers pass through a reserved slot in each layer they cross, and every
 * edge leaves and enters its nodes through a short stub, so no arrow cuts through a box.
 * Each group gets its own band across the layers, so group frames never overlap each other
 * or enclose nodes from outside the group.
 */
import { closest, measureText, SceneError, type SkeletonEl } from "./scene.js";

export interface NodeSpec {
  id: string;
  label: string;
  /** rectangle | ellipse | diamond, or a library shape (resolved and sized by the caller). */
  shape?: string;
  color?: string;
  group?: string;
  /** Fixed size, for library shapes. */
  size?: { w: number; h: number };
  /** Project file (optionally `:line`) the node stands for; the caller turns it into a code link. */
  code?: string;
  /** UML: shown as «stereotype» above the name (interface, abstract, enumeration, device, …). */
  stereotype?: string;
  /** UML class compartments, below the name, each under a rule line. */
  attributes?: string[];
  operations?: string[];
}

export type Arrowhead =
  | "arrow"
  | "bar"
  | "dot"
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many";

interface RelationStyle {
  style: "solid" | "dashed";
  start: Arrowhead | null;
  end: Arrowhead | null;
  label?: string;
  /** The `to` end is the parent, laid out in the earlier layer (above in TB, left in LR). */
  parentFirst?: boolean;
}

/**
 * Standard relationships and how they are drawn, so a model can say what an edge means and
 * get the notation right.
 */
export const RELATIONS = {
  // UML class, object, component and package diagrams
  association: { style: "solid", start: null, end: null },
  "directed-association": { style: "solid", start: null, end: "arrow" },
  dependency: { style: "dashed", start: null, end: "arrow" },
  inheritance: { style: "solid", start: null, end: "triangle_outline", parentFirst: true },
  realization: { style: "dashed", start: null, end: "triangle_outline", parentFirst: true },
  aggregation: { style: "solid", start: "diamond_outline", end: null },
  composition: { style: "solid", start: "diamond", end: null },
  // UML use case diagrams
  include: { style: "dashed", start: null, end: "arrow", label: "«include»" },
  extend: { style: "dashed", start: null, end: "arrow", label: "«extend»" },
  // Sequence and communication messages
  message: { style: "solid", start: null, end: "triangle" },
  "async-message": { style: "solid", start: null, end: "arrow" },
  reply: { style: "dashed", start: null, end: "arrow" },
  // Crow's foot ER relationships, read from the `from` entity to the `to` entity
  "one-to-one": { style: "solid", start: "crowfoot_one", end: "crowfoot_one" },
  "one-to-many": { style: "solid", start: "crowfoot_one", end: "crowfoot_many" },
  "many-to-many": { style: "solid", start: "crowfoot_many", end: "crowfoot_many" },
  "one-to-one-or-many": { style: "solid", start: "crowfoot_one", end: "crowfoot_one_or_many" },
} satisfies Record<string, RelationStyle>;

export type Relation = keyof typeof RELATIONS;

export interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  /** Text beside the `from` / `to` end: a UML multiplicity or role, an ER cardinality ("1", "0..*"). */
  startLabel?: string;
  endLabel?: string;
  style?: "solid" | "dashed" | "dotted";
  bidirectional?: boolean;
  /** What the edge means; sets its arrowheads, line style and (for include/extend) label. */
  relation?: Relation;
  /** Override the relation's arrowheads; null for a plain end. */
  startArrowhead?: Arrowhead | null;
  endArrowhead?: Arrowhead | null;
}

export interface GroupSpec {
  id: string;
  label?: string;
  color?: string;
}

export interface GraphSpec {
  nodes: NodeSpec[];
  edges?: EdgeSpec[];
  groups?: GroupSpec[];
  direction?: "LR" | "TB";
  title?: string;
}

const MIN_H_GAP = 110; // between layers
const V_GAP = 50; // between siblings in a layer
const SLOT = 16; // cross-axis room for an edge passing through a layer
const PORT = 14; // how far past a layer's edge an edge's stub reaches
const PARALLEL = 18; // spacing between edges joining the same two nodes
const FRAME_PAD = 60; // room around a group's members for its frame (frames use 40, plus the title)
const BAND_GAP = 40; // between neighbouring groups

/**
 * UML symbols that aren't boxes: the activity/state initial node (●), final node (◉) and a
 * fork/join bar (across the flow). They carry no label.
 */
export const PSEUDO_SHAPES = new Set(["initial", "final", "bar"]);

const INK = "#1e1e1e";

function nodeSize(n: NodeSpec, dir: "LR" | "TB"): { w: number; h: number } {
  if (n.size) return n.size;
  if (n.shape === "initial") return { w: 30, h: 30 };
  if (n.shape === "final") return { w: 36, h: 36 };
  if (n.shape === "bar") return dir === "TB" ? { w: 160, h: 10 } : { w: 10, h: 160 };
  const m = measureText(n.label, 20);
  // Excalidraw fits bound text in the inscribed box: about half a diamond, ~70% of an ellipse.
  if (n.shape === "diamond") return { w: Math.round(Math.max(170, m.width * 2 + 50)), h: Math.round(Math.max(100, m.height * 2 + 40)) };
  if (n.shape === "ellipse") return { w: Math.round(Math.max(160, m.width * 1.45 + 50)), h: Math.round(Math.max(80, m.height * 1.45 + 36)) };
  return { w: Math.round(Math.max(140, m.width + 50)), h: Math.round(Math.max(70, m.height + 36)) };
}

type Pt = [number, number];

/** Drops waypoints that lie on the straight line between their neighbours. */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [out[out.length - 1], pts[i], pts[i + 1]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) > 0.5 || dot < 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** The «stereotype», name and compartments of a UML node as one label. */
export function compartmentLabel(n: Pick<NodeSpec, "label" | "stereotype" | "attributes" | "operations">): string {
  const st = n.stereotype?.trim().replace(/^(«|<<)\s*|\s*(»|>>)$/g, "");
  const head = [st ? `«${st}»` : "", n.label].filter(Boolean).join("\n");
  const sections = [n.attributes, n.operations].filter((x): x is string[] => Array.isArray(x));
  if (!sections.length) return head;
  // Shorter than the longest line, or the rule wraps and overflows the box (boxes are sized to the text).
  const longest = Math.max(...[head, ...sections.flat()].flatMap((t) => t.split("\n")).map((l) => l.length));
  const rule = "─".repeat(Math.max(4, Math.min(16, Math.floor(longest * 0.6))));
  return [head, ...sections.map((xs) => [rule, ...xs].join("\n"))].join("\n");
}

export function layoutGraph(spec: GraphSpec, origin = { x: 0, y: 0 }): SkeletonEl[] {
  const dir = spec.direction ?? "LR";
  const nodes = (spec.nodes ?? []).map((n) => (n.stereotype || n.attributes || n.operations ? { ...n, label: compartmentLabel(n) } : n));
  if (!nodes.length) throw new SceneError("A diagram needs at least one node");
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new SceneError(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  const allEdges = (spec.edges ?? []).map((e, i) => ({ ...e, i }));
  for (const e of allEdges) {
    const missing = [e.from, e.to].filter((id) => !ids.has(id));
    if (missing.length) {
      const hints = missing.map((id) => {
        const near = closest(id, ids, 2);
        return near ? `"${id}" (did you mean "${near}"?)` : `"${id}"`;
      });
      throw new SceneError(
        `Edge ${e.from} -> ${e.to} references ${hints.join(" and ")}, which ${missing.length > 1 ? "aren't nodes" : "isn't a node"}. ` +
          `Node ids are: ${[...ids].join(", ")}. Add the missing node to \`nodes\`, or fix or drop the edge.`,
      );
    }
  }
  const edges = allEdges.filter((e) => e.from !== e.to);

  // Break cycles with a DFS so layering terminates.
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const relationOf = (e: EdgeSpec): RelationStyle | undefined => (e.relation ? RELATIONS[e.relation] : undefined);
  for (const e of edges) {
    if (relationOf(e)?.parentFirst) out.get(e.to)!.push(e.from);
    else out.get(e.from)!.push(e.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const dag = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const visit = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) continue; // back edge: ignore for layering
      dag.get(u)!.push(v);
      if (!state.get(v)) visit(v);
    }
    state.set(u, 2);
  };
  for (const n of nodes) if (!state.get(n.id)) visit(n.id);

  // Longest-path layering.
  const layer = new Map<string, number>();
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const vs of dag.values()) for (const v of vs) indeg.set(v, indeg.get(v)! + 1);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of dag.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, layer.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  const layers: string[][] = [];
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    (layers[l] ??= []).push(n.id);
  }
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];

  // Each edge runs from its earlier-layer end (u) to its later one (v), through one slot
  // ("dummy" node) per layer in between. Back edges of cycles are routed the same way, reversed.
  const groupOf = new Map(nodes.map((n) => [n.id, n.group ?? ""]));
  const dummies = new Set<string>();
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const chains = edges.map((e) => {
    const reversed = layer.get(e.from)! > layer.get(e.to)!;
    const [u, v] = reversed ? [e.to, e.from] : [e.from, e.to];
    const via: string[] = [];
    for (let l = layer.get(u)! + 1; l < layer.get(v)!; l++) {
      const d = `\u0000${e.i}:${l}`;
      dummies.add(d);
      layers[l].push(d);
      // An edge inside a group stays in the group's band.
      groupOf.set(d, groupOf.get(u) === groupOf.get(v) ? groupOf.get(u)! : "");
      preds.set(d, []);
      succs.set(d, []);
      via.push(d);
    }
    const path = [u, ...via, v];
    for (let k = 0; k + 1 < path.length; k++) {
      succs.get(path[k])!.push(path[k + 1]);
      preds.get(path[k + 1])!.push(path[k]);
    }
    return { e, u, v, via, reversed };
  });

  // Barycentre ordering sweeps, keeping group members adjacent.
  const pos = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  reindex();
  // Edge crossings between neighbouring layers for the current order: pairs of edges whose ends swap places.
  const crossings = () => {
    let n = 0;
    for (const l of layers) {
      const es: [number, number][] = [];
      for (const id of l) for (const s of succs.get(id)!) es.push([pos.get(id)!, pos.get(s)!]);
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) n++;
    }
    return n;
  };
  // A sweep can undo what the one before got right, so keep the order with the fewest crossings.
  let best = { n: crossings(), layers: layers.map((l) => [...l]) };
  for (let iter = 0; iter < 6; iter++) {
    const down = iter % 2 === 0;
    const seq = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of seq) {
      const bary = new Map<string, number>();
      for (const id of l) {
        const ns = (down ? preds : succs).get(id)!.filter((n) => pos.has(n));
        bary.set(id, ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : pos.get(id)!);
      }
      const groupBary = new Map<string, number>();
      for (const id of l) {
        const g = groupOf.get(id)!;
        if (!g) continue;
        const members = l.filter((m) => groupOf.get(m) === g);
        groupBary.set(g, members.reduce((s, m) => s + bary.get(m)!, 0) / members.length);
      }
      l.sort((a, b) => {
        const ga = groupOf.get(a)! ? groupBary.get(groupOf.get(a)!)! : bary.get(a)!;
        const gb = groupOf.get(b)! ? groupBary.get(groupOf.get(b)!)! : bary.get(b)!;
        return ga - gb || bary.get(a)! - bary.get(b)!;
      });
      reindex();
    }
    const n = crossings();
    if (n < best.n) best = { n, layers: layers.map((l) => [...l]) };
  }
  best.layers.forEach((l, i) => (layers[i] = l));
  reindex();

  // Bands: every group (and the ungrouped nodes) gets its own stretch of the cross axis in all
  // layers, ordered by where its members ended up on average.
  const bandKeys: string[] = [];
  const bandPos = new Map<string, number[]>();
  for (const l of layers) {
    for (const id of l) {
      const g = groupOf.get(id)!;
      if (!bandPos.has(g)) {
        bandKeys.push(g);
        bandPos.set(g, []);
      }
      bandPos.get(g)!.push((pos.get(id)! + 0.5) / l.length);
    }
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  bandKeys.sort((a, b) => mean(bandPos.get(a)!) - mean(bandPos.get(b)!) || bandKeys.indexOf(a) - bandKeys.indexOf(b));
  const bandIndex = new Map(bandKeys.map((g, i) => [g, i]));
  for (const l of layers) l.sort((a, b) => bandIndex.get(groupOf.get(a)!)! - bandIndex.get(groupOf.get(b)!)! || pos.get(a)! - pos.get(b)!);
  reindex();

  // Coordinates: layers advance along the main axis; siblings spread on the cross axis.
  // Edges that carry end labels each get their own port (see below): make a box wide enough
  // (tall enough, in LR) to space them so the labels don't stack.
  const endText = (e: EdgeSpec, node: string) => (node === e.from ? e.startLabel : e.endLabel);
  const portStep = (texts: string[]) => Math.max(...texts.map((t) => measureText(t, 16)[dir === "LR" ? "height" : "width"])) + 24;
  const sideEdges = new Map<string, number[]>(); // `${node}\u0000out|in` -> chain indexes
  chains.forEach((ch, k) => {
    for (const key of [`${ch.u}\u0000out`, `${ch.v}\u0000in`]) sideEdges.set(key, [...(sideEdges.get(key) ?? []), k]);
  });
  const portRoom = new Map<string, number>();
  for (const [key, ks] of sideEdges) {
    const node = key.split("\u0000")[0];
    const texts = ks.map((k) => endText(chains[k].e, node)).filter((t): t is string => !!t);
    if (texts.length && ks.length > 1) portRoom.set(node, Math.max(portRoom.get(node) ?? 0, (ks.length - 1) * portStep(texts)));
  }
  const size = new Map(
    nodes.map((n) => {
      const s = nodeSize(n, dir);
      const room = n.size || PSEUDO_SHAPES.has(n.shape ?? "") ? 0 : (portRoom.get(n.id) ?? 0) / 0.8;
      return [n.id, dir === "LR" ? { ...s, h: Math.max(s.h, Math.ceil(room)) } : { ...s, w: Math.max(s.w, Math.ceil(room)) }];
    }),
  );
  const main = (id: string) => (dummies.has(id) ? 0 : dir === "LR" ? size.get(id)!.w : size.get(id)!.h);
  const cross = (id: string) => (dummies.has(id) ? SLOT : dir === "LR" ? size.get(id)!.h : size.get(id)!.w);
  const gapAfter = (a: string, b: string) => (dummies.has(a) && dummies.has(b) ? SLOT : V_GAP);
  const extent = (ids: string[]) => ids.reduce((s, id, k) => s + cross(id) + (k ? gapAfter(ids[k - 1], id) : 0), 0);

  const bandStart = new Map<string, number>();
  const bandSize = new Map<string, number>();
  let c0 = 0;
  for (const g of bandKeys) {
    const inner = Math.max(...layers.map((l) => extent(l.filter((id) => groupOf.get(id) === g))));
    const s = inner + (g ? FRAME_PAD * 2 : 0);
    bandStart.set(g, c0);
    bandSize.set(g, s);
    c0 += s + BAND_GAP;
  }

  const layerMain = layers.map((l) => Math.max(0, ...l.map(main)));
  const titleOffset = spec.title ? 70 : 0;
  // Leave room for edge labels between layers (only matters for LR; TB labels sit beside the arrow).
  const longestLabel = Math.max(0, ...edges.map((e) => (e.label ? measureText(e.label, 16).width : 0)));
  // End labels sit beside the arrow near each end, before and after any middle label.
  const longestEnd = Math.max(0, ...edges.flatMap((e) => [e.startLabel, e.endLabel].map((t) => (t ? measureText(t, 16) : { width: 0, height: 0 })[dir === "LR" ? "width" : "height"])));
  // A longer stub at each end, so an end label sits beside a straight stretch of its arrow.
  const port = longestEnd ? Math.max(PORT, longestEnd + 14) : PORT;
  const H_GAP = Math.max(MIN_H_GAP, (dir === "LR" ? longestLabel : 0) + (longestEnd ? 2 * (longestEnd + 10) : 0) + (dir === "LR" ? 80 : 40));
  const colStart: number[] = [];
  let m = 0;
  layers.forEach((_, li) => {
    colStart[li] = m;
    m += layerMain[li] + H_GAP;
  });
  const colEnd = (li: number) => colStart[li] + layerMain[li];

  /** Main-axis and cross-axis coordinates to canvas x, y. */
  const at = (mm: number, cc: number): Pt =>
    dir === "LR" ? [origin.x + mm, origin.y + titleOffset + cc] : [origin.x + cc, origin.y + titleOffset + mm];
  const crossAt = new Map<string, number>(); // top (or left) edge on the cross axis
  for (const l of layers) {
    for (const g of bandKeys) {
      const items = l.filter((id) => groupOf.get(id) === g);
      let c = bandStart.get(g)! + (bandSize.get(g)! - extent(items)) / 2;
      items.forEach((id, k) => {
        if (k) c += gapAfter(items[k - 1], id);
        crossAt.set(id, c);
        c += cross(id);
      });
    }
  }
  const coord = new Map<string, Pt>();
  for (const n of nodes) {
    const li = layer.get(n.id)!;
    coord.set(n.id, at(colStart[li] + (layerMain[li] - main(n.id)) / 2, crossAt.get(n.id)!));
  }
  const crossMid = (id: string) => crossAt.get(id)! + cross(id) / 2;
  const mainMid = (id: string) => colStart[layer.get(id)!] + layerMain[layer.get(id)!] / 2;

  const els: SkeletonEl[] = [];
  if (spec.title) {
    els.push({ type: "text", id: "title", text: spec.title, fontSize: 28, x: origin.x, y: origin.y });
  }
  for (const n of nodes) {
    const c = coord.get(n.id)!;
    const s = size.get(n.id)!;
    if (n.shape && PSEUDO_SHAPES.has(n.shape)) {
      const [x, y] = [Math.round(c[0]), Math.round(c[1])];
      const solid = { strokeColor: INK, backgroundColor: INK, fillStyle: "solid" };
      if (n.shape === "initial") els.push({ type: "ellipse", id: n.id, x, y, width: s.w, height: s.h, ...solid });
      else if (n.shape === "bar") els.push({ type: "rectangle", id: n.id, x, y, width: s.w, height: s.h, ...solid });
      else {
        // A ring the arrows bind to, around a solid dot, moved as one.
        const g = [`${n.id}-symbol`];
        els.push({ type: "ellipse", id: n.id, x, y, width: s.w, height: s.h, strokeColor: INK, backgroundColor: "transparent", strokeWidth: 2, groupIds: g });
        els.push({ type: "ellipse", id: `${n.id}-dot`, x: x + 8, y: y + 8, width: s.w - 16, height: s.h - 16, ...solid, groupIds: g });
      }
      continue;
    }
    els.push({
      type: n.shape ?? "rectangle",
      id: n.id,
      x: Math.round(c[0]),
      y: Math.round(c[1]),
      width: s.w,
      height: s.h,
      label: n.label,
      color: n.color,
      rounded: (n.shape ?? "rectangle") === "rectangle",
    });
  }

  // Edges joining the same two nodes (either way round) are spread apart.
  const pairs = new Map<string, number[]>();
  chains.forEach((ch, k) => {
    const key = `${ch.u}\u0000${ch.v}`;
    pairs.set(key, [...(pairs.get(key) ?? []), k]);
  });
  const offset = new Map<number, number>();
  for (const ks of pairs.values()) ks.forEach((k, j) => offset.set(k, (j - (ks.length - 1) / 2) * PARALLEL));

  // Where a node's edges on one side carry end labels, each edge gets its own port, ordered by
  // where it heads, far enough apart that the labels don't stack; elsewhere they share the centre.
  const portOff = new Map<string, number>(); // `${k}:u` / `${k}:v`
  for (const [key, ks] of sideEdges) {
    const [node, side] = key.split("\u0000");
    const texts = ks.map((k) => endText(chains[k].e, node)).filter((t): t is string => !!t);
    if (!texts.length || ks.length < 2) continue;
    const step = Math.min(portStep(texts), (cross(node) * 0.8) / (ks.length - 1));
    const toward = (k: number) => crossMid(side === "out" ? (chains[k].via[0] ?? chains[k].v) : (chains[k].via.at(-1) ?? chains[k].u));
    [...ks].sort((a, b) => toward(a) - toward(b) || a - b).forEach((k, j) => portOff.set(`${k}:${side === "out" ? "u" : "v"}`, (j - (ks.length - 1) / 2) * step));
  }

  const arrow = (e: (typeof allEdges)[number], pts?: Pt[]): SkeletonEl => {
    const rel = relationOf(e);
    return {
      type: "arrow",
      id: `${e.from}->${e.to}${e.i ? `#${e.i}` : ""}`,
      start: { id: e.from },
      end: { id: e.to },
      label: e.label ?? rel?.label,
      ...(e.startLabel ? { startLabel: e.startLabel } : {}),
      ...(e.endLabel ? { endLabel: e.endLabel } : {}),
      strokeStyle: e.style ?? rel?.style ?? "solid",
      startArrowhead: e.startArrowhead !== undefined ? e.startArrowhead : e.bidirectional ? "arrow" : (rel?.start ?? null),
      ...(e.endArrowhead !== undefined ? { endArrowhead: e.endArrowhead } : rel ? { endArrowhead: rel.end } : {}),
      ...(pts && pts.length > 2
        ? {
            x: Math.round(pts[0][0]),
            y: Math.round(pts[0][1]),
            points: pts.map(([x, y]) => [Math.round(x - pts[0][0]), Math.round(y - pts[0][1])] as Pt),
            roundness: null,
          }
        : {}),
    };
  };

  chains.forEach((ch, k) => {
    const ou = portOff.get(`${k}:u`) ?? offset.get(k)!;
    const ov = portOff.get(`${k}:v`) ?? offset.get(k)!;
    const lu = layer.get(ch.u)!;
    const lv = layer.get(ch.v)!;
    // Centre of u, a stub just past u's layer, through each slot, a stub before v's layer, centre of v.
    let pts: Pt[] = [
      at(mainMid(ch.u), crossMid(ch.u) + (portOff.has(`${k}:u`) ? ou : 0)),
      at(colEnd(lu) + port, crossMid(ch.u) + ou),
      ...ch.via.flatMap((d, j): Pt[] => [at(colStart[lu + 1 + j], crossMid(d)), at(colEnd(lu + 1 + j), crossMid(d))]),
      at(colStart[lv] - port, crossMid(ch.v) + ov),
      at(mainMid(ch.v), crossMid(ch.v) + (portOff.has(`${k}:v`) ? ov : 0)),
    ];
    if (ch.reversed) pts.reverse();
    pts = simplify(pts);
    els.push(arrow(ch.e, pts));
  });
  // Self-loops are drawn as a small loop on the node (see routeArrow).
  for (const e of allEdges) if (e.from === e.to) els.push(arrow(e));

  // Groups become labelled frames around their members.
  for (const g of spec.groups ?? []) {
    const members = nodes.filter((n) => n.group === g.id).map((n) => n.id);
    if (!members.length) continue;
    els.push({ type: "frame", id: g.id, name: g.label ?? g.id, children: members });
  }
  return els;
}
