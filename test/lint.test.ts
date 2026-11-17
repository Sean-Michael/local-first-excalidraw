/**
 * Diagram quality: the readability check every write returns, and what the layout engine
 * promises so that a first draft doesn't need a "clean it up" pass (right-angle edges, full-size
 * arrowheads, labels on their own run, boxes of one width, a shape close to a window's).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewNote } from "../src/server/ai/agent.js";
import { type GraphSpec, layoutGraph } from "../src/server/layout.js";
import { checkLayout, layoutReport } from "../src/server/lint.js";
import { addSkeletons, bounds, connectArrow, type El, isSquare, live, type SkeletonEl, updateElements } from "../src/server/scene.js";

const draw = (skeletons: SkeletonEl[]): El[] => live(addSkeletons([], skeletons).elements);
const graph = (spec: GraphSpec): El[] => draw(layoutGraph(spec));
const box = (id: string, x: number, y: number, extra: Partial<SkeletonEl> = {}): SkeletonEl => ({ type: "rectangle", id, x, y, width: 160, height: 70, label: `${id} box`, ...extra });
/** The elements with one changed, as a hand edit or a careless update would leave them. */
const patch = (els: El[], id: string, change: (e: El) => Partial<El>): El[] => els.map((e) => (e.id === id ? { ...e, ...change(e) } : e));
const labelId = (els: El[], id: string) => (els.find((e) => e.id === id)!.boundElements as { id: string; type: string }[]).find((b) => b.type === "text")!.id;
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, ...extra });
const edges = (...pairs: [string, string, string?][]) => pairs.map(([from, to, label]) => ({ from, to, label }));

const SHOP: GraphSpec = {
  nodes: ["client", "gateway", "auth", "orders", "cache", "db", "queue", "payments", "worker", "mail"].map((id) => node(id)),
  edges: edges(["client", "gateway", "HTTP"], ["gateway", "auth", "introspect"], ["gateway", "orders", "HTTP"], ["auth", "cache", "sessions"], ["auth", "db", "SQL"], ["orders", "db", "SQL"], ["orders", "queue", "order.placed"], ["orders", "payments", "charges"], ["queue", "worker", "events"], ["worker", "mail", "emails"]),
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

test("a tidy drawing has nothing to report", () => {
  const c = checkLayout(draw([box("a", 0, 0), box("b", 300, 0), { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" }, label: "calls" }]));
  assert.deepEqual(c, { problems: [], suggestions: [] });
  assert.match(layoutReport(c), /^\nLayout check: no overlaps/);
  assert.equal(layoutReport(undefined), "");
});

test("overlapping shapes are a problem; a zone around shapes and a title inside a box are not", () => {
  const over = checkLayout(draw([box("a", 0, 0), box("b", 100, 30)]));
  assert.equal(over.problems.length, 1);
  assert.match(over.problems[0], /"a box" \(a\) and "b box" \(b\) overlap: move one/);

  // A big rectangle holding two boxes and a caption is a zone, however much it "overlaps" them.
  const zone = checkLayout(draw([{ type: "rectangle", id: "zone", x: -40, y: -60, width: 600, height: 200 }, { type: "text", id: "cap", x: -30, y: -50, text: "Backend" }, box("a", 0, 0), box("b", 300, 0)]));
  assert.deepEqual(zone.problems, []);

  // A caption that straddles a box's edge is a collision.
  const straddle = checkLayout(draw([box("a", 0, 0), { type: "text", id: "note", x: 120, y: 20, text: "a long note about a" }]));
  assert.match(straddle.problems[0], /overlap/);

  // Shapes that merely touch aren't reported as overlapping, but nearly touching ones are worth a mention.
  const tight = checkLayout(draw([box("a", 0, 0), box("b", 164, 0)]));
  assert.deepEqual(tight.problems, []);
  assert.match(tight.suggestions[0], /less than 10 px apart/);
});

test("frames: a child sticking out and an outsider overlapping are told apart", () => {
  const els = draw([box("in", 0, 0), box("stray", 400, 0), { type: "frame", id: "f", name: "Tier", children: ["in"] }]);
  assert.deepEqual(checkLayout(els).problems, []);
  const moved = els.map((e) => (e.id === "in" ? { ...e, x: e.x - 120 } : e.id === "stray" ? { ...e, x: 150 } : e));
  const problems = checkLayout(moved).problems.join("\n");
  assert.match(problems, /"in box" \(in\) sticks out of its frame "Tier" \(f\)/);
  assert.match(problems, /"stray box" \(stray\) overlaps the frame "Tier" \(f\) without being in it/);
});

test("a label that doesn't fit its shape is a problem, with the sizes", () => {
  // Drawn, the box is sized to its label; then something shrinks the box.
  const drawn = draw([box("a", 0, 0, { label: "a label much wider than its box" })]);
  assert.deepEqual(checkLayout(drawn).problems, []);
  const [p] = checkLayout(patch(drawn, "a", () => ({ width: 90 }))).problems;
  assert.match(p, /The label "a label much wider than its box" doesn't fit its rectangle a \(text \d+×\d+, room \d+×\d+\): enlarge a or shorten the label/);
  // A diamond holds about half its width.
  const diamond = draw([{ type: "diamond", id: "d", x: 0, y: 0, label: "approved by finance?" }]);
  assert.deepEqual(checkLayout(diamond).problems, []);
  const text = diamond.find((e) => e.type === "text")!;
  assert.match(checkLayout(patch(diamond, "d", () => ({ width: text.width + 30 }))).problems[0], /doesn't fit its diamond d/);
});

test("an arrow through a shape it doesn't join is a problem; entering a zone is not", () => {
  const els = draw([box("a", 0, 0), box("mid", 300, 0), box("c", 600, 0), { type: "arrow", id: "ac", start: { id: "a" }, end: { id: "c" } }]);
  const [p] = checkLayout(els).problems;
  assert.match(p, /The arrow "a box" → "c box" \(ac\) runs through "mid box" \(mid\)/);

  const zoned = draw([box("a", 0, 0), { type: "rectangle", id: "zone", x: 260, y: -60, width: 300, height: 200 }, box("c", 320, 0), { type: "arrow", id: "ac", start: { id: "a" }, end: { id: "c" } }]);
  assert.deepEqual(checkLayout(zoned).problems, []);
});

test("arrow labels on top of a shape or of each other are problems", () => {
  // A label that ends up over the box its arrow starts at.
  const drawn = draw([box("a", 0, 0), box("b", 400, 0), { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" }, label: "publishes" }]);
  assert.deepEqual(checkLayout(drawn).problems, []);
  const moved = patch(drawn, labelId(drawn, "ab"), () => ({ x: 100 }));
  assert.match(checkLayout(moved).problems.join("\n"), /The arrow label "publishes" \(on ab\) sits on top of "a box" \(a\)/);

  // Two arrows crossing at their midpoints put their labels on the same spot.
  const crossed = draw([
    box("a", 0, 0), box("b", 600, 300), box("c", 0, 300), box("d", 600, 0),
    { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" }, label: "reads" },
    { type: "arrow", id: "cd", start: { id: "c" }, end: { id: "d" }, label: "writes" },
  ]);
  assert.match(checkLayout(crossed).problems.join("\n"), /The arrow labels "reads" \(on ab\) and "writes" \(on cd\) overlap/);
});

test("judgement calls are suggestions: a strip of a drawing, many crossings, tiny text", () => {
  const strip = draw(Array.from({ length: 8 }, (_, i) => box(`n${i}`, i * 260, 0)));
  const c = checkLayout(strip);
  assert.deepEqual(c.problems, []);
  assert.match(c.suggestions.join("\n"), /times wider than tall.*direction "TB"/);
  const tall = checkLayout(draw(Array.from({ length: 8 }, (_, i) => box(`n${i}`, 0, i * 160))));
  assert.match(tall.suggestions.join("\n"), /times taller than wide.*direction "LR"/);
  const small = checkLayout(draw([{ type: "text", id: "t", x: 0, y: 0, text: "fine print", fontSize: 9 }]));
  assert.match(small.suggestions.join("\n"), /smallest text is 9 px/);

  const report = layoutReport(c);
  assert.match(report, /Layout check: no overlaps[^\n]*\nWorth improving:\n- The drawing is/);
});

test("a long list of problems is capped, and the report tells the model what to do", () => {
  // Twelve boxes stacked on one spot: 66 overlapping pairs.
  const pile = checkLayout(draw(Array.from({ length: 12 }, (_, i) => box(`n${i}`, i * 3, i * 3))));
  assert.equal(pile.problems.length, 9);
  assert.match(pile.problems.at(-1)!, /…and \d+ more of the same kind/);
  assert.match(layoutReport(pile), /Layout check: 9 problems a reader would trip over\. Fix them \(update_elements moves and resizes; bound arrows follow\) before you reply:\n- /);
});

test("the note that sends a turn back to tidy up is worded as the check, not the user", () => {
  const both = reviewNote(["a and b overlap."], ["The drawing is a strip."]);
  assert.match(both, /^\(Automatic layout check[^\n]*not a message from the user/);
  assert.match(both, /still has 1 problem a reader would trip over:\n- a and b overlap\.\nAlso worth improving:\n- The drawing is a strip\./);
  assert.match(both, /Fix these now with the drawing tools/);
  const soft = reviewNote([], ["The drawing is a strip."]);
  assert.match(soft, /no outright defects/);
  assert.match(soft, /If the drawing is better as it is, just reply\.$/);
});

// ---------------------------------------------------------------------------
// What the layout engine promises
// ---------------------------------------------------------------------------

const arrowsOf = (els: El[]) => els.filter((e) => e.type === "arrow");
const segments = (a: El) => (a.points as [number, number][]).slice(1).map((p, i) => [(a.points as [number, number][])[i], p] as const);

for (const [name, spec] of Object.entries({
  "an architecture with labelled edges": SHOP,
  "the same, left to right": { ...SHOP, direction: "LR" as const },
  "a state machine with cycles": { direction: "TB" as const, nodes: ["Idle", "Fetching", "Parsing", "Rendering", "Error", "Done"].map((id) => node(id)), edges: edges(["Idle", "Fetching", "start"], ["Fetching", "Parsing", "200 OK"], ["Fetching", "Error", "timeout"], ["Parsing", "Rendering"], ["Parsing", "Error", "bad json"], ["Rendering", "Done"], ["Error", "Idle", "retry"], ["Done", "Idle", "reset"], ["Rendering", "Fetching", "more pages"]) },
  "tiers in groups": {
    nodes: [node("web", { group: "fe" }), node("mobile", { group: "fe" }), node("gateway", { group: "be" }), node("auth", { group: "be" }), node("orders", { group: "be" }), node("pg", { group: "data" }), node("redis", { group: "data" }), node("stripe")],
    groups: [{ id: "fe", label: "Frontend" }, { id: "be", label: "Backend" }, { id: "data", label: "Data" }],
    edges: edges(["web", "gateway"], ["mobile", "gateway"], ["gateway", "auth"], ["gateway", "orders"], ["auth", "redis"], ["auth", "pg"], ["orders", "pg"], ["orders", "stripe"], ["web", "auth", "login"]),
  },
}) as [string, GraphSpec][]) {
  test(`layout quality, ${name}: nothing for the check to complain about, and every edge at right angles`, () => {
    const els = graph(spec);
    assert.deepEqual(checkLayout(els).problems, []);
    for (const a of arrowsOf(els)) {
      for (const [p, q] of segments(a)) {
        assert.ok(Math.abs(p[0] - q[0]) < 1.5 || Math.abs(p[1] - q[1]) < 1.5, `${a.id}: segment ${p} -> ${q} is neither horizontal nor vertical`);
      }
    }
  });
}

test("layout quality: an arrowhead's last run is long enough to draw the head at full size", () => {
  // Excalidraw draws an arrowhead no longer than half the last segment: 25 px needs a 50 px run.
  for (const direction of ["LR", "TB"] as const) {
    for (const a of arrowsOf(graph({ ...SHOP, direction, edges: SHOP.edges!.map(({ label: _l, ...e }) => e) }))) {
      const pts = a.points as [number, number][];
      const [p, q] = [pts[pts.length - 2], pts[pts.length - 1]];
      assert.ok(Math.hypot(q[0] - p[0], q[1] - p[1]) >= 50, `${a.id} (${direction}): last run is ${Math.hypot(q[0] - p[0], q[1] - p[1])} px`);
    }
  }
});

test("layout quality: an edge's label sits on the edge's own last run, not on a trunk shared with its siblings", () => {
  const els = graph({ ...SHOP, direction: "TB" });
  const byId = new Map(els.map((e) => [e.id, e]));
  const labelOf = (a: El) => byId.get((a.boundElements as { id: string; type: string }[]).find((b) => b.type === "text")!.id)!;
  // gateway fans out to auth and orders: both edges share the horizontal trunk under gateway.
  for (const id of ["gateway->auth#1", "gateway->orders#2"]) {
    const a = byId.get(id)!;
    const target = byId.get((a.endBinding as { elementId: string }).elementId)!;
    const label = labelOf(a);
    const cx = label.x + label.width / 2;
    assert.ok(Math.abs(cx - (target.x + target.width / 2)) < 40, `${id}: the label is above its own target`);
    assert.ok(label.y + label.height < target.y, `${id}: and clear of it`);
    assert.equal((a.points as unknown[]).length % 2, 1, "an odd number of points, so the middle one carries the label");
  }
  // Two labelled edges into the same node don't put their labels side by side.
  const [l1, l2] = ["auth->db#4", "orders->db#5"].map((id) => labelOf(byId.get(id)!));
  assert.ok(l1.y + l1.height <= l2.y || l2.y + l2.height <= l1.y || l1.x + l1.width <= l2.x || l2.x + l2.width <= l1.x, "the two SQL labels don't overlap");
});

test("layout quality: boxes of one kind share a width, unless one label is far longer", () => {
  const els = graph({ nodes: [node("a", { label: "API" }), node("b", { label: "orders service" }), node("c", { label: "db" })], edges: edges(["a", "b"], ["b", "c"]), direction: "TB" });
  const widths = ["a", "b", "c"].map((id) => els.find((e) => e.id === id)!.width);
  assert.equal(new Set(widths).size, 1, `widths ${widths}`);

  const long = graph({ nodes: [node("a", { label: "API" }), node("b", { label: "a service whose name goes on for a very long time indeed" })], edges: edges(["a", "b"]), direction: "TB" });
  const [wa, wb] = ["a", "b"].map((id) => long.find((e) => e.id === id)!.width);
  assert.ok(wb > wa * 2.2, "the long one keeps its own width and the short one isn't stretched to it");
});

test("layout quality: without a direction, a graph that would be a strip left to right is drawn top to bottom", () => {
  const size = (els: El[]) => {
    const b = bounds(els.filter((e) => e.type !== "arrow" && e.type !== "text"))!;
    return { w: b.maxX - b.minX, h: b.maxY - b.minY };
  };
  const auto = size(graph(SHOP));
  const lr = size(graph({ ...SHOP, direction: "LR" }));
  assert.ok(lr.w / lr.h > 3, "left to right, this graph is a strip");
  assert.ok(auto.w / auto.h < 2.5 && auto.h / auto.w < 2.5, `chosen layout is ${auto.w}×${auto.h}`);
  // An explicit direction is always honoured, and a graph that is fine left to right stays that way.
  const fan = { nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)), edges: edges(["a", "b"], ["a", "c"], ["a", "d"], ["b", "e"], ["c", "e"], ["d", "e"]) };
  const f = size(graph(fan));
  assert.ok(f.w > f.h, "a three-layer fan stays left to right");
  assert.deepEqual(layoutGraph(fan), layoutGraph({ ...fan, direction: "LR" }));
});

test("layout quality: groups whose layers don't overlap share a row instead of stacking as a staircase", () => {
  const els = graph({
    direction: "LR",
    nodes: [node("web", { group: "fe" }), node("api", { group: "be" }), node("svc", { group: "be" }), node("db", { group: "data" })],
    groups: [{ id: "fe" }, { id: "be" }, { id: "data" }],
    edges: edges(["web", "api"], ["api", "svc"], ["svc", "db"]),
  });
  const mid = (id: string) => {
    const e = els.find((x) => x.id === id)!;
    return e.y + e.height / 2;
  };
  // One chain through three tiers: every node on the same line, every edge straight.
  assert.ok(Math.max(...["web", "api", "svc", "db"].map(mid)) - Math.min(...["web", "api", "svc", "db"].map(mid)) < 1);
  for (const a of arrowsOf(els)) assert.equal((a.points as unknown[]).length, 2, `${a.id} is a straight line`);
  const frames = els.filter((e) => e.type === "frame");
  assert.equal(frames.length, 3);
  for (const f of frames) for (const g of frames) if (f !== g) assert.ok(f.x + f.width <= g.x || g.x + g.width <= f.x, "frames sit side by side");
});

test("layout quality: an arrow arriving where others leave gets its own port", () => {
  // b -> a closes a cycle: it arrives on the side of a that a's own arrow leaves from.
  const els = graph({ direction: "TB", nodes: ["a", "b", "c"].map((id) => node(id)), edges: edges(["a", "b"], ["b", "c"], ["c", "a"]) });
  const a = els.find((e) => e.id === "a")!;
  const out = els.find((e) => e.id === "a->b")!;
  const back = els.find((e) => e.id === "c->a#2")!;
  const backEnd = (back.points as [number, number][]).at(-1)!;
  const [xOut, xBack] = [out.x + (out.points as [number, number][])[0][0], back.x + backEnd[0]];
  assert.ok(Math.abs(xOut - xBack) >= 20, `ports ${xOut} and ${xBack} are apart`);
  for (const x of [xOut, xBack]) assert.ok(x > a.x + 8 && x < a.x + a.width - 8, "both on the flat of the side");
});

test("layout quality: a long chain wraps into rows instead of being a strip either way", () => {
  const steps = ["commit", "lint", "unit tests", "build image", "scan image", "push image", "deploy staging", "smoke tests", "approve", "deploy prod", "verify", "announce"];
  const chain: GraphSpec = { nodes: steps.map((id) => node(id)), edges: steps.slice(1).map((to, i) => ({ from: steps[i], to, label: i === 5 ? "tag" : undefined })) };
  const els = graph(chain);
  const b = bounds(els)!;
  const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);
  assert.ok(aspect > 0.75 && aspect < 3, `close to a window's shape, got ${aspect.toFixed(2)}`);
  const rows = new Set(steps.map((id) => els.find((e) => e.id === id)!.y));
  assert.ok(rows.size >= 2 && rows.size <= 4, `${rows.size} rows`);
  // Every row starts at the same left edge and reads left to right.
  const firstOfRow = [...rows].map((y) => Math.min(...steps.map((id) => els.find((e) => e.id === id)!).filter((e) => e.y === y).map((e) => e.x)));
  assert.equal(new Set(firstOfRow).size, 1);
  const arrows = els.filter((e) => e.type === "arrow");
  assert.equal(arrows.length, steps.length - 1);
  for (const a of arrows) assert.ok(isSquare(a.points), `${a.id} runs at right angles`);
  assert.deepEqual(checkLayout(els), { problems: [], suggestions: [] });

  // An explicit direction is respected, and a graph with an edge across the cut isn't wrapped.
  assert.equal(new Set(steps.map((id) => graph({ ...chain, direction: "LR" }).find((e) => e.id === id)!.y)).size, 1);
  const skip = graph({ ...chain, edges: [...chain.edges!, { from: "commit", to: "announce" }] });
  assert.ok(skip.filter((e) => e.type === "arrow").every((a) => a.points.length < 12));
  assert.deepEqual(checkLayout(skip).problems, []);
});

test("layout quality: wrapped rows keep groups whole and carry several edges between rows", () => {
  const ids = "abcdefghijklmnop".split("");
  const spec: GraphSpec = {
    nodes: ids.map((id) => node(id, { label: `step ${id}`, group: "cd".includes(id) ? "pair" : undefined })),
    groups: [{ id: "pair", label: "Pair" }],
    edges: edges(["a", "b"], ["b", "c"], ["b", "d"], ["c", "e"], ["d", "e"], ["e", "f"], ["f", "g"], ["g", "h"], ["g", "i"], ["h", "j"], ["i", "j"], ["j", "k"], ["k", "l"], ["l", "m"], ["m", "n"], ["n", "o"], ["o", "p"]),
  };
  const els = graph(spec);
  const at = (id: string) => els.find((e) => e.id === id)!;
  assert.ok(new Set(ids.map((id) => at(id).y)).size > 3, "more than one row");
  assert.equal(at("c").frameId, "pair");
  assert.equal(at("d").frameId, "pair");
  assert.ok(Math.abs(at("c").x - at("d").x) < 1, "the group's two nodes stay in one layer of one row");
  assert.deepEqual(checkLayout(els).problems, []);
});

test("layout quality: a label is moved off a stretch another edge runs through", () => {
  const spec: GraphSpec = {
    nodes: ["Draft", "Review", "Approved", "Published", "Archived", "Rejected", "Changes"].map((id) => node(id)),
    edges: edges(["Draft", "Review", "submit"], ["Review", "Approved", "approve"], ["Review", "Rejected", "reject"], ["Review", "Changes", "request changes"], ["Changes", "Draft", "revise"], ["Rejected", "Draft", "reopen"], ["Approved", "Published", "publish"], ["Published", "Archived", "archive"], ["Published", "Draft", "new version"], ["Archived", "Draft", "restore"], ["Approved", "Review", "recheck"]),
  };
  for (const direction of ["LR", "TB"] as const) assert.deepEqual(checkLayout(graph({ ...spec, direction })).problems, [], direction);
});

test("an arrow running through another arrow's label is a problem", () => {
  const els = draw([
    box("a", 0, 0),
    box("b", 500, 0),
    box("c", 250, -300),
    box("d", 250, 300),
    { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" }, label: "publishes" },
    { type: "arrow", id: "cd", start: { id: "c" }, end: { id: "d" } },
  ]);
  const c = checkLayout(els);
  assert.equal(c.problems.length, 1, c.problems.join("\n"));
  assert.match(c.problems[0], /^The arrow "c box" → "d box" \(cd\) runs through the arrow label "publishes" \(on ab\)/);
});

test("hand-placed arrows: bound arrows without a path of their own run at right angles", () => {
  const els = draw([
    box("api", 0, 0),
    box("auth", 400, -120),
    box("orders", 400, 120),
    box("queue", 440, 380),
    box("near", 30, 110),
    box("db", 800, 150, { type: "ellipse", height: 90 }),
    { type: "arrow", id: "z", start: { id: "api" }, end: { id: "auth" } },
    { type: "arrow", id: "down", start: { id: "orders" }, end: { id: "queue" } },
    { type: "arrow", id: "side", start: { id: "orders" }, end: { id: "db" } },
    { type: "arrow", id: "close", start: { id: "api" }, end: { id: "near" } },
    { type: "arrow", id: "own", start: { id: "api" }, end: { id: "queue" }, points: [[0, 0], [440, 380]] },
  ]);
  const at = (id: string) => els.find((e) => e.id === id)!;
  // Diagonal neighbours: out of one side, a turn in the gap, into the facing side.
  assert.equal(at("z").points.length, 4);
  assert.ok(isSquare(at("z").points));
  assert.equal(at("z").roundness, null);
  // Rectangles that face each other off-centre: one straight line, not a slant between centres.
  assert.equal(at("down").points.length, 2);
  assert.ok(Math.abs(at("down").points[1][0]) < 1 && at("down").points[1][1] > 100);
  // An ellipse is entered at its middle, so the line turns to get there.
  assert.ok(isSquare(at("side").points) && at("side").points.length === 4);
  assert.ok(isSquare(at("close").points));
  // An arrow drawn with its own points keeps them.
  assert.ok(!isSquare(at("own").points));

  // Moving a shape keeps its arrows square, and re-attaching an arrow routes it the same way.
  let moved = updateElements(els, [{ id: "auth", x: 520, y: -300 }]);
  assert.ok(isSquare(moved.find((e) => e.id === "z")!.points));
  moved = connectArrow(moved, "z", "auth", "queue");
  const z = moved.find((e) => e.id === "z")!;
  assert.ok(isSquare(z.points));
  assert.equal(z.endBinding.elementId, "queue");
  assert.deepEqual(checkLayout(els).problems.filter((p) => !p.includes("(own)")), []);
});

test("layout quality: a diagram's arrows stay square when one of its nodes is moved", () => {
  const els = graph({ ...SHOP, direction: "TB" });
  const moved = updateElements(els, [{ id: "queue", x: els.find((e) => e.id === "queue")!.x + 260 }]);
  for (const a of moved.filter((e) => e.type === "arrow" && [e.startBinding?.elementId, e.endBinding?.elementId].includes("queue"))) assert.ok(isSquare(a.points), `${a.id} still runs at right angles`);
});
