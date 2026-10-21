import assert from "node:assert/strict";
import { test } from "node:test";
import { type GraphSpec, layoutGraph } from "../src/server/layout.js";
import { addSkeletons, type El, live, SceneError } from "../src/server/scene.js";

type Box = { id: string; x: number; y: number; w: number; h: number };

const boxOf = (e: El): Box => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** True when segment p-q passes through the inside of box b (touching its edge doesn't count). */
function segmentHitsBox(p: number[], q: number[], b: Box, inset = 1): boolean {
  const [x0, y0, x1, y1] = [b.x + inset, b.y + inset, b.x + b.w - inset, b.y + b.h - inset];
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  // Liang-Barsky clipping.
  for (const [pp, qq] of [
    [-dx, p[0] - x0],
    [dx, x1 - p[0]],
    [-dy, p[1] - y0],
    [dy, y1 - p[1]],
  ]) {
    if (pp === 0) {
      if (qq < 0) return false;
    } else {
      const r = qq / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function build(spec: GraphSpec): El[] {
  return live(addSkeletons([], layoutGraph(spec)).elements);
}

function checkLayout(name: string, spec: GraphSpec) {
  for (const direction of ["LR", "TB"] as const) {
    const els = build({ ...spec, direction });
    const nodeIds = new Set(spec.nodes.map((n) => n.id));
    const nodes = els.filter((e) => nodeIds.has(e.id)).map(boxOf);
    assert.equal(nodes.length, spec.nodes.length, `${name}: every node is drawn`);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        assert.ok(!overlaps(nodes[i], nodes[j]), `${name} ${direction}: ${nodes[i].id} overlaps ${nodes[j].id}`);
      }
    }
    const arrows = els.filter((e) => e.type === "arrow");
    assert.equal(arrows.length, spec.edges?.length ?? 0, `${name}: every edge is drawn, self-loops included`);
    for (const a of arrows) {
      const pts = (a.points as number[][]).map(([x, y]) => [a.x + x, a.y + y]);
      for (const v of [a.x, a.y, a.width, a.height, ...pts.flat()]) assert.ok(Number.isFinite(v), `${name}: ${a.id} is finite`);
      const ends = new Set([a.startBinding?.elementId, a.endBinding?.elementId]);
      for (const b of nodes) {
        if (ends.has(b.id)) continue;
        for (let k = 0; k + 1 < pts.length; k++) {
          assert.ok(!segmentHitsBox(pts[k], pts[k + 1], b), `${name} ${direction}: ${a.id} passes through ${b.id}`);
        }
      }
    }
    const frames = els.filter((e) => e.type === "frame").map(boxOf);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        assert.ok(!overlaps(frames[i], frames[j]), `${name} ${direction}: frames ${frames[i].id} and ${frames[j].id} overlap`);
      }
    }
    for (const f of frames) {
      const outsiders = spec.nodes.filter((n) => n.group !== f.id).map((n) => nodes.find((b) => b.id === n.id)!);
      for (const o of outsiders) assert.ok(!overlaps(f, o), `${name} ${direction}: frame ${f.id} encloses ${o.id}`);
    }
  }
}

const n = (...ids: string[]) => ids.map((id) => ({ id, label: id.toUpperCase() }));
const e = (...pairs: string[]) => pairs.map((p) => ({ from: p[0], to: p[1] }));

test("layout: chain", () => checkLayout("chain", { nodes: n("a", "b", "c", "d"), edges: e("ab", "bc", "cd") }));

test("layout: fan-out", () =>
  checkLayout("fan-out", { nodes: n("a", "b", "c", "d", "e", "f", "g"), edges: e("ab", "ac", "ad", "ae", "af", "ag") }));

test("layout: diamond", () => checkLayout("diamond", { nodes: n("a", "b", "c", "d"), edges: e("ab", "ac", "bd", "cd") }));

test("layout: edges that skip layers go around the boxes in between", () => {
  const spec = { nodes: n("a", "b", "c", "d", "e"), edges: e("ab", "bc", "cd", "ad", "ae", "ec", "be") };
  checkLayout("skip-layer", spec);
  // The long edge bends through waypoints instead of running straight through b and c.
  const ad = build(spec).find((x) => x.id === "a->d#3")!;
  assert.ok(ad.points.length > 2);
});

test("layout: groups get their own frames that don't overlap", () =>
  checkLayout("groups", {
    nodes: [
      { id: "web", label: "Web", group: "front" },
      { id: "app", label: "Mobile", group: "front" },
      { id: "api", label: "API" },
      { id: "auth", label: "Auth", group: "back" },
      { id: "orders", label: "Orders", group: "back" },
      { id: "db", label: "Postgres", group: "data" },
      { id: "cache", label: "Redis", group: "data" },
      { id: "log", label: "Logs" },
    ],
    edges: [
      { from: "web", to: "api" },
      { from: "app", to: "api" },
      { from: "api", to: "auth" },
      { from: "api", to: "orders" },
      { from: "orders", to: "db" },
      { from: "auth", to: "cache" },
      { from: "web", to: "db" },
      { from: "api", to: "log" },
    ],
    groups: [{ id: "front", label: "Clients" }, { id: "back", label: "Services" }, { id: "data", label: "Data" }],
  }));

test("layout: a group spanning layers doesn't enclose the nodes between", () =>
  checkLayout("group-span", {
    nodes: [
      { id: "x", label: "X", group: "g" },
      { id: "y", label: "Y" },
      { id: "z", label: "Z", group: "g" },
      { id: "w", label: "W", group: "h" },
    ],
    edges: [
      { from: "x", to: "y" },
      { from: "y", to: "z" },
      { from: "x", to: "w" },
      { from: "w", to: "z" },
    ],
    groups: [{ id: "g" }, { id: "h" }],
  }));

test("layout: cycles, self-loops and parallel or opposite edges", () => {
  const spec = { nodes: n("a", "b", "c"), edges: e("ab", "bc", "ca", "aa", "ab", "ba") };
  checkLayout("cycle", spec);
  const els = build(spec);
  const loop = els.find((x) => x.id === "a->a#3")!;
  assert.equal(loop.startBinding.elementId, "a");
  assert.equal(loop.endBinding.elementId, "a");
  // The three edges between a and b don't sit on top of each other.
  const ab = els.filter((x) => x.type === "arrow" && [x.startBinding.elementId, x.endBinding.elementId].sort().join() === "a,b");
  assert.equal(ab.length, 3);
  const mids = ab.map((x) => JSON.stringify((x.points as number[][]).map(([px, py]) => [Math.round(x.x + px), Math.round(x.y + py)])));
  assert.equal(new Set(mids).size, 3);
});

test("layout input errors are SceneErrors", () => {
  assert.throws(() => layoutGraph({ nodes: n("a", "a") }), SceneError);
  assert.throws(() => layoutGraph({ nodes: n("a"), edges: e("ab") }), SceneError);
});

test("layout: UML relations set arrowheads and put parents above their children", () => {
  const els = build({
    direction: "TB",
    nodes: [
      { id: "card", label: "CardPayment" },
      { id: "payment", label: "Payment", stereotype: "abstract", attributes: ["-amount: Money"], operations: ["+pay(): void"] },
      { id: "order", label: "Order" },
      { id: "item", label: "OrderItem" },
      { id: "base", label: "Withdraw" },
      { id: "auth", label: "Authenticate" },
    ],
    edges: [
      { from: "card", to: "payment", relation: "inheritance" },
      { from: "order", to: "item", relation: "composition", label: "1 — 1..*" },
      { from: "order", to: "payment", relation: "association" },
      { from: "base", to: "auth", relation: "include" },
      { from: "order", to: "base", relation: "one-to-many", endArrowhead: "crowfoot_one_or_many" },
    ],
  });
  const byId = (id: string) => els.find((e) => e.id === id)!;
  // The parent is laid out first even though the arrow runs child -> parent.
  assert.ok(byId("payment").y < byId("card").y, "parent above child");
  const inherit = byId("card->payment");
  assert.equal(inherit.endArrowhead, "triangle_outline");
  assert.equal(inherit.startArrowhead, null);
  assert.equal(inherit.startBinding.elementId, "card");
  const comp = byId("order->item#1");
  assert.equal(comp.startArrowhead, "diamond");
  assert.equal(comp.endArrowhead, null);
  assert.equal(byId("order->payment#2").endArrowhead, null);
  const inc = byId("base->auth#3");
  assert.equal(inc.strokeStyle, "dashed");
  assert.ok(els.some((e) => e.type === "text" && e.containerId === inc.id && e.text === "«include»"));
  // An explicit arrowhead overrides the relation's.
  const er = byId("order->base#4");
  assert.equal(er.startArrowhead, "crowfoot_one");
  assert.equal(er.endArrowhead, "crowfoot_one_or_many");
  // Compartments: stereotype, name, a rule, attributes, a rule, operations.
  const label = els.find((e) => e.type === "text" && e.containerId === "payment")!.text as string;
  assert.match(label, /^«abstract»\nPayment\n─+\n-amount: Money\n─+\n\+pay\(\): void$/);
});

test("layout: initial, final and bar shapes are small unlabelled UML symbols", () => {
  const els = build({
    direction: "TB",
    nodes: [
      { id: "start", label: "", shape: "initial" },
      { id: "fork", label: "", shape: "bar" },
      { id: "a", label: "Pack" },
      { id: "b", label: "Invoice" },
      { id: "end", label: "", shape: "final" },
    ],
    edges: [
      { from: "start", to: "fork" },
      { from: "fork", to: "a" },
      { from: "fork", to: "b" },
      { from: "a", to: "end" },
      { from: "b", to: "end" },
    ],
  });
  const byId = (id: string) => els.find((e) => e.id === id)!;
  assert.equal(byId("start").type, "ellipse");
  assert.equal(byId("start").width, 30);
  assert.equal(byId("start").fillStyle, "solid");
  assert.ok(byId("fork").width > byId("fork").height * 5, "a horizontal bar across a TB flow");
  // The final node is a ring (what arrows bind to) around a solid dot, grouped.
  const ring = byId("end");
  const dot = byId("end-dot");
  assert.equal(ring.backgroundColor, "transparent");
  assert.ok(dot.x > ring.x && dot.x + dot.width < ring.x + ring.width);
  assert.deepEqual(dot.groupIds, ring.groupIds);
  assert.equal(byId("a->end#3").endBinding.elementId, "end");
  assert.ok(!els.some((e) => e.type === "text" && ["start", "fork", "end"].includes(e.containerId)), "no labels");
});
