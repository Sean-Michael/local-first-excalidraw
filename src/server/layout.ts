/**
 * Minimal layered graph layout (longest-path layering + barycentre ordering) so agents
 * can describe a diagram as nodes and edges instead of computing coordinates.
 */
import { measureText, type SkeletonEl } from "./scene.js";

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

function nodeSize(n: NodeSpec): { w: number; h: number } {
  if (n.size) return n.size;
  const m = measureText(n.label, 20);
  // Excalidraw fits bound text in the inscribed box: about half a diamond, ~70% of an ellipse.
  if (n.shape === "diamond") return { w: Math.round(Math.max(170, m.width * 2 + 50)), h: Math.round(Math.max(100, m.height * 2 + 40)) };
  if (n.shape === "ellipse") return { w: Math.round(Math.max(160, m.width * 1.45 + 50)), h: Math.round(Math.max(80, m.height * 1.45 + 36)) };
  return { w: Math.round(Math.max(140, m.width + 50)), h: Math.round(Math.max(70, m.height + 36)) };
}

export function layoutGraph(spec: GraphSpec, origin = { x: 0, y: 0 }): SkeletonEl[] {
  const dir = spec.direction ?? "LR";
  const nodes = spec.nodes;
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new Error(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  const edges = (spec.edges ?? []).filter((e) => {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`Edge ${e.from} -> ${e.to} references an unknown node`);
    return e.from !== e.to;
  });

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

  // Barycentre ordering sweeps, keeping group members adjacent.
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }
  const groupOf = new Map(nodes.map((n) => [n.id, n.group ?? ""]));
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

  // Coordinates: layers advance along the main axis; siblings spread on the cross axis.
  const size = new Map(nodes.map((n) => [n.id, nodeSize(n)]));
  const main = (id: string) => (dir === "LR" ? size.get(id)!.w : size.get(id)!.h);
  const cross = (id: string) => (dir === "LR" ? size.get(id)!.h : size.get(id)!.w);
  const layerMain = layers.map((l) => Math.max(...l.map(main)));
  const layerCross = layers.map((l) => l.reduce((s, id) => s + cross(id), 0) + V_GAP * (l.length - 1));
  const maxCross = Math.max(...layerCross);
  const titleOffset = spec.title ? 70 : 0;
  // Leave room for edge labels between layers (only matters for LR; TB labels sit beside the arrow).
  const longestLabel = Math.max(0, ...edges.map((e) => (e.label ? measureText(e.label, 16).width : 0)));
  const H_GAP = Math.max(MIN_H_GAP, dir === "LR" ? longestLabel + 80 : 0);
  const coord = new Map<string, { x: number; y: number }>();
  let m = 0;
  layers.forEach((l, li) => {
    let c = (maxCross - layerCross[li]) / 2;
    for (const id of l) {
      const mo = m + (layerMain[li] - main(id)) / 2;
      coord.set(id, dir === "LR" ? { x: origin.x + mo, y: origin.y + titleOffset + c } : { x: origin.x + c, y: origin.y + titleOffset + mo });
      c += cross(id) + V_GAP;
    }
    m += layerMain[li] + H_GAP;
  });

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
      x: Math.round(c.x),
      y: Math.round(c.y),
      width: s.w,
      height: s.h,
      label: n.label,
      color: n.color,
      rounded: (n.shape ?? "rectangle") === "rectangle",
    });
  }
  edges.forEach((e, i) => {
    els.push({
      type: "arrow",
      id: `${e.from}->${e.to}${i ? `#${i}` : ""}`,
      start: { id: e.from },
      end: { id: e.to },
      label: e.label,
      strokeStyle: e.style ?? "solid",
      startArrowhead: e.bidirectional ? "arrow" : null,
    });
  });

  // Groups become labelled frames around their members.
  for (const g of spec.groups ?? []) {
    const members = nodes.filter((n) => n.group === g.id).map((n) => n.id);
    if (!members.length) continue;
    els.push({ type: "frame", id: g.id, name: g.label ?? g.id, children: members });
  }
  return els;
}
