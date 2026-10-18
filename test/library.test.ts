import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findShape, Libraries, LibraryError, type LibraryShape, parseLibrary, placeShape, searchShapes, shapeScale, upgradeElement } from "../src/server/library.js";

const loadShapes = (personal: string, root: string) => new Libraries(fs.mkdtempSync(path.join(os.tmpdir(), "lfx-st-")), personal, undefined).shapes(root);
import { el, writeLibraries } from "./fixtures.js";

test("libraries load from every source, newest format or not, with useful names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-lib-"));
  const personal = path.join(root, "personal.json");
  writeLibraries(root, personal);
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "x", "skip.excalidrawlib"), JSON.stringify({ libraryItems: [{ name: "Hidden", elements: [el("h", "rectangle", 0, 0, 1, 1)] }] }));
  // v1: no names; text inside names items, but text every item shares ("Condition") doesn't.
  const flow = (label: string) => [el(`d${label}`, "diamond", 0, 0, 100, 60), el(`c${label}`, "text", 10, 10, 50, 20, { text: "Condition" }), el(`t${label}`, "text", 10, 40, 30, 20, { text: label })];
  fs.writeFileSync(path.join(root, "flow.excalidrawlib"), JSON.stringify({ type: "excalidrawlib", version: 1, library: [flow("Yes"), flow("No"), flow("Maybe"), [el("o", "ellipse", 0, 0, 10, 10)]] }));
  fs.writeFileSync(path.join(root, "broken.excalidrawlib"), "{");

  const shapes = loadShapes(personal, root);
  assert.deepEqual(shapes.map((s: LibraryShape) => [s.key, s.libraryName]), [
    ["infra/database", "infra"],
    ["infra/message-queue", "infra"],
    ["flow/yes", "flow"],
    ["flow/no", "flow"],
    ["flow/maybe", "flow"],
    ["flow/flow-4", "flow"],
    ["your-excalidraw-library/your-excalidraw-library-1", "Your Excalidraw library"],
  ]);
  const db = shapes[0];
  assert.deepEqual([db.width, db.height], [80, 80]);
  assert.match(db.description, /rectangle, ellipse, text, arrow; text "DB"/);
  assert.equal(parseLibrary(JSON.stringify({ library: [[]] })).length, 1);
  assert.throws(() => parseLibrary("{}"), LibraryError);

  assert.equal(findShape(shapes, "Database").key, "infra/database");
  assert.equal(findShape(shapes, "infra/message-queue").name, "Message Queue");
  assert.equal(findShape(shapes, "queue").key, "infra/message-queue");
  assert.throws(() => findShape(shapes, "flow"), /matches several shapes/);
  assert.throws(() => findShape(shapes, "kubernetes"), /No library shape "kubernetes"/);
  assert.throws(() => findShape([], "x"), /No library shapes are available/);
  // A query must not match the source label ("personal library" contains "person").
  assert.deepEqual(searchShapes(shapes, "person"), []);
  assert.deepEqual(searchShapes(shapes, "message queue").map((s) => s.key), ["infra/message-queue"]);
});

test("old library elements are upgraded to the current format", () => {
  const up = upgradeElement({ ...el("a", "draw", 0, 0, 10, 10), strokeSharpness: "round", boundElementIds: ["x"] } as any);
  assert.equal(up.type, "line");
  assert.deepEqual(up.roundness, { type: 2 });
  assert.deepEqual(up.boundElements, [{ id: "x", type: "arrow" }]);
  assert.equal("boundElementIds" in up, false);
  assert.equal("strokeSharpness" in up, false);
  assert.equal(upgradeElement({ ...el("r", "rectangle", 0, 0, 1, 1), strokeSharpness: "sharp" } as any).roundness, null);
  assert.equal(upgradeElement({ ...el("t", "text", 0, 0, 1, 1), text: "hi" } as any).originalText, "hi");
});

test("installed libraries: import, catalog names, rename, disable and remove", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-st-"));
  const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-bundled-"));
  fs.writeFileSync(path.join(bundled, "figures.excalidrawlib"), JSON.stringify({ library: [[el("s", "line", 0, 0, 20, 40)], [el("t", "line", 0, 0, 20, 40)]] }));
  fs.writeFileSync(path.join(bundled, "manifest.json"), JSON.stringify({ libraries: [{ file: "figures.excalidrawlib", name: "Stick Figures", itemNames: ["Standing", "Waving"] }] }));
  const libs = new Libraries(state, path.join(state, "library.json"), bundled);

  assert.deepEqual(libs.shapes().map((s) => s.key), ["stick-figures/standing", "stick-figures/waving"]);
  const info = libs.install(JSON.stringify({ libraryItems: [{ id: "i1", elements: [el("q", "rectangle", 0, 0, 40, 40)] }] }), { fileName: "my-icons.excalidrawlib" });
  assert.equal(info.id, "installed:my-icons");
  assert.equal(info.name, "my icons");
  assert.deepEqual(libs.list().map((l) => [l.id, l.origin, l.items, l.enabled]), [
    ["built-in:figures", "built-in", 2, true],
    ["installed:my-icons", "installed", 1, true],
  ]);
  assert.equal((fs.statSync(path.join(state, "libraries")).mode & 0o777).toString(8), "700");

  libs.rename("installed:my-icons", "i1", "Queue");
  libs.rename("built-in:figures", "1", "Hello");
  assert.deepEqual(libs.shapes().map((s) => s.name), ["Standing", "Hello", "Queue"]);
  libs.rename("built-in:figures", "1", null);
  libs.setEnabled("built-in:figures", false);
  assert.deepEqual(libs.shapes().map((s) => s.key), ["my-icons/queue"]);
  // A disabled library can still be browsed on its own.
  assert.equal(libs.shapes(undefined, "built-in:figures").length, 2);
  libs.setEnabled("built-in:figures", true);

  // Reinstalling replaces the file; removing deletes it.
  libs.install(JSON.stringify({ libraryItems: [{ elements: [el("z", "ellipse", 0, 0, 5, 5)] }] }), { fileName: "my-icons.excalidrawlib" });
  assert.equal(fs.readdirSync(path.join(state, "libraries")).length, 1);
  libs.remove("installed:my-icons");
  assert.equal(fs.readdirSync(path.join(state, "libraries")).length, 0);
  assert.throws(() => libs.remove("built-in:figures"), /Only installed libraries/);
  assert.throws(() => libs.install("{}", {}), LibraryError);
  assert.throws(() => libs.install(fs.readFileSync(path.join(bundled, "figures.excalidrawlib"), "utf8"), {}), /Stick Figures is already built in/);
  assert.throws(() => libs.install("not json", {}), SyntaxError);
});

test("placing a shape copies it with fresh ids, remapped links, one group and a label", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-lib-"));
  const personal = path.join(root, "personal.json");
  writeLibraries(root, personal);
  const db = findShape(loadShapes(personal, root), "infra/database");
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
  const queue = findShape(loadShapes(personal, root), "message queue");
  const q = placeShape(queue, { x: 0, y: 0, anchorId: "q1" });
  assert.equal(q.elements.length, 1);
  assert.equal(q.elements[0].id, "q1");
  // Placing twice never collides.
  const again = placeShape(db, { x: 0, y: 0 });
  assert.ok(!again.ids.some((id) => ids.includes(id)));
});

test("search knows common diagram synonyms", () => {
  const shape = (key: string, name: string, libraryName = "lib") =>
    ({ key, name, library: "x", libraryName, itemId: "0", elements: [], width: 1, height: 1, description: "" }) as LibraryShape;
  const shapes = [shape("figures/stick-man", "Stick man", "Stick Figures"), shape("icons/user", "User"), shape("sa/database", "Database"), shape("x/queue", "Message Q")];
  assert.deepEqual(searchShapes(shapes, "user").map((s) => s.key), ["icons/user", "figures/stick-man"]);
  assert.deepEqual(searchShapes(shapes, "person").map((s) => s.key).sort(), ["figures/stick-man", "icons/user"]);
  assert.deepEqual(searchShapes(shapes, "db").map((s) => s.key), ["sa/database"]);
  assert.deepEqual(searchShapes(shapes, "kafka").map((s) => s.key), ["x/queue"]);
});

test("an icon's own caption is relabelled instead of getting a second one", () => {
  const icon = [el("head", "ellipse", 20, 0, 20, 20), el("body", "line", 10, 20, 40, 40, { points: [[0, 0], [40, 40]] }), el("cap", "text", 15, 70, 30, 20, { text: "User", fontSize: 16 })];
  const shape = { key: "i/user", name: "User", library: "i", libraryName: "i", itemId: "0", elements: icon, width: 50, height: 90, description: "" } as LibraryShape;
  const placed = placeShape(shape, { x: 0, y: 0, label: "Client", anchorId: "c" });
  const texts = placed.elements.filter((e) => e.type === "text");
  assert.deepEqual(texts.map((t) => t.text), ["Client"]);
  // The arrow target covers the drawing, not the caption.
  const box = placed.elements.find((e) => e.id === "c")!;
  assert.deepEqual([box.y, box.height], [0, 60]);
});

const bundled = () => new Libraries(fs.mkdtempSync(path.join(os.tmpdir(), "lfx-st-")), path.join(os.tmpdir(), "lfx-no-personal.json"), path.resolve("libraries")).shapes();

test("every bundled shape has a meaningful name, and common terms find it", () => {
  const shapes = bundled();
  const manifest = JSON.parse(fs.readFileSync("libraries/manifest.json", "utf8"));
  assert.equal(shapes.length, manifest.libraries.reduce((n: number, l: { items: number }) => n + l.items, 0));
  for (const s of shapes) {
    // No fallback names: "<library> N", the "shape" slug of a name with no letters, filler text.
    assert.doesNotMatch(s.key, /-\d+$/, s.key);
    assert.notEqual(s.key.split("/")[1], "shape", s.key);
    assert.doesNotMatch(`${s.name} ${s.description}`, /lorem ipsum/i, s.key);
  }
  for (const l of manifest.libraries) {
    assert.equal(l.itemNames.length, l.items, l.name);
    if (l.itemUse) assert.equal(l.itemUse.length, l.items, l.name);
  }
  const top = (q: string) => searchShapes(shapes, q)[0]?.key;
  const expect: Record<string, string[]> = {
    postgres: ["system-design-components/relational-db", "software-architecture/database"],
    s3: ["system-design-components/object-storage"],
    "object storage": ["system-design-components/object-storage"],
    "api gateway": ["system-design-components/load-balancer"],
    mongo: ["system-design-components/document-db"],
    nosql: ["system-design-components/document-db"],
    kafka: ["system-design-components/message-queue", "software-architecture/event-bus-or-pipeline"],
    queue: ["system-design-components/message-queue"],
    kubernetes: ["system-design-components/multi-instance-server", "system-design-components/multi-instance-server-wide"],
    lambda: ["software-architecture/microservice"],
    redis: ["system-design-components/key-value-cache", "software-architecture/cache"],
    dns: ["system-design-components/dns"],
    user: ["stick-figures/stick-man", "stick-figures/girl", "stick-figures/guy", "stick-figures/moustache-man"],
  };
  for (const [q, keys] of Object.entries(expect)) assert.ok(keys.includes(top(q)!), `${q} -> ${top(q)}`);
  const pg = shapes.find((s) => s.key === "system-design-components/relational-db")!;
  assert.match(pg.description, /^use for: relational database, SQL, Postgres/);
});

test("a label replaces a component's own caption, inside or below the art, and drops filler text", () => {
  const shapes = bundled();
  const words = (p: ReturnType<typeof placeShape>) => p.elements.filter((e) => e.type === "text" && /[a-z]{2}/i.test(e.text)).map((e) => e.text);
  for (const key of ["system-design-components/load-balancer", "system-design-components/message-queue", "system-design-components/mobile-app", "system-design-components/relational-db"]) {
    const shape = findShape(shapes, key);
    const placed = placeShape(shape, { x: 0, y: 0, label: "Orders" });
    assert.deepEqual(words(placed), ["Orders"], key);
    // Replaced in place: the shape doesn't grow a caption underneath.
    assert.equal(Math.round(placed.bounds.height), shape.height, key);
  }
  // Scaled down for a diagram, an inner caption would be unreadable: it goes, and the label sits below.
  const lb = findShape(shapes, "system-design-components/load-balancer");
  const small = placeShape(lb, { x: 0, y: 0, scale: shapeScale(lb, { normalize: true }), label: "alb-public\n[ALB, HTTPS :443]" });
  assert.deepEqual(words(small), ["alb-public\n[ALB, HTTPS :443]"]);
  assert.equal(small.elements.find((e) => e.type === "text")!.fontSize, 16);
  assert.ok(small.bounds.height > 96);
  // Small text that is part of the drawing stays: the cache's Key/Value cells, the DNS record.
  const cache = placeShape(findShape(shapes, "system-design-components/key-value-cache"), { x: 0, y: 0, label: "Sessions" });
  assert.deepEqual(words(cache).sort(), ["Key", "Key", "Sessions", "Value", "Value"]);
  // A face isn't a caption, so a figure gets its label below.
  const happy = findShape(shapes, "stick-figures/happy");
  const fig = placeShape(happy, { x: 0, y: 0, label: "Customer" });
  assert.deepEqual(words(fig), ["Customer"]);
  assert.equal(fig.elements.filter((e) => e.type === "text").length, 2);
  assert.ok(fig.bounds.height > happy.height);
});
