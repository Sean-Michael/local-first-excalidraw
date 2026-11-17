/**
 * What the page decides without a browser: how tool calls read in the chat panel, and how the
 * editor's chrome adapts to the width it has.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolCatalog } from "../src/server/ai/agent.js";
import { SettingsStore } from "../src/server/ai/settings.js";
import { codeTools, drawingTools } from "../src/server/tools.js";
import type { ToolPart } from "../src/shared/chat.js";
import { CHAT_WIDTH, compactTopBar, MIN_CANVAS_WITH_CHAT, sidebarShouldYield } from "../src/shared/layout.js";
import { errorLine, FAILED_LABELS, shortPath, TOOL_LABELS, toolLabel, toolSummary } from "../src/shared/tool-labels.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const part = (name: string, args: unknown, extra: Partial<ToolPart> = {}): ToolPart => ({
  type: "tool",
  callId: "c1",
  name,
  args: typeof args === "string" ? args : JSON.stringify(args),
  status: "ok",
  ...extra,
});

const DRAWING = "/Users/me/code/shop/docs/diagrams/shop.excalidraw";

// ---------------------------------------------------------------------------
// Tool chips
// ---------------------------------------------------------------------------

test("every tool the assistant can call has a label, so no chip shows a raw tool name", () => {
  const names = new Set([...drawingTools({ currentDrawing: true }), ...drawingTools({ currentDrawing: false }), ...codeTools()].map((t) => t.name));
  // The settings page lists the same tools; it must not know one the registry doesn't.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-labels-"));
  for (const t of toolCatalog(new SettingsStore(stateDir)).tools) names.add(t.name);
  assert.ok(names.size > 25, "the registry should list the drawing and code tools");
  const missing = [...names].filter((n) => !TOOL_LABELS[n]);
  assert.deepEqual(missing, [], "add these to TOOL_LABELS in src/shared/tool-labels.ts");
  for (const n of ["Read", "Grep", "Glob"]) assert.ok(TOOL_LABELS[n], `Claude Code's ${n}`);
  // A failure label only makes sense for a tool that exists.
  assert.deepEqual(Object.keys(FAILED_LABELS).filter((n) => !names.has(n)), []);
});

test("a failed call never reads as a success, and an unknown tool is still readable", () => {
  assert.equal(toolLabel({ name: "create_diagram", status: "ok" }), "Drew a diagram");
  assert.equal(toolLabel({ name: "create_diagram", status: "running" }), "Drew a diagram");
  assert.equal(toolLabel({ name: "create_diagram", status: "error" }), "Couldn't draw the diagram");
  assert.equal(toolLabel({ name: "read_file", status: "error" }), "Read a file (failed)");
  assert.equal(toolLabel({ name: "brand_new_tool", status: "ok" }), "Brand new tool");
  assert.equal(toolLabel({ name: "brand_new_tool", status: "error" }), "Brand new tool (failed)");
});

test("shortPath reads from the project down and keeps the file name", () => {
  // An absolute path loses what it shares with the open drawing's folder.
  assert.equal(shortPath("/Users/me/code/shop/docker-compose.yml", DRAWING), "docker-compose.yml");
  assert.equal(shortPath("/Users/me/code/shop/services/orders/server.ts", DRAWING), "services/orders/server.ts");
  assert.equal(shortPath("/Users/me/code/shop/services/orders/src/repo/orderRepository.ts", DRAWING), "…/src/repo/orderRepository.ts");
  assert.equal(shortPath("/Users/me/code/shop/docs/diagrams/other.excalidraw", DRAWING), "other.excalidraw");
  // Outside the project, or with no drawing to compare with: the last folders.
  assert.equal(shortPath("/etc/hosts", DRAWING), "etc/hosts");
  assert.equal(shortPath("/Users/me/code/shop/services/orders/server.ts"), "orders/server.ts");
  // Relative paths are already short; long ones keep their end.
  assert.equal(shortPath("src/server.ts", DRAWING), "src/server.ts");
  assert.equal(shortPath("a/b/c/d/e.ts"), "…/c/d/e.ts");
  // Windows paths.
  assert.equal(shortPath("C:\\code\\shop\\src\\a.ts", "C:\\code\\shop\\docs\\d.excalidraw"), "src/a.ts");
});

test("toolSummary says what a call was about", () => {
  assert.equal(toolSummary(part("Read", { file_path: "/Users/me/code/shop/services/orders/server.ts" }), DRAWING), "services/orders/server.ts");
  assert.equal(toolSummary(part("read_file", { path: "services/orders/server.ts", start: 1 }), DRAWING), "services/orders/server.ts");
  assert.equal(toolSummary(part("Grep", { pattern: "placeOrder\\(", path: "/Users/me/code/shop" }), DRAWING), "placeOrder\\(");
  assert.equal(toolSummary(part("create_diagram", { title: "Shop", nodes: [{}, {}, {}] })), "Shop · 3 nodes");
  assert.equal(toolSummary(part("create_diagram", { nodes: [{}] })), "1 node");
  assert.equal(toolSummary(part("find_symbol", { name: "OrderRepository" })), "OrderRepository");
  assert.equal(toolSummary(part("diagram_reference", { topic: "uml class diagram" })), "uml class diagram");
  assert.equal(toolSummary(part("list_shapes", { query: "database" })), "database");
  assert.equal(toolSummary(part("apply_changes", { add: [{}, {}], update: [{}], delete: [] })), "2 added, 1 updated");
  assert.equal(toolSummary(part("delete_elements", { ids: ["a", "b"] })), "2");
  // A drawing tool's path is nearly always the open drawing: the chip shows what the call was about instead.
  assert.equal(toolSummary(part("connect_elements", { path: "docs/diagrams/shop.excalidraw", from: "a", to: "b", label: "SQL" }), DRAWING), "SQL");
  assert.equal(toolSummary(part("connect_elements", { path: DRAWING, from: "a", to: "b" }), DRAWING), "");
  assert.equal(toolSummary(part("read_drawing", { path: "docs/diagrams/other.excalidraw" }), DRAWING), "docs/diagrams/other.excalidraw");
  // add_elements takes a drawing path that is nearly always the open drawing: not worth showing.
  assert.equal(toolSummary(part("add_elements", { path: "docs/diagrams/shop.excalidraw", elements: [{}, {}] })), "2");
  assert.equal(toolSummary(part("project_overview", {})), "");
});

test("toolSummary survives arguments still streaming in, and shows why a call failed", () => {
  assert.equal(toolSummary(part("create_diagram", '{"title":"Sho')), "");
  assert.equal(toolSummary(part("create_diagram", "")), "");
  assert.equal(toolSummary(part("create_diagram", "[1,2]")), "");
  const failed = part("create_diagram", { nodes: [{}, {}] }, { status: "error", result: "Invalid arguments:\n✖ edges[0–3].to: missing (id of the node the edge points to)\nmore" });
  assert.equal(toolSummary(failed), "edges[0–3].to: missing (id of the node the edge points to)");
  assert.equal(errorLine("Error: Element \"x\" not found"), 'Element "x" not found');
  assert.equal(errorLine("Not run: this call already failed"), "this call already failed");
  assert.equal(errorLine(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Editor chrome
// ---------------------------------------------------------------------------

test("the top bar goes compact before its controls would leave the screen", () => {
  // Menu button, 550 px toolbar and the full-size controls need about 950 px.
  assert.equal(compactTopBar(1180), false);
  assert.equal(compactTopBar(1000), false);
  assert.equal(compactTopBar(999), true);
  assert.equal(compactTopBar(764), true); // a 1024 px window with the sidebar open
  // The stale-links badge needs more room.
  assert.equal(compactTopBar(1100, true), true);
  assert.equal(compactTopBar(1180, true), false);
  // Not measured yet: don't flash the compact layout.
  assert.equal(compactTopBar(0), false);
});

test("the sidebar gives way to the assistant only when the canvas would be too narrow", () => {
  // 1024 px window, 260 px sidebar: 764 px of canvas, 384 with the assistant.
  assert.equal(sidebarShouldYield(764, true), true);
  // 1440 px window: 1180 px of canvas, 800 with the assistant.
  assert.equal(sidebarShouldYield(1180, true), false);
  assert.equal(sidebarShouldYield(CHAT_WIDTH + MIN_CANVAS_WITH_CHAT, true), false);
  assert.equal(sidebarShouldYield(CHAT_WIDTH + MIN_CANVAS_WITH_CHAT - 1, true), true);
  // Nothing to close, or nothing measured.
  assert.equal(sidebarShouldYield(600, false), false);
  assert.equal(sidebarShouldYield(0, true), false);
});
