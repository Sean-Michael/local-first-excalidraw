import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../src/server/config.js";
import { startDaemon } from "../src/server/daemon.js";
import {
  addSkeletons,
  bump,
  connectArrow,
  deleteElements,
  type El,
  live,
  SceneError,
  updateElements,
} from "../src/server/scene.js";
import { DocStore, InvalidDrawingError } from "../src/server/store.js";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`));
const byId = (els: El[], id: string) => els.find((e) => e.id === id)!;
const finite = (e: El) =>
  [e.x, e.y, e.width, e.height, ...((e.points as number[][] | undefined) ?? []).flat()].every((v) => Number.isFinite(v));

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

test("an arrow from a shape to itself is a small loop, not NaN", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
    { type: "arrow", id: "loop", start: { id: "a" }, end: { id: "a" } },
  ]);
  const loop = byId(elements, "loop");
  assert.ok(finite(loop));
  assert.ok(loop.points.length > 2);
  assert.equal(loop.startBinding.elementId, "a");
  assert.equal(loop.endBinding.elementId, "a");
  // Starts on the top edge, ends on the right edge.
  assert.ok(loop.y < 0);
  assert.ok(loop.x + loop.points.at(-1)[0] > 100);
  assert.ok(byId(elements, "a").boundElements.some((b: { id: string }) => b.id === "loop"));
});

test("arrows between shapes with the same centre stay finite", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
    { type: "ellipse", id: "b", x: 0, y: 0, width: 100, height: 60 },
    { type: "rectangle", id: "z", x: 10, y: 10, width: 0, height: 0 },
    { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
    { type: "arrow", id: "az", start: { id: "z" }, end: { id: "z" } },
  ]);
  assert.ok(finite(byId(elements, "ab")));
  assert.ok(finite(byId(elements, "az")));
});

test("the store refuses non-finite coordinates", () => {
  const p = path.join(tmp("finite"), "d.excalidraw");
  const store = new DocStore();
  const [a] = addSkeletons([], [{ type: "rectangle", id: "a", x: 0, y: 0 }]).elements;
  assert.throws(() => store.apply(p, { elements: [{ ...a, x: NaN }] }), SceneError);
  assert.throws(() => store.apply(p, { elements: [{ ...a, type: "arrow", points: [[0, 0], [Infinity, 1]] }] }), SceneError);
  assert.equal(fs.existsSync(p), false);
});

test("unknown element types are rejected with a suggestion", () => {
  assert.throws(() => addSkeletons([], [{ type: "box", x: 0, y: 0 }]), /Unknown element type "box"; did you mean "rectangle"\?/);
  assert.throws(() => addSkeletons([], [{ type: "elipse", x: 0, y: 0 }]), /did you mean "ellipse"/);
  assert.throws(() => addSkeletons([], [{ type: "zzzzzzzzzz" }]), SceneError);
  // Raw types Excalidraw knows still pass through.
  const { elements } = addSkeletons([], [{ type: "freedraw", id: "f", x: 0, y: 0, points: [[0, 0], [5, 5]] }]);
  assert.equal(byId(elements, "f").type, "freedraw");
});

test("moving a frame moves its children; their arrows re-route", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0, label: "A" },
    { type: "rectangle", id: "b", x: 0, y: 200, label: "B" },
    { type: "rectangle", id: "out", x: 600, y: 0 },
    { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
    { type: "arrow", id: "ao", start: { id: "a" }, end: { id: "out" } },
    { type: "frame", id: "f", name: "F", children: ["a", "b"] },
  ]);
  const f = byId(elements, "f");
  const next = updateElements(elements, [{ id: "f", x: f.x + 50, y: f.y + 30 }]);
  assert.equal(byId(next, "a").x, 50);
  assert.equal(byId(next, "a").y, 30);
  assert.equal(byId(next, "b").y, 230);
  assert.equal(byId(next, "out").x, 600, "outside the frame: stays");
  const label = next.find((e) => e.containerId === "a")!;
  assert.ok(label.x > 50 && label.y > 30, "label follows");
  const ao = byId(next, "ao");
  assert.ok(ao.version > byId(elements, "ao").version, "arrow to the outside re-routed");
  assert.ok(Math.abs(ao.x - (50 + 120 + 6)) < 1, "starts at the moved box's right edge");
});

test("moving a library shape's anchor moves its whole group", () => {
  const shape = (id: string, x: number, y: number) =>
    addSkeletons([], [{ type: "rectangle", id, x, y, width: 40, height: 40 }]).elements.map((e) => ({ ...e, groupIds: ["inner", "outer"] }));
  const els = [...shape("anchor", 0, 0), ...shape("part", 10, 50), ...addSkeletons([], [{ type: "ellipse", id: "other", x: 300, y: 0 }]).elements];
  const next = updateElements(els, [{ id: "anchor", x: 100 }]);
  assert.equal(byId(next, "anchor").x, 100);
  assert.equal(byId(next, "part").x, 110);
  assert.equal(byId(next, "part").y, 50);
  assert.equal(byId(next, "other").x, 300);
});

test("connectArrow binds an existing free arrow and detaches it from its old end", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0 },
    { type: "rectangle", id: "b", x: 300, y: 0 },
    { type: "rectangle", id: "c", x: 0, y: 300 },
    { type: "arrow", id: "free", x: 50, y: 50, points: [[0, 0], [30, 80], [100, 100]] },
    { type: "arrow", id: "bound", start: { id: "a" }, end: { id: "c" } },
  ]);
  const next = connectArrow(elements, "free", "a", "b");
  const free = byId(next, "free");
  assert.equal(free.startBinding.elementId, "a");
  assert.equal(free.endBinding.elementId, "b");
  assert.equal(free.points.length, 2, "re-routed straight");
  assert.ok(byId(next, "a").boundElements.some((b: { id: string }) => b.id === "free"));
  assert.ok(byId(next, "b").boundElements.some((b: { id: string }) => b.id === "free"));
  const moved = connectArrow(next, "bound", "a", "b");
  assert.ok(!byId(moved, "c").boundElements?.some((b: { id: string }) => b.id === "bound"), "old end forgets it");
  assert.throws(() => connectArrow(next, "a", "b", "c"), /not an arrow/);
  assert.throws(() => connectArrow(next, "free", "a", "nope"), SceneError);
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test("an unparseable drawing is reported clearly and can be discarded", () => {
  const p = path.join(tmp("conflict"), "d.excalidraw");
  fs.writeFileSync(p, '<<<<<<< HEAD\n{"elements":[]}\n=======\n{"elements":[1]}\n>>>>>>> other\n');
  const store = new DocStore();
  assert.throws(() => store.get(p), (e: Error) => e instanceof InvalidDrawingError && /is not valid Excalidraw JSON \(merge conflict\?\).*conflict markers/s.test(e.message));
  store.discardInvalid(p);
  const [a] = addSkeletons([], [{ type: "rectangle", id: "a", x: 0, y: 0 }]).elements;
  store.apply(p, { elements: [a], replace: true });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).elements[0].id, "a");
});

test("deleted elements stay deleted after a restart when a stale tab saves them", () => {
  const stateDir = tmp("state");
  const p = path.join(tmp("tomb"), "d.excalidraw");
  let store = new DocStore({ stateDir });
  const els = addSkeletons([], [{ type: "rectangle", id: "keep", x: 0, y: 0 }, { type: "rectangle", id: "gone", x: 200, y: 0 }]).elements;
  store.apply(p, { elements: els });
  const stale = store.get(p).scene.elements.map((e) => ({ ...e }));
  store.apply(p, { elements: deleteElements(store.get(p).scene.elements, ["gone"]).elements });
  assert.ok(fs.existsSync(path.join(stateDir, "tombstones.json")), "sidecar lives in the state dir");
  assert.ok(!fs.readdirSync(path.dirname(p)).some((f) => f !== "d.excalidraw"), "nothing next to the drawing");

  // Restart: the file has no tombstones, but the sidecar remembers.
  store = new DocStore({ stateDir });
  store.apply(p, { elements: stale, fromEditor: true });
  const onDisk = JSON.parse(fs.readFileSync(p, "utf8")).elements.map((e: El) => e.id);
  assert.deepEqual(onDisk, ["keep"]);
  // A genuinely newer edit of that element (e.g. undo in the tab) still wins.
  const undone = bump(bump(bump(stale.find((e) => e.id === "gone")!)));
  store.apply(p, { elements: [undone], fromEditor: true });
  assert.ok(live(store.get(p).scene.elements).some((e) => e.id === "gone"));

  // Agents re-creating a deleted id after a restart aren't affected.
  store.apply(p, { elements: deleteElements(store.get(p).scene.elements, ["gone"]).elements });
  store = new DocStore({ stateDir });
  const again = addSkeletons(store.get(p).scene.elements, [{ type: "rectangle", id: "gone", x: 0, y: 300 }]).elements;
  store.apply(p, { elements: again });
  assert.ok(live(store.get(p).scene.elements).some((e) => e.id === "gone"));
});

// ---------------------------------------------------------------------------
// Daemon operations
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

let server: http.Server;
let cfg: Config;
let root: string;
let token: string;

before(async () => {
  const port = await freePort();
  root = tmp("core-root");
  cfg = {
    stateDir: tmp("core-state"),
    host: "127.0.0.1",
    port,
    allowedHosts: new Set([`127.0.0.1:${port}`]),
    defaultRoots: [root],
    allowRootRegistration: true,
    webDir: tmp("core-web"),
  };
  server = await startDaemon(cfg);
  token = fs.readFileSync(path.join(cfg.stateDir, "token"), "utf8").trim();
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const op = async (body: Record<string, unknown>) => {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/op`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")).elements as El[];

test("ops on a drawing with merge conflict markers return 422, and overwrite recovers it", async () => {
  const file = path.join(root, "conflict.excalidraw");
  fs.writeFileSync(file, '<<<<<<< HEAD\n{"type":"excalidraw","elements":[]}\n=======\n{}\n>>>>>>> branch\n');
  const r = await op({ op: "read", path: file });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /conflict\.excalidraw is not valid Excalidraw JSON \(merge conflict\?\)/);
  assert.equal((await op({ op: "add", path: file, elements: [{ type: "rectangle", x: 0, y: 0 }] })).status, 422);
  const c = await op({ op: "create", path: file, overwrite: true, elements: [{ type: "rectangle", id: "a", x: 0, y: 0 }] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(read(file).map((e) => e.id), ["a"]);
});

test("create_diagram replace is one write, and reused ids replace the old elements", async () => {
  const file = path.join(root, "replace.excalidraw");
  const graph = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };
  await op({ op: "diagram", path: file, graph });
  await op({ op: "add", path: file, elements: [{ type: "ellipse", id: "extra", x: 0, y: 500 }] });
  const before = (await op({ op: "read", path: file })).body.rev;
  const r = await op({ op: "diagram", path: file, replace: true, graph: { ...graph, nodes: [{ id: "a", label: "Alpha" }, { id: "b", label: "B" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rev, before + 1, "a single revision");
  const els = read(file);
  assert.ok(!els.some((e) => e.id === "extra"), "old content is gone");
  assert.equal(byId(els, "a").x, 0, "laid out from the origin, not appended");
  assert.ok(els.some((e) => e.type === "text" && e.text === "Alpha"));
  assert.ok(!els.some((e) => e.id.includes("-a")), "ids are not namespaced");
  // A failed layout leaves the drawing untouched.
  const bad = await op({ op: "diagram", path: file, replace: true, graph: { nodes: [{ id: "x", label: "X" }], edges: [{ from: "x", to: "nope" }] } });
  assert.equal(bad.status, 400);
  assert.deepEqual(read(file).map((e) => e.id).sort(), els.map((e) => e.id).sort());
});

test("connect binds an existing arrow instead of drawing a new one", async () => {
  const file = path.join(root, "connect.excalidraw");
  await op({
    op: "create",
    path: file,
    elements: [
      { type: "rectangle", id: "a", x: 0, y: 0 },
      { type: "rectangle", id: "b", x: 300, y: 0 },
      { type: "arrow", id: "free", x: 0, y: 200 },
    ],
  });
  const r = await op({ op: "connect", path: file, id: "free", from: "a", to: "b", label: "calls" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rebound, true);
  const els = read(file);
  assert.equal(els.filter((e) => e.type === "arrow").length, 1);
  assert.equal(byId(els, "free").endBinding.elementId, "b");
  assert.ok(els.some((e) => e.containerId === "free" && e.text === "calls"));
  const n = await op({ op: "connect", path: file, from: "b", to: "a", id: "back" });
  assert.equal(n.body.rebound, false);
  assert.equal(n.body.id, "back");
  assert.equal((await op({ op: "connect", path: file, from: "a", to: "b", id: "a" })).status, 400);
  assert.equal((await op({ op: "add", path: file, elements: [{ type: "box" }] })).status, 400);
});
