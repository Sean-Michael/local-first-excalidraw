import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { summariseTranscript } from "../evals/claude.js";
import { grade, idPreservation, linkTarget, matches, measure, nonFinite, overlaps, textOverflow } from "../evals/grade.js";
import { parseJudgeReply } from "../evals/judge.js";
import { loadScenarios, REPO_ROOT } from "../evals/scenarios.js";
import { applyPatch, initProject, listProjectFiles } from "../evals/setup.js";
import { renderSkillEvals, SKILLS, skillEvalsPath } from "../evals/skill-evals.js";
import { type GraphSpec, layoutGraph } from "../src/server/layout.js";
import { addSkeletons, type El } from "../src/server/scene.js";
import { el } from "./fixtures.js";

const scene = (skeletons: Parameters<typeof addSkeletons>[1]) => ({ elements: addSkeletons([], skeletons).elements });
const data = loadScenarios();
const scenario = (id: string) => data.scenarios.find((s) => s.id === id)!;
const noFiles = { projectRoot: "/p", projectFiles: new Set<string>() };

test("label matching ignores case, punctuation and camelCase", () => {
  assert.ok(matches("Turnstile Gateway", ["turnstile-gateway"]));
  assert.ok(matches("turnstile-gateway\n(Fastify)", ["turnstile"]));
  assert.ok(matches("PaylodeClient", ["paylode"]));
  assert.ok(matches("shopapp_pg", ["shopapp-pg"]));
  assert.ok(!matches("keymaster-auth", ["ledger"]));
});

test("the reference architecture graph passes the arch-overview checks", () => {
  const graph = data.graphs["shopapp-arch"] as GraphSpec;
  const g = grade({ final: { elements: addSkeletons([], layoutGraph(graph)).elements }, checks: scenario("arch-overview").checks, ...noFiles });
  assert.deepEqual(g.checks.filter((c) => !c.pass), []);
  assert.equal(g.score, 1);
});

test("text fit trusts a label's measured width unless the server clamped it", () => {
  const box = el("c", "rectangle", 0, 0, 150, 65, { groupIds: [], boundElements: [{ id: "t", type: "text" }] });
  // Measured by the Mermaid converter with real fonts: fits, though the estimate says it doesn't.
  const real = el("t", "text", 20, 22, 111, 20, { groupIds: [], containerId: "c", text: "turnstile-gateway", fontSize: 16, fontFamily: 5 });
  assert.deepEqual(textOverflow([box, real]), []);
  // At the clamp width (container - 20) the estimate decides.
  const clamped = { ...real, width: 130, text: "turnstile-gateway-and-more" };
  assert.equal(textOverflow([box, clamped]).length, 1);
});

test("required frames match frame names only", () => {
  const checks = { requiredFrames: [["shopapp", "system"]] };
  const framed = scene([
    { type: "rectangle", id: "a", x: 0, y: 0, label: "api" },
    { type: "frame", id: "f", name: "shopapp [Software System]", children: ["a"] },
  ]);
  assert.equal(grade({ final: framed, checks, ...noFiles }).pass, true);
  const unframed = scene([{ type: "rectangle", id: "a", x: 0, y: 0, label: "shopapp system" }]);
  const g = grade({ final: unframed, checks, ...noFiles });
  assert.equal(g.pass, false);
  assert.match(g.checks.find((c) => c.name === "required-frames")!.detail, /no frames/);
});

test("overlaps: partial overlaps count, containers and groups don't", () => {
  const els = [
    el("a", "rectangle", 0, 0, 100, 50, { groupIds: [] }),
    el("b", "rectangle", 80, 20, 100, 50, { groupIds: [] }), // partial overlap with a
    el("frame", "rectangle", -50, -50, 400, 300, { groupIds: [] }), // contains a and b: a container
    el("i1", "rectangle", 500, 0, 50, 50, { groupIds: ["icon"] }),
    el("i2", "ellipse", 510, 10, 50, 50, { groupIds: ["icon"] }), // same group
    el("t", "text", 60, 40, 80, 20, { groupIds: [], text: "note" }), // crosses a and b
  ];
  assert.deepEqual(overlaps(els).sort(), ["a~b", "t~a", "t~b"].sort());
});

test("text overflow uses the container's usable width", () => {
  const { elements } = addSkeletons([], [
    { type: "rectangle", id: "ok", x: 0, y: 0, width: 300, height: 80, label: "fits fine" },
    { type: "rectangle", id: "narrow", x: 0, y: 200, width: 60, height: 40, label: "ledger-orders" },
    { type: "diamond", id: "dia", x: 0, y: 400, width: 160, height: 80, label: "payment approved?" },
  ]);
  assert.deepEqual(textOverflow(elements).map((s) => s.split(":")[0]).sort(), ["dia", "narrow"]);
});

test("non-finite coordinates fail the finite check", () => {
  const els = [el("a", "rectangle", 0, 0, 10, 10), el("b", "arrow", 0, 0, 10, 10, { points: [[0, 0], [NaN, 1]] })];
  assert.deepEqual(nonFinite(els), ["b"]);
  const g = grade({ final: { elements: els }, checks: {}, ...noFiles });
  assert.equal(g.checks.find((c) => c.name === "finite")!.pass, false);
});

test("edges match by endpoint labels, respecting direction unless undirected", () => {
  const s = scene([
    { type: "rectangle", id: "o", x: 0, y: 0, label: "ledger-orders" },
    { type: "rectangle", id: "q", x: 300, y: 0, label: "postbox-mq" },
    { type: "rectangle", id: "w", x: 600, y: 0, label: "courier-worker" },
    { type: "arrow", start: { id: "o" }, end: { id: "q" } },
    { type: "arrow", start: { id: "w" }, end: { id: "q" } },
    { type: "arrow", x: 0, y: 200, width: 100, height: 0 }, // unbound
  ]);
  const m = measure(s);
  assert.equal(m.arrows, 3);
  assert.equal(m.boundArrows, 2);
  const g = grade({
    final: s,
    checks: {
      requiredEdges: [
        { from: ["ledger"], to: ["postbox"] },
        { from: ["postbox"], to: ["courier"], undirected: true },
        { from: ["postbox"], to: ["courier"] },
      ],
      minBoundRatio: 0.9,
    },
    ...noFiles,
  });
  const edges = g.checks.find((c) => c.name === "required-edges")!;
  assert.equal(edges.pass, false);
  assert.match(edges.detail, /2\/3 present; missing postbox->courier/);
  assert.equal(g.checks.find((c) => c.name === "bound-arrows")!.pass, false);
});

test("library icons are named by their caption", () => {
  const els = [
    el("body", "rectangle", 0, 0, 80, 60, { groupIds: ["db1"] }),
    el("cap", "text", 0, 70, 80, 20, { groupIds: ["db1"], text: "shopapp-pg" }),
    el("svc", "rectangle", 300, 0, 100, 60, { groupIds: [], boundElements: [{ id: "l", type: "text" }] }),
    el("l", "text", 310, 20, 80, 20, { groupIds: [], text: "ledger-orders", containerId: "svc" }),
    el("arr", "arrow", 100, 30, 200, 0, { groupIds: [], startBinding: { elementId: "svc" }, endBinding: { elementId: "body" } }),
  ];
  assert.deepEqual(measure({ elements: els }).edges, [{ from: "ledger-orders", to: "shopapp-pg", bidirectional: false }]);
});

test("id preservation ignores labels and counts deletions", () => {
  const base = scene([
    { type: "rectangle", id: "a", x: 0, y: 0, label: "A" },
    { type: "rectangle", id: "b", x: 200, y: 0, label: "B" },
    { type: "arrow", id: "ab", start: { id: "a" }, end: { id: "b" } },
    { type: "text", id: "note", x: 0, y: 200, text: "note" },
  ]);
  const final = { elements: base.elements.map((e: El) => (e.id === "b" ? { ...e, isDeleted: true } : e)) };
  const p = idPreservation(base, final);
  assert.equal(p.ratio, 0.75);
  assert.deepEqual(p.lost, ["b"]);
});

test("preserve detects moved, recoloured and deleted user edits", () => {
  const base = scene([
    { type: "rectangle", id: "a", x: 0, y: 0, label: "A", backgroundColor: "#ffc9c9" },
    { type: "rectangle", id: "b", x: 300, y: 0, label: "B" },
    { type: "text", id: "note", x: 0, y: 200, text: "Ask Priya" },
  ]);
  const checks = { preserve: { ids: ["a", "b", "note"], props: ["x", "y", "backgroundColor"], texts: ["Ask Priya"] } };
  const same = grade({ final: base, baseline: base, checks, ...noFiles });
  assert.ok(same.pass);
  const edited = {
    elements: base.elements
      .filter((e: El) => e.id !== "note")
      .map((e: El) => (e.id === "a" ? { ...e, x: e.x + 0.5, backgroundColor: "transparent" } : e.id === "b" ? { ...e, y: 40 } : e)),
  };
  const g = grade({ final: edited, baseline: base, checks, ...noFiles });
  const d = g.checks.find((c) => c.name === "user-edits")!.detail;
  assert.match(d, /a\.backgroundColor/);
  assert.doesNotMatch(d, /a\.x/); // within the 1px tolerance
  assert.match(d, /b\.y 0 -> 40/);
  assert.match(d, /note deleted/);
  assert.match(d, /text "Ask Priya" gone/);
});

test("links resolve relative, absolute, file:// and vscode:// targets", () => {
  const root = "/tmp/proj";
  assert.equal(linkTarget("services/a.ts", root), "services/a.ts");
  assert.equal(linkTarget("./services/a.ts#L12", root), "services/a.ts");
  assert.equal(linkTarget("services/a.ts:12:3", root), "services/a.ts");
  assert.equal(linkTarget("/tmp/proj/services/a.ts", root), "services/a.ts");
  assert.equal(linkTarget("file:///tmp/proj/services/a.ts", root), "services/a.ts");
  assert.equal(linkTarget("vscode://file/tmp/proj/services/a.ts:4", root), "services/a.ts");
  assert.equal(linkTarget("https://example.com/a.ts", root), null);
  assert.equal(linkTarget("../outside.ts", root), null);

  const s = scene([
    { type: "rectangle", id: "a", x: 0, y: 0, label: "A", link: "services/a.ts" },
    { type: "rectangle", id: "b", x: 200, y: 0, label: "B", link: "services/gone.ts" },
    { type: "rectangle", id: "c", x: 400, y: 0, label: "C", link: "services" },
  ]);
  const files = new Set(["services/a.ts"]);
  const g = grade({ final: s, checks: { links: { minLinked: 2, allExist: true } }, projectRoot: root, projectFiles: files });
  const c = g.checks.find((x) => x.name === "links")!;
  assert.equal(c.pass, false);
  assert.match(c.detail, /2 links to existing files \(min 2\), 1 broken: services\/gone.ts/);
});

test("improve compares against the baseline's metrics", () => {
  const messy = scene([
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50, label: { text: "A", fontSize: 10 } },
    { type: "rectangle", id: "b", x: 50, y: 20, width: 100, height: 50, label: "B" },
    { type: "arrow", x: 0, y: 200, width: 100, height: 0 },
  ]);
  const tidy = scene([
    { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50, label: { text: "A", fontSize: 16 } },
    { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 50, label: "B" },
    { type: "arrow", start: { id: "a" }, end: { id: "b" } },
  ]);
  const checks = { improve: { overlaps: true, boundRatio: true, minFontSize: true } };
  assert.ok(grade({ final: tidy, baseline: messy, checks, ...noFiles }).pass);
  const g = grade({ final: messy, baseline: messy, checks, ...noFiles });
  assert.match(g.checks[1].detail, /not improved: overlaps 1 -> 1, bound 0 -> 0, min font 10 -> 10/);
});

test("a missing drawing fails with score 0", () => {
  const g = grade({ final: null, checks: { minArrows: 1 }, ...noFiles });
  assert.equal(g.pass, false);
  assert.equal(g.score, 0);
});

test("transcript summary counts tools, errors, skills and cost", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: "m", mcp_servers: [{ name: "excalidraw", status: "connected" }] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "1", name: "Skill", input: { skill: "excalidraw:excalidraw" } }, { type: "tool_use", id: "2", name: "mcp__excalidraw__render_drawing", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "2", is_error: true, content: [{ type: "text", text: "Error: No editor is open" }] }] } }),
    "not json",
    JSON.stringify({ type: "result", subtype: "success", num_turns: 4, total_cost_usd: 0.25, duration_ms: 1000, result: "Done", permission_denials: [{ tool_name: "Write" }] }),
  ];
  const s = summariseTranscript(lines);
  assert.equal(s.model, "m");
  assert.deepEqual(s.toolCounts, { Skill: 1, mcp__excalidraw__render_drawing: 1 });
  assert.deepEqual(s.skillsUsed, ["excalidraw:excalidraw"]);
  assert.deepEqual(s.toolErrors, [{ name: "mcp__excalidraw__render_drawing", error: "Error: No editor is open" }]);
  assert.equal(s.turns, 4);
  assert.equal(s.costUsd, 0.25);
  assert.equal(s.permissionDenials.length, 1);
  assert.equal(s.finalText, "Done");
});

test("judge replies are parsed from the first JSON object", () => {
  assert.deepEqual(parseJudgeReply('Sure.\n{"readability": 4, "correctness": 5, "notes": "ok"}'), { readability: 4, correctness: 5, notes: "ok" });
  assert.deepEqual(parseJudgeReply('{"readability": 9, "correctness": 2}'), { readability: undefined, correctness: 2, notes: undefined });
  assert.throws(() => parseJudgeReply("no idea"));
});

test("the skills' evals.json files match scenarios.json", () => {
  for (const skill of SKILLS) {
    assert.equal(fs.readFileSync(skillEvalsPath(skill), "utf8"), renderSkillEvals(skill), `${skill}: run npm run evals:skills`);
  }
});

test("every scenario's fixture and patch exist, and each patch applies to the fixture", () => {
  for (const s of data.scenarios) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "evals", "fixtures", s.fixture)), s.id);
    for (const f of s.files) assert.ok(fs.existsSync(path.join(REPO_ROOT, f)), `${s.id}: ${f}`);
  }
  // Each patch, and a file it should add (+) or remove (-).
  const expect: Record<string, string> = {
    "add-inventory-service": "+services/stockroom-inventory/src/server.ts",
    "replace-redis-with-memory-cache": "-services/keymaster-auth/src/cache/redisTokenCache.ts",
    "add-paylode-webhook": "+services/ledger-orders/src/routes/paylodeWebhook.ts",
  };
  const patches = fs.readdirSync(path.join(REPO_ROOT, "evals", "fixtures", "shopapp.patches")).map((f) => f.replace(/\.patch$/, ""));
  assert.deepEqual(patches.sort(), Object.keys(expect).sort());
  for (const s of data.scenarios) if (s.patch) assert.ok(patches.includes(s.patch), `${s.id}: ${s.patch}`);
  for (const [name, change] of Object.entries(expect)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfx-evals-test-"));
    try {
      initProject("shopapp", dir);
      applyPatch(dir, "shopapp", name);
      assert.equal(listProjectFiles(dir).includes(change.slice(1)), change[0] === "+", `${name}: ${change}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
