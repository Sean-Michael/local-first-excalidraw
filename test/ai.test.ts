import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { ChatEvent, ChatItem } from "../src/shared/chat.js";
import { applyChatEvent } from "../src/shared/chat.js";
import { mermaidBlocks } from "../src/server/ai/agent.js";
import { claudeCodeArgs } from "../src/server/ai/claude-code.js";
import { SettingsStore } from "../src/server/ai/settings.js";
import { CodeError, globToRegExp, isSecretFile, listFiles, readFile, searchFiles } from "../src/server/code.js";
import type { Config } from "../src/server/config.js";
import { startDaemon } from "../src/server/daemon.js";
import { writeLibraries } from "./fixtures.js";
import { codeTools, drawingTools, jsonSchema, resolveDrawing, type ToolContext } from "../src/server/tools.js";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`));

// ---------------------------------------------------------------------------
// Code search confinement
// ---------------------------------------------------------------------------

function project(): string {
  const root = tmp("proj");
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "api", "server.ts"), "export function handleLogin() {\n  return db.query('users');\n}\n");
  fs.writeFileSync(path.join(root, "src", "db.ts"), "export const db = connect(process.env.DATABASE_URL);\n");
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "handleLogin\n");
  fs.writeFileSync(path.join(root, "generated", "big.ts"), "handleLogin\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n*.log\n");
  fs.writeFileSync(path.join(root, "debug.log"), "handleLogin\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=hunter2\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SECRET=\n");
  fs.writeFileSync(path.join(root, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  return root;
}

test("code tools list and search the project but skip ignored, vendored and secret files", () => {
  const root = project();
  const files = listFiles(root, {}).split("\n");
  assert.ok(files.includes("src/api/server.ts"));
  assert.ok(files.includes(".env.example"));
  for (const f of ["node_modules/dep/index.js", "generated/big.ts", "debug.log", ".env", "server.pem"]) {
    assert.ok(!files.includes(f), `${f} should be hidden`);
  }
  assert.deepEqual(listFiles(root, { glob: "**/*.ts" }).split("\n"), ["src/api/server.ts", "src/db.ts"]);
  const hits = searchFiles(root, { pattern: "handlelogin" });
  assert.equal(hits, "src/api/server.ts:1: export function handleLogin() {");
  assert.match(searchFiles(root, { pattern: "db\\.\\w+\\(", regex: true }), /src\/api\/server\.ts:2/);
  assert.equal(searchFiles(root, { pattern: "hunter2" }), "No matches.");
});

test("read_file is confined to the project root and refuses secrets", () => {
  const root = project();
  assert.match(readFile(root, { path: "src/db.ts" }), /1  export const db/);
  assert.match(readFile(root, { path: "src/api/server.ts", start_line: 2, end_line: 2 }), /lines 2-2 of 4/);
  const outside = tmp("outside");
  fs.writeFileSync(path.join(outside, "x.txt"), "nope");
  fs.symlinkSync(path.join(outside, "x.txt"), path.join(root, "link.txt"));
  fs.symlinkSync(outside, path.join(root, "linkdir"));
  for (const p of ["../x.txt", path.join(outside, "x.txt"), "link.txt", "linkdir/x.txt", ".env", "server.pem", "image.bin", "src"]) {
    assert.throws(() => readFile(root, { path: p }), CodeError, p);
  }
  assert.ok(!listFiles(root, {}).includes("linkdir"));
});

test("secret detection and globs", () => {
  for (const f of [".env", ".env.local", "config/.env.production", "id_rsa", "deploy/key.pem", ".npmrc", "home/.ssh/config", "credentials.json", "secrets.yaml", "terraform.tfstate"]) {
    assert.ok(isSecretFile(f), f);
  }
  for (const f of [".env.example", "src/env.ts", "keys.ts", "README.md", "secretary.md"]) assert.ok(!isSecretFile(f), f);
  assert.ok(globToRegExp("**/*.{ts,tsx}").test("a/b/c.tsx"));
  assert.ok(globToRegExp("**/*.ts").test("c.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("API keys are write-only and dropped when an endpoint's URL changes", () => {
  const dir = tmp("state");
  const s = new SettingsStore(dir);
  s.update({ enabled: true, active: "a", endpoints: [{ id: "a", kind: "openai", baseUrl: "https://api.example.com/v1/", model: "m", apiKey: "sk-1" }] });
  assert.equal(s.get().endpoints[0].baseUrl, "https://api.example.com/v1");
  assert.equal(s.get().endpoints[0].apiKey, "sk-1");
  const pub = JSON.stringify(s.public({ available: false }));
  assert.ok(!pub.includes("sk-1"));
  assert.ok(pub.includes('"hasKey":true'));
  assert.equal((fs.statSync(path.join(dir, "ai.json")).mode & 0o777).toString(8), "600");

  // Keep the key when the form leaves it out.
  s.update({ endpoints: [{ id: "a", kind: "openai", baseUrl: "https://api.example.com/v1", model: "m2" }] });
  assert.equal(s.get().endpoints[0].apiKey, "sk-1");
  // A new host must not inherit the key.
  s.update({ endpoints: [{ id: "a", kind: "openai", baseUrl: "https://evil.example.net/v1", model: "m2" }] });
  assert.equal(s.get().endpoints[0].apiKey, undefined);
  assert.throws(() => s.update({ endpoints: [{ id: "a", kind: "openai", baseUrl: "file:///etc/passwd" }] }));
  assert.throws(() => s.update({ endpoints: [{ id: "a", kind: "shell", baseUrl: "http://x" }] }));
  assert.throws(() => s.update({ endpoints: [{ id: "a", kind: "openai", baseUrl: "http://user:pw@x" }] }));
});

// ---------------------------------------------------------------------------
// Tool registry and helpers
// ---------------------------------------------------------------------------

test("every tool has an object JSON Schema", () => {
  for (const def of [...drawingTools({ currentDrawing: true }), ...drawingTools({ currentDrawing: false }), ...codeTools()]) {
    const s = jsonSchema(def);
    assert.equal(s.type, "object", def.name);
    assert.ok(s.properties && typeof s.properties === "object", def.name);
  }
  const withCurrent = jsonSchema(drawingTools({ currentDrawing: true }).find((t) => t.name === "add_elements")!);
  const without = jsonSchema(drawingTools({ currentDrawing: false }).find((t) => t.name === "add_elements")!);
  assert.ok(!(withCurrent.required as string[]).includes("path"));
  assert.ok((without.required as string[]).includes("path"));
});

test("mermaid fences are extracted for endpoints without tool calling", () => {
  assert.deepEqual(mermaidBlocks("Here:\n```mermaid\nflowchart LR\n  a --> b\n```\nand ```js\nx\n```"), ["flowchart LR\n  a --> b"]);
});

test("Claude Code runs restricted, with only this project's MCP server", () => {
  const args = claudeCodeArgs({
    bin: "claude", cwd: "/p", systemPrompt: "sys", mcpEnv: { LFX_PORT: "1" }, codeAccess: true, signal: new AbortController().signal, sessionId: "s1", model: "sonnet",
  });
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(args[args.indexOf("--resume") + 1], "s1");
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["excalidraw"]);
  assert.deepEqual(mcp.mcpServers.excalidraw.args.slice(1), ["mcp", "--root", "/p"]);
  const noCode = claudeCodeArgs({ bin: "claude", cwd: "/p", systemPrompt: "", mcpEnv: {}, codeAccess: false, signal: new AbortController().signal });
  assert.equal(noCode[noCode.indexOf("--tools") + 1], "");
});

// ---------------------------------------------------------------------------
// End to end: daemon + fake model servers + WebSocket client
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

interface Fake {
  url: string;
  requests: any[];
  close(): void;
}

/** A model server that replays scripted SSE responses, one per request. */
async function fakeServer(script: (req: any, n: number) => string[]): Promise<Fake> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }], has_more: false, first_id: "model-b", last_id: "model-a" }));
      }
      const parsed = JSON.parse(body);
      requests.push({ headers: req.headers, body: parsed, url: req.url });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of script(parsed, requests.length)) res.write(chunk);
      res.end();
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

const oaChunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const antEvent = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function antMessage(blocks: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown })[], stop: string): string[] {
  const out = [antEvent("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out.push(antEvent("content_block_start", { index, content_block: { type: "text", text: "" } }));
      out.push(antEvent("content_block_delta", { index, delta: { type: "text_delta", text: b.text } }));
    } else {
      out.push(antEvent("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }));
      out.push(antEvent("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
    }
    out.push(antEvent("content_block_stop", { index }));
  });
  out.push(antEvent("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }));
  out.push(antEvent("message_stop", {}));
  return out;
}

let cfg: Config;
let server: http.Server;
let root: string;
let cookie: string;
const base = () => `http://127.0.0.1:${cfg.port}`;

before(async () => {
  const port = await freePort();
  root = project();
  cfg = {
    stateDir: tmp("daemon"),
    host: "127.0.0.1",
    port,
    allowedHosts: new Set([`127.0.0.1:${port}`]),
    defaultRoots: [root],
    allowRootRegistration: true,
    webDir: tmp("web"),
  };
  server = await startDaemon(cfg);
  const token = fs.readFileSync(path.join(cfg.stateDir, "token"), "utf8").trim();
  const { code } = (await (await fetch(`${base()}/api/login-code`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })).json()) as { code: string };
  const login = await fetch(`${base()}/login?code=${code}`, { redirect: "manual" });
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(base() + route, {
    method,
    headers: { Cookie: cookie, Origin: base(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** An editor tab: opens the drawing and collects chat events until a turn ends. */
async function tab(file: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`, { headers: { Cookie: cookie, Origin: base() } });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  let items: ChatItem[] = [];
  const scenes: any[] = [];
  const errors: string[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "chat") {
      items = applyChatEvent(items, m.ev as ChatEvent);
      if ((m.ev as ChatEvent).type === "turn-end" || m.ev.type === "reverted") waiters.splice(0).forEach((w) => w());
    } else if (m.t === "scene") scenes.push(m);
    // Stand in for the browser's Mermaid converter.
    else if (m.t === "mermaid") {
      const el = { id: "m1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1 };
      ws.send(JSON.stringify({ t: "reply", id: m.id, ok: true, result: { elements: [el], files: {} } }));
    } else if (m.t === "chat-error" || m.t === "error") {
      errors.push(m.message);
      waiters.splice(0).forEach((w) => w());
    }
  });
  ws.send(JSON.stringify({ t: "open", path: file }));
  const next = () => new Promise<void>((r) => waiters.push(r));
  return {
    ws,
    get items() {
      return items;
    },
    scenes,
    errors,
    async chat(text: string, extra: Record<string, unknown> = {}) {
      const done = next();
      ws.send(JSON.stringify({ t: "chat-send", path: file, text, selection: [], mentions: [], ...extra }));
      await done;
    },
    async revert(id: string) {
      const done = next();
      ws.send(JSON.stringify({ t: "chat-revert", id }));
      await done;
    },
  };
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the assistant refuses to run until an endpoint is configured", async () => {
  const file = path.join(root, "docs", "diagrams", "unconfigured.excalidraw");
  const t = await tab(file);
  await t.chat("hello");
  assert.match(t.errors[0], /isn't set up/);
  t.ws.close();
});

test("OpenAI-compatible endpoint: streamed tool calls edit the drawing and can be reverted", async () => {
  const fake = await fakeServer((req, n) => {
    if (n === 1) {
      const args = JSON.stringify({ nodes: [{ id: "api", label: "API" }, { id: "db", label: "DB" }], edges: [{ from: "api", to: "db" }] });
      return [
        oaChunk({ reasoning_content: "Planning." }),
        oaChunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "create_diagram", arguments: args.slice(0, 20) } }] }),
        oaChunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(20) } }] }),
        oaChunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ];
    }
    return [oaChunk({ content: "Drew the API " }), oaChunk({ content: "and DB." }, "stop"), "data: [DONE]\n\n"];
  });
  try {
    const put = await api("PUT", "/api/ai/settings", {
      enabled: true,
      active: "local",
      endpoints: [{ id: "local", name: "Local", kind: "openai", baseUrl: `${fake.url}/v1`, model: "qwen", apiKey: "sk-test" }],
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.endpoints[0].hasKey, true);
    assert.ok(!JSON.stringify(put.body).includes("sk-test"));
    const models = await api("POST", "/api/ai/models", { id: "local", kind: "openai", baseUrl: `${fake.url}/v1` });
    assert.deepEqual(models.body.models, ["model-a", "model-b"]);

    const file = path.join(root, "docs", "diagrams", "oa.excalidraw");
    const t = await tab(file);
    await t.chat("Draw an API talking to a DB", { selection: [] });
    assert.deepEqual(t.errors, []);

    const turn = t.items.find((i) => i.kind === "assistant")!;
    assert.equal(turn.kind, "assistant");
    if (turn.kind !== "assistant") return;
    assert.equal(turn.status, "done", turn.error);
    assert.deepEqual(turn.parts.map((p) => p.type), ["reasoning", "tool", "text"]);
    assert.equal(turn.parts[2].type === "text" && turn.parts[2].text, "Drew the API and DB.");
    assert.equal(turn.parts[1].type === "tool" && turn.parts[1].status, "ok");
    assert.ok(turn.revertable);
    assert.ok(turn.changed! >= 5);

    // The file changed on disk and the edit was tagged for the canvas undo stack.
    const labels = read(file).elements.filter((e: any) => e.type === "text").map((e: any) => e.text);
    assert.deepEqual(labels.sort(), ["API", "DB"]);
    assert.ok(t.scenes.some((s) => s.agent === true));

    // Request shape: system prompt, context block, tools, key, and the tool result on the second call.
    const [first, second] = fake.requests;
    assert.equal(first.headers.authorization, "Bearer sk-test");
    assert.equal(first.body.model, "qwen");
    assert.equal(first.body.messages[0].role, "system");
    assert.match(first.body.messages[1].content, /<context>\nOpen drawing: docs\/diagrams\/oa\.excalidraw/);
    const toolNames = first.body.tools.map((x: any) => x.function.name);
    assert.ok(toolNames.includes("create_diagram") && toolNames.includes("search_files"));
    assert.ok(!toolNames.includes("render_drawing"), "no render without vision");
    assert.ok(!toolNames.includes("open_drawing"));
    const toolMsg = second.body.messages.find((m: any) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.match(toolMsg.content, /Drew 2 nodes and 1 edges/);

    // Revert the turn: the drawing is empty again.
    await t.revert(turn.id);
    assert.equal(read(file).elements.length, 0);
    const reverted = t.items.find((i) => i.id === turn.id);
    assert.ok(reverted && reverted.kind === "assistant" && reverted.reverted);

    // History is persisted and replayed to a new tab.
    const t2 = await tab(file);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t2.items.length, 2);
    t.ws.close();
    t2.ws.close();
  } finally {
    fake.close();
  }
});

test("selection and @-mentions are described in the context; bad tool args are reported back", async () => {
  const fake = await fakeServer((_req, n) =>
    n === 1
      ? [oaChunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "update_elements", arguments: '{"updates": "nope"}' } }] }, "tool_calls")]
      : [oaChunk({ content: "Sorry." }, "stop")],
  );
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "x", endpoints: [{ id: "x", kind: "openai", baseUrl: fake.url, model: "m" }] });
    const file = path.join(root, "docs", "diagrams", "sel.excalidraw");
    const other = path.join(root, "docs", "diagrams", "other.excalidraw");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rect = (id: string, x: number) => ({ id, type: "rectangle", x, y: 0, width: 100, height: 50, version: 1, versionNonce: 1 });
    fs.writeFileSync(file, JSON.stringify({ type: "excalidraw", elements: [rect("keep", 0), rect("pick", 200)] }));
    fs.writeFileSync(other, JSON.stringify({ type: "excalidraw", elements: [rect("o1", 0)] }));

    const mentions = await api("GET", `/api/ai/mentions?path=${encodeURIComponent(file)}&q=serv`);
    assert.deepEqual(mentions.body.items.map((i: any) => i.rel), ["src/api/server.ts"]);
    const drawings = await api("GET", `/api/ai/mentions?path=${encodeURIComponent(file)}&q=other`);
    assert.deepEqual(drawings.body.items.map((i: any) => i.kind), ["drawing"]);

    const t = await tab(file);
    await t.chat("make this blue", {
      selection: ["pick"],
      mentions: [
        { kind: "file", path: path.join(root, "src", "db.ts") },
        { kind: "file", path: path.join(root, ".env") },
        { kind: "drawing", path: other },
      ],
    });
    const ctx: string = fake.requests[0].body.messages[1].content;
    assert.match(ctx, /Selected elements \(1\): 1 elements.*\n\[pick\] rectangle at \(200,0\)/);
    assert.ok(!/Selected[\s\S]*\[keep\]/.test(ctx.split("Selected")[1].split("Mentioned")[0]));
    assert.match(ctx, /<file>\nsrc\/db\.ts \(lines 1-2 of 2\)/);
    assert.match(ctx, /Mentioned file .*\.env: Refusing to read \.env/);
    assert.match(ctx, /Mentioned drawing docs\/diagrams\/other\.excalidraw: 1 elements/);
    const toolMsg = fake.requests[1].body.messages.find((m: any) => m.role === "tool");
    assert.match(toolMsg.content, /^Error: Invalid arguments/);
    const turn = t.items.find((i) => i.kind === "assistant");
    assert.ok(turn && turn.kind === "assistant" && turn.status === "done" && !turn.revertable);
    t.ws.close();
  } finally {
    fake.close();
  }
});

test("Anthropic endpoint: tool use through the SDK, with caching, thinking and replayed content", async () => {
  const fake = await fakeServer((_req, n) =>
    n === 1
      ? antMessage(
          [
            { type: "text", text: "Adding a note." },
            { type: "tool_use", id: "toolu_1", name: "add_elements", input: { elements: [{ type: "text", x: 0, y: 0, text: "Hello" }] } },
          ],
          "tool_use",
        )
      : antMessage([{ type: "text", text: "Done." }], "end_turn"),
  );
  try {
    await api("PUT", "/api/ai/settings", {
      enabled: true,
      active: "ant",
      endpoints: [{ id: "ant", kind: "anthropic", baseUrl: fake.url, model: "claude-opus-5-5", apiKey: "sk-ant-test", vision: true }],
    });
    const file = path.join(root, "docs", "diagrams", "ant.excalidraw");
    const t = await tab(file);
    await t.chat("add a hello note", { image: { data: "iVBORw0KGgo=", mime: "image/png" }, selection: [] });
    const turn = t.items.find((i) => i.kind === "assistant");
    assert.ok(turn && turn.kind === "assistant");
    assert.equal(turn.status, "done", turn.error);
    assert.equal(read(file).elements[0].text, "Hello");

    const [first, second] = fake.requests;
    assert.equal(first.url, "/v1/messages?beta=true");
    assert.equal(first.headers["x-api-key"], "sk-ant-test");
    assert.equal(first.body.model, "claude-opus-5-5");
    assert.deepEqual(first.body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
    assert.equal(first.body.stream, true);
    // Custom base URL: no fallbacks or eager streaming, which proxies may reject.
    assert.equal(first.body.fallbacks, undefined);
    assert.ok(first.body.tools.some((x: any) => x.name === "render_drawing"), "vision endpoints can render");
    assert.equal(first.body.messages[0].content[1].type, "image");
    // Second request replays the assistant content verbatim, then the tool result.
    assert.deepEqual(second.body.messages[1].content.map((b: any) => b.type), ["text", "tool_use"]);
    assert.equal(second.body.messages[2].content[0].type, "tool_result");
    assert.equal(second.body.messages[2].content[0].tool_use_id, "toolu_1");
    t.ws.close();
  } finally {
    fake.close();
  }
});

test("endpoints without tool calling answer in Mermaid", async () => {
  const fake = await fakeServer(() => [oaChunk({ content: "```mermaid\nflowchart LR\n  a --> b\n```" }, "stop")]);
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "m", endpoints: [{ id: "m", kind: "openai", baseUrl: fake.url, model: "tiny", tools: false }] });
    const file = path.join(root, "docs", "diagrams", "mermaid.excalidraw");
    const t = await tab(file);
    await t.chat("a to b");
    assert.equal(fake.requests[0].body.tools, undefined);
    assert.match(fake.requests[0].body.messages[0].content, /reply with one ```mermaid code block/);
    const turn = t.items.find((i) => i.kind === "assistant");
    assert.ok(turn && turn.kind === "assistant");
    const tool = turn.parts.find((p) => p.type === "tool");
    assert.ok(tool && tool.type === "tool" && tool.name === "mermaid_to_drawing" && tool.status === "ok", JSON.stringify(tool));
    assert.equal(read(file).elements[0].id, "m1");
    t.ws.close();
  } finally {
    fake.close();
  }
});

test("Ollama endpoint: native chat API with a real context window", async () => {
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  const fake = await fakeServer((_req, n) =>
    n === 1
      ? [
          line({ message: { role: "assistant", content: "", thinking: "Let me look." } }),
          line({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "search_files", arguments: { pattern: "handleLogin" } } }] } }),
          line({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
        ]
      : [line({ message: { role: "assistant", content: "Found it." } }), line({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })],
  );
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "o", endpoints: [{ id: "o", kind: "ollama", baseUrl: fake.url, model: "qwen3-coder:30b" }] });
    const models = await api("POST", "/api/ai/models", { id: "o", kind: "ollama", baseUrl: fake.url });
    assert.equal(models.status, 200);
    const file = path.join(root, "docs", "diagrams", "ollama.excalidraw");
    const t = await tab(file);
    await t.chat("where is login handled?");
    const [first, second] = fake.requests;
    assert.equal(first.url, "/api/chat");
    assert.equal(first.body.options.num_ctx, 32768);
    assert.equal(first.body.messages[0].role, "system");
    const toolMsg = second.body.messages.find((m: any) => m.role === "tool");
    assert.equal(toolMsg.tool_name, "search_files");
    assert.match(toolMsg.content, /src\/api\/server\.ts:1/);
    assert.deepEqual(second.body.messages.find((m: any) => m.tool_calls).tool_calls[0].function.arguments, { pattern: "handleLogin" });
    const turn = t.items.find((i) => i.kind === "assistant");
    assert.ok(turn && turn.kind === "assistant" && turn.status === "done");
    assert.deepEqual(turn.parts.map((p) => p.type), ["reasoning", "tool", "text"]);
    t.ws.close();
  } finally {
    fake.close();
  }
});

test("the project root is the drawing's git repository, not just its folder", async () => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs", "diagrams"), { recursive: true });
  fs.writeFileSync(path.join(repo, "main.go"), "package main\n");
  const file = path.join(repo, "docs", "diagrams", "x.excalidraw");
  const r = await api("GET", `/api/ai/mentions?path=${encodeURIComponent(file)}&q=main`);
  assert.equal(r.body.root, fs.realpathSync(repo));
  assert.deepEqual(r.body.items.map((i: any) => i.rel), ["main.go"]);
  // Without a repository, it falls back to the allowed root.
  const plain = path.join(root, "docs", "diagrams", "y.excalidraw");
  assert.equal((await api("GET", `/api/ai/mentions?path=${encodeURIComponent(plain)}&q=`)).body.root, fs.realpathSync(root));
});

test("in the assistant, a bare drawing name means the open drawing's folder, not docs/diagrams", () => {
  const base = { projectRoot: "/home/me", op: async () => ({}), withEditor: async () => ({}), list: async () => [] } as ToolContext;
  const current = "/home/me/Excalidraw/sketch.excalidraw";
  const assistant = { ...base, currentDrawing: current };
  assert.equal(resolveDrawing(assistant, "sketch.excalidraw"), current);
  assert.equal(resolveDrawing(assistant, "sketch"), current);
  assert.equal(resolveDrawing(assistant, undefined), current);
  assert.equal(resolveDrawing(assistant, "other"), "/home/me/Excalidraw/other.excalidraw");
  assert.equal(resolveDrawing(assistant, "docs/x"), "/home/me/docs/x.excalidraw");
  // MCP agents keep the docs/diagrams default.
  assert.equal(resolveDrawing(base, "sketch"), "/home/me/docs/diagrams/sketch.excalidraw");
});

test("library shapes: list, insert, and use as create_diagram nodes with bound arrows", async () => {
  const proj = path.join(root, "shapes-proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  writeLibraries(proj, path.join(cfg.stateDir, "library.json"));
  const token = fs.readFileSync(path.join(cfg.stateDir, "token"), "utf8").trim();
  const op = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base()}/api/op`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const file = path.join(proj, "docs", "arch.excalidraw");

  const list = await op({ op: "shapes", path: file });
  assert.deepEqual(list.body.shapes.map((s: any) => s.key), ["item-1", "database", "message-queue"]);
  assert.equal(list.body.shapes[0].elements, undefined, "elements stay server-side");

  const ins = await op({ op: "insert_shape", path: file, shape: "Database", x: 10, y: 20, label: "Orders", id: "orders" });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  assert.equal(ins.body.anchor, "orders");
  assert.equal((await op({ op: "insert_shape", path: file, shape: "Database", id: "orders" })).status, 409);
  assert.match((await op({ op: "insert_shape", path: file, shape: "kubernetes" })).body.error, /No library shape/);

  const diag = await op({
    op: "diagram",
    path: file,
    graph: {
      nodes: [
        { id: "api", label: "API" },
        { id: "db", label: "Users DB", shape: "database", group: "data" },
        { id: "q", label: "Events", shape: "Message Queue" },
      ],
      edges: [{ from: "api", to: "db" }, { from: "api", to: "q" }],
      groups: [{ id: "data", label: "Data" }],
    },
  });
  assert.equal(diag.status, 200, JSON.stringify(diag.body));
  const els = read(file).elements as any[];
  const byId = new Map(els.map((e) => [e.id, e]));
  // Library nodes keep the node id on their arrow target, so the edges bind to them.
  assert.equal(byId.get("db").strokeColor, "transparent", "multi-part icon: invisible target box");
  assert.notEqual(byId.get("q").strokeColor, "transparent", "single-shape icon is its own target");
  const toDb = els.find((e) => e.type === "arrow" && e.endBinding?.elementId === "db");
  assert.ok(toDb, "arrow bound to the database shape");
  assert.ok(byId.get("db").boundElements.some((b: any) => b.id === toDb.id));
  assert.ok(els.some((e) => e.type === "text" && e.text === "Users DB"));
  // The group's frame contains every part of the library shape, not just its anchor.
  const dbGroup = byId.get("db").groupIds.at(-1);
  const parts = els.filter((e) => e.groupIds?.includes(dbGroup));
  assert.ok(parts.length >= 4);
  for (const part of parts) assert.equal(part.frameId, "data");
  // Not drawn as a plain labelled box.
  assert.ok(!els.some((e) => e.type === "text" && e.text === "Users DB" && e.containerId === "db"));
});
