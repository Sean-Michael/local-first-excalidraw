/**
 * The drawing tree (sidebar and drawing list): building the tree from paths, and the daemon's
 * "files-changed" event when drawings are created, renamed, moved or deleted.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { relevantChange } from "../src/server/drawing-watch.js";
import { listFolders } from "../src/server/files.js";
import { ancestorFolders, buildTree, type FolderNode, type TreeNode, visibleRows } from "../src/shared/tree.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "cli.js");
const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`)));

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

const R = "/p/app";
const d = (rel: string) => ({ path: `${R}/${rel}`, root: R });
const shape = (n: TreeNode): unknown => (n.kind === "drawing" ? n.name : { [n.name]: n.children.map(shape) });

test("buildTree nests drawings under their folders, folders first, then by name", () => {
  const [root] = buildTree({
    roots: [R],
    drawings: [d("zeta.excalidraw"), d("docs/b.excalidraw"), d("docs/arch/c 10.excalidraw"), d("docs/arch/c 9.excalidraw"), d("Alpha.excalidraw"), d("docs/a.excalidraw")],
    folders: [],
  });
  assert.equal(root.isRoot, true);
  assert.equal(root.count, 6);
  assert.deepEqual(root.children.map(shape), [{ docs: [{ arch: ["c 9", "c 10"] }, "a", "b"] }, "Alpha", "zeta"]);
  const docs = root.children[0] as FolderNode;
  assert.equal(docs.path, `${R}/docs`);
  assert.equal(docs.rel, "docs");
  assert.equal(docs.count, 4);
  assert.equal((docs.children[0] as FolderNode).path, `${R}/docs/arch`);
});

test("buildTree hides folders without drawings unless empty or showAll", () => {
  const input = {
    roots: [R, "/p/empty"],
    drawings: [d("docs/a.excalidraw")],
    folders: [
      { path: `${R}/docs`, root: R },
      { path: `${R}/src`, root: R },
      { path: `${R}/src/lib`, root: R },
      { path: `${R}/new`, root: R, empty: true },
      { path: `${R}/new/inner`, root: R, empty: true },
    ],
  };
  const [root, empty] = buildTree(input);
  assert.deepEqual(root.children.map(shape), [{ docs: ["a"] }, { new: [{ inner: [] }] }]);
  assert.equal(empty.children.length, 0, "every root is listed, even with no drawings");
  const [all] = buildTree(input, { showAll: true });
  assert.deepEqual(all.children.map(shape), [{ docs: ["a"] }, { new: [{ inner: [] }] }, { src: [{ lib: [] }] }]);
});

test("buildTree shows a root inside another root once, inside the outer one", () => {
  const inner = `${R}/docs`;
  const tree = buildTree({
    roots: [inner, R],
    drawings: [d("docs/a.excalidraw"), { path: `${inner}/a.excalidraw`, root: inner }, d("b.excalidraw")],
    folders: [{ path: `${inner}/new`, root: inner, empty: true }],
  });
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map(shape), [{ docs: [{ new: [] }, "a"] }, "b"]);
  assert.equal(tree[0].count, 2);
});

test("buildTree filters by name and folder, case-insensitively", () => {
  const input = { roots: [R], drawings: [d("docs/Login Flow.excalidraw"), d("docs/db.excalidraw"), d("ops/deploy.excalidraw")], folders: [{ path: `${R}/flows`, root: R, empty: true }] };
  assert.deepEqual(buildTree(input, { filter: "LOGIN" })[0].children.map(shape), [{ docs: ["Login Flow"] }]);
  assert.deepEqual(buildTree(input, { filter: "docs/" })[0].children.map(shape), [{ docs: ["db", "Login Flow"] }]);
  assert.deepEqual(buildTree(input, { filter: "flow" })[0].children.map(shape), [{ docs: ["Login Flow"] }, { flows: [] }]);
  assert.equal(buildTree(input, { filter: "nothing" })[0].children.length, 0);
});

test("ancestorFolders and visibleRows support revealing and keyboard navigation", () => {
  assert.deepEqual(ancestorFolders(R, `${R}/a/b/c.excalidraw`), [R, `${R}/a`, `${R}/a/b`]);
  assert.deepEqual(ancestorFolders("C:\\p", "C:\\p\\a\\x.excalidraw"), ["C:\\p", "C:\\p\\a"]);
  const tree = buildTree({ roots: [R], drawings: [d("a/x.excalidraw"), d("y.excalidraw")], folders: [] });
  const rows = visibleRows(tree, (p) => p === R);
  assert.deepEqual(rows.map((r) => [r.node.name, r.depth, r.parent]), [[R, 0, undefined], ["a", 1, R], ["y", 1, R]]);
  assert.equal(visibleRows(tree, () => true).length, 4);
});

test("listFolders marks empty folders and relevantChange ignores noise", () => {
  const root = tmp("folders");
  fs.mkdirSync(path.join(root, "made", "deeper"), { recursive: true });
  fs.mkdirSync(path.join(root, "code"));
  fs.writeFileSync(path.join(root, "code", "x.ts"), "");
  const byRel = Object.fromEntries(listFolders([root]).map((f) => [path.relative(root, f.path), !!f.empty]));
  assert.deepEqual(byRel, { code: false, made: false, [path.join("made", "deeper")]: true });
  assert.equal(relevantChange("docs/a.excalidraw"), true);
  assert.equal(relevantChange("docs/new-folder"), true);
  assert.equal(relevantChange("src/a.ts"), false);
  assert.equal(relevantChange(".git/index"), false);
  assert.equal(relevantChange("node_modules/x/y"), false);
});

// ---------------------------------------------------------------------------
// files-changed from a real daemon
// ---------------------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

let port: number;
let root: string;
let daemon: ChildProcess;
let token: string;
let cookie: string;

function call(method: string, route: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Origin: `http://127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json" } : {}) },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

before(async () => {
  port = await freePort();
  const stateDir = tmp("side-state");
  root = tmp("side-root");
  const web = tmp("side-web");
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>lfx</title>");
  daemon = spawn(process.execPath, [CLI, "serve"], {
    env: {
      ...process.env,
      LFX_PORT: String(port),
      LFX_STATE_DIR: stateDir,
      LFX_ROOTS: root,
      LFX_WEB_DIR: web,
      LFX_NO_BROWSER: "1",
      LFX_HEADLESS: "off",
      LFX_TRASH_DIR: tmp("side-trash"),
      LFX_URL: undefined,
      LFX_TOKEN: undefined,
      LFX_IDLE_EXIT_MIN: undefined,
      LFX_ON_DEMAND: undefined,
      LFX_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  daemon.stderr!.on("data", (c) => (log += c));
  for (let i = 0; i < 100 && !log.includes("listening on"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening on/);
  token = fs.readFileSync(path.join(stateDir, "token"), "utf8").trim();
  const code = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/login-code", headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve(JSON.parse(t).code));
    });
    req.on("error", reject);
    req.end("{}");
  });
  const res = await new Promise<http.IncomingMessage>((resolve) => http.get({ host: "127.0.0.1", port, path: `/login?code=${code}`, headers: { Host: `127.0.0.1:${port}` } }, resolve));
  cookie = String(res.headers["set-cookie"]![0]).split(";")[0];
});

after(() => {
  daemon.kill();
});

/** A drawing-list tab: a socket that opens no drawing and counts "files-changed". */
async function listener() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` } });
  let count = 0;
  ws.on("message", (raw) => {
    if (JSON.parse(raw.toString()).t === "files-changed") count++;
  });
  await new Promise((r) => ws.once("open", r));
  // Let the daemon take its first look at the drawing set.
  await new Promise((r) => setTimeout(r, 300));
  const changed = async (what: string, ms = 5000) => {
    const start = count;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (count > start) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no files-changed after ${what}`);
  };
  return { ws, changed, mark: () => count, count: () => count };
}

test("files-changed fires on create, rename, move, new folder, delete and edits on disk", async () => {
  const tab = await listener();
  const a = path.join(root, "a.excalidraw");

  let wait = tab.changed("create");
  assert.equal((await call("POST", "/api/new", { path: a })).status, 200);
  await wait;

  wait = tab.changed("rename");
  const b = path.join(root, "b.excalidraw");
  assert.equal((await call("POST", "/api/files/rename", { path: a, to: b })).status, 200);
  await wait;

  wait = tab.changed("new folder");
  assert.equal((await call("POST", "/api/files/folder", { path: path.join(root, "docs") })).status, 200);
  await wait;

  wait = tab.changed("move");
  assert.equal((await call("POST", "/api/files/move", { path: b, dir: path.join(root, "docs") })).status, 200);
  await wait;

  wait = tab.changed("rename folder");
  const r = await call("POST", "/api/files/rename-folder", { path: path.join(root, "docs"), name: "diagrams" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fs.existsSync(path.join(root, "diagrams", "b.excalidraw")));
  await wait;

  wait = tab.changed("trash");
  assert.equal((await call("POST", "/api/files/trash", { path: path.join(root, "diagrams", "b.excalidraw") })).status, 200);
  await wait;

  // Made by something else entirely (an agent's file tool, git): the watcher or scan notices.
  wait = tab.changed("a file written on disk", 8000);
  fs.writeFileSync(path.join(root, "outside.excalidraw"), JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }));
  await wait;
  wait = tab.changed("a file deleted on disk", 8000);
  fs.rmSync(path.join(root, "outside.excalidraw"));
  await wait;

  // Saving an existing drawing doesn't change the set.
  await call("POST", "/api/new", { path: path.join(root, "c.excalidraw") });
  await new Promise((r) => setTimeout(r, 600));
  const before = tab.count();
  fs.writeFileSync(path.join(root, "src.ts"), "x");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(tab.count(), before, "unrelated files don't fire it");
  tab.ws.close();
});

test("a folder rename tells open tabs where their drawing went", async () => {
  const dir = path.join(root, "team");
  fs.mkdirSync(dir);
  const file = path.join(dir, "x.excalidraw");
  await call("POST", "/api/new", { path: file });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` } });
  const msgs: any[] = [];
  ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ t: "open", path: file }));
  for (let i = 0; i < 100 && !msgs.some((m) => m.t === "scene"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await call("POST", "/api/files/rename-folder", { path: dir, name: "crew" })).status, 200);
  for (let i = 0; i < 100 && !msgs.some((m) => m.t === "moved"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(msgs.find((m) => m.t === "moved"), { t: "moved", path: file, to: path.join(root, "crew", "x.excalidraw") });
  ws.close();
  // Refusals: a root, a path with slashes, a name that exists.
  assert.equal((await call("POST", "/api/files/rename-folder", { path: root, name: "x" })).status, 400);
  assert.equal((await call("POST", "/api/files/rename-folder", { path: path.join(root, "crew"), name: "a/b" })).status, 400);
  fs.mkdirSync(path.join(root, "taken"));
  assert.equal((await call("POST", "/api/files/rename-folder", { path: path.join(root, "crew"), name: "taken" })).status, 409);
});

test("/api/events streams files-changed for the macOS app", async () => {
  const got = await new Promise<string>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } }, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream");
      let text = "";
      let made: Promise<unknown> | undefined;
      res.on("data", (c) => {
        text += c;
        if (!made && text.includes(": connected")) made = new Promise((r) => setTimeout(r, 300)).then(() => call("POST", "/api/new", { path: path.join(root, "sse.excalidraw") }));
        if (text.includes("event: files-changed")) {
          clearTimeout(timer);
          req.destroy();
          void made!.then(() => resolve(text));
        }
      });
    });
    req.on("error", (e) => (e.message.includes("aborted") || e.message.includes("socket hang up") ? undefined : reject(e)));
    const timer = setTimeout(() => reject(new Error("no event")), 5000);
  });
  assert.match(got, /event: files-changed\ndata: \{\}\n\n/);
});
