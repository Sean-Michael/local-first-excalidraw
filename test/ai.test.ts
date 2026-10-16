import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { WebSocket } from "ws";
import type { ChatEvent, ChatItem, ChatSessionInfo } from "../src/shared/chat.js";
import { applyChatEvent } from "../src/shared/chat.js";
import { mermaidBlocks } from "../src/server/ai/agent.js";
import { claudeCodeArgs } from "../src/server/ai/claude-code.js";
import { SettingsStore } from "../src/server/ai/settings.js";
import { JsoncError, parseJsonc } from "../src/shared/jsonc.js";
import { CodeError, globToRegExp, isSecretFile, listFiles, readFile, searchFiles } from "../src/server/code.js";
import type { Config } from "../src/server/config.js";
import { startDaemon } from "../src/server/daemon.js";
import { writeLibraries } from "./fixtures.js";
import { initTelemetry } from "../src/server/telemetry.js";
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

test("code tools list and search the project but skip ignored, vendored and secret files", async () => {
  const root = project();
  const files = listFiles(root, {}).split("\n");
  assert.ok(files.includes("src/api/server.ts"));
  assert.ok(files.includes(".env.example"));
  for (const f of ["node_modules/dep/index.js", "generated/big.ts", "debug.log", ".env", "server.pem"]) {
    assert.ok(!files.includes(f), `${f} should be hidden`);
  }
  assert.deepEqual(listFiles(root, { glob: "**/*.ts" }).split("\n"), ["src/api/server.ts", "src/db.ts"]);
  const hits = await searchFiles(root, { pattern: "handlelogin" });
  assert.equal(hits, "src/api/server.ts:1: export function handleLogin() {");
  assert.match(await searchFiles(root, { pattern: "db\\.\\w+\\(", regex: true }), /src\/api\/server\.ts:2/);
  assert.equal(await searchFiles(root, { pattern: "hunter2" }), "No matches.");
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

test("hand edits to ai.json apply without a restart, and a broken edit keeps the last good settings", () => {
  const dir = tmp("state");
  const file = path.join(dir, "ai.json");
  const s = new SettingsStore(dir);
  s.update({ enabled: true, active: "a", endpoints: [{ id: "a", kind: "openai", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk-1" }] });

  const edited = JSON.parse(fs.readFileSync(file, "utf8"));
  edited.endpoints[0].model = "m2";
  edited.endpoints[0].baseUrl = "https://api.example.com/v1/";
  fs.writeFileSync(file, JSON.stringify(edited));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(s.get().endpoints[0].model, "m2");
  assert.equal(s.get().endpoints[0].baseUrl, "https://api.example.com/v1");
  // The user's own file may hold a key for any host.
  assert.equal(s.get().endpoints[0].apiKey, "sk-1");

  fs.writeFileSync(file, `// mine\n{ "enabled": true, "endpoints": [{ "id": "a", "kind": "ollama", "model": "q", },], }`);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 7000));
  assert.equal(s.get().endpoints[0].model, "q");

  fs.writeFileSync(file, '{ "enabled": true, ');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
  assert.equal(s.get().endpoints[0].model, "q");
  assert.match(s.public({ available: false }).fileError ?? "", /ai\.json was not loaded/);

  fs.writeFileSync(file, JSON.stringify({ endpoints: [{ kind: "shell" }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 15000));
  assert.match(s.public({ available: false }).fileError ?? "", /Unknown endpoint kind/);

  // Saving from the app replaces the broken file and clears the error.
  s.update({ enabled: false });
  assert.equal(s.public({ available: false }).fileError, undefined);
  assert.throws(() => s.update({ endpoints: [{ id: "x", kind: "ollama" }, { id: "x", kind: "ollama" }] }), /share the id/);
});

test("JSONC accepts comments and trailing commas and reports where errors are", () => {
  assert.deepEqual(parseJsonc('// note\n{\n  "a": [1, 2,], /* x */ "b": "c\\"d", // end\n}\n'), { a: [1, 2], b: 'c"d' });
  assert.deepEqual(parseJsonc('{"url": "http://x//y"}'), { url: "http://x//y" });
  const err = (t: string) => {
    try {
      parseJsonc(t);
    } catch (e) {
      assert.ok(e instanceof JsoncError);
      return [e.line, e.column];
    }
    assert.fail("expected an error");
  };
  assert.deepEqual(err('{\n  "a": 1\n  "b": 2\n}'), [3, 3]);
  assert.deepEqual(err('{\n  "a": tru\n}'), [2, 8]);
  assert.deepEqual(err('{ "a": 1 } x'), [1, 12]);
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
async function fakeServer(script: (req: any, n: number) => string[] | Promise<string[]>): Promise<Fake> {
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
      void Promise.resolve(script(parsed, requests.length)).then((chunks) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const chunk of chunks) res.write(chunk);
        res.end();
      });
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

const spans = new InMemorySpanExporter();
const traceFile = path.join(tmp("trace"), "spans.jsonl");

let cfg: Config;
let server: http.Server;
let root: string;
let cookie: string;
const base = () => `http://127.0.0.1:${cfg.port}`;

before(async () => {
  process.env.LFX_TRACE_FILE = traceFile;
  initTelemetry("lfx-test", { exporter: spans, captureContent: true });
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
  // Like the page: the log shows the open session; events of other sessions are ignored.
  let items: ChatItem[] = [];
  let session = "";
  let sessions: ChatSessionInfo[] = [];
  const scenes: any[] = [];
  const errors: string[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "chat") {
      const ev = m.ev as ChatEvent;
      if (ev.type === "history") {
        session = ev.session;
        sessions = ev.sessions;
        items = ev.items;
      } else if (ev.type === "sessions") sessions = ev.sessions;
      else if (m.session === session) items = applyChatEvent(items, ev);
      if (ev.type === "turn-end" || ev.type === "reverted" || ev.type === "history") waiters.splice(0).forEach((w) => w());
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
  const next = () => new Promise<void>((r) => waiters.push(r));
  const opened = next();
  ws.send(JSON.stringify({ t: "open", path: file }));
  await opened;
  return {
    ws,
    get items() {
      return items;
    },
    get session() {
      return session;
    },
    get sessions() {
      return sessions;
    },
    /** Sends a message and waits for the reply it causes (a turn ending, a session opening, an error). */
    async send(msg: Record<string, unknown>) {
      const done = next();
      ws.send(JSON.stringify(msg));
      await done;
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
    assert.ok(toolNames.includes("connect_elements"));
    const listShapes = first.body.tools.find((x: any) => x.function.name === "list_shapes");
    assert.equal(listShapes.function.parameters.properties.preview, undefined, "no image previews for models that can't see");
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
  assert.deepEqual(list.body.shapes.map((s: any) => s.key), ["infra/database", "infra/message-queue", "your-excalidraw-library/your-excalidraw-library-1"]);
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
  // next_to places a shape beside an element; connect_elements binds an arrow to both ends.
  const before = read(file).elements.length;
  const beside = await op({ op: "insert_shape", path: file, shape: "message queue", next_to: { id: "api", side: "left", gap: 50 }, id: "q2", label: "Retry" });
  assert.equal(beside.status, 200, JSON.stringify(beside.body));
  const api2 = read(file).elements.find((e: any) => e.id === "api");
  assert.ok(beside.body.bounds.x + beside.body.bounds.width <= api2.x - 49, "left of the API");
  assert.ok(read(file).elements.length > before);
  // Not drawn as a plain labelled box.
  assert.ok(!els.some((e) => e.type === "text" && e.text === "Users DB" && e.containerId === "db"));
});

test("library routes: import, browse, rename, toggle and remove from the page", async () => {
  const file = path.join(root, "docs", "diagrams", "libs.excalidraw");
  const lib = JSON.stringify({ type: "excalidrawlib", version: 1, library: [[{ id: "a", type: "ellipse", x: 0, y: 0, width: 30, height: 30, version: 1, versionNonce: 1 }]] });
  const imp = await api("POST", "/api/libraries/import", { fileName: "people.excalidrawlib", content: lib });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const id = imp.body.library.id;
  assert.equal(id, "installed:people");
  assert.equal((await api("POST", "/api/libraries/import", { content: "{" })).status, 400);

  const list = await api("GET", `/api/libraries?path=${encodeURIComponent(file)}`);
  assert.ok(list.body.libraries.some((l: any) => l.id === id && l.items === 1 && l.enabled));
  const items = await api("GET", `/api/libraries/items?id=${encodeURIComponent(id)}&path=${encodeURIComponent(file)}`);
  assert.equal(items.body.items[0].name, "people 1");
  assert.equal(items.body.items[0].elements[0].type, "ellipse");

  await api("POST", "/api/libraries/update", { id, rename: { itemId: "0", name: "Head" } });
  await api("POST", "/api/libraries/update", { id, enabled: false });
  const after = await api("GET", `/api/libraries/items?id=${encodeURIComponent(id)}`);
  assert.equal(after.body.items[0].key, "people/head");
  assert.equal((await api("GET", "/api/libraries")).body.libraries.find((l: any) => l.id === id).enabled, false);

  assert.equal((await api("POST", "/api/libraries/remove", { id })).status, 200);
  assert.equal((await api("POST", "/api/libraries/remove", { id: "personal" })).status, 400);
  assert.ok(!(await api("GET", "/api/libraries")).body.libraries.some((l: any) => l.id === id));
});

test("a tool call the server couldn't parse is retried instead of ending the turn", async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n++;
      if (n === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: 'error parsing tool call: raw=\'{"from":"a",\', err=unexpected end of JSON input' }));
      }
      const sent = JSON.parse(body);
      const last = sent.messages[sent.messages.length - 1];
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(JSON.stringify({ message: { role: "assistant", content: last.content.includes("could not be parsed") ? "Retried." : "?" }, done: true, done_reason: "stop" }) + "\n");
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "o", endpoints: [{ id: "o", kind: "ollama", baseUrl: `http://127.0.0.1:${port}`, model: "m" }] });
    const t = await tab(path.join(root, "docs", "diagrams", "retry.excalidraw"));
    await t.chat("connect them");
    const turn = t.items.find((i) => i.kind === "assistant");
    assert.ok(turn && turn.kind === "assistant");
    assert.equal(turn.status, "done", turn.error);
    assert.equal(turn.parts.find((p) => p.type === "text")?.type === "text" && (turn.parts.find((p) => p.type === "text") as any).text, "Retried.");
    t.ws.close();
  } finally {
    server.close();
  }
});

test("a turn is traced: agent, model calls with usage, tools and the operations they run", async () => {
  const fake = await fakeServer((_req, n) =>
    n === 1
      ? [
          oaChunk({ tool_calls: [{ index: 0, id: "call_t", type: "function", function: { name: "create_diagram", arguments: JSON.stringify({ nodes: [{ id: "a", label: "Web" }, { id: "b", label: "API" }], edges: [{ from: "a", to: "b" }] }) } }] }),
          oaChunk({}, "tool_calls"),
          `data: ${JSON.stringify({ id: "resp_1", model: "qwen-served", choices: [], usage: { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } } })}\n\n`,
          "data: [DONE]\n\n",
        ]
      : [oaChunk({ content: "Drew Web calling API." }, "stop"), "data: [DONE]\n\n"],
  );
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "t", endpoints: [{ id: "t", name: "Traced", kind: "openai", baseUrl: fake.url, model: "qwen" }] });
    const file = path.join(root, "docs", "diagrams", "traced.excalidraw");
    const t = await tab(file);
    await t.chat("Draw a web app calling an API");
    const turn = t.items.find((i) => i.kind === "assistant")!;
    assert.equal(fake.requests[0].body.stream_options.include_usage, true);

    const all = spans.getFinishedSpans();
    const agent = all.find((s) => s.attributes["lfx.turn.id"] === turn.id)!;
    assert.ok(agent, "agent span");
    const traceId = agent.spanContext().traceId;
    const inTrace = all.filter((s) => s.spanContext().traceId === traceId);
    const childrenOf = (s: ReadableSpan) => inTrace.filter((x) => x.parentSpanContext?.spanId === s.spanContext().spanId);

    assert.equal(agent.name, "invoke_agent lfx-assistant");
    assert.equal(agent.attributes["gen_ai.provider.name"], "openai");
    assert.equal(agent.attributes["gen_ai.request.model"], "qwen");
    assert.equal(agent.attributes["lfx.turn.status"], "done");
    assert.equal(agent.attributes["lfx.turn.steps"], 2);
    assert.equal(agent.attributes["lfx.turn.tool_calls"], 1);
    assert.equal(agent.attributes["lfx.turn.tool_errors"], 0);
    assert.equal(agent.attributes["gen_ai.usage.input_tokens"], 120);
    assert.equal(agent.attributes["input.value"], "Draw a web app calling an API");
    assert.equal(agent.attributes["output.value"], "Drew Web calling API.");

    const kids = childrenOf(agent).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    assert.deepEqual(kids.map((s) => s.name), ["chat qwen", "execute_tool create_diagram", "chat qwen"]);
    const [chat1, tool, chat2] = kids;
    assert.equal(chat1.attributes["gen_ai.usage.output_tokens"], 9);
    assert.equal(chat1.attributes["gen_ai.usage.cache_read.input_tokens"], 100);
    assert.equal(chat1.attributes["gen_ai.response.model"], "qwen-served");
    assert.deepEqual(chat1.attributes["lfx.tool_calls"], ["create_diagram"]);
    assert.match(String(chat1.attributes["gen_ai.input.messages"]), /Draw a web app calling an API/);
    assert.match(String(chat1.attributes["gen_ai.system_instructions"]), /drawing assistant/);
    // The second call records only what's new: the tool result.
    assert.match(String(chat2.attributes["gen_ai.input.messages"]), /^\[\{"role":"tool"/);
    assert.equal(chat2.attributes["gen_ai.system_instructions"], undefined);
    assert.equal(tool.attributes["gen_ai.tool.call.id"], "call_t");
    assert.match(String(tool.attributes["gen_ai.tool.call.result"]), /Drew 2 nodes/);
    assert.deepEqual(childrenOf(tool).map((s) => s.name), ["lfx.op diagram"]);
    assert.equal(childrenOf(tool)[0].attributes["lfx.drawing"], "docs/diagrams/traced.excalidraw");
    assert.equal(childrenOf(tool)[0].attributes["lfx.op.assistant"], true);

    // Reverting links back to the turn.
    await t.revert(turn.id);
    const revert = spans.getFinishedSpans().find((s) => s.name === "lfx.assistant.revert" && s.attributes["lfx.turn.id"] === turn.id)!;
    assert.equal(revert.links[0].context.spanId, agent.spanContext().spanId);
    assert.ok((revert.attributes["lfx.revert.restored"] as number) > 0);

    // The same spans went to the trace file.
    const lines = fs.readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.spanId === tool.spanContext().spanId && l.parentSpanId === agent.spanContext().spanId && l.name === "execute_tool create_diagram"));
    t.ws.close();
  } finally {
    fake.close();
  }
});

test("failed tool calls are marked as errors with their kind", async () => {
  const fake = await fakeServer((_req, n) =>
    n === 1 ? [oaChunk({ tool_calls: [{ index: 0, id: "bad", function: { name: "no_such_tool", arguments: "{}" } }] }, "tool_calls")] : [oaChunk({ content: "Oops." }, "stop")],
  );
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "t", endpoints: [{ id: "t", kind: "openai", baseUrl: fake.url, model: "m" }] });
    const t = await tab(path.join(root, "docs", "diagrams", "traced-fail.excalidraw"));
    await t.chat("hi");
    const turn = t.items.find((i) => i.kind === "assistant")!;
    const agent = spans.getFinishedSpans().find((s) => s.attributes["lfx.turn.id"] === turn.id)!;
    assert.equal(agent.attributes["lfx.turn.tool_errors"], 1);
    const tool = spans.getFinishedSpans().find((s) => s.attributes["gen_ai.tool.call.id"] === "bad")!;
    assert.equal(tool.attributes["error.type"], "unknown_tool");
    assert.equal(tool.status.code, 2);
    t.ws.close();
  } finally {
    fake.close();
  }
});

const textOf = (items: ChatItem[]) => items.map((i) => (i.kind === "user" ? i.text : i.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))).join(" | ");

test("chat sessions: a new chat keeps the old one, which can be reopened or deleted", async () => {
  const fake = await fakeServer((req) => [oaChunk({ content: `re: ${JSON.stringify(req.messages.at(-1).content).match(/\\n\\n(\w+)/)?.[1]}` }, "stop")]);
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "s", endpoints: [{ id: "s", kind: "openai", baseUrl: fake.url, model: "m" }] });
    const file = path.join(root, "docs", "diagrams", "sessions.excalidraw");
    const t = await tab(file);
    await t.chat("first");
    const first = t.session;
    assert.equal(textOf(t.items), "first | re: first");
    assert.equal(t.sessions[0].title, "first");

    await t.send({ t: "chat-new" });
    assert.notEqual(t.session, first);
    assert.deepEqual(t.items, []);
    await t.chat("second");
    // The new chat starts fresh: the model doesn't see the first one.
    assert.equal(fake.requests[1].body.messages.length, 2);
    assert.deepEqual(t.sessions.map((s) => s.title), ["second", "first"]);
    // "New chat" on an empty chat doesn't pile up empty sessions.
    await t.send({ t: "chat-new" });
    const empty = t.session;
    await t.send({ t: "chat-new" });
    assert.equal(t.session, empty);

    await t.send({ t: "chat-open", session: first });
    assert.equal(textOf(t.items), "first | re: first");
    assert.deepEqual(t.sessions.map((s) => s.title), ["second", "first"], "the empty chat is dropped once another is opened");
    await t.chat("more");
    assert.equal(textOf(t.items), "first | re: first | more | re: more");
    assert.equal(fake.requests[2].body.messages.length, 4, "a reopened chat continues where it left off");

    // Saved per drawing, and a new tab opens the same chat.
    const dir = path.join(cfg.stateDir, "chats", crypto.createHash("sha256").update(path.join(fs.realpathSync(path.dirname(file)), path.basename(file))).digest("hex").slice(0, 24));
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${first}.json`, `${t.sessions[1].id}.json`, "open.json"].sort());
    const t2 = await tab(file);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t2.session, first);

    const second = t.sessions.find((s) => s.title === "second")!.id;
    await t.send({ t: "chat-delete", session: first });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.session, second, "deleting the open chat opens the next one");
    assert.equal(textOf(t2.items), "second | re: second", "every tab follows");
    assert.ok(!fs.existsSync(path.join(dir, `${first}.json`)));
    t.ws.close();
    t2.ws.close();
  } finally {
    fake.close();
  }
});

test("a conversation saved before sessions existed becomes the drawing's first session", async () => {
  const file = path.join(root, "docs", "diagrams", "legacy.excalidraw");
  const id = crypto.createHash("sha256").update(path.join(fs.realpathSync(path.dirname(file)), path.basename(file))).digest("hex").slice(0, 24);
  fs.mkdirSync(path.join(cfg.stateDir, "chats"), { recursive: true });
  const legacy = path.join(cfg.stateDir, "chats", `${id}.json`);
  const items: ChatItem[] = [
    { kind: "user", id: "u1", text: "an old question", context: { selection: 0, mentions: [], image: false } },
    { kind: "assistant", id: "a1", endpoint: "x", parts: [{ type: "text", text: "an old answer" }], status: "done" },
  ];
  fs.writeFileSync(legacy, JSON.stringify({ path: file, items, messages: [] }));
  const t = await tab(file);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(textOf(t.items), "an old question | an old answer");
  assert.equal(t.sessions[0].title, "an old question");
  assert.ok(!fs.existsSync(legacy));
  t.ws.close();
});

test("each chat keeps its endpoint, and two drawings can get replies at once without mixing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = await fakeServer(async (_req, n) => {
    if (n === 1) await gate;
    return [oaChunk({ content: `slow ${n}` }, "stop")];
  });
  const fast = await fakeServer((_req, n) => [oaChunk({ content: `fast ${n}` }, "stop")]);
  try {
    await api("PUT", "/api/ai/settings", {
      enabled: true,
      active: "slow",
      endpoints: [
        { id: "slow", kind: "openai", baseUrl: slow.url, model: "a" },
        { id: "fast", kind: "openai", baseUrl: fast.url, model: "b" },
      ],
    });
    const one = await tab(path.join(root, "docs", "diagrams", "one.excalidraw"));
    const two = await tab(path.join(root, "docs", "diagrams", "two.excalidraw"));
    const oneDone = one.chat("draw one");
    while (slow.requests.length < 1) await new Promise((r) => setTimeout(r, 10));

    // The other drawing's chat switches model while the first reply is still running.
    await api("PUT", "/api/ai/settings", { active: "fast" });
    await two.chat("draw two");
    assert.equal(textOf(two.items), "draw two | fast 1");

    release();
    await oneDone;
    assert.equal(textOf(one.items), "draw one | slow 1");
    assert.equal(one.sessions[0].endpoint, "slow");

    // The first chat stays on its model even though the default changed.
    await one.chat("again");
    assert.equal(slow.requests.length, 2);
    assert.equal(fast.requests.length, 1);
    // Until it is switched.
    one.ws.send(JSON.stringify({ t: "chat-endpoint", session: one.session, endpoint: "fast" }));
    await one.chat("and again");
    assert.equal(fast.requests.length, 2);
    assert.match(textOf(one.items), /and again \| fast 2$/);
    one.ws.close();
    two.ws.close();
  } finally {
    slow.close();
    fast.close();
  }
});

test("one reply at a time per drawing, across its chats", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = await fakeServer(async (_req, n) => {
    if (n === 1) await gate;
    return [oaChunk({ content: "ok" }, "stop")];
  });
  try {
    await api("PUT", "/api/ai/settings", { enabled: true, active: "g", endpoints: [{ id: "g", kind: "openai", baseUrl: fake.url, model: "m" }] });
    const t = await tab(path.join(root, "docs", "diagrams", "busy.excalidraw"));
    void t.chat("long one");
    while (fake.requests.length < 1) await new Promise((r) => setTimeout(r, 10));
    const busy = t.session;
    await t.send({ t: "chat-new" });
    assert.ok(t.sessions.find((s) => s.id === busy)?.busy);
    await t.chat("meanwhile");
    assert.match(t.errors.at(-1)!, /Another chat on this drawing/);
    await t.send({ t: "chat-delete", session: busy });
    assert.match(t.errors.at(-1)!, /Stop this chat/);
    release();
    while (t.sessions.find((s) => s.id === busy)?.busy) await new Promise((r) => setTimeout(r, 10));
    await t.chat("now");
    assert.equal(textOf(t.items), "now | ok");
    t.ws.close();
  } finally {
    fake.close();
  }
});
