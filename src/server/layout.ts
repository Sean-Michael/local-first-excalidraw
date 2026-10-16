/**
 * Minimal layered graph layout (longest-path layering + barycentre ordering) so agents
 * can describe a diagram as nodes and edges instead of computing coordinates.
 *
 * Edges that skip layers pass through a reserved slot in each layer they cross, and every
 * edge leaves and enters its nodes through a short stub, so no arrow cuts through a box.
 * Each group gets its own band across the layers, so group frames never overlap each other
 * or enclose nodes from outside the group.
 */
import { measureText, SceneError, type SkeletonEl } from "./scene.js";

export interface NodeSpec {
  id: string;
  label: string;
  /** rectangle | ellipse | diamond, or a library shape (resolved and sized by the caller). */
  shape?: string;
  color?: string;
  group?: string;
  /** Fixed size, for library shapes. */
  size?: { w: number; h: number };
}

export interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  style?: "solid" | "dashed" | "dotted";
  bidirectional?: boolean;
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

function nodeSize(n: NodeSpec): { w: number; h: number } {
  if (n.size) return n.size;
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

export function layoutGraph(spec: GraphSpec, origin = { x: 0, y: 0 }): SkeletonEl[] {
  const dir = spec.direction ?? "LR";
  const nodes = spec.nodes ?? [];
  if (!nodes.length) throw new SceneError("A diagram needs at least one node");
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new SceneError(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  const allEdges = (spec.edges ?? []).map((e, i) => ({ ...e, i }));
  for (const e of allEdges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new SceneError(`Edge ${e.from} -> ${e.to} references an unknown node`);
  }
  const edges = allEdges.filter((e) => e.from !== e.to);

  // Break cycles with a DFS so layering terminates.
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)!.push(e.to);
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
  }

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
  const size = new Map(nodes.map((n) => [n.id, nodeSize(n)]));
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
  const H_GAP = Math.max(MIN_H_GAP, dir === "LR" ? longestLabel + 80 : 0);
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

  const arrow = (e: (typeof allEdges)[number], pts?: Pt[]): SkeletonEl => ({
    type: "arrow",
    id: `${e.from}->${e.to}${e.i ? `#${e.i}` : ""}`,
    start: { id: e.from },
    end: { id: e.to },
    label: e.label,
    strokeStyle: e.style ?? "solid",
    startArrowhead: e.bidirectional ? "arrow" : null,
    ...(pts && pts.length > 2
      ? {
          x: Math.round(pts[0][0]),
          y: Math.round(pts[0][1]),
          points: pts.map(([x, y]) => [Math.round(x - pts[0][0]), Math.round(y - pts[0][1])] as Pt),
          roundness: null,
        }
      : {}),
  });

  chains.forEach((ch, k) => {
    const off = offset.get(k)!;
    const lu = layer.get(ch.u)!;
    const lv = layer.get(ch.v)!;
    // Centre of u, a stub just past u's layer, through each slot, a stub before v's layer, centre of v.
    let pts: Pt[] = [
      at(mainMid(ch.u), crossMid(ch.u)),
      at(colEnd(lu) + PORT, crossMid(ch.u) + off),
      ...ch.via.flatMap((d, j): Pt[] => [at(colStart[lu + 1 + j], crossMid(d)), at(colEnd(lu + 1 + j), crossMid(d))]),
      at(colStart[lv] - PORT, crossMid(ch.v) + off),
      at(mainMid(ch.v), crossMid(ch.v)),
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
