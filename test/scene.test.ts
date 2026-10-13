import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { layoutGraph } from "../src/server/layout.js";
import {
  addSkeletons,
  bump,
  deleteElements,
  describe,
  type El,
  emptyScene,
  live,
  mergeElements,
  parseScene,
  serializeScene,
  tombstonesFor,
  updateElements,
} from "../src/server/scene.js";
import { resolveSafePath } from "../src/server/security.js";
import { DocStore } from "../src/server/store.js";

const byId = (els: El[], id: string) => els.find((e) => e.id === id)!;

test("labels are bound text centred in their container", () => {
  const { elements } = addSkeletons([], [{ type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 100, label: "Hi" }]);
  const rect = byId(elements, "a");
  const text = elements.find((e) => e.type === "text")!;
  assert.equal(text.containerId, "a");
  assert.deepEqual(rect.boundElements, [{ id: text.id, type: "text" }]);
  assert.ok(Math.abs(text.x + text.width / 2 - 100) < 1);
  assert.ok(Math.abs(text.y + text.height / 2 - 50) < 1);
});

test("arrows bind to shapes and stop at their outlines", () => {
  const { elements } = addSkeletons(
    [],
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 100 },
      { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
    ],
  );
  const arrow = byId(elements, "ab");
  assert.equal(arrow.startBinding.elementId, "a");
  assert.equal(arrow.endBinding.elementId, "b");
  assert.ok(arrow.x > 100 && arrow.x < 110, `start x ${arrow.x}`);
  assert.ok(arrow.x + arrow.points[1][0] < 300 && arrow.x + arrow.points[1][0] > 290);
  assert.deepEqual(byId(elements, "a").boundElements, [{ id: "ab", type: "arrow" }]);
});

test("moving a shape re-routes its arrows and keeps the label centred", () => {
  let { elements } = addSkeletons(
    [],
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100, label: "A" },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 100 },
      { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
    ],
  );
  const before = byId(elements, "ab");
  elements = updateElements(elements, [{ id: "b", y: 300 }]);
  const after = byId(elements, "ab");
  assert.ok(after.version > before.version);
  assert.ok(after.points[1][1] > 100, "arrow now points downwards");
  const label = elements.find((e) => e.containerId === "a")!;
  elements = updateElements(elements, [{ id: "a", x: 500 }]);
  const moved = byId(elements, label.id);
  assert.ok(Math.abs(moved.x + moved.width / 2 - 550) < 1);
});

test("deleting a shape removes its label and detaches arrows", () => {
  const { elements } = addSkeletons(
    [],
    [
      { type: "rectangle", id: "a", x: 0, y: 0, label: "A" },
      { type: "rectangle", id: "b", x: 300, y: 0 },
      { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
    ],
  );
  const r = deleteElements(elements, ["a"]);
  assert.equal(live(r.elements).filter((e) => e.type === "text").length, 0);
  assert.equal(byId(r.elements, "ab").startBinding, null);
  assert.equal(byId(r.elements, "ab").isDeleted, false);
});

test("merge: higher version wins, tombstones propagate", () => {
  const { elements } = addSkeletons([], [{ type: "rectangle", id: "a", x: 0, y: 0 }]);
  const a = elements[0];
  const edited = bump(a, { x: 50 });
  assert.equal(mergeElements([edited], [a])[0].x, 50, "stale copy loses");
  assert.equal(mergeElements([a], [edited])[0].x, 50, "newer copy wins");
  const gone = tombstonesFor([edited], []);
  assert.equal(mergeElements([edited], gone)[0].isDeleted, true);
});

test("re-creating a deleted id outranks its tombstone (regression)", () => {
  const first = addSkeletons([], [{ type: "rectangle", id: "web", x: 0, y: 0 }]).elements;
  const deleted = mergeElements(first, tombstonesFor(first, []));
  const again = addSkeletons(deleted, [{ type: "rectangle", id: "web", x: 10, y: 0 }]).elements;
  const merged = mergeElements(deleted, again);
  assert.equal(live(merged).length, 1);
  assert.equal(byId(merged, "web").x, 10);
});

test("frames adopt their children", () => {
  const { elements } = addSkeletons(
    [],
    [
      { type: "rectangle", id: "a", x: 0, y: 0, label: "A" },
      { type: "frame", id: "f", name: "Group", children: ["a"] },
    ],
  );
  assert.equal(byId(elements, "a").frameId, "f");
  assert.equal(elements.find((e) => e.containerId === "a")!.frameId, "f");
  const f = byId(elements, "f");
  assert.ok(f.x < 0 && f.y < 0 && f.width > 120);
});

test("layout puts dependents in later layers and handles cycles", () => {
  const els = layoutGraph({
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ],
  });
  const x = (id: string) => els.find((e) => e.id === id)!.x!;
  assert.ok(x("a") < x("b") && x("b") < x("c"));
  const built = addSkeletons([], els).elements;
  assert.equal(live(built).filter((e) => e.type === "arrow").length, 3);
});

test("describe lists labels and connections", () => {
  const scene = emptyScene();
  scene.elements = addSkeletons(
    [],
    [
      { type: "rectangle", id: "api", x: 0, y: 0, label: "API", color: "blue" },
      { type: "ellipse", id: "db", x: 300, y: 0, label: "DB" },
      { type: "arrow", id: "q", start: { id: "api" }, end: { id: "db" }, label: "SQL" },
    ],
  ).elements;
  const d = describe(scene);
  assert.match(d, /\[api\] rectangle .*"API" fill=blue/);
  assert.match(d, /\[q\] arrow api -> db "SQL"/);
  assert.doesNotMatch(d, /\] text/, "bound labels are folded into their containers");
});

test("serialised files drop tombstones and round-trip", () => {
  const scene = emptyScene();
  const els = addSkeletons([], [{ type: "rectangle", id: "a", x: 0, y: 0 }, { type: "rectangle", id: "b", x: 0, y: 0 }]).elements;
  scene.elements = mergeElements(els, tombstonesFor([byId(els, "b")], []));
  const back = parseScene(serializeScene(scene));
  assert.deepEqual(back.elements.map((e) => e.id), ["a"]);
});

test("paths outside the roots, wrong extensions and symlink escapes are rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-out-"));
  fs.symlinkSync(outside, path.join(root, "escape"));
  assert.ok(resolveSafePath(path.join(root, "a/b/new.excalidraw"), [root]).endsWith("new.excalidraw"));
  assert.throws(() => resolveSafePath(path.join(root, "../x.excalidraw"), [root]));
  assert.throws(() => resolveSafePath(path.join(root, "notes.txt"), [root]));
  assert.throws(() => resolveSafePath(path.join(root, "escape/x.excalidraw"), [root]));
  assert.throws(() => resolveSafePath("relative.excalidraw", [root]));
});

test("store picks up external edits and deletions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-store-"));
  const p = path.join(dir, "d.excalidraw");
  const store = new DocStore();
  const els = addSkeletons([], [{ type: "rectangle", id: "a", x: 0, y: 0 }]).elements;
  store.apply(p, { elements: els, replace: true });
  // An external writer changes x without bumping the version.
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.elements[0].x = 99;
  fs.writeFileSync(p, JSON.stringify(raw));
  const after = store.get(p).scene.elements[0];
  assert.equal(after.x, 99);
  assert.ok(after.version > els[0].version, "external change outranks cached copy");
  let deleted = false;
  store.on("deleted", () => (deleted = true));
  fs.unlinkSync(p);
  assert.equal(store.get(p).exists, false);
  assert.ok(deleted);
});
