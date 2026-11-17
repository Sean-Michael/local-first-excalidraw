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
const UNIFORM_UP_TO = 2.2; // boxes up to this many times the narrowest are widened to match
const LABEL_PAD = 14; // around an edge label on its run, clear of the turn and the arrowhead
const CHANNEL = 18; // between the turns of edges that jog in the same gap
const CHANNEL_MARGIN = 28; // a gap's spare room beside its channels
const V_GAP = 50; // between siblings in a layer
const SLOT = 24; // cross-axis room for an edge passing through a layer
const PORT = 14; // how far past a layer's edge an edge's stub reaches
const MIXED_PORT_STEP = 36; // between arrows arriving and leaving on the same side of a node
const PORT_INSET = 12; // ports keep this far from a node's corners
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

/**
 * How long the stub at an arrowhead's end must be. Excalidraw draws an arrowhead no longer than
 * half the arrow's last segment, so a head on a short stub shrinks to a dot: leave the full
 * length (25 px for an arrow, 12 for a diamond at a quarter, 20 for a crow's foot, 15 otherwise)
 * plus the gap between the arrow and the shape it is bound to.
 */
function headRoom(head: Arrowhead | null | undefined): number {
  if (!head) return 0;
  if (head === "arrow") return 56;
  if (head === "diamond" || head === "diamond_outline") return 54;
  return head.startsWith("crowfoot") ? 46 : 36;
}

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

/** The shape a diagram should come close to: a landscape window. */
const TARGET_ASPECT = 1.5;

/** Width and height of the nodes a layout placed. */
function extentOf(els: SkeletonEl[]): { w: number; h: number } {
  const boxes = els.filter((e) => e.type !== "arrow" && e.type !== "frame" && typeof e.width === "number" && typeof e.height === "number");
  if (!boxes.length) return { w: 0, h: 0 };
  const xs = boxes.flatMap((e) => [e.x ?? 0, (e.x ?? 0) + e.width!]);
  const ys = boxes.flatMap((e) => [e.y ?? 0, (e.y ?? 0) + e.height!]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Lays the graph out in the given direction, or, when none is given, in the one whose result is
 * closer to the shape of a window: a long pipeline drawn left to right is a strip that is tiny
 * when fitted to the screen, and the same graph top to bottom often isn't. Left to right wins
 * unless top to bottom is clearly better.
 */
export function layoutGraph(spec: GraphSpec, origin = { x: 0, y: 0 }): SkeletonEl[] {
  if (spec.direction || (spec.nodes ?? []).length < 4) return layoutIn(spec, spec.direction ?? "LR", origin);
  const lr = layoutIn(spec, "LR", origin);
  const off = (els: SkeletonEl[]) => {
    const { w, h } = extentOf(els);
    return w && h ? Math.abs(Math.log(w / h / TARGET_ASPECT)) : 0;
  };
  if (off(lr) < Math.log(2)) return lr; // within a factor of two of the target: fine as it is
  const tb = layoutIn(spec, "TB", origin);
  return off(tb) < off(lr) - 0.2 ? tb : lr;
}

function layoutIn(spec: GraphSpec, dir: "LR" | "TB", origin: { x: number; y: number }): SkeletonEl[] {
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
  // The layers each group's nodes span.
  const span = new Map<string, [number, number]>();
  for (const n of nodes) {
    if (!n.group) continue;
    const l = layer.get(n.id)!;
    const sp = span.get(n.group);
    span.set(n.group, sp ? [Math.min(sp[0], l), Math.max(sp[1], l)] : [l, l]);
  }
  const within = (g: string, l: number) => span.has(g) && l >= span.get(g)![0] && l <= span.get(g)![1];
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
      // An edge inside a group stays in the group's band; one into or out of a group runs
      // inside it where it passes the group's layers, rather than around the frame.
      const [gu, gv] = [groupOf.get(u)!, groupOf.get(v)!];
      groupOf.set(d, gu === gv ? gu : within(gv, l) ? gv : within(gu, l) ? gu : "");
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

  // Bands: a group gets a stretch of the cross axis in every layer it spans, so its frame
  // encloses only its own nodes. The ungrouped nodes of one layer form a band of their own.
  // Bands whose layers don't overlap share a track (a tier of services beside a tier of data
  // stores), instead of each group sitting on a step of a staircase with empty space around it.
  const layerOfItem = new Map<string, number>();
  layers.forEach((l, li) => l.forEach((id) => layerOfItem.set(id, li)));
  const bandOf = (id: string) => groupOf.get(id)! || `\u0001${layerOfItem.get(id)}`;
  const bandKeys: string[] = [];
  const bandPos = new Map<string, number[]>();
  const bandSpan = new Map<string, [number, number]>();
  layers.forEach((l, li) => {
    for (const id of l) {
      const g = bandOf(id);
      if (!bandPos.has(g)) {
        bandKeys.push(g);
        bandPos.set(g, []);
        bandSpan.set(g, [li, li]);
      }
      bandPos.get(g)!.push((pos.get(id)! + 0.5) / l.length);
      const sp = bandSpan.get(g)!;
      sp[1] = Math.max(sp[1], li);
    }
  });
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const firstSeen = new Map(bandKeys.map((g, i) => [g, i]));
  bandKeys.sort((a, b) => mean(bandPos.get(a)!) - mean(bandPos.get(b)!) || firstSeen.get(a)! - firstSeen.get(b)!);
  const tracks: string[][] = [];
  const trackOf = new Map<string, number>();
  // Widest bands first, so the groups that span the diagram share a row and the rest fit around them.
  const width = (g: string) => bandSpan.get(g)![1] - bandSpan.get(g)![0];
  for (const g of [...bandKeys].sort((x, y) => width(y) - width(x) || bandKeys.indexOf(x) - bandKeys.indexOf(y))) {
    const sp = bandSpan.get(g)!;
    let t = tracks.findIndex((members) => members.every((m) => bandSpan.get(m)![1] < sp[0] || bandSpan.get(m)![0] > sp[1]));
    if (t < 0) t = tracks.push([]) - 1;
    tracks[t].push(g);
  }
  // Tracks run across the diagram in the order the ordering sweeps put their members.
  const trackMean = (members: string[]) => mean(members.flatMap((m) => bandPos.get(m)!));
  tracks.sort((x, y) => trackMean(x) - trackMean(y));
  tracks.forEach((members, t) => members.forEach((m) => trackOf.set(m, t)));
  for (const l of layers) l.sort((a, b) => trackOf.get(bandOf(a))! - trackOf.get(bandOf(b))! || pos.get(a)! - pos.get(b)!);
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
  // Boxes of one kind share a width, as on a schematic: a row of boxes each sized to its own
  // label looks ragged. A label much longer than the rest keeps its own, wider box.
  const natural = new Map(nodes.map((n) => [n.id, nodeSize(n, dir)]));
  const plain = (n: NodeSpec) => !n.size && !PSEUDO_SHAPES.has(n.shape ?? "") && !n.label.includes("\n");
  const commonWidth = new Map<string, number>();
  for (const n of nodes) {
    if (!plain(n)) continue;
    const kind = n.shape ?? "rectangle";
    const widths = nodes.filter((o) => plain(o) && (o.shape ?? "rectangle") === kind).map((o) => natural.get(o.id)!.w);
    const narrowest = Math.min(...widths);
    commonWidth.set(kind, Math.max(...widths.filter((w) => w <= narrowest * UNIFORM_UP_TO)));
  }
  const size = new Map(
    nodes.map((n) => {
      const own = natural.get(n.id)!;
      const s = plain(n) ? { ...own, w: Math.max(own.w, commonWidth.get(n.shape ?? "rectangle")!) } : own;
      const room = n.size || PSEUDO_SHAPES.has(n.shape ?? "") ? 0 : (portRoom.get(n.id) ?? 0) / 0.8;
      return [n.id, dir === "LR" ? { ...s, h: Math.max(s.h, Math.ceil(room)) } : { ...s, w: Math.max(s.w, Math.ceil(room)) }];
    }),
  );
  const main = (id: string) => (dummies.has(id) ? 0 : dir === "LR" ? size.get(id)!.w : size.get(id)!.h);
  const cross = (id: string) => (dummies.has(id) ? SLOT : dir === "LR" ? size.get(id)!.h : size.get(id)!.w);
  const gapAfter = (a: string, b: string) => (dummies.has(a) && dummies.has(b) ? SLOT : V_GAP);
  const extent = (ids: string[]) => ids.reduce((s, id, k) => s + cross(id) + (k ? gapAfter(ids[k - 1], id) : 0), 0);

  const bandSize = new Map<string, number>();
  for (const g of bandKeys) {
    const inner = Math.max(...layers.map((l) => extent(l.filter((id) => bandOf(id) === g))));
    bandSize.set(g, inner + (span.has(g) ? FRAME_PAD * 2 : 0));
  }
  const bandStart = new Map<string, number>();
  let c0 = 0;
  for (const members of tracks) {
    const size = Math.max(...members.map((m) => bandSize.get(m)!));
    for (const m of members) bandStart.set(m, c0 + (size - bandSize.get(m)!) / 2);
    c0 += size + BAND_GAP;
  }

  const crossAt = new Map<string, number>(); // top (or left) edge on the cross axis
  for (const l of layers) {
    for (const g of bandKeys) {
      const items = l.filter((id) => bandOf(id) === g);
      let c = bandStart.get(g)! + (bandSize.get(g)! - extent(items)) / 2;
      items.forEach((id, k) => {
        if (k) c += gapAfter(items[k - 1], id);
        crossAt.set(id, c);
        c += cross(id);
      });
    }
  }
  const crossMid = (id: string) => crossAt.get(id)! + cross(id) / 2;

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
  // The same goes for a side where some arrows arrive and others leave (the back edge of a cycle
  // meets its node where that node's own arrows start): on one port, the incoming arrowhead sits
  // on the outgoing line and the pair reads as a single two-headed arrow.
  /** How much of an edge's run its middle label takes up. */
  const labelLen = (e: EdgeSpec) => {
    const text = e.label ?? relationOf(e)?.label;
    return text ? measureText(text, 16)[dir === "LR" ? "width" : "height"] : 0;
  };
  const heads = chains.map((ch) => {
    const rel = relationOf(ch.e);
    const end = ch.e.endArrowhead !== undefined ? ch.e.endArrowhead : rel ? rel.end : "arrow";
    const start = ch.e.startArrowhead !== undefined ? ch.e.startArrowhead : ch.e.bidirectional ? "arrow" : (rel?.start ?? null);
    return ch.reversed ? { u: end, v: start } : { u: start, v: end };
  });
  const portOff = new Map<string, number>(); // `${k}:u` / `${k}:v`
  for (const [key, ks] of sideEdges) {
    const [node, side] = key.split("\u0000");
    const texts = ks.map((k) => endText(chains[k].e, node)).filter((t): t is string => !!t);
    const mixed = new Set(ks.map((k) => !!heads[k][side === "out" ? "u" : "v"])).size > 1;
    // And for edges that end here with a label: on one port, each one's line would run through the others' labels.
    const labelled = ks.some((k) => chains[k].reversed === (side === "out") && labelLen(chains[k].e) > 0);
    if ((!texts.length && !mixed && !labelled) || ks.length < 2) continue;
    // Ports stay on the flat part of the side, so every edge still leaves it at a right angle.
    const step = Math.min(texts.length ? portStep(texts) : MIXED_PORT_STEP, Math.max(0, cross(node) - 2 * PORT_INSET) / (ks.length - 1));
    const toward = (k: number) => crossMid(side === "out" ? (chains[k].via[0] ?? chains[k].v) : (chains[k].via.at(-1) ?? chains[k].u));
    [...ks].sort((a, b) => toward(a) - toward(b) || a - b).forEach((k, j) => portOff.set(`${k}:${side === "out" ? "u" : "v"}`, (j - (ks.length - 1) / 2) * step));
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

  // Edges are drawn the way a schematic draws wires: straight out of a node, one right-angle jog
  // in the gap between two layers, straight into the next. Every hop that changes its cross
  // position needs a channel in that gap to turn in. Hops leaving the same port share one (a
  // trunk with branches); the others get channels of their own, ordered so that they nest
  // instead of crossing, and the gap grows to hold them.
  const hops = chains.map((ch, k) => {
    const path = [ch.u, ...ch.via, ch.v];
    const lu = layer.get(ch.u)!;
    const ou = portOff.get(`${k}:u`) ?? offset.get(k)!;
    const ov = portOff.get(`${k}:v`) ?? offset.get(k)!;
    const c = path.map((id, j) => crossMid(id) + (j === 0 ? ou : j === path.length - 1 ? ov : 0));
    return path.slice(0, -1).map((id, j) => ({ gap: lu + j, from: c[j], to: c[j + 1], key: `${id}\u0000${Math.round(c[j])}`, jog: Math.abs(c[j] - c[j + 1]) > 0.5 }));
  });
  const labelStack = new Map<string, number>();
  const labelBehind = new Map<number, number>();
  const channel = new Map<string, number>(); // `${gap}\u0000${key}` -> index of the channel in its gap
  const channels: number[] = layers.map(() => 0);
  const lead: number[] = layers.map(() => port); // straight run after a layer, before the first channel
  const trail: number[] = layers.map(() => port); // and after the last channel, into the next layer
  chains.forEach((ch, k) => {
    const lu = layer.get(ch.u)!;
    const lv = layer.get(ch.v)!;
    // Room to draw an arrowhead at full size on the straight run into its node.
    lead[lu] = Math.max(lead[lu], headRoom(heads[k].u));
    trail[lv - 1] = Math.max(trail[lv - 1], headRoom(heads[k].v));
    // And for the label of an edge that turns: it goes on the edge's own last run (see below).
    // Labels of edges that end at the same node sit one behind the other, not side by side.
    const len = labelLen(ch.e);
    if (len && hops[k].some((h) => h.jog)) {
      const key = `${ch.reversed ? ch.u : ch.v}\u0000${ch.reversed}`;
      const behind = labelStack.get(key) ?? 0;
      labelBehind.set(k, behind);
      labelStack.set(key, behind + len + LABEL_PAD / 2);
      if (ch.reversed) lead[lu] = Math.max(lead[lu], headRoom(heads[k].u) + behind + len + LABEL_PAD);
      else trail[lv - 1] = Math.max(trail[lv - 1], headRoom(heads[k].v) + behind + len + LABEL_PAD);
    }
  });
  layers.forEach((_, li) => {
    const trunks = new Map<string, { from: number; drift: number }>();
    for (const h of hops.flat()) {
      if (h.gap !== li || !h.jog) continue;
      const t = trunks.get(h.key) ?? { from: h.from, drift: 0 };
      t.drift += h.to - h.from;
      trunks.set(h.key, t);
    }
    // Trunks heading the same way nest when the one that starts furthest along turns first.
    const down = [...trunks].filter(([, t]) => t.drift >= 0).sort((a, b) => b[1].from - a[1].from);
    const up = [...trunks].filter(([, t]) => t.drift < 0).sort((a, b) => a[1].from - b[1].from);
    [...down, ...up].forEach(([key], i) => channel.set(`${li}\u0000${key}`, i));
    channels[li] = trunks.size;
  });
  const gapWidth = layers.map((_, li) => Math.max(H_GAP, lead[li] + trail[li] + Math.max(0, channels[li] - 1) * CHANNEL + CHANNEL_MARGIN));
  const colStart: number[] = [];
  let m = 0;
  layers.forEach((_, li) => {
    colStart[li] = m;
    m += layerMain[li] + gapWidth[li];
  });
  const colEnd = (li: number) => colStart[li] + layerMain[li];
  /** Where on the main axis a hop turns: its channel, centred in the room the gap has for channels. */
  const turnAt = (li: number, key: string) => {
    const [from, to] = [colEnd(li) + lead[li], colStart[li + 1] - trail[li]];
    return (from + to) / 2 + (channel.get(`${li}\u0000${key}`)! - (channels[li] - 1) / 2) * CHANNEL;
  };

  /** Main-axis and cross-axis coordinates to canvas x, y. */
  const at = (mm: number, cc: number): Pt =>
    dir === "LR" ? [origin.x + mm, origin.y + titleOffset + cc] : [origin.x + cc, origin.y + titleOffset + mm];
  const coord = new Map<string, Pt>();
  for (const n of nodes) {
    const li = layer.get(n.id)!;
    coord.set(n.id, at(colStart[li] + (layerMain[li] - main(n.id)) / 2, crossAt.get(n.id)!));
  }
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
    const hs = hops[k];
    // Centre of u (routeArrow starts the arrow on u's edge), a turn in each gap where the edge
    // changes its cross position, centre of v.
    let pts: Pt[] = [
      at(mainMid(ch.u), hs[0].from),
      ...hs.flatMap((h): Pt[] => (h.jog ? [at(turnAt(h.gap, h.key), h.from), at(turnAt(h.gap, h.key), h.to)] : [])),
      at(mainMid(ch.v), hs[hs.length - 1].to),
    ];
    pts = simplify(pts);
    // A straight edge off the centre line (one of two between the same nodes) keeps a waypoint,
    // or it would be routed centre to centre on top of its twin.
    if (pts.length === 2 && Math.abs(hs[0].from - crossMid(ch.u)) > 0.5) pts = [pts[0], [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], pts[1]];
    if (ch.reversed) pts.reverse();
    // Excalidraw centres a label on the middle point of its arrow, which for an edge that turns
    // is on the trunk it shares with its siblings: their lines would run through the text. Put
    // the middle point on the edge's own last run instead, just before the arrowhead, by adding
    // points there until as many follow it as come before.
    const len = labelLen(ch.e);
    if (len && pts.length > 2) {
      const to = ch.reversed ? ch.u : ch.v;
      const l = layer.get(to)!;
      const inset = (layerMain[l] - main(to)) / 2;
      const back = headRoom(ch.reversed ? heads[k].u : heads[k].v) + LABEL_PAD / 2 + (labelBehind.get(k) ?? 0) + len / 2;
      const [side, step] = ch.reversed ? [colEnd(l) - inset + back, -1] : [colStart[l] + inset - back, 1];
      const c = ch.reversed ? hs[0].from : hs[hs.length - 1].to;
      const before = pts.length - 1;
      pts = [...pts.slice(0, -1), ...Array.from({ length: before }, (_, j) => at(side + j * step, c)), pts[pts.length - 1]];
    }
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
