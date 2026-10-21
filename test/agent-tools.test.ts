/**
 * The agent tools added for v1: read filters and revisions, if_rev, apply_changes,
 * arrange_elements, snapshots, code links and diagram_reference. Scene helpers are tested
 * directly; the tools run against a real daemon on a random port with temporary state.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { hashFile } from "../src/server/codelinks.js";
import type { Config } from "../src/server/config.js";
import { startDaemon } from "../src/server/daemon.js";
import { GUIDE, SERVER_INSTRUCTIONS } from "../src/server/guide.js";
import { listTopics, readTopic, referencesDir } from "../src/server/references.js";
import { addSkeletons, arrangeElements, contentRev, describe, type El, emptyScene, findElements, live, restoreElements, updateElements } from "../src/server/scene.js";
import { drawingTools, type ToolContext } from "../src/server/tools.js";

const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`)));
const byId = (els: El[], id: string) => els.find((e) => e.id === id)!;

const three = () =>
  addSkeletons([], [
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60, label: "Orders API" },
    { type: "rectangle", id: "b", x: 300, y: 37, width: 100, height: 80, label: "Billing" },
    { type: "rectangle", id: "c", x: 520, y: 11, width: 100, height: 60, label: "Ledger", link: "https://example.com" },
    { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
  ]).elements;

test("contentRev changes with every edit and ignores deleted elements' order", () => {
  const els = three();
  const r0 = contentRev(els);
  assert.equal(r0, contentRev([...els].reverse()));
  assert.match(r0, /^[0-9a-f]{12}$/);
  const moved = updateElements(els, [{ id: "c", x: 600 }]);
  assert.notEqual(contentRev(moved), r0);
});

test("findElements matches labels, links, ids and types, bringing attached arrows", () => {
  const els = three();
  assert.deepEqual([...findElements(els, { query: "orders" })].sort(), ["a", "ab"]);
  assert.deepEqual([...findElements(els, { query: "example.com" })], ["c"]);
  assert.deepEqual([...findElements(els, { type: "arrow" })], ["ab"]);
  assert.deepEqual([...findElements(els, { ids: ["b"], type: "rectangle" })], ["b"]);
  const s = describe({ ...emptyScene(), elements: els }, findElements(els, { query: "billing" }));
  assert.match(s, /^2 elements/);
  assert.match(s, /"Billing"/);
  assert.doesNotMatch(s, /Ledger/);
});

test("align and distribute move shapes with their labels and re-route arrows", () => {
  const els = three();
  const top = arrangeElements(els, ["a", "b", "c"], { align: "top" });
  for (const id of ["a", "b", "c"]) assert.equal(byId(top, id).y, 0, id);
  const label = top.find((e) => e.containerId === "b")!;
  assert.ok(label.y > 0 && label.y < 80, "label follows its shape");
  assert.equal(byId(top, "ab").startBinding.elementId, "a");
  assert.ok(byId(top, "ab").version > byId(els, "ab").version, "arrow re-routed");

  const mid = arrangeElements(els, ["a", "b"], { align: "middle" });
  assert.equal(byId(mid, "a").y + 30, byId(mid, "b").y + 40);

  const spread = arrangeElements(els, ["c", "a", "b"], { distribute: "horizontal" });
  const gap1 = byId(spread, "b").x - (byId(spread, "a").x + 100);
  const gap2 = byId(spread, "c").x - (byId(spread, "b").x + 100);
  assert.ok(Math.abs(gap1 - gap2) < 0.01, `${gap1} vs ${gap2}`);
  assert.equal(byId(spread, "a").x, 0, "the outermost stay put");
  assert.equal(byId(spread, "c").x, 520);

  assert.throws(() => arrangeElements(els, ["a", "b"], { distribute: "vertical" }), /at least three/);
  assert.throws(() => arrangeElements(els, ["a", "ab"], { align: "left" }), /arrow/);
  assert.throws(() => arrangeElements(els, ["a", "b"], {}), /either align or distribute/);
});

test("arranging a grouped shape moves its whole group", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "icon", x: 0, y: 100, width: 40, height: 40, groupIds: ["g"] },
    { type: "text", id: "cap", x: 0, y: 145, text: "db", groupIds: ["g"] },
    { type: "rectangle", id: "box", x: 200, y: 0, width: 80, height: 40 },
  ]);
  const out = arrangeElements(elements, ["icon", "box"], { align: "top" });
  assert.equal(byId(out, "box").y, 0);
  assert.equal(byId(out, "icon").y, 0);
  assert.equal(byId(out, "cap").y, 45, "the caption moved with the icon");
});

test("setting frameId on a shape brings its label into the frame", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "s", x: 0, y: 0, label: "API" },
    { type: "frame", id: "f", x: -50, y: -50, width: 400, height: 300, name: "Backend" },
  ]);
  const out = updateElements(elements, [{ id: "s", frameId: "f" }]);
  const label = out.find((e) => e.containerId === "s")!;
  assert.equal(byId(out, "s").frameId, "f");
  assert.equal(label.frameId, "f");
});

test("moving a shape keeps its label's measured size; new label text is measured again", () => {
  const { elements } = addSkeletons([], [{ type: "rectangle", id: "s", x: 0, y: 0, width: 150, height: 65, label: { text: "turnstile-gateway", fontSize: 16 } }]);
  // As the Mermaid converter or the editor leaves it: measured with the real font.
  const measured = elements.map((e) => (e.containerId === "s" ? { ...e, width: 111, height: 20 } : e));
  const moved = updateElements(measured, [{ id: "s", x: 300 }]);
  const label = moved.find((e) => e.containerId === "s")!;
  assert.equal(label.width, 111);
  assert.equal(label.x, 300 + (150 - 111) / 2);
  const renamed = updateElements(measured, [{ id: "s", x: 300, label: "turnstile-gateway-v2" }]);
  assert.notEqual(renamed.find((e) => e.containerId === "s")!.width, 111);
});

test("restoreElements outranks the current copies", () => {
  const els = three();
  const changed = updateElements(els, [{ id: "a", x: 999 }]);
  const restored = restoreElements(changed, els);
  assert.ok(byId(restored, "a").version > byId(changed, "a").version);
  assert.equal(byId(restored, "a").x, 0);
});

test("diagram references are found next to the code and served by name only", () => {
  assert.ok(referencesDir(), "references directory found");
  const topics = listTopics();
  assert.ok(topics.some((t) => t.topic === "c4" && /C4/.test(t.title)));
  assert.match(readTopic("c4"), /^# C4/);
  assert.match(readTopic("C4.md"), /^# C4/);
  // A path never reaches the filesystem: it is only matched against the topics.
  assert.doesNotMatch(readTopic("../../../package.json"), /"devDependencies"/);
  // Topics are found by what they cover, in the caller's own words.
  assert.match(readTopic("uml-class"), /^\(Best match for "uml-class": uml-structure, section "Class diagram"/);
  assert.match(readTopic("UML class diagram"), /# UML structure diagrams/);
  assert.match(readTopic("use case diagram"), /## Use case diagram/);
  assert.match(readTopic("erd"), /# Data models/);
  assert.match(readTopic("sequence"), /# UML behaviour diagrams/);
  assert.match(readTopic("what kinds of uml diagrams are there"), /# UML: the 14 diagram types/);
  assert.match(readTopic("zzzz qqq"), /No reference topic matches "zzzz qqq"\. Topics/);
});

// ---- tools against a daemon -------------------------------------------------------------

let server: http.Server;
let root: string;
let ctx: ToolContext;
const tools = Object.fromEntries(drawingTools({ currentDrawing: false }).map((t) => [t.name, t]));
const run = (name: string, args: Record<string, unknown>) => tools[name].run(args, ctx);

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  root = tmp("tools-root");
  const cfg: Config = {
    stateDir: tmp("tools-state"),
    host: "127.0.0.1",
    port,
    allowedHosts: new Set([`127.0.0.1:${port}`]),
    defaultRoots: [root],
    allowRootRegistration: true,
    webDir: tmp("tools-web"),
  };
  server = await startDaemon(cfg);
  const token = fs.readFileSync(path.join(cfg.stateDir, "token"), "utf8").trim();
  const op = async (body: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/op`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error));
    return data;
  };
  ctx = { projectRoot: root, op, withEditor: (_f, b) => op(b), list: async () => [] };
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "orders.ts"), "export const a = 1;\nexport const b = 2;\n");
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const readFile = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")).elements as El[];
const revOf = (text: string) => /rev ([0-9a-f]{12})/i.exec(text)![1];

test("read_drawing returns a rev, and writes with a stale if_rev change nothing", async () => {
  await run("create_drawing", { path: "docs/rev.excalidraw", elements: [{ type: "rectangle", id: "a", x: 0, y: 0, label: "A" }] });
  const rev = revOf((await run("read_drawing", { path: "docs/rev.excalidraw" })).text);
  const added = await run("add_elements", { path: "docs/rev.excalidraw", elements: [{ type: "ellipse", id: "b", x: 300, y: 0 }], if_rev: rev });
  const next = revOf(added.text);
  assert.notEqual(next, rev);
  await assert.rejects(run("update_elements", { path: "docs/rev.excalidraw", updates: [{ id: "a", x: 50 }], if_rev: rev }), /changed since you read it/);
  await assert.rejects(run("delete_elements", { path: "docs/rev.excalidraw", ids: ["a"], if_rev: rev }), /changed since you read it/);
  assert.equal(byId(readFile("docs/rev.excalidraw"), "a").x, 0);
  await run("update_elements", { path: "docs/rev.excalidraw", updates: [{ id: "a", x: 50 }], if_rev: next });
  assert.equal(byId(readFile("docs/rev.excalidraw"), "a").x, 50);
});

test("read_drawing filters by query, ids and type", async () => {
  await run("create_diagram", {
    path: "docs/filter.excalidraw",
    nodes: [{ id: "gw", label: "turnstile-gateway" }, { id: "orders", label: "ledger-orders" }, { id: "pg", label: "shopapp-pg" }],
    edges: [{ from: "gw", to: "orders" }, { from: "orders", to: "pg" }],
  });
  const r = await run("read_drawing", { path: "docs/filter.excalidraw", query: "gateway" });
  assert.match(r.text, /filtered: 2 of \d+ elements match/);
  assert.match(r.text, /\[gw\] rectangle/);
  assert.doesNotMatch(r.text, /shopapp-pg/);
  const none = await run("read_drawing", { path: "docs/filter.excalidraw", query: "zzz" });
  assert.match(none.text, /Nothing matches/);
  const arrows = await run("read_drawing", { path: "docs/filter.excalidraw", type: "arrow" });
  assert.match(arrows.text, /gw -> orders/);
  assert.doesNotMatch(arrows.text, /\[pg\]/);
});

test("apply_changes adds, updates and deletes in one revision, or not at all", async () => {
  const file = "docs/apply.excalidraw";
  await run("create_drawing", {
    path: file,
    elements: [
      { type: "rectangle", id: "a", x: 0, y: 0, label: "A" },
      { type: "rectangle", id: "old", x: 300, y: 0, label: "Old" },
      { type: "arrow", id: "a-old", start: { id: "a" }, end: { id: "old" } },
    ],
  });
  const before = (await ctx.op({ op: "read", path: path.join(root, file) })).rev as number;
  const r = await run("apply_changes", {
    path: file,
    delete: ["old", "a-old"],
    add: [{ type: "rectangle", id: "new", x: 300, y: 0, label: "New" }, { type: "arrow", id: "a-new", start: { id: "a" }, end: { id: "new" } }],
    update: [{ id: "a", label: "Alpha" }, { id: "new", color: "green" }],
  });
  assert.match(r.text, /added 2 \(new, a-new\), updated 2, deleted 3/);
  const after = (await ctx.op({ op: "read", path: path.join(root, file) })).rev as number;
  assert.equal(after, before + 1, "one revision");
  const els = readFile(file);
  assert.ok(!els.some((e) => e.id === "old"));
  assert.equal(byId(els, "a-new").endBinding.elementId, "new");
  assert.equal(byId(els, "new").backgroundColor, "#b2f2bb");
  assert.ok(els.some((e) => e.text === "Alpha"));
  await assert.rejects(run("apply_changes", { path: file, delete: ["a"], update: [{ id: "missing", x: 1 }] }), /not found/);
  assert.ok(readFile(file).some((e) => e.id === "a"), "a failed batch changes nothing");
});

test("arrange_elements aligns by id", async () => {
  const file = "docs/arrange.excalidraw";
  await run("create_drawing", {
    path: file,
    elements: [
      { type: "rectangle", id: "a", x: 0, y: 10, width: 100, height: 60 },
      { type: "rectangle", id: "b", x: 200, y: 30, width: 100, height: 60 },
    ],
  });
  const r = await run("arrange_elements", { path: file, ids: ["a", "b"], align: "top" });
  assert.match(r.text, /Aligned 2 elements \(top\)/);
  assert.equal(byId(readFile(file), "b").y, 10);
});

test("snapshots save, list and restore a drawing in one revision", async () => {
  const file = "docs/snap.excalidraw";
  await run("create_drawing", { path: file, elements: [{ type: "rectangle", id: "a", x: 0, y: 0, label: "A" }] });
  assert.match((await run("list_snapshots", { path: file })).text, /no snapshots/);
  const saved = await run("snapshot_drawing", { path: file, name: "before sync" });
  assert.match(saved.text, /Saved snapshot \S+ "before sync" .*1 elements/);
  await run("apply_changes", { path: file, delete: ["a"], add: [{ type: "ellipse", id: "b", x: 0, y: 0 }] });
  const restored = await run("restore_drawing", { path: file, snapshot: "before sync" });
  assert.match(restored.text, /Restored .* "before sync"/);
  const els = readFile(file);
  assert.deepEqual(els.filter((e) => !e.containerId).map((e) => e.id), ["a"]);
  // The state before the restore was kept.
  const list = (await run("list_snapshots", { path: file })).text.split("\n");
  assert.equal(list.length, 2);
  assert.match(list[0], /before restoring before sync/);
  await run("restore_drawing", { path: file });
  assert.deepEqual(readFile(file).map((e) => e.id), ["b"]);
  await assert.rejects(run("restore_drawing", { path: file, snapshot: "nope" }), /No snapshot "nope"/);
});

test("code links on diagram nodes, added shapes and updates use one convention", async () => {
  const file = "docs/code.excalidraw";
  const sha = hashFile(path.join(root, "src", "orders.ts"));
  const d = await run("create_diagram", {
    path: file,
    nodes: [{ id: "orders", label: "orders", code: "src/orders.ts:2" }, { id: "gone", label: "gone", code: "src/gone.ts" }],
  });
  assert.match(d.text, /src\/gone\.ts doesn't exist/);
  let els = readFile(file);
  assert.equal(byId(els, "orders").link, "src/orders.ts#L2");
  assert.deepEqual(byId(els, "orders").customData.lfxCode, { path: "src/orders.ts", line: 2, sha });
  assert.equal(byId(els, "gone").customData.lfxCode.sha, undefined);

  await run("add_elements", { path: file, elements: [{ type: "rectangle", id: "x", x: 0, y: 400, label: "x", code: path.join(root, "src", "orders.ts") }] });
  els = readFile(file);
  assert.equal(byId(els, "x").link, "src/orders.ts", "absolute paths inside the project become relative");
  assert.equal(byId(els, "x").code, undefined, "code isn't stored as a raw property");

  const read = await run("read_drawing", { path: file });
  assert.match(read.text, /\[orders\] rectangle .* code=src\/orders\.ts#L2/);

  await run("update_elements", { path: file, updates: [{ id: "gone", code: "src/orders.ts" }, { id: "x", code: null }] });
  els = readFile(file);
  assert.equal(byId(els, "gone").link, "src/orders.ts");
  assert.equal(byId(els, "gone").customData.lfxCode.sha, sha);
  assert.equal(byId(els, "x").link, null);
  assert.equal(byId(els, "x").customData.lfxCode, undefined);

  // A plain project-path link set directly follows the same convention; a web link drops the code ref.
  await run("update_elements", { path: file, updates: [{ id: "x", link: "src/orders.ts:1" }, { id: "orders", link: "https://example.com" }] });
  els = readFile(file);
  assert.equal(byId(els, "x").link, "src/orders.ts#L1");
  assert.equal(byId(els, "orders").link, "https://example.com");
  assert.equal(byId(els, "orders").customData.lfxCode, undefined);
  await assert.rejects(run("update_elements", { path: file, updates: [{ id: "x", code: "https://example.com/a.ts" }] }), /isn't a path inside the project/);
  assert.equal(live(els).filter((e) => e.code !== undefined).length, 0);
});

test("diagram_reference lists topics and serves one", async () => {
  const list = await run("diagram_reference", {});
  assert.match(list.text, /- c4: /);
  assert.match(list.text, /- living-diagrams: /);
  assert.match((await run("diagram_reference", { topic: "living-diagrams" })).text, /^# Living diagrams/);
});

test("the guide and the excalidraw skill describe every drawing tool", () => {
  const skill = fs.readFileSync(path.join(referencesDir()!, "..", "..", "excalidraw", "SKILL.md"), "utf8");
  for (const name of Object.keys(tools)) {
    if (name !== "excalidraw_guide") assert.ok(GUIDE.includes(`**${name}**`), `GUIDE mentions ${name}`);
  }
  for (const name of ["create_diagram", "read_drawing", "apply_changes", "render_drawing", "snapshot_drawing", "diagram_reference"]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(name), `SERVER_INSTRUCTIONS mentions ${name}`);
  }
  for (const name of ["create_diagram", "apply_changes", "arrange_elements", "restore_drawing", "if_rev"]) assert.ok(skill.includes(name), `skill mentions ${name}`);
  // The same rules everywhere.
  for (const text of [GUIDE, skill]) assert.match(text, /12 characters or fewer/);
});

test("mermaid_to_drawing says which diagram kinds stay editable", () => {
  assert.match(tools.mermaid_to_drawing.description, /Only flowchart and sequenceDiagram/);
  assert.match(tools.mermaid_to_drawing.description, /create_diagram/);
});
