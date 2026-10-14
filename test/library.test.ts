import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findShape, LibraryError, loadShapes, parseLibrary, placeShape, shapeScale } from "../src/server/library.js";
import { el, writeLibraries } from "./fixtures.js";

test("libraries load from the personal file and project .excalidrawlib files, v1 and v2", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-lib-"));
  const personal = path.join(root, "personal.json");
  writeLibraries(root, personal);
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "x", "skip.excalidrawlib"), JSON.stringify({ libraryItems: [{ name: "Hidden", elements: [el("h", "rectangle", 0, 0, 1, 1)] }] }));
  fs.writeFileSync(path.join(root, "old.excalidrawlib"), JSON.stringify({ type: "excalidrawlib", version: 1, library: [[el("o", "ellipse", 0, 0, 10, 10)]] }));
  fs.writeFileSync(path.join(root, "broken.excalidrawlib"), "{");

  const shapes = loadShapes(personal, root);
  assert.deepEqual(shapes.map((s) => [s.key, s.source]), [
    ["item-1", "personal library"],
    ["database", "design/infra.excalidrawlib"],
    ["message-queue", "design/infra.excalidrawlib"],
    ["old-1", "old.excalidrawlib"],
  ]);
  const db = shapes[1];
  assert.deepEqual([db.width, db.height], [80, 80]);
  assert.match(db.description, /rectangle, ellipse, text, arrow; text "DB"/);
  assert.equal(parseLibrary(JSON.stringify({ library: [[]] })).length, 1);
  assert.throws(() => parseLibrary("{}"), LibraryError);

  assert.equal(findShape(shapes, "Database").key, "database");
  assert.equal(findShape(shapes, "message queue").key, "message-queue");
  assert.equal(findShape(shapes, "queue").key, "message-queue");
  assert.throws(() => findShape(shapes, "e"), /matches several shapes/);
  assert.throws(() => findShape(shapes, "kubernetes"), /No library shape "kubernetes"/);
  assert.throws(() => findShape([], "x"), /library is empty/);
});

test("placing a shape copies it with fresh ids, remapped links, one group and a label", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-lib-"));
  const personal = path.join(root, "personal.json");
  writeLibraries(root, personal);
  const db = findShape(loadShapes(personal, root), "database");
  const scale = shapeScale(db, { width: 160 });
  assert.equal(scale, 2);
  const placed = placeShape(db, { x: 500, y: 300, scale, label: "Orders DB", anchorId: "orders" });
  const by = new Map(placed.elements.map((e) => [e.type === "text" && e.text === "Orders DB" ? "label" : e.type, e]));

  // A multi-part shape gets an invisible box around the icon as its arrow target, with the requested id.
  assert.equal(placed.anchorId, "orders");
  const box = placed.elements[0];
  assert.equal(box.id, "orders");
  assert.equal(box.strokeColor, "transparent");
  assert.deepEqual([box.x, box.y, box.width, box.height], [500, 300, 160, 160]);
  const body = by.get("rectangle")!;
  assert.notEqual(body.id, "orders");
  assert.deepEqual([body.x, body.y, body.width, body.height], [500, 340, 160, 120]);
  assert.deepEqual([by.get("ellipse")!.x, by.get("ellipse")!.y], [500, 300]);
  // Internal references follow the new ids; references to elements outside the item are dropped.
  const text = placed.elements.find((e) => e.text === "DB")!;
  const arrow = by.get("arrow")!;
  assert.equal(text.containerId, body.id);
  assert.equal(text.fontSize, 40);
  assert.deepEqual(body.boundElements.map((b: { id: string }) => b.id).sort(), [arrow.id, text.id].sort());
  assert.equal(arrow.startBinding.elementId, body.id);
  assert.equal(arrow.endBinding, null);
  assert.deepEqual(arrow.points, [[0, 0], [40, 0]]);
  // Fresh identity, one shared outer group (inner groups remapped), no stale fractional index.
  const ids = placed.elements.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const old of ["body", "cap", "lbl", "inner"]) assert.ok(!ids.includes(old));
  const outer = placed.elements[0].groupIds.at(-1);
  for (const e of placed.elements) {
    assert.equal(e.groupIds.at(-1), outer);
    assert.equal(e.version, 1);
    assert.equal(e.index, undefined);
  }
  assert.ok(!placed.elements.some((e) => e.groupIds.includes("g1")));
  // The label sits centred under the shape.
  const label = by.get("label")!;
  assert.ok(label.y > 300 + 160);
  assert.ok(Math.abs(label.x + label.width / 2 - 580) < 1);
  assert.equal(placed.bounds.width, 160);
  assert.ok(placed.bounds.height > 160);
  // A single-shape item is its own arrow target.
  const queue = findShape(loadShapes(personal, root), "queue");
  const q = placeShape(queue, { x: 0, y: 0, anchorId: "q1" });
  assert.equal(q.elements.length, 1);
  assert.equal(q.elements[0].id, "q1");
  // Placing twice never collides.
  const again = placeShape(db, { x: 0, y: 0 });
  assert.ok(!again.ids.some((id) => ids.includes(id)));
});
