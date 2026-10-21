/**
 * Recovery paths for weaker models: argument repair and reporting, errors that name the fix,
 * group ids, library lookups by slug or primitive name, and lifelines cut behind labels.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { checkArgs } from "../src/server/args.js";
import { resolveInRoot } from "../src/server/code.js";
import { findSymbol } from "../src/server/explore.js";
import { layoutGraph } from "../src/server/layout.js";
import { findShape, type LibraryShape } from "../src/server/library.js";
import { addSkeletons, arrangeElements, deleteElements, type El, gapLifelines, repeatedLabels, updateElements } from "../src/server/scene.js";
import { drawingTools, normalizeGraphArgs, type ToolContext } from "../src/server/tools.js";

const input = {
  nodes: z.array(z.object({ id: z.string(), label: z.string(), shape: z.string().optional() })),
  edges: z.array(z.object({ from: z.string(), to: z.string().describe("id of the node the edge points to") })).optional(),
};

test("unknown fields are reported with the field meant, once for all the items that share them", () => {
  const r = checkArgs(input, { nodes: [{ id: "a", label: "A", type: "ellipse" }, { id: "b", label: "B", type: "ellipse" }], colour: "red" });
  assert.ok(r.ok);
  assert.deepEqual(r.data.nodes, [{ id: "a", label: "A" }, { id: "b", label: "B" }]);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /nodes\[0–1\]\.type \(did you mean `shape`\?\)/);
  assert.match(r.notes[0], /; colour$|; colour\.$/);
});

test("a validation error repeated across items is reported once, with the field's description", () => {
  const r = checkArgs(input, { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a" }, { from: "a" }, { from: "a" }] });
  assert.ok(!r.ok);
  assert.equal(r.error, "Invalid arguments: edges[0–2].to: missing (id of the node the edge points to)");
});

test("normalizeGraphArgs moves edges and nodes into the right lists and maps type", () => {
  const a: Record<string, unknown> = {
    nodes: [{ id: "u", label: "User", type: "ellipse" }, { id: "e", from: "u", to: "s" }],
    edges: [{ id: "s", from: "s", label: "Server" }, { id: "u", from: "u", label: "User again" }, { from: "u", to: "s", type: "dependency" }],
  };
  const notes = normalizeGraphArgs(a);
  assert.deepEqual(a.nodes, [{ id: "u", label: "User", shape: "ellipse" }, { id: "s", label: "Server" }]);
  assert.deepEqual(a.edges, [{ id: "e", from: "u", to: "s" }, { from: "u", to: "s", relation: "dependency" }]);
  assert.equal(notes.length, 5);
  assert.match(notes.join("\n"), /Dropped edges u: they had no `to` and repeat nodes already listed/);
  assert.doesNotMatch(notes.join("\n"), /sequenceDiagram/, "only message edges suggest a sequence diagram");
});

test("an edge to an unknown node lists the node ids and suggests the nearest", () => {
  assert.throws(
    () => layoutGraph({ nodes: [{ id: "chat", label: "Chat" }, { id: "server", label: "Server" }], edges: [{ from: "chat", to: "servr" }] }),
    /references "servr" \(did you mean "server"\?\), which isn't a node\. Node ids are: chat, server\. Add the missing node/,
  );
});

const grouped = (): El[] =>
  addSkeletons([], [
    { type: "rectangle", id: "head", x: 0, y: 0, width: 40, height: 40, groupIds: ["fig"] },
    { type: "rectangle", id: "body", x: 0, y: 50, width: 40, height: 80, groupIds: ["fig"] },
    { type: "rectangle", id: "box", x: 300, y: 0, width: 100, height: 60 },
  ]).elements;

test("a group id gets an explanation from update_elements, and works in delete and arrange", () => {
  assert.throws(() => updateElements(grouped(), [{ id: "fig", x: 10 }]), /"fig" is a group id, not an element id\. Its members are head, body/);
  assert.throws(() => updateElements(grouped(), [{ id: "bx", x: 10 }]), /Element "bx" not found; did you mean "box"\?/);
  const { elements } = deleteElements(grouped(), ["fig"]);
  assert.deepEqual(elements.filter((e) => !e.isDeleted).map((e) => e.id), ["box"]);
  const moved = arrangeElements(grouped(), ["fig", "box"], { align: "top" });
  assert.equal(moved.find((e) => e.id === "box")!.y, 0);
});

test("lifelines are cut where a label crosses them; other lines are untouched", () => {
  const els: El[] = [
    { id: "life", type: "line", x: 100, y: 0, width: 0, height: 600, points: [[0, 0], [0, 600]], groupIds: [] },
    { id: "short", type: "line", x: 100, y: 0, width: 0, height: 100, points: [[0, 0], [0, 100]], groupIds: [] },
    { id: "msg", type: "text", x: 60, y: 200, width: 120, height: 20, text: "GET bottle" },
    { id: "far", type: "text", x: 400, y: 300, width: 80, height: 20, text: "elsewhere" },
  ] as unknown as El[];
  const out = gapLifelines(els);
  const pieces = out.filter((e) => e.id.startsWith("life"));
  assert.deepEqual(pieces.map((e) => [e.id, e.y, e.height]), [["life", 0, 196], ["life-2", 224, 376]]);
  assert.deepEqual(pieces[1].points, [[0, 0], [0, 376]]);
  assert.ok(out.some((e) => e.id === "short" && e.height === 100));
});

const shape = (key: string, name: string): LibraryShape =>
  ({ key, name, library: "builtin:x", libraryName: "Basic UX/wireframing elements", itemId: key, elements: [], width: 10, height: 10, description: "" }) as LibraryShape;

test("asking the library for an arrow or a box points at the drawing tools", () => {
  const shapes = [shape("basic-ux-wireframing-elements/go-back-arrow", "go back arrow"), shape("basic-ux-wireframing-elements/go-forward-arrow", "go forward arrow")];
  assert.throws(() => findShape(shapes, "arrow"), /"arrow" isn't a library shape: draw connections as create_diagram edges/);
  assert.throws(() => findShape(shapes, "go"), /matches several shapes: basic-ux-wireframing-elements\/go-back-arrow, basic-ux-wireframing-elements\/go-forward-arrow\. Pass one/);
});

test("list_shapes finds a library by the slug its shape keys start with", async () => {
  const tool = drawingTools({ currentDrawing: false }).find((t) => t.name === "list_shapes")!;
  const ctx = {
    projectRoot: "/tmp",
    op: async () => ({
      libraries: [{ id: "builtin:sdc", name: "System Design Components", origin: "built-in", items: 1, enabled: true }],
      shapes: [{ ...shape("system-design-components/database", "database"), library: "builtin:sdc", libraryName: "System Design Components" }],
    }),
  } as unknown as ToolContext;
  const out = await tool.run({ library: "system-design-components", query: "database" }, ctx);
  assert.match(out.text, /system-design-components\/database: "database"/);
});

test("repeatedLabels spots a diagram drawn again, but not one that shares a node or two", () => {
  const els = addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60, label: "Gateway" },
    { type: "rectangle", id: "b", x: 200, y: 0, width: 100, height: 60, label: "«abstract»\nFormula\n────\n+name: String" },
    { type: "rectangle", id: "c", x: 400, y: 0, width: 100, height: 60, label: "Ledger" },
  ]).elements;
  assert.deepEqual(repeatedLabels(els, ["gateway", "Formula", "Ledger"]), ["gateway", "formula", "ledger"]);
  assert.deepEqual(repeatedLabels(els, ["Gateway", "Billing", "Queue", "Worker"]), []);
  assert.deepEqual(repeatedLabels(els, ["Gateway"]), [], "one node isn't a diagram");
});

test("repeatedLabels ignores spacing and case, so a Mermaid redraw of a graph is caught", () => {
  const els = addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60, label: "Order Service" },
    { type: "rectangle", id: "b", x: 200, y: 0, width: 100, height: 60, label: "Payment Provider" },
  ]).elements;
  assert.deepEqual(repeatedLabels(els, ["OrderService", "payment-provider"]), ["orderservice", "payment-provider"]);
});

test("find_symbol references skip drawings, and a missing path names the project's folders", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lfx-weak-")));
  fs.mkdirSync(path.join(root, "services", "orders"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "diagrams"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "services", "orders", "repo.ts"), "export class OrderRepository {}\nnew OrderRepository();\n");
  fs.writeFileSync(path.join(root, "docs", "diagrams", "a.excalidraw"), '{"id": "OrderRepository"}\n');
  const out = findSymbol(root, { name: "OrderRepository", references: true });
  assert.match(out, /services\/orders\/repo\.ts:2/);
  assert.doesNotMatch(out, /a\.excalidraw/);
  assert.throws(() => resolveInRoot(root, "src"), /No such file or directory: src\. Paths are relative to the project root, whose folders are: docs, services\./);
});
