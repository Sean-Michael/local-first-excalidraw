/**
 * Integration tests against a real daemon process (`lfx serve`) on a random port with its own
 * state directory, over HTTP, WebSocket and MCP stdio. Nothing touches the user's daemon.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";
import { type Config, VERSION } from "../src/server/config.js";
import { startDaemon } from "../src/server/daemon.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "cli.js");
const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`)));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

/** Environment for a CLI or daemon that is isolated from the user's: its own port, state and roots. */
const isolatedEnv = (port: number, stateDir: string, root: string, web: string): NodeJS.ProcessEnv => ({
  ...process.env,
  LFX_PORT: String(port),
  LFX_STATE_DIR: stateDir,
  LFX_ROOTS: root,
  LFX_WEB_DIR: web,
  LFX_NO_BROWSER: "1",
  // The web directory here is a stub that can't render; headless rendering has its own tests.
  LFX_HEADLESS: "off",
  LFX_URL: undefined,
  LFX_TOKEN: undefined,
  LFX_PROJECT_ROOT: undefined,
  LFX_IDLE_EXIT_MIN: undefined,
  LFX_ON_DEMAND: undefined,
  // Exit with the test run even if it is killed.
  LFX_PARENT_PID: String(process.pid),
});

const lfx = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  promisify(execFile)(process.execPath, [CLI, ...args], { env, timeout: 20_000 }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

/** A raw HTTP request, so Host and Origin can be set freely. */
function raw(port: number, method: string, route: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { Host: `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // html page
          }
          resolve({ status: res.statusCode!, body: parsed, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

let port: number;
let stateDir: string;
let root: string;
let web: string;
let env: NodeJS.ProcessEnv;
let daemon: ChildProcess;
let token: string;
let cookie: string;

const bearer = () => ({ Authorization: `Bearer ${token}` });
const origin = () => ({ Origin: `http://127.0.0.1:${port}` });

async function login(): Promise<string> {
  const { body } = await raw(port, "POST", "/api/login-code", bearer(), {});
  const res = await raw(port, "GET", `/login?code=${body.code}`);
  assert.equal(res.status, 303);
  return String(res.headers["set-cookie"]![0]).split(";")[0];
}

before(async () => {
  port = await freePort();
  stateDir = tmp("state");
  root = tmp("root");
  web = tmp("web");
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>lfx</title>");
  env = isolatedEnv(port, stateDir, root, web);
  daemon = spawn(process.execPath, [CLI, "serve"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  daemon.stderr!.on("data", (c) => (log += c));
  for (let i = 0; i < 100; i++) {
    if (log.includes("listening on")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(log, /listening on/);
  token = fs.readFileSync(path.join(stateDir, "token"), "utf8").trim();
  cookie = await login();
});

after(async () => {
  daemon.kill();
});

test("requests with a foreign Host header are refused (DNS rebinding)", async () => {
  assert.equal((await raw(port, "GET", "/api/health", { Host: `evil.example:${port}` })).status, 421);
  assert.equal((await raw(port, "GET", "/api/health")).status, 200);
});

test("cross-origin requests are refused, same-origin ones allowed", async () => {
  assert.equal((await raw(port, "GET", "/api/files", { Cookie: cookie, Origin: "http://evil.example" })).status, 403);
  assert.equal((await raw(port, "GET", "/api/files", { Cookie: cookie, Origin: `https://127.0.0.1:${port}` })).status, 403);
  assert.equal((await raw(port, "GET", "/api/files", { Cookie: cookie, ...origin() })).status, 200);
});

test("the WebSocket needs a same-origin Origin header and a session", async () => {
  const attempt = (headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
      ws.on("error", () => resolve("error"));
    });
  assert.equal(await attempt({ Cookie: cookie }), "403");
  assert.equal(await attempt({ Cookie: cookie, Origin: "http://evil.example" }), "403");
  assert.equal(await attempt({ ...origin() }), "403");
  assert.equal(await attempt({ Cookie: cookie, ...origin() }), "open");
});

test("local-client endpoints reject browser sessions and anonymous calls", async () => {
  const p = path.join(root, "a.excalidraw");
  for (const [method, route, body] of [
    ["POST", "/api/op", { op: "read", path: p }],
    ["POST", "/api/list", {}],
    ["POST", "/api/roots", { path: root }],
    ["GET", "/api/roots", undefined],
    ["DELETE", "/api/roots", { path: root }],
    ["POST", "/api/login-code", {}],
    ["GET", "/api/status", undefined],
    ["POST", "/api/shutdown", {}],
  ] as const) {
    assert.equal((await raw(port, method, route, { Cookie: cookie }, body)).status, 403, `${method} ${route} with a session`);
    assert.equal((await raw(port, method, route, {}, body)).status, 401, `${method} ${route} anonymously`);
  }
  assert.equal((await raw(port, "GET", "/", {})).status, 401);
  assert.equal((await raw(port, "GET", "/", { Cookie: cookie })).status, 200);
});

test("a sign-in link works once", async () => {
  const { body } = await raw(port, "POST", "/api/login-code", bearer(), {});
  assert.equal((await raw(port, "GET", `/login?code=${body.code}`)).status, 303);
  assert.equal((await raw(port, "GET", `/login?code=${body.code}`)).status, 401);
  assert.equal((await raw(port, "GET", "/login?code=made-up")).status, 401);
});

test("a malformed escape in a page path is a 400, not a 500", async () => {
  assert.equal((await raw(port, "GET", "/%E0%A4%A", { Cookie: cookie })).status, 400);
});

test("a path outside the roots is refused with the roots named", async () => {
  const r = await raw(port, "POST", "/api/op", bearer(), { op: "read", path: path.join(tmp("elsewhere"), "x.excalidraw") });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "outside-roots");
  assert.ok(r.body.error.includes(root), r.body.error);
});

test("rendering with no editor open is a 409 no-editor", async () => {
  const p = path.join(root, "render.excalidraw");
  await raw(port, "POST", "/api/op", bearer(), { op: "create", path: p, elements: [{ type: "rectangle", x: 0, y: 0, width: 50, height: 50 }] });
  const r = await raw(port, "POST", "/api/op", bearer(), { op: "render", path: p });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "no-editor");
});

test("a render is rejected as soon as the tab asked to do it closes", async () => {
  const p = path.join(root, "closing.excalidraw");
  await raw(port, "POST", "/api/op", bearer(), { op: "create", path: p, elements: [] });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, ...origin() } });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "open", path: p }));
  ws.on("message", (m) => {
    if (JSON.parse(String(m)).t === "render") ws.close();
  });
  const started = Date.now();
  const r = await raw(port, "POST", "/api/op", bearer(), { op: "render", path: p });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "editor-closed");
  assert.ok(Date.now() - started < 5000);
});

test("roots registered for a session are not persisted, and roots can be removed", async () => {
  const project = tmp("project");
  const kept = tmp("kept");
  await raw(port, "POST", "/api/roots", bearer(), { path: project, session: true });
  await raw(port, "POST", "/api/roots", bearer(), { path: kept });
  const listed = await lfx(env, "roots");
  assert.match(listed.stdout, new RegExp(`session\\s+${project}`));
  assert.match(listed.stdout, new RegExp(`registered\\s+${kept}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "roots.json"), "utf8")), [kept]);
  assert.equal((await lfx(env, "roots", "remove", kept)).code, 0);
  assert.equal((await lfx(env, "roots", "remove", project)).code, 0);
  const after = (await raw(port, "GET", "/api/roots", bearer())).body;
  assert.deepEqual([after.registered, after.session], [[], []]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "roots.json"), "utf8")), []);
  assert.equal((await raw(port, "DELETE", "/api/roots", bearer(), { path: root })).status, 400);
  assert.equal((await raw(port, "DELETE", "/api/roots", bearer(), { path: project })).status, 404);
});

test("lfx status shows the daemon's and client's versions", async () => {
  const r = await lfx(env, "status");
  assert.equal(r.code, 0);
  const s = JSON.parse(r.stdout);
  assert.equal(s.version, VERSION);
  assert.equal(s.clientVersion, VERSION);
  assert.equal(s.versionMismatch, undefined);
});

test("MCP over stdio: list tools, draw a diagram and read it back", async () => {
  const project = tmp("mcp project");
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--root", project], env: env as Record<string, string>, stderr: "ignore" }));
  try {
    const { tools } = await client.listTools();
    for (const t of ["create_diagram", "read_drawing", "render_drawing"]) assert.ok(tools.some((x) => x.name === t), t);
    const made = (await client.callTool({
      name: "create_diagram",
      arguments: { path: "arch", nodes: [{ id: "api", label: "API" }, { id: "db", label: "Database" }], edges: [{ from: "api", to: "db", label: "queries" }] },
    })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!made.isError, made.content[0].text);
    assert.ok(fs.existsSync(path.join(project, "docs", "diagrams", "arch.excalidraw")));
    const read = (await client.callTool({ name: "read_drawing", arguments: { path: "arch" } })) as { content: { text: string }[] };
    assert.match(read.content[0].text, /API/);
    assert.match(read.content[0].text, /Database/);
    // The project was registered for this daemon's lifetime only.
    assert.ok(!fs.readFileSync(path.join(stateDir, "roots.json"), "utf8").includes(project));
  } finally {
    await client.close();
  }
});

test("MCP roots from the client are decoded (spaces, unicode)", async () => {
  const project = tmp("roots ünïcode dir");
  const client = new Client({ name: "test", version: "1" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(project).href, name: "p" }] }));
  const cwd = tmp("cwd");
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd, env: env as Record<string, string>, stderr: "ignore" }));
  try {
    const r = (await client.callTool({ name: "create_diagram", arguments: { path: "x", nodes: [{ id: "a", label: "A" }] } })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!r.isError, r.content[0].text);
    assert.ok(fs.existsSync(path.join(project, "docs", "diagrams", "x.excalidraw")));
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// Version mismatch and stop, against a stand-in for an old daemon
// ---------------------------------------------------------------------------

/** Answers like a daemon of another version. It exits on /api/shutdown unless told to hang on. */
async function oldDaemon(p: number, health: Record<string, unknown>, opts: { ignoreShutdown?: boolean } = {}) {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, name: "local-first-excalidraw", pid: 4242, ...health }));
    if (req.url === "/api/status") return res.end(JSON.stringify({ version: health.version, pid: 4242, roots: [], editors: [] }));
    if (req.url === "/api/shutdown") {
      res.end("{}");
      if (!opts.ignoreShutdown) setImmediate(() => close());
      return;
    }
    res.end("{}");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const close = () => {
    server.close();
    for (const s of sockets) s.destroy();
  };
  await new Promise<void>((r) => server.listen(p, "127.0.0.1", () => r()));
  return { close };
}

test("an older on-demand daemon is replaced by the current version", async () => {
  const p = await freePort();
  const e = isolatedEnv(p, tmp("state"), tmp("root"), web);
  const old = await oldDaemon(p, { version: "0.0.1", onDemand: true });
  try {
    const status = await lfx(e, "status");
    assert.equal(status.code, 2);
    assert.equal(JSON.parse(status.stdout).versionMismatch, true);
    assert.match(status.stderr, /daemon v0\.0\.1, client v/);
    const r = await lfx(e, "url");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\/login\?code=/);
    assert.match(r.stderr, /Replacing daemon v0\.0\.1/);
    const health = await (await fetch(`http://127.0.0.1:${p}/api/health`)).json();
    assert.equal(health.version, VERSION);
    assert.equal(health.onDemand, true);
    const stop = await lfx(e, "stop");
    assert.equal(stop.stdout.trim(), "Stopped.");
    assert.equal((await lfx(e, "stop")).stdout.trim(), "Daemon is not running.");
  } finally {
    old.close();
  }
});

test("a daemon of another version that wasn't started on demand is left alone, with a clear error", async () => {
  for (const health of [{ version: "0.0.1" }, { version: "99.0.0", onDemand: true }]) {
    const p = await freePort();
    const e = isolatedEnv(p, tmp("state"), tmp("root"), web);
    const old = await oldDaemon(p, health);
    try {
      const r = await lfx(e, "url");
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`Daemon v${health.version.replace(/\./g, "\\.")} is running .* client is v`));
      assert.match(r.stderr, /lfx stop/);
      assert.ok((await fetch(`http://127.0.0.1:${p}/api/health`)).ok, "still running");
    } finally {
      old.close();
    }
  }
});

test("lfx stop says so when the daemon doesn't go", async () => {
  const p = await freePort();
  const e = isolatedEnv(p, tmp("state"), tmp("root"), web);
  const old = await oldDaemon(p, { version: VERSION }, { ignoreShutdown: true });
  try {
    const r = await lfx(e, "stop");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /still running \(pid 4242\)/);
    assert.doesNotMatch(r.stdout, /Stopped/);
  } finally {
    old.close();
  }
});

// ---------------------------------------------------------------------------
// In-process, where time can be moved forward
// ---------------------------------------------------------------------------

test("a sign-in link expires after two minutes", async () => {
  const p = await freePort();
  const cfg: Config = { stateDir: tmp("state"), host: "127.0.0.1", port: p, allowedHosts: new Set([`127.0.0.1:${p}`]), defaultRoots: [tmp("root")], allowRootRegistration: true, webDir: web };
  const server = await startDaemon(cfg);
  try {
    const t = fs.readFileSync(path.join(cfg.stateDir, "token"), "utf8").trim();
    const { body } = await raw(p, "POST", "/api/login-code", { Authorization: `Bearer ${t}` }, {});
    mock.timers.enable({ apis: ["Date"], now: Date.now() + 121_000 });
    try {
      assert.equal((await raw(p, "GET", `/login?code=${body.code}`)).status, 401);
    } finally {
      mock.timers.reset();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
